#!/usr/bin/env python3
import requests, re, hashlib, json, time
from pathlib import Path
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

BASE="https://alio.go.kr"; DISC="2026041303151943"
ROOT=Path("external_audit_c0345"); ROOT.mkdir(exist_ok=True)
s=requests.Session()
retry=Retry(total=5,connect=5,read=5,status=4,backoff_factor=1,status_forcelist=[429,500,502,503,504,522],allowed_methods=frozenset(["GET"]))
s.mount("https://",HTTPAdapter(max_retries=retry))
s.headers.update({"User-Agent":"Mozilla/5.0 Chrome/140 Safari/537.36","Referer":f"{BASE}/mobile/item/itemReportTerm.do?apbaId=C0345&reportFormRootNo=32301"})
# Warm session and verify page identity.
for a in range(4):
    try:
        r=s.get(f"{BASE}/mobile/item/itemReportTerm.do",params={"apbaId":"C0345","reportFormRootNo":"32301"},timeout=(8,25))
        if r.ok and "국방과학연구소" in r.text and DISC in r.text: break
    except Exception: pass
    time.sleep(a+1)
names={101:"회계감사보고서(2025).zip",102:"회계감사보고서(2024).zip",103:"회계감사보고서(2023).zip",104:"회계감사보고서(2022).zip",105:"회계감사보고서(2021).zip"}
out=[]
for fno,name in names.items():
    try:
        r=s.get(f"{BASE}/download/file.json",params={"f":fno,"d":DISC},timeout=(8,90),allow_redirects=True)
        if not r.ok or len(r.content)<1000 or r.content[:2]!=b"PK":
            raise RuntimeError(f"HTTP={r.status_code}, bytes={len(r.content)}, head={r.content[:20]!r}")
        p=ROOT/name; p.write_bytes(r.content)
        h=hashlib.sha256(r.content).hexdigest()
        out.append({"fileNo":fno,"name":name,"size":len(r.content),"sha256":h,"status":"ok"})
        print(json.dumps(out[-1],ensure_ascii=False))
    except Exception as e:
        out.append({"fileNo":fno,"name":name,"status":"fail","error":repr(e)})
        print(json.dumps(out[-1],ensure_ascii=False))
(ROOT/"manifest.json").write_text(json.dumps({"institution":"국방과학연구소","apbaId":"C0345","disclosureNo":DISC,"files":out},ensure_ascii=False,indent=2),encoding="utf-8")
