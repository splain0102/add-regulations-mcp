import { getDocumentProxy } from "unpdf";
const r=await fetch("https://www.alio.go.kr/download/rulefiledown.json?fileNo=166852");
if(!r.ok) throw new Error(String(r.status));
const pdf=await getDocumentProxy(new Uint8Array(await r.arrayBuffer()));
const page=await pdf.getPage(17);
const ops=await page.getOperatorList();
const counts=new Map();
const samples=new Map();
for(let i=0;i<ops.fnArray.length;i++){
  const fn=ops.fnArray[i];
  counts.set(fn,(counts.get(fn)??0)+1);
  if(!samples.has(fn)) samples.set(fn,[]);
  if(samples.get(fn).length<4) samples.get(fn).push(ops.argsArray[i]);
}
console.log("COUNTS",JSON.stringify([...counts.entries()].sort((a,b)=>b[1]-a[1])));
for(const [fn,args] of [...samples.entries()].sort((a,b)=>a[0]-b[0])){
  console.log("FN",fn,JSON.stringify(args).slice(0,5000));
}
