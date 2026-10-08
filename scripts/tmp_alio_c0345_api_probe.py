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
    r=s.post(BASE+"/item/itemReportListSusi.json",data=data,timeout=30)
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
