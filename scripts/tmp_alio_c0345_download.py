#!/usr/bin/env python3
import os, re, time, json, hashlib, shutil, base64
from pathlib import Path
from urllib.parse import urljoin, unquote
import requests
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC

ROOT = Path("alio_c0345")
DL = (Path.cwd()/ROOT/"_downloads").resolve()
ROOT.mkdir(exist_ok=True); DL.mkdir(parents=True,exist_ok=True)
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36"
BOARD_URL="https://alio.go.kr/item/itemOrganList.do?apbaId=C0345&reportFormRootNo=43005"
AUDIT_URL="https://alio.go.kr/item/itemOrganList.do?apbaId=C0345&reportFormRootNo=43006"
LOG=[]

def safe(s):
    return re.sub(r'[\\/:*?"<>|]+','_',s).strip()[:150]

def sha256(p):
    h=hashlib.sha256()
    with open(p,'rb') as f:
        for b in iter(lambda:f.read(1024*1024),b''): h.update(b)
    return h.hexdigest()

def log(kind,title,status,note="",path=None,url=None):
    d={"kind":kind,"title":title,"status":status,"note":note,"url":url or ""}
    if path and Path(path).exists():
        p=Path(path); d.update(path=str(p),size=p.stat().st_size,sha256=sha256(p))
    LOG.append(d); print(json.dumps(d,ensure_ascii=False),flush=True)

opts=Options()
opts.add_argument("--headless=new"); opts.add_argument("--no-sandbox"); opts.add_argument("--disable-dev-shm-usage")
opts.add_argument("--disable-gpu"); opts.add_argument(f"--user-agent={UA}")
opts.add_experimental_option("prefs",{
    "download.default_directory":str(DL),"download.prompt_for_download":False,
    "download.directory_upgrade":True,"safebrowsing.enabled":True,
    "plugins.always_open_pdf_externally":True
})
driver=webdriver.Chrome(options=opts)
driver.execute_cdp_cmd("Page.setDownloadBehavior",{"behavior":"allow","downloadPath":str(DL)})
wait=WebDriverWait(driver,15)

def assert_add():
    body=driver.find_element(By.TAG_NAME,"body").text
    if "국방과학연구소" not in body:
        raise RuntimeError("기관 검증 실패: 국방과학연구소가 페이지에 없음")

def goto_list(url,page=1):
    driver.get(url); time.sleep(2); assert_add()
    if page>1:
        pages=driver.find_elements(By.CSS_SELECTOR,"div.paging a")
        target=None
        for a in pages:
            if (a.text or "").strip()==str(page):
                target=a; break
        if target is None: raise RuntimeError(f"페이지 {page} 버튼 없음")
        driver.execute_script("arguments[0].click();",target); time.sleep(2); assert_add()

def current_titles():
    out=[]
    for s in driver.find_elements(By.CSS_SELECTOR,"div.list-outer div.list-inner2 span.tit"):
        t=(s.text or "").strip()
        if t: out.append(t)
    return out

def snapshot_files():
    return {p.name for p in DL.iterdir() if p.is_file() and not p.name.endswith(".crdownload")}

def wait_new(before,timeout=8):
    end=time.time()+timeout
    while time.time()<end:
        partial=list(DL.glob("*.crdownload"))
        new=snapshot_files()-before
        if new and not partial: return sorted(new)
        time.sleep(.4)
    return sorted(snapshot_files()-before)

def valid_file(p):
    p=Path(p)
    if not p.exists() or p.stat().st_size<1000: return False
    head=p.read_bytes()[:32]
    # reject HTML/text error pages
    low=head.lower()
    if b"<html" in low or b"<!doctype" in low: return False
    return True

def move_downloads(names,outdir,title):
    outdir=Path(outdir); outdir.mkdir(parents=True,exist_ok=True)
    moved=[]
    for n in names:
        src=DL/n
        if not valid_file(src):
            try: src.unlink()
            except: pass
            continue
        dst=outdir/(safe(title)+"__"+safe(n))
        i=1
        while dst.exists():
            dst=outdir/(safe(title)+f"__{i}__"+safe(n)); i+=1
        shutil.move(str(src),str(dst)); moved.append(dst)
        log("attachment",title,"ok","browser download",dst,driver.current_url)
    return moved

def sync_session():
    s=requests.Session(); s.headers.update({"User-Agent":UA,"Referer":driver.current_url})
    for c in driver.get_cookies():
        try: s.cookies.set(c["name"],c["value"],domain=c.get("domain"))
        except: s.cookies.set(c["name"],c["value"])
    return s

def download_href(href,outdir,title,label):
    if not href or href.startswith("javascript:"): return None
    href=urljoin(driver.current_url,href)
    s=sync_session()
    try:
        r=s.get(href,timeout=30,allow_redirects=True)
        if r.status_code!=200 or len(r.content)<1000 or b"<html" in r.content[:100].lower():
            return None
        cd=r.headers.get("content-disposition","")
        fn=None
        m=re.search(r"filename\*=UTF-8''([^;]+)",cd,re.I)
        if m: fn=unquote(m.group(1))
        if not fn:
            m=re.search(r'filename="?([^";]+)',cd,re.I)
            if m: fn=unquote(m.group(1))
        if not fn:
            ext=".pdf" if r.content[:4]==b"%PDF" else ".hwp" if r.content[:8]==bytes.fromhex("d0cf11e0a1b11ae1") else ".bin"
            fn=safe(label or title)+ext
        outdir=Path(outdir); outdir.mkdir(parents=True,exist_ok=True)
        p=outdir/(safe(title)+"__"+safe(fn)); p.write_bytes(r.content)
        if not valid_file(p): p.unlink(missing_ok=True); return None
        log("attachment",title,"ok","direct href",p,href); return p
    except Exception:
        return None

