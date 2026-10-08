#!/usr/bin/env python3
import requests, json, re, hashlib, zipfile, os
from pathlib import Path
from urllib.parse import unquote

BASE="https://alio.go.kr"
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36"
ROOT=Path("alio_c0345_direct")
ROOT.mkdir(exist_ok=True)
LOG=[]

s=requests.Session()
s.headers.update({
    "User-Agent":UA,
    "Accept":"*/*",
    "X-Requested-With":"XMLHttpRequest",
    "Referer":BASE+"/item/itemOrganList.do?apbaId=C0345&reportFormRootNo=43005",
})

def safe(x):
    return re.sub(r'[\\/:*?"<>|]+','_', (x or '').strip())[:170] or "file"

def sha256(p):
    h=hashlib.sha256()
    with open(p,'rb') as f:
        for b in iter(lambda:f.read(1024*1024),b''): h.update(b)
    return h.hexdigest()

def record(kind,title,status,note="",path=None,url=""):
    d={"kind":kind,"title":title,"status":status,"note":note,"url":url}
    if path and Path(path).exists():
        p=Path(path); d.update(path=str(p),size=p.stat().st_size,sha256=sha256(p))
    LOG.append(d); print(json.dumps(d,ensure_ascii=False),flush=True)

def init_root(root):
    url=f"{BASE}/item/itemOrganList.do?apbaId=C0345&reportFormRootNo={root}"
    r=s.get(url,timeout=30)
    r.raise_for_status()
    return url

def list_reports(root,page=1):
    init_root(root)
    payload={
        "pageNo":page,
        "apbaId":"C0345",
        "apbaType":"A2005",
        "reportFormRootNo":root,
        "search_word":"",
        "search_flag":"title",
        "bid_type":"",
        "enfc_istt":"",
    }
    r=s.post(BASE+"/item/itemReportListSusi.json",json=payload,timeout=30)
    r.raise_for_status()
    obj=r.json()
    if obj.get("status")!="success":
        raise RuntimeError(f"list API error {root} p{page}: {obj}")
    data=obj["data"]
    if data.get("organInfo",{}).get("apbaId")!="C0345" or data.get("organInfo",{}).get("apbaNa")!="국방과학연구소":
        raise RuntimeError(f"institution mismatch {data.get('organInfo')}")
    return data["result"],data["page"]

def get_files(disclosure):
    r=s.get(BASE+"/item/itemReportFiles.json",params={"disclosureNo":disclosure},timeout=30)
    r.raise_for_status()
    obj=r.json()
    # This endpoint may return a bare array or {data:[...]}
    if isinstance(obj,list): return obj
    if isinstance(obj,dict):
        if isinstance(obj.get("data"),list): return obj["data"]
        if isinstance(obj.get("result"),list): return obj["result"]
    return []

def filename_from_response(r, fallback):
    cd=r.headers.get("content-disposition","")
    fn=None
    m=re.search(r"filename\*=UTF-8''([^;]+)",cd,re.I)
    if m: fn=unquote(m.group(1))
    if not fn:
        m=re.search(r'filename="?([^";]+)"?',cd,re.I)
        if m: fn=unquote(m.group(1))
    if not fn: fn=fallback
    return safe(fn)

def download_file(item,finfo,outdir):
    disclosure=item["disclosureNo"]
    fileNo=str(finfo.get("fileNo") or finfo.get("file_no") or finfo.get("fileSeq") or "")
    fname=(finfo.get("orcpFileNa") or finfo.get("orcpFileNm") or finfo.get("fileName") or finfo.get("fileNa") or f"file_{fileNo}")
    if not fileNo:
        record("attachment",item["title"],"fail","fileNo missing: "+json.dumps(finfo,ensure_ascii=False)); return None
    url=BASE+"/download/file.json"
    r=s.get(url,params={"f":fileNo,"d":disclosure},timeout=60,allow_redirects=True)
    if r.status_code!=200 or len(r.content)<500:
        record("attachment",item["title"],"fail",f"HTTP {r.status_code}, bytes={len(r.content)}",url=r.url); return None
    head=r.content[:120].lower()
    if b"<html" in head or b"<!doctype" in head:
        record("attachment",item["title"],"fail","HTML/error response instead of binary",url=r.url); return None
    outdir=Path(outdir); outdir.mkdir(parents=True,exist_ok=True)
    actual=filename_from_response(r,fname)
    p=outdir/(safe(item["title"])+"__"+actual)
    p.write_bytes(r.content)
    record("attachment",item["title"],"ok",f"fileNo={fileNo}; original={fname}",p,r.url)
    return p

