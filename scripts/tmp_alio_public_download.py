#!/usr/bin/env python3
import os, re, time, json, hashlib, shutil, subprocess, sys
from pathlib import Path
from urllib.parse import urljoin, unquote
import requests

ROOT = Path("alio_public_files")
ROOT.mkdir(exist_ok=True)
LOG = []
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36"

def safe(s):
    s = re.sub(r'[\\/:*?"<>|]+', '_', s).strip()
    return s[:140] or "file"

def sha256(path):
    h=hashlib.sha256()
    with open(path,'rb') as f:
        for b in iter(lambda:f.read(1024*1024), b''): h.update(b)
    return h.hexdigest()

def record(kind,title,url,path=None,status="ok",note=""):
    x={"kind":kind,"title":title,"url":url,"status":status,"note":note}
    if path and Path(path).exists():
        p=Path(path)
        x.update({"path":str(p),"size":p.stat().st_size,"sha256":sha256(p)})
    LOG.append(x)
    print(json.dumps(x,ensure_ascii=False), flush=True)

sess=requests.Session()
sess.headers.update({"User-Agent":UA,"Accept":"*/*","Referer":"https://www.alio.go.kr/"})

def requests_download(url, outdir, suggested=None, kind="web", title=""):
    outdir=Path(outdir); outdir.mkdir(parents=True,exist_ok=True)
    try:
        r=sess.get(url,timeout=40,allow_redirects=True)
        ct=(r.headers.get("content-type") or "").lower()
        cd=r.headers.get("content-disposition") or ""
        if r.status_code!=200 or len(r.content)<100:
            record(kind,title,url,status="fail",note=f"HTTP {r.status_code} {ct} bytes={len(r.content)}")
            return None
        fname=None
        m=re.search(r"filename\\*=UTF-8''([^;]+)",cd,re.I)
        if m: fname=unquote(m.group(1))
        if not fname:
            m=re.search(r'filename="?([^";]+)"?',cd,re.I)
            if m: fname=unquote(m.group(1))
        if not fname: fname=suggested
        if not fname:
            # infer extension
            ext=".bin"
            if "pdf" in ct or r.content[:4]==b"%PDF": ext=".pdf"
            elif r.content[:8]==bytes.fromhex("d0cf11e0a1b11ae1"): ext=".hwp"
            elif "html" in ct: ext=".html"
            fname=safe(title or "download")+ext
        p=outdir/safe(fname)
        p.write_bytes(r.content)
        record(kind,title,url,p,note=f"{ct}; {cd}")
        return p
    except Exception as e:
        record(kind,title,url,status="fail",note=repr(e))
        return None

# 1) Exact ALIO regulation attachments (original binary)
regulations = [
 ("이사회운영규정","164732","이사회운영규정(2022년도 12월 개정).pdf"),
 ("감사규정","214802","감사규정(2025년도 4월 9일 개정).hwp"),
 ("감사요령","214803","감사요령(2025년도 4월 9일 개정).hwp"),
 ("회계규정","164739","회계규정(2022년도 12월 개정).pdf"),
 ("정보화업무규정","166853","정보화업무규정(2023년 2월 개정).pdf"),
 ("성과연봉제 운영요령","199578","성과연봉제 운영요령(2024년도 6월 개정).hwp"),
 ("직제규정","209393","직제규정(2024년도 12월 개정).hwp"),
]
for title,fileNo,fname in regulations:
    url=f"https://www.alio.go.kr/download/rulefiledown.json?fileNo={fileNo}"
    p=requests_download(url,ROOT/"01_내부규정_원본",fname,"alio_rule",title)
    # fallback with non-www
    if p is None:
        requests_download(url.replace("www.alio.go.kr","alio.go.kr"),ROOT/"01_내부규정_원본",fname,"alio_rule",title)