def open_title(url,title):
    # search page1 then page2 (board only)
    maxpage=2 if "43005" in url else 1
    for pg in range(1,maxpage+1):
        goto_list(url,pg)
        spans=driver.find_elements(By.CSS_SELECTOR,"div.list-outer div.list-inner2 span.tit")
        for s in spans:
            if (s.text or "").strip()==title:
                a=s.find_element(By.XPATH,"./ancestor::a[1]")
                driver.execute_script("arguments[0].scrollIntoView({block:'center'});",a)
                driver.execute_script("arguments[0].click();",a)
                time.sleep(2)
                return True
    return False

def collect_detail(title,url,outdir):
    if not open_title(url,title):
        log("item",title,"fail","목록에서 제목을 다시 찾지 못함",url=url); return
    # Save detail HTML for auditability
    ddir=ROOT/"_detail_html"; ddir.mkdir(exist_ok=True)
    (ddir/(safe(title)+".html")).write_text(driver.page_source,encoding="utf-8")
    body=driver.find_element(By.TAG_NAME,"body").text
    if "국방과학연구소" not in body:
        log("item",title,"fail","상세페이지 기관 검증 실패",url=driver.current_url); return
    before=snapshot_files()
    got=[]
    candidates=[]
    for el in driver.find_elements(By.CSS_SELECTOR,"a,button"):
        try:
            txt=(el.text or "").strip()
            href=el.get_attribute("href") or ""
            titleattr=el.get_attribute("title") or ""
            aria=el.get_attribute("aria-label") or ""
            blob=" ".join([txt,titleattr,aria,href]).lower()
            if any(ext in blob for ext in [".pdf",".hwp",".hwpx",".xlsx",".xls",".docx",".zip"]) or "다운로드" in blob or "첨부파일" in blob:
                candidates.append((el,txt,href))
        except: pass
    # direct hrefs first
    seen=set()
    for el,txt,href in candidates:
        if href and href not in seen and not href.startswith("javascript:"):
            seen.add(href)
            p=download_href(href,outdir,title,txt)
            if p: got.append(p)
    # click only attachment-like elements
    for el,txt,href in candidates:
        try:
            before=snapshot_files()
            driver.execute_script("arguments[0].click();",el)
            new=wait_new(before,5)
            if new: got += move_downloads(new,outdir,title)
        except: pass
    # regex fallback for ALIO download endpoints embedded in page
    html=driver.page_source
    for u in set(re.findall(r'https?://[^"\'<> ]+(?:download|filedown)[^"\'<> ]*',html,re.I)):
        if u in seen: continue
        p=download_href(u.replace("&amp;","&"),outdir,title,title)
        if p: got.append(p)
    # de-duplicate by hash, remove duplicates
    uniq={}
    for p in list(Path(outdir).glob(safe(title)+"__*")):
        if not valid_file(p): continue
        h=sha256(p)
        if h in uniq:
            p.unlink()
        else: uniq[h]=p
    if not uniq:
        log("item",title,"fail","첨부파일 다운로드 없음",url=driver.current_url)
    else:
        log("item",title,"ok",f"원본 {len(uniq)}개 확보",url=driver.current_url)

# Discover exact current ADD titles from C0345 itself.
goto_list(BOARD_URL,1); board1=current_titles()
goto_list(BOARD_URL,2); board2=current_titles()
board_titles=board1+board2
goto_list(AUDIT_URL,1); audit_titles=current_titles()[:10]
(ROOT/"board_titles.json").write_text(json.dumps(board_titles,ensure_ascii=False,indent=2),encoding="utf-8")
(ROOT/"audit_titles_latest10.json").write_text(json.dumps(audit_titles,ensure_ascii=False,indent=2),encoding="utf-8")
print("BOARD",json.dumps(board_titles,ensure_ascii=False))
print("AUDIT",json.dumps(audit_titles,ensure_ascii=False))

for t in board_titles:
    collect_detail(t,BOARD_URL,ROOT/"01_ADD_이사회_회의록_원본")
for t in audit_titles:
    collect_detail(t,AUDIT_URL,ROOT/"02_ADD_감사결과_원본")

driver.quit()

# summary
ok=[x for x in LOG if x["status"]=="ok" and x["kind"]=="item"]
fail=[x for x in LOG if x["status"]=="fail" and x["kind"]=="item"]
(ROOT/"download_manifest.json").write_text(json.dumps(LOG,ensure_ascii=False,indent=2),encoding="utf-8")
lines=[f"ADD C0345 검증 다운로드",f"이사회 목록 {len(board_titles)}건 / 감사 최신목록 {len(audit_titles)}건",
       f"성공 항목 {len(ok)}건 / 실패 항목 {len(fail)}건","",
       "성공:", *[f"- {x['title']}: {x['note']}" for x in ok], "",
       "실패:", *[f"- {x['title']}: {x['note']}" for x in fail]]
(ROOT/"다운로드_결과.txt").write_text("\n".join(lines),encoding="utf-8")
