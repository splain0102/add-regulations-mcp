#!/usr/bin/env python3
from pathlib import Path
import base64, json, time, hashlib
from selenium import webdriver
from selenium.webdriver.chrome.options import Options

ROOT=Path("add_page_snapshots"); ROOT.mkdir(exist_ok=True)
pages=[
 ("ADD_사업실명제.pdf","https://www.add.re.kr/board?menuId=MENU02538&siteId=SITE00002"),
 ("ADD_정보목록.pdf","https://www.add.re.kr/kps/infoOpen/infoOpenList?menuId=MENU02244"),
 ("ADD_조직도.pdf","https://www.add.re.kr/board?menuId=MENU02031&siteId=SITE00002"),
]
o=Options(); o.add_argument("--headless=new"); o.add_argument("--no-sandbox"); o.add_argument("--disable-dev-shm-usage"); o.add_argument("--disable-gpu")
d=webdriver.Chrome(options=o)
manifest=[]
for fn,url in pages:
    d.get(url); time.sleep(3)
    pdf=d.execute_cdp_cmd("Page.printToPDF",{"printBackground":True,"preferCSSPageSize":True})
    data=base64.b64decode(pdf["data"]); p=ROOT/fn; p.write_bytes(data)
    manifest.append({"file":fn,"url":url,"size":len(data),"sha256":hashlib.sha256(data).hexdigest()})
    print(manifest[-1])
d.quit()
(ROOT/"manifest.json").write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding="utf-8")