# 2) ICI public PDFs (original files)
for title,url in [
 ("ICI_Internal_Control_Certificate_2026.pdf","https://icikorea.kr/brochure/ICIK_2026.pdf"),
 ("ICI_Brochure_Main.pdf","https://icikorea.kr/brochure/ICIK_BROCHURE_MAIN.pdf"),
]:
    requests_download(url,ROOT/"02_ICI_공개자료",title,"public_pdf",title)

# Selenium browser for dynamic ALIO attachments
try:
    from selenium import webdriver
    from selenium.webdriver.common.by import By
    from selenium.webdriver.chrome.options import Options
    from selenium.webdriver.support.ui import WebDriverWait
    from selenium.webdriver.support import expected_conditions as EC
except Exception as e:
    print("selenium import failed",e)
    sys.exit(0)

dl = (Path.cwd()/ROOT/"_browser_downloads").resolve()
dl.mkdir(parents=True,exist_ok=True)
opts=Options()
opts.add_argument("--headless=new")
opts.add_argument("--no-sandbox")
opts.add_argument("--disable-dev-shm-usage")
opts.add_argument("--disable-gpu")
opts.add_argument(f"--user-agent={UA}")
opts.add_experimental_option("prefs",{
 "download.default_directory":str(dl),
 "download.prompt_for_download":False,
 "download.directory_upgrade":True,
 "safebrowsing.enabled":True,
 "plugins.always_open_pdf_externally":True
})
driver=webdriver.Chrome(options=opts)
driver.execute_cdp_cmd("Page.setDownloadBehavior", {"behavior":"allow","downloadPath":str(dl)})
wait=WebDriverWait(driver,20)

def sync_cookies():
    sess.cookies.clear()
    for c in driver.get_cookies():
        try: sess.cookies.set(c["name"],c["value"],domain=c.get("domain"))
        except: pass

def files_snapshot():
    return {p.name for p in dl.iterdir() if p.is_file() and not p.name.endswith(".crdownload")}

def wait_download(before, timeout=6):
    end=time.time()+timeout
    while time.time()<end:
        partial=list(dl.glob("*.crdownload"))
        now=files_snapshot()
        new=now-before
        if new and not partial:
            return sorted(new)
        time.sleep(.5)
    return sorted(files_snapshot()-before)

def move_new(names,outdir,prefix):
    outdir=Path(outdir); outdir.mkdir(parents=True,exist_ok=True)
    moved=[]
    for n in names:
        s=dl/n
        if not s.exists(): continue
        dst=outdir/(safe(prefix)+"__"+safe(n))
        i=1
        while dst.exists():
            dst=outdir/(safe(prefix)+f"__{i}__"+safe(n)); i+=1
        shutil.move(str(s),str(dst))
        moved.append(dst)
        record("alio_attachment",prefix,driver.current_url,dst,note="browser download")
    return moved

def likely_download(el):
    try:
        txt=(el.text or "")+" "+(el.get_attribute("aria-label") or "")+" "+(el.get_attribute("title") or "")
        href=el.get_attribute("href") or ""
        onclick=el.get_attribute("onclick") or ""
        blob=(txt+" "+href+" "+onclick).lower()
        return any(k in blob for k in ["다운로드","첨부","pdf","hwp","hwpx","filedown","download","파일"])
    except: return False