def download_report_pdf(item,outdir):
    # Supplemental ALIO-generated report PDF, not a replacement for original attachment.
    r=s.get(BASE+"/download/pdf.json",params={"disclosureNo":item["disclosureNo"]},timeout=60,allow_redirects=True)
    if r.status_code==200 and len(r.content)>1000 and r.content[:4]==b"%PDF":
        outdir=Path(outdir); outdir.mkdir(parents=True,exist_ok=True)
        p=outdir/(safe(item["title"])+"__ALIO_보고서.pdf")
        p.write_bytes(r.content)
        record("report_pdf",item["title"],"ok","ALIO generated report PDF",p,r.url)
        return p
    record("report_pdf",item["title"],"fail",f"HTTP {r.status_code}, bytes={len(r.content)}",url=r.url)
    return None

def handle_items(items,outdir,include_pdf=True):
    for item in items:
        # Detail page institution/title validation.
        detail=s.get(BASE+"/item/itemReport.do",params={"seq":item["disclosureNo"],"disclosureNo":item["disclosureNo"]},timeout=30)
        if detail.status_code!=200 or "국방과학연구소" not in detail.text or item["title"].strip() not in detail.text:
            record("item",item["title"],"fail","detail validation failed",url=detail.url); continue
        files=get_files(item["disclosureNo"])
        if not files:
            # Fallback: parse <option value=fileNo>filename</option> from detail.
            opts=re.findall(r'<option\s+value="(\d+)">\s*([^<]+)</option>',detail.text)
            files=[{"fileNo":a,"orcpFileNa":b.strip()} for a,b in opts if a]
        if not files:
            record("item",item["title"],"fail","no attachments listed",url=detail.url)
        else:
            for f in files:
                download_file(item,f,outdir)
            record("item",item["title"],"ok",f"{len(files)} attachment(s) listed",url=detail.url)
        if include_pdf:
            download_report_pdf(item,outdir)

# 1) Board: all 12
board=[]
_,pg=list_reports("43005",1)
for page in range(1,pg["totalPage"]+1):
    xs,_=list_reports("43005",page); board.extend(xs)
(ROOT/"board_index.json").write_text(json.dumps(board,ensure_ascii=False,indent=2),encoding="utf-8")
handle_items(board,ROOT/"01_이사회_회의록_원본")

# 2) Audit: latest 10 only (current page 1) -- enough for evidence package; index also records total 71.
audit,auditpg=list_reports("43006",1)
(ROOT/"audit_latest10_index.json").write_text(json.dumps({"page":auditpg,"items":audit},ensure_ascii=False,indent=2),encoding="utf-8")
handle_items(audit,ROOT/"02_감사결과_최신10건_원본")

# 3) External financial audit: latest three public reports if available.
try:
    ext,extpg=list_reports("32301",1)
    ext=ext[:3]
    (ROOT/"external_audit_index.json").write_text(json.dumps({"page":extpg,"items":ext},ensure_ascii=False,indent=2),encoding="utf-8")
    handle_items(ext,ROOT/"03_외부회계감사_최근자료",include_pdf=True)
except Exception as e:
    record("external_audit","외부회계감사","fail",repr(e))

# Manifest and result
(ROOT/"download_manifest.json").write_text(json.dumps(LOG,ensure_ascii=False,indent=2),encoding="utf-8")
success=[x for x in LOG if x["status"]=="ok" and x["kind"]=="attachment"]
fails=[x for x in LOG if x["status"]=="fail"]
lines=[
    "국방과학연구소 C0345 ALIO 원본 다운로드 결과",
    f"이사회 전체: {len(board)}건",
    f"감사 공개총계: {auditpg.get('totalCount')}건 / 이번 패키지 최신 {len(audit)}건 다운로드",
    f"원본 첨부 다운로드 성공: {len(success)}개",
    f"실패: {len(fails)}건",
    "",
    "원본 첨부:",
    *[f"- {x['title']} | {x['path']} | {x['size']} bytes | sha256={x['sha256']}" for x in success],
    "",
    "실패/확인필요:",
    *[f"- {x['kind']} / {x['title']}: {x['note']}" for x in fails],
]
(ROOT/"다운로드_결과.txt").write_text("\n".join(lines),encoding="utf-8")
