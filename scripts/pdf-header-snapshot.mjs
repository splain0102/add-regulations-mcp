import { extractTextItems, getDocumentProxy } from "unpdf";
const res=await fetch("https://www.alio.go.kr/download/rulefiledown.json?fileNo=166852");
if(!res.ok) throw new Error("download "+res.status);
const pdf=await getDocumentProxy(new Uint8Array(await res.arrayBuffer()));
const out=await extractTextItems(pdf);
for (const p of [8,9,16,17,18]) {
  const items=out.items[p-1]??[];
  console.log("PAGE",p,"HEADER",JSON.stringify(items.filter(x=>x.y>=485&&x.y<=506)));
  console.log("PAGE",p,"CONTRACT",JSON.stringify(items.filter(x=>/계약|국정감사|중요사항/.test(x.str))));
}


const p17=out.items[16]??[];
console.log("PAGE17_HEADER_FULL",JSON.stringify(
  p17.filter(x=>x.str.trim() && x.y>=470 && x.y<=506 && x.x>=430)
));