def process_item(list_url,title,outdir):
    outdir=Path(outdir); outdir.mkdir(parents=True,exist_ok=True)
    try:
        driver.get(list_url); time.sleep(2)
        # save rendered DOM for diagnostics
        (ROOT/"_diagnostics").mkdir(exist_ok=True)
        # find exact or contains text
        els=driver.find_elements(By.XPATH, f"//*[normalize-space(text())={json.dumps(title,ensure_ascii=False)}]")
        if not els:
            els=driver.find_elements(By.XPATH, f"//*[contains(normalize-space(.), {json.dumps(title,ensure_ascii=False)})]")
        if not els:
            record("alio_item",title,list_url,status="fail",note="title element not found")
            return
        el=els[0]
        clickable=el
        for xp in ["./ancestor-or-self::a[1]","./ancestor-or-self::button[1]","./ancestor-or-self::*[@onclick][1]"]:
            found=el.find_elements(By.XPATH,xp)
            if found: clickable=found[0]; break
        old_handles=set(driver.window_handles)
        before=files_snapshot()
        try:
            driver.execute_script("arguments[0].scrollIntoView({block:'center'});", clickable)
            driver.execute_script("arguments[0].click();", clickable)
        except Exception:
            clickable.click()
        time.sleep(2)
        # Switch popup if opened
        new_handles=set(driver.window_handles)-old_handles
        if new_handles:
            driver.switch_to.window(list(new_handles)[0])
            time.sleep(2)
        # If title click itself downloaded file
        new=wait_download(before,3)
        if new:
            move_new(new,outdir,title)
            if new_handles:
                driver.close(); driver.switch_to.window(list(old_handles)[0])
            return
        # Save detail DOM
        html=driver.page_source
        (ROOT/"_diagnostics"/(safe(title)+".html")).write_text(html,encoding="utf-8")
        sync_cookies()
        # direct href candidates first
        candidates=[]
        for a in driver.find_elements(By.CSS_SELECTOR,"a[href]"):
            if likely_download(a):
                href=a.get_attribute("href") or ""
                if href.startswith("http"):
                    candidates.append((a,href))
        got=False
        seen=set()
        for a,href in candidates:
            if href in seen: continue
            seen.add(href)
            if not href.lower().startswith("javascript"):
                p=requests_download(href,outdir,None,"alio_attachment",title)
                if p and ("html" not in (p.suffix or "").lower()):
                    got=True
        # click candidate elements, letting browser catch downloads
        elems=driver.find_elements(By.CSS_SELECTOR,"a,button,input")
        for e in elems[:3]:
            if not likely_download(e): continue
            try:
                before=files_snapshot()
                driver.execute_script("arguments[0].click();",e)
                new=wait_download(before,2)
                if new:
                    move_new(new,outdir,title); got=True
            except Exception:
                pass
        if not got:
            # extract any fileNo / download urls from DOM, download via requests
            urls=set(re.findall(r"https?://[^\"'<> ]+(?:download|filedown)[^\"'<> ]*", html, re.I))
            for u in urls:
                u=u.replace("&amp;","&")
                if requests_download(u,outdir,None,"alio_attachment",title): got=True
            for fno in set(re.findall(r"fileNo[=:'\\\"]+\\s*(\\d+)", html, re.I)):
                u=f"https://www.alio.go.kr/download/rulefiledown.json?fileNo={fno}"
                if requests_download(u,outdir,None,"alio_attachment",title): got=True
        if not got:
            record("alio_item",title,driver.current_url,status="fail",note="detail opened but no downloadable attachment captured")
        if new_handles:
            driver.close(); driver.switch_to.window(list(old_handles)[0])
    except Exception as e:
        record("alio_item",title,list_url,status="fail",note=repr(e))
        try:
            if len(driver.window_handles)>1:
                driver.close(); driver.switch_to.window(driver.window_handles[0])
        except: pass

board_url="https://alio.go.kr/item/itemOrganList.do?apbaId=C0215&reportFormRootNo=43005"
board_titles=[
"2026년도 134차 이사회회의록","2026년도 133차 이사회회의록","2026년도 132차 이사회회의록",
"2025년도 131차 이사회회의록","2025년도 130차 이사회회의록","2025년도 129차 이사회회의록",
"2025년도 128차 이사회회의록","제127차 이사회 회의록","제126차 이사회 회의록","제125차 이사회 회의록"
]
for t in board_titles:
    process_item(board_url,t,ROOT/"03_ALIO_이사회_회의록_원본")

