#!/usr/bin/env python3
import requests, json, re, hashlib, time, threading
from pathlib import Path
from urllib.parse import unquote
from concurrent.futures import ThreadPoolExecutor, as_completed
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

BASE="https://alio.go.kr"
ROOT=Path("alio_c0345_fast"); ROOT.mkdir(exist_ok=True)
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36"
lock=threading.Lock(); LOG=[]

def safe(x):
    return re.sub(r'[\\/:*?"<>|]+','_',str(x or '').strip())[:170] or "file"

def hashf(p):
    h=hashlib.sha256()
    with open(p,'rb') as f:
        for b in iter(lambda:f.read(1024*1024),b''): h.update(b)
    return h.hexdigest()

def session():
    s=requests.Session()
    retry=Retry(total=3,connect=3,read=3,status=3,backoff_factor=.8,
                status_forcelist=[429,500,502,503,504,522],allowed_methods=frozenset(["GET","POST"]))
    s.mount("https://",HTTPAdapter(max_retries=retry))
    s.headers.update({"User-Agent":UA,"Accept":"*/*","X-Requested-With":"XMLHttpRequest",
                      "Referer":BASE+"/item/itemOrganList.do?apbaId=C0345"})
    return s

def log(d):
    with lock:
        LOG.append(d); print(json.dumps(d,ensure_ascii=False),flush=True)

def list_page(root,page):
    s=session()
    payload={"pageNo":page,"apbaId":"C0345","apbaType":"A2005","reportFormRootNo":root,
             "search_word":"","search_flag":"title","bid_type":"","enfc_istt":""}
    last=None
    for a in range(5):
        try:
            r=s.post(BASE+"/item/itemReportListSusi.json",json=payload,timeout=(8,20))
            obj=r.json()
            if obj.get("status")=="success":
                d=obj["data"]
                org=d.get("organInfo",{})
                if org.get("apbaId")!="C0345" or org.get("apbaNa")!="국방과학연구소":
                    raise RuntimeError("institution mismatch "+repr(org))
                return d["result"],d["page"]
            last=RuntimeError(str(obj))
        except Exception as e: last=e
        time.sleep(1.2*(a+1))
    raise RuntimeError(f"list root={root} page={page} failed: {last}")

def get_files(disclosure):
    s=session()
    r=s.get(BASE+"/item/itemReportFiles.json",params={"disclosureNo":disclosure},timeout=(8,20))
    r.raise_for_status()
    obj=r.json()
    if isinstance(obj,list): return obj
    if isinstance(obj,dict):
        for k in ("data","result"):
            if isinstance(obj.get(k),list): return obj[k]
    return []

def response_filename(r,fallback):
    cd=r.headers.get("content-disposition","")
    m=re.search(r"filename\*=UTF-8''([^;]+)",cd,re.I)
    if m:return safe(unquote(m.group(1)))
    m=re.search(r'filename="?([^";]+)"?',cd,re.I)
    if m:return safe(unquote(m.group(1)))
    return safe(fallback)

def download_item(item,outdir):
    title=item["title"].strip(); disc=item["disclosureNo"]; s=session()
    try:
        files=get_files(disc)
        if not files:
            log({"kind":"item","title":title,"disclosureNo":disc,"status":"fail","note":"no attachment metadata"}); return
        count=0
        for fi in files:
            fno=str(fi.get("fileNo") or "")
            fname=fi.get("orcpFileNa") or fi.get("orcpFileNm") or f"file_{fno}"
            if not fno: continue
            try:
                r=s.get(BASE+"/download/file.json",params={"f":fno,"d":disc},timeout=(8,75),allow_redirects=True)
                if r.status_code!=200 or len(r.content)<500:
                    raise RuntimeError(f"HTTP {r.status_code}, {len(r.content)} bytes")
                if b"<html" in r.content[:150].lower() or b"<!doctype" in r.content[:150].lower():
                    raise RuntimeError("HTML returned instead of attachment")
                p=Path(outdir); p.mkdir(parents=True,exist_ok=True)
                fn=response_filename(r,fname)
                dst=p/(safe(title)+"__"+fn)
                dst.write_bytes(r.content)
                count+=1
                log({"kind":"attachment","title":title,"disclosureNo":disc,"fileNo":fno,
                     "source_filename":fname,"status":"ok","path":str(dst),"size":dst.stat().st_size,
                     "sha256":hashf(dst),"url":r.url})
            except Exception as e:
                log({"kind":"attachment","title":title,"disclosureNo":disc,"fileNo":fno,
                     "source_filename":fname,"status":"fail","note":repr(e)})
        log({"kind":"item","title":title,"disclosureNo":disc,"status":"ok" if count else "fail",
             "note":f"{count}/{len(files)} original attachments downloaded"})
    except Exception as e:
        log({"kind":"item","title":title,"disclosureNo":disc,"status":"fail","note":repr(e)})

# Board all pages
b1,bpg=list_page("43005",1); board=list(b1)
for p in range(2,bpg["totalPage"]+1):
    xs,_=list_page("43005",p); board.extend(xs)
(ROOT/"board_index.json").write_text(json.dumps({"page":bpg,"items":board},ensure_ascii=False,indent=2),encoding="utf-8")

# Latest 10 audit
audit,apg=list_page("43006",1)
(ROOT/"audit_latest10_index.json").write_text(json.dumps({"page":apg,"items":audit},ensure_ascii=False,indent=2),encoding="utf-8")

tasks=[]
with ThreadPoolExecutor(max_workers=4) as ex:
    for it in board: tasks.append(ex.submit(download_item,it,ROOT/"01_이사회_회의록_원본"))
    for it in audit: tasks.append(ex.submit(download_item,it,ROOT/"02_감사결과_최신10건_원본"))
    for fut in as_completed(tasks):
        try:fut.result()
        except Exception as e: log({"kind":"worker","status":"fail","note":repr(e)})

# External accounting audit root: latest up to 3, if exposed through same API.
try:
    ext,epg=list_page("32301",1)
    ext=ext[:3]
    (ROOT/"external_audit_index.json").write_text(json.dumps({"page":epg,"items":ext},ensure_ascii=False,indent=2),encoding="utf-8")
    with ThreadPoolExecutor(max_workers=3) as ex:
        fs=[ex.submit(download_item,it,ROOT/"03_외부회계감사_최근자료") for it in ext]
        for f in as_completed(fs): f.result()
except Exception as e:
    log({"kind":"external_audit","status":"fail","note":repr(e)})

(ROOT/"download_manifest.json").write_text(json.dumps(LOG,ensure_ascii=False,indent=2),encoding="utf-8")
oks=[x for x in LOG if x.get("kind")=="attachment" and x.get("status")=="ok"]
fails=[x for x in LOG if x.get("status")=="fail"]
summary=[
    "국방과학연구소 C0345 ALIO 원본첨부 직접 다운로드 결과",
    f"이사회 공개총계: {bpg.get('totalCount')}건 / 다운로드 대상: {len(board)}건",
    f"감사결과 공개총계: {apg.get('totalCount')}건 / 다운로드 대상: 최신 {len(audit)}건",
    f"원본 첨부파일 성공: {len(oks)}개 / 실패 기록: {len(fails)}건",
    "",
    "다운로드 성공 원본:",
    *[f"- {x['title']} | {x['source_filename']} | {x['size']} bytes | {x['sha256']}" for x in oks],
    "",
    "실패/확인 필요:",
    *[f"- {x.get('kind')} / {x.get('title','')}: {x.get('note','')}" for x in fails],
]
(ROOT/"다운로드_결과.txt").write_text("\n".join(summary),encoding="utf-8")
