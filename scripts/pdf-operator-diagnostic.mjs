import { getDocumentProxy } from "unpdf";
const r=await fetch("https://www.alio.go.kr/download/rulefiledown.json?fileNo=166852");
if(!r.ok) throw new Error(String(r.status));
const pdf=await getDocumentProxy(new Uint8Array(await r.arrayBuffer()));
const page=await pdf.getPage(17);
const ops=await page.getOperatorList();
for(let i=0;i<ops.fnArray.length;i++){
  const s=JSON.stringify(ops.argsArray[i]);
  if(/사책|과책|운영|실장|센터|부소장|소장|국정감사/.test(s)){
    console.log("OP",i,ops.fnArray[i],s);
  }
}
