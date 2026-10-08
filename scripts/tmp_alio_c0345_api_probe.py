#!/usr/bin/env python3
import requests, json, re
from bs4 import BeautifulSoup

BASE="https://alio.go.kr"
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36"
s=requests.Session()
s.headers.update({"User-Agent":UA,"Accept":"application/json, text/plain, */*","X-Requested-With":"XMLHttpRequest","Referer":BASE+"/item/itemOrganList.do?apbaId=C0345&reportFormRootNo=43005"})

def fetch(root,page=1):
    s.get(f"{BASE}/item/itemOrganList.do?apbaId=C0345&reportFormRootNo={root}",timeout=30)
    data={
        "pageNo":str(page),
        "apbaId":"C0345",
        "apbaType":"A2005",
        "reportFormRootNo":root,
        "search_word":"",
        "search_flag":"title",
        "bid_type":"",
        "enfc_istt":"",
    }
    r=s.post(BASE+"/item/itemReportListSusi.json",json=data,timeout=30)
    print("ROOT",root,"PAGE",page,"STATUS",r.status_code,"CT",r.headers.get("content-type"))
    print(r.text[:12000])
    if r.ok:
        try:
            obj=r.json()
            print("KEYS",obj.keys())
            print("PAGEOBJ",obj.get("page"))
            for i,item in enumerate(obj.get("result") or []):
                print("ITEM",i,json.dumps(item,ensure_ascii=False)[:5000])
                if i>=1: break
        except Exception as e: print("JSONERR",repr(e))

fetch("43005",1)
fetch("43006",1)


# Detail-page attachment probe
for title, disc in [
    ("BOARD_PROBE","2024032902781963"),
    ("AUDIT_PROBE","2026071103214096"),
]:
    u=f"{BASE}/item/itemReport.do?seq={disc}&disclosureNo={disc}"
    rr=s.get(u,timeout=30)
    print("DETAIL",title,disc,"STATUS",rr.status_code,"LEN",len(rr.text),"URL",rr.url)
    print(rr.text[:25000])


js=s.get(BASE+"/resources/js/page/portal/downloadUtils.js?v=202109131",timeout=30).text
print("DOWNLOAD_JS_STATUS",len(js))
for key in ["downReportAttachFile","downItemReport","previewAjax"]:
    pos=js.find(key)
    print("JSKEY",key,"POS",pos)
    if pos>=0:
        print(js[max(0,pos-1500):pos+5000])
