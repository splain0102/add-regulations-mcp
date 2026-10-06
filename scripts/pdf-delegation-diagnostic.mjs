import { extractTextItems, getDocumentProxy } from "unpdf";

const response = await fetch("https://www.alio.go.kr/download/rulefiledown.json?fileNo=166852");
if (!response.ok) throw new Error(String(response.status));
const bytes = new Uint8Array(await response.arrayBuffer());
const pdf = await getDocumentProxy(bytes);
const result = await extractTextItems(pdf);
for (let p = 0; p < result.items.length; p++) {
  const hits = result.items[p].filter((x) => /구\s*분|업무내용|사책|과책|운영|실장|센터장|부소장|소장|국정감사|계약승인|◎|★|☆/.test(x.str));
  if (hits.length) console.log("PAGE", p + 1, JSON.stringify(hits));
}
await pdf.destroy();