audit_url="https://alio.go.kr/item/itemOrganList.do?apbaId=C0542&reportFormRootNo=43006"
audit_titles=[
"2026년도 내부감사인의 감사보고서","2025년도 자체(정기)감사 결과","2025년 내부감사인의 감사보고서",
"2024년도 자체(정기)감사 결과","2024년 내부감사인의 감사보고서","2023년도 자체(정기)감사 결과",
"2023년 내부감사인의 감사보고서","2022년 내부감사인의 감사보고서","2021년도 자체(정기)감사 결과",
"2021년 내부감사인의 감사보고서"
]
for t in audit_titles:
    process_item(audit_url,t,ROOT/"04_ALIO_감사결과_원본")

# External accounting audit page: capture all downloadable elements
ext_url="https://www.alio.go.kr/mobile/item/itemReportTerm.do?apbaId=C0345&reportFormRootNo=32301"
try:
    driver.get(ext_url); time.sleep(4)
    html=driver.page_source
    (ROOT/"_diagnostics"/"external_audit_page.html").write_text(html,encoding="utf-8")
    sync_cookies()
    out=ROOT/"05_ALIO_외부회계감사_원본"; out.mkdir(exist_ok=True)
    seen=set(); got=False
    for a in driver.find_elements(By.CSS_SELECTOR,"a[href]"):
        if likely_download(a):
            href=a.get_attribute("href") or ""
            if href.startswith("http") and href not in seen:
                seen.add(href)
                if requests_download(href,out,None,"alio_external_audit","외부회계감사보고서"): got=True
    elems=driver.find_elements(By.CSS_SELECTOR,"a,button,input")
    for e in elems[:3]:
        if not likely_download(e): continue
        try:
            before=files_snapshot()
            driver.execute_script("arguments[0].click();",e)
            new=wait_download(before,2)
            if new: move_new(new,out,"외부회계감사보고서"); got=True
        except: pass
    if not got:
        record("alio_external_audit","외부회계감사보고서",ext_url,status="fail",note="no downloadable attachment captured")
except Exception as e:
    record("alio_external_audit","외부회계감사보고서",ext_url,status="fail",note=repr(e))

# Public ADD pages -> print-to-PDF as faithful snapshot (pages, not original attachment)
for title,url in [
 ("ADD_내부통제경영대상_공식보도자료","https://add.re.kr/board/view?boardStyle=&linkId=5774&menuId=MENU02226&pageNum=1&rowCnt=10&schText=&schType=0&upDown=0"),
 ("ADD_임무_비전_발전전략","https://www.add.re.kr/board?menuId=MENU02029&siteId=null"),
 ("ADD_ESG경영","https://www.add.re.kr/board?menuId=MENU03089&siteId=SITE00002"),
 ("ADD_경영공시","https://www.add.re.kr/board?menuId=MENU02537&siteId=SITE00002"),
]:
    try:
        driver.get(url); time.sleep(2)
        pdf=driver.execute_cdp_cmd("Page.printToPDF", {"printBackground":True,"preferCSSPageSize":True})
        import base64
        p=ROOT/"06_ADD_공개페이지_PDF"/(safe(title)+".pdf"); p.parent.mkdir(exist_ok=True)
        p.write_bytes(base64.b64decode(pdf["data"]))
        record("add_page_pdf",title,url,p,note="Chrome printToPDF snapshot")
    except Exception as e:
        record("add_page_pdf",title,url,status="fail",note=repr(e))

driver.quit()

# delete leftover partials
for p in dl.glob("*"):
    try: p.unlink()
    except: pass

# manifest + summary
(ROOT/"download_manifest.json").write_text(json.dumps(LOG,ensure_ascii=False,indent=2),encoding="utf-8")
ok=[x for x in LOG if x["status"]=="ok"]
fail=[x for x in LOG if x["status"]!="ok"]
summary = [
 f"성공 {len(ok)}건 / 실패 {len(fail)}건",
 "",
 "성공 파일:",
 *[f"- {x.get('title')}: {x.get('path')} ({x.get('size')} bytes)" for x in ok],
 "",
 "실패/추가확인:",
 *[f"- {x.get('title')}: {x.get('note')} | {x.get('url')}" for x in fail],
]
(ROOT/"다운로드_결과.txt").write_text("\\n".join(summary),encoding="utf-8")
