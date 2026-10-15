import {searchBounds,supplementLabels} from '../regulation-core/search-sections';
import {normalizeName} from '../d1/normalize';
import {deletedSection,fold,tokenWeights,wordsWeight,sectionScore} from '../regulation-core/search-ranking';
import {extractArticleSnippet} from '../regulation-core/article-snippet';

type Section={at:number;label:string;labelFolded:string;text:string;folded:string;compact?:string;words?:string[];skip:boolean};
type Prepared={sections:Section[];title:string};
// Body shard objects are immutable and cached by R2Reader, so their section split,
// labels and folded text are computed once per isolate, not once per query.
const prepared=new WeakMap<object,Prepared>();
const LABEL=/^\s*(제\s*\d+\s*조(?:의\s*\d+)?(?:\s*\([^\n)]*\))?|부\s*칙(?:\s*<[^\n>]+>)?|\[(?:별표|별지)[^\]\n]*\])/;
const squeeze=(s:string)=>s.replace(/[\s,]+/g,'');
export function prepareDocument(doc:any):Prepared{
 let p=prepared.get(doc);if(p)return p;
 const content=String(doc.text??''),bounds=searchBounds(content,doc.searchSections),supplements=supplementLabels(content,bounds),excluded=bounds===doc.searchSections?.bounds?doc.searchSections.excluded??[]:[],sections:Section[]=[];
 for(let i=0;i<bounds.length-1;i++){const text=content.slice(bounds[i],bounds[i+1]),folded=fold(text),label=supplements.get(bounds[i])??text.match(LABEL)?.[1]??extractArticleSnippet(text,0,0,true).label;
  sections.push({at:bounds[i],text,folded,label,labelFolded:fold(label),skip:excluded.includes(bounds[i])||deletedSection(text)});}
 p={sections,title:normalizeName(String(doc.title??''))};prepared.set(doc,p);return p;
}
const meta=(doc:any)=>({regulationName:doc.title,reg_id:doc.regulation_id,fileNo:doc.fileNo,revisionDate:doc.revisionDate,updatedDate:doc.updatedDate,sourceUrl:doc.sourceUrl,indexedAt:doc.verifiedAt,sha256:doc.sha256});
// Amount and number terms ("300만원", "10억") ignore spacing and commas.
const hasNumber=(t:string)=>/\d/.test(t);
// The squeezed copy is made only for number terms, keeping the cached corpus small.
const folds=new Map<string,string>(),folded=(t:string)=>{let f=folds.get(t);if(f===undefined){f=fold(t);if(folds.size>256)folds.clear();folds.set(t,f);}return f;};
function present(s:Section,t:string){return hasNumber(t)?(s.compact??=squeeze(s.folded)).includes(squeeze(folded(t))):s.folded.includes(folded(t));}
// Word split is cached per section; the weight rule is tokenWeights' own.
function weightsFor(s:Section,terms:string[]){return terms.map(t=>hasNumber(t)?(present(s,t)?1:0):wordsWeight(s.words??=s.folded.match(/[\p{L}\p{N}]+/gu)??[],t));}
function rank(found:any[]){return Math.max(...found.map(m=>m.score))+0.1*found.map(m=>m.score).sort((a,b)=>b-a).slice(0,3).reduce((sum,n)=>sum+n,0);}

// Identical word-boundary, deleted-article and form ranking rules to the
// production corpus search. Only the source of the pre-parsed documents differs.
export function searchBodies(docs:any[],query:string){
 const terms=query.toLowerCase().trim().split(/\s+/).filter(Boolean),results:any[]=[],nameQuery=normalizeName(query);
 if(terms.length)for(const doc of docs){const p=prepareDocument(doc),found:any[]=[];
  for(const s of p.sections){if(s.skip||!terms.every(t=>s.folded.includes(fold(t))))continue;const weights=tokenWeights(s.text,terms);if(weights.some(w=>!w))continue;
   const at=Math.max(0,s.text.toLowerCase().indexOf(terms[0]));found.push({label:s.label,snippet:extractArticleSnippet(s.text,at,query.length,true).snippet,score:sectionScore(s.text,s.label,query,weights)});}
  // A regulation whose name contains the query ranks ahead of passing mentions.
  const titleBonus=nameQuery.length>=2&&p.title.includes(nameQuery)?30:0;
  if(found.length)results.push({...meta(doc),score:titleBonus+rank(found),matches:found.sort((a,b)=>b.score-a.score).slice(0,3)});
 }
 return results.sort((a,b)=>b.score-a.score||b.matches[0].score-a.matches[0].score||a.regulationName.localeCompare(b.regulationName,'ko'));
}

