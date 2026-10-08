#!/usr/bin/env python3
import json,time,re
from pathlib import Path
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.chrome.options import Options

ROOT=Path("alio_discovery"); ROOT.mkdir(exist_ok=True)
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36"
opts=Options(); opts.add_argument("--headless=new"); opts.add_argument("--no-sandbox"); opts.add_argument("--disable-dev-shm-usage"); opts.add_argument(f"--user-agent={UA}")
driver=webdriver.Chrome(options=opts)
for typ,url in [
 ("board","https://alio.go.kr/item/itemOrganList.do?apbaId=C0345&reportFormRootNo=43005"),
 ("audit","https://alio.go.kr/item/itemOrganList.do?apbaId=C0345&reportFormRootNo=43006"),
]:
    driver.get(url); time.sleep(4)
    html=driver.page_source
    (ROOT/f"{typ}.html").write_text(html,encoding="utf-8")
    (ROOT/f"{typ}.txt").write_text(driver.find_element(By.TAG_NAME,"body").text,encoding="utf-8")
    items=[]
    for e in driver.find_elements(By.CSS_SELECTOR,"a,button"):
        try:
            txt=(e.text or "").strip()
            href=e.get_attribute("href") or ""
            onclick=e.get_attribute("onclick") or ""
            if txt and (("이사회" in txt) if typ=="board" else ("감사" in txt)):
                items.append({"text":txt,"tag":e.tag_name,"href":href,"onclick":onclick})
        except: pass
    (ROOT/f"{typ}_candidates.json").write_text(json.dumps(items,ensure_ascii=False,indent=2),encoding="utf-8")
    print("###",typ,"URL",driver.current_url)
    print("INSTITUTION?", "국방과학연구소" in html)
    print("CANDIDATES",json.dumps(items[:100],ensure_ascii=False))
driver.quit()
