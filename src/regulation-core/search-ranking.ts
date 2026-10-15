// Lightweight Korean word rules; no morphology service or runtime dependency.
export const fold=(s:string)=>s.normalize('NFKC').toLowerCase().replace(/[·ㆍ･‧]/g,'');
const suffix=/^(?:(?:을|를|이|가|은|는|의|에|로|으로|와|과|도|만|부터|까지|에게|께|보다|및|등|서){1,3}|보고(?:서)?(?:를|의|는|에)?|(?:하|되|받)[가-힣]*)$/;
export function wordWeight(word:string,term:string){
 return normalizedWeight(fold(word),fold(term));
}
// A term of four or more syllables may also open a compound word
// ("전문가활용" in "전문가활용경비") at a lower weight. Shorter terms stay strict
// so "사고" never matches "사고방식".
function normalizedWeight(word:string,term:string){let best=0;
 for(let at=word.indexOf(term);at>=0;at=word.indexOf(term,at+1)){
  const tail=word.slice(at+term.length);
  if(tail&&!suffix.test(tail)){if(at===0&&Array.from(term).length>=4)best=Math.max(best,0.5);continue;}
  best=Math.max(best,at===0?1:0.3);
 }return best;
}
export function tokenWeights(text:string,terms:string[]){
 const words=fold(text).match(/[\p{L}\p{N}]+/gu)??[];
 return terms.map(fold).map(term=>{let best=0;for(const word of words){best=Math.max(best,normalizedWeight(word,term));if(best===1)break;}return best;});
}
export function deletedSection(article:string){
 return /^\s*제\s*\d+\s*조(?:의\s*\d+)?(?:\s*\([^\n)]*\))?\s*[.(]?\s*삭제\s*20\d{2}\s*[.년]\s*\d{1,2}\s*[.월]\s*\d{1,2}\s*[.일]?\s*[).]?\s*$/u.test(article);
}
export function formSection(article:string,label:string){
 if(/서식|견본/.test(label)||label.startsWith('[')&&/서식|견본|신고서|신고처리부/.test(article.split('\n').map(s=>s.trim()).filter(Boolean).slice(0,2).join(' ')))return true;
 const fields=article.match(/성\s*명|소\s*속|연락처|주\s*소|년\s*월\s*일|\(\s*(?:인|서명)\s*\)/g)??[];
 const lines=article.split('\n').map(s=>s.trim()).filter(Boolean);
 const fieldLines=lines.filter(s=>/^(?:성\s*명|소\s*속|연락처|주\s*소|년\s*월\s*일|\(\s*(?:인|서명)\s*\))\s*[:：_()\s]*$/.test(s));
 return fields.length>=3&&fieldLines.length/Math.max(1,lines.length)>=0.12;
}
export function sectionScore(article:string,label:string,query:string,weights:number[]){
 const terms=query.trim().split(/\s+/).filter(Boolean),heading=tokenWeights(label,terms);
 // Count each query token once, regardless of repeated form rows.
 const phrase=fold(article).includes(fold(query))?10:0;
 const titleBonus=heading.every(w=>w>0)?16*Math.min(...heading):0;
 const base=phrase*Math.min(...weights)+weights.reduce((sum,w)=>sum+3*w,0)+titleBonus;
 return base*(formSection(article,label)?0.2:label.startsWith('[')?0.5:1);
}