// The paragraph (①②…) holding most query terms, so the snippet shows the
// actual rule (e.g. 제9조⑤ "잔액은 개인에게 지급") instead of the article's opening.
export function paragraphSnippet(s:Section,terms:string[],max=700){
 const parts=s.text.split(/(?=[①-⑳])/);
 if(parts.length<2){const lower=s.text.toLowerCase(),at=Math.max(0,...terms.map(t=>lower.indexOf(t.toLowerCase())).filter(n=>n>=0).slice(0,1));return {snippet:extractArticleSnippet(s.text,at,terms[0]?.length??0,true).snippet,paragraph:null};}
 let best=parts[0],bestScore=-1;for(const part of parts){const sec={...s,text:part,folded:fold(part),compact:undefined,words:undefined},hits=terms.filter(t=>present(sec,t)).length,score=hits*10+weightsFor(sec,terms).reduce((a,b)=>a+b,0);if(score>bestScore){best=part;bestScore=score;}}
 const symbol=/^[①-⑳]/.test(best)?best[0]:null,body=best.trim();
 return {snippet:(symbol&&best!==parts[0]?`${s.label} … ${body}`:body).slice(0,max),paragraph:symbol};
}

// Question words that name the kind of answer rather than its content.
const INTENT:Record<string,string>={승인권자:'approver',결재권자:'approver',전결권자:'approver',전결:'approver',승인권:'approver',결재권:'approver'};
const SUFFIXES=['권자','비용','비','금','액','료'];
export type Unified={results:any[];related:any[];coverage:{terms:string[];resolved:Record<string,string>;ignored:string[];missing:string[]};intent:string|null};

// One call: full matches (every term in one article, or terms naming the
// regulation plus the rest in its article), then — only when no article covers
// every term — the best article per term, then citation-linked articles.
export function unifiedSearch(docs:any[],query:string,limit=5):Unified{
 const raw=query.toLowerCase().trim().split(/\s+/).filter(Boolean),intents=raw.filter(t=>INTENT[t]);
 let terms=raw.filter(t=>!INTENT[t]);if(!terms.length)terms=raw;
 const preparedDocs=docs.map(d=>({doc:d,p:prepareDocument(d)})),resolved:Record<string,string>={};
 // A compound absent from every regulation falls back to its stem ("국외출장비" → "국외출장").
 terms=terms.map(t=>{if(hasNumber(t)||preparedDocs.some(({p})=>p.sections.some(s=>s.folded.includes(t))))return t;
  for(const suffix of SUFFIXES)if(t.endsWith(suffix)&&Array.from(t).length-Array.from(suffix).length>=2){const stem=t.slice(0,-suffix.length);if(preparedDocs.some(({p})=>p.sections.some(s=>s.folded.includes(stem)))){resolved[t]=stem;return stem;}}
  return t;});
 const full:any[]=[],nameQuery=normalizeName(terms.join(''));
 for(const {doc,p} of preparedDocs){
  // Terms that name this regulation ("직제" in 직제규정) need not repeat in the article.
  const titleTerms=terms.length>1?terms.filter(t=>!hasNumber(t)&&p.title.includes(normalizeName(t))):[],bodyTerms=titleTerms.length&&titleTerms.length<terms.length?terms.filter(t=>!titleTerms.includes(t)):terms,routed=bodyTerms!==terms,found:any[]=[];
  for(const s of p.sections){if(s.skip||!bodyTerms.every(t=>present(s,t)))continue;const weights=weightsFor(s,bodyTerms);if(weights.some(w=>!w))continue;
   const {snippet,paragraph}=paragraphSnippet(s,bodyTerms);found.push({label:s.label,...paragraph?{paragraph}:{},snippet,score:sectionScore(s.text,s.label,bodyTerms.join(' '),weights)});}
  if(!found.length)continue;
  const bonus=(nameQuery.length>=2&&p.title.includes(nameQuery)?30:0)+(routed?20*titleTerms.length:0);
  full.push({...meta(doc),score:Math.round((bonus+rank(found))*100)/100,match_type:'full',matched_terms:terms,...routed?{title_terms:titleTerms}:{},matches:found.sort((a,b)=>b.score-a.score).slice(0,3)});
 }
 full.sort((a,b)=>b.score-a.score||b.matches[0].score-a.matches[0].score||a.regulationName.localeCompare(b.regulationName,'ko'));
 const partial:any[]=[];
 if(!full.length&&terms.length>1){
  // Each term's strongest article. Only headings, regulation names or rare terms
  // qualify, so a word that merely occurs somewhere is not presented as the answer.
  for(const t of terms){const candidates:any[]=[],docsWith=preparedDocs.filter(({p})=>p.sections.some(s=>present(s,t))).length;
   for(const {doc,p} of preparedDocs){let best:any;const inTitle=p.title.includes(normalizeName(t)),ft=folded(t);for(const s of p.sections){if(s.skip)continue;const inLabel=s.labelFolded.includes(ft);if(!inLabel&&!inTitle&&docsWith>5||!present(s,t))continue;const [w]=weightsFor(s,[t]);if(!w)continue;
     const cheap=3*w+(inLabel?10:0);if(!best||cheap>best.cheap)best={s,cheap,w,inLabel};}
    // Form/annex down-weighting (sectionScore) only for this document's best candidate.
    if(best)best.score=sectionScore(best.s.text,best.s.label,t,[best.w])+(best.inLabel?10:0)+(inTitle?8:0);
    if(best){const {snippet,paragraph}=paragraphSnippet(best.s,[t]);candidates.push({...meta(doc),score:Math.round(best.score*50)/100,match_type:'partial',matched_terms:[t],missing_terms:terms.filter(x=>x!==t),matches:[{label:best.s.label,...paragraph?{paragraph}:{},snippet,score:best.score}]});}}
   partial.push(...candidates.sort((a,b)=>b.score-a.score).slice(0,2));}
 }
 const results=[...full,...partial.filter((r,i,a)=>a.findIndex(x=>x.reg_id===r.reg_id&&x.matches[0].label===r.matches[0].label)===i)];
 const covered=new Set(results.slice(0,limit).flatMap(r=>[...r.matched_terms,...r.title_terms??[]]));
 return {results,related:relatedArticles(preparedDocs,results.slice(0,limit),terms),coverage:{terms,resolved,ignored:intents,missing:terms.filter(t=>!covered.has(t))},intent:intents.length?INTENT[intents[0]]:null};
}

// Explicit citations recorded at build time (「규정명」 [제N조]) between a result
// article and other regulations, in both directions. Shared words alone never
// create a link here.
function relatedArticles(preparedDocs:{doc:any;p:Prepared}[],results:any[],terms:string[]){
 const byId=new Map(preparedDocs.map(x=>[x.doc.regulation_id,x])),shown=new Set(results.flatMap(r=>r.matches.map((m:any)=>r.reg_id+'\0'+m.label))),out:any[]=[];
 const pick=(target:{doc:any;p:Prepared},article:string|null)=>{const sections=target.p.sections.filter(s=>!s.skip);if(article){const s=sections.find(x=>x.labelFolded.replace(/\s/g,'').startsWith(article.replace(/\s/g,'')));if(s)return s;}
  let best:Section|undefined,score=0;for(const s of sections){const n=weightsFor(s,terms).filter(Boolean).length;if(n>score){best=s;score=n;}}return best;};
 const push=(target:{doc:any;p:Prepared},s:Section|undefined,relation:any)=>{if(!s||out.length>=5||shown.has(target.doc.regulation_id+'\0'+s.label))return;shown.add(target.doc.regulation_id+'\0'+s.label);const {snippet,paragraph}=paragraphSnippet(s,terms,300);out.push({...meta(target.doc),label:s.label,...paragraph?{paragraph}:{},snippet,relation});};
 for(const r of results){const source=byId.get(r.reg_id);if(!source)continue;const labels=new Set(r.matches.map((m:any)=>m.label));
  for(const c of source.doc.citations??[]){if(!labels.has(c.label))continue;const target=byId.get(c.to);if(target)push(target,pick(target,c.article),{type:'citation',confidence:c.article?'high':'medium',from:`${r.regulationName} ${c.label}`,evidence:c.evidence});}
  for(const other of preparedDocs){if(other.doc.regulation_id===r.reg_id)continue;for(const c of other.doc.citations??[]){if(c.to!==r.reg_id)continue;const s=other.p.sections.find(x=>x.label===c.label);if(s&&weightsFor(s,terms).some(Boolean))push(other,s,{type:'cited_by',confidence:'medium',from:`${other.doc.title} ${c.label}`,evidence:c.evidence});}}}
 return out;
}

// Build-time citation extraction: 「…」/｢…｣ naming another regulation in the
// catalog (exact normalized title or alias), with an optional article number.
export function extractCitations(doc:any,titles:Map<string,{reg_id:string;title:string}>){
 const p=prepareDocument(doc),out:any[]=[];
 for(const s of p.sections){if(s.skip)continue;for(const m of s.text.matchAll(/[「｢『]([^」｣』\n]{2,60})[」｣』](\s*제\s*\d+\s*조(?:의\s*\d+)?)?/g)){const hit=titles.get(normalizeName(m[1]));if(!hit||hit.reg_id===doc.regulation_id)continue;const article=m[2]?m[2].replace(/\s/g,''):null;
  if(!out.some(c=>c.label===s.label&&c.to===hit.reg_id&&c.article===article))out.push({label:s.label,to:hit.reg_id,to_title:hit.title,article,evidence:m[0].trim().slice(0,80)});}}
 return out;
}
