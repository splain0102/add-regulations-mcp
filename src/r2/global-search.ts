import {searchBounds,supplementLabels} from '../regulation-core/search-sections';
import {normalizeName} from '../d1/normalize';
import {deletedSection,fold,tokenWeights,sectionScore} from '../regulation-core/search-ranking';
import {extractArticleSnippet} from '../regulation-core/article-snippet';
// Identical word-boundary, deleted-article and form ranking rules to the
// production corpus search. Only the source of the pre-parsed documents differs.
export function searchBodies(docs:any[],query:string){
 const terms=query.toLowerCase().trim().split(/\s+/).filter(Boolean),results:any[]=[];
 const nameQuery=normalizeName(query);
 if(terms.length)for(const doc of docs){const content=doc.text,bounds=searchBounds(content,doc.searchSections),supplements=supplementLabels(content,bounds),found:any[]=[];
  for(let i=0;i<bounds.length-1;i++){
   const article=content.slice(bounds[i],bounds[i+1]),part=article.toLowerCase();
   if(bounds===doc.searchSections?.bounds&&doc.searchSections.excluded?.includes(bounds[i])||deletedSection(article))continue;
   const folded=fold(article);if(!terms.every(t=>folded.includes(fold(t))))continue;
   const weights=tokenWeights(article,terms);if(weights.some(w=>!w))continue;
   const at=Math.max(0,part.indexOf(terms[0])),snippet=extractArticleSnippet(article,at,query.length,true);
   const label=supplements.get(bounds[i])??article.match(/^\s*(제\s*\d+\s*조(?:의\s*\d+)?(?:\s*\([^\n)]*\))?|부\s*칙(?:\s*<[^\n>]+>)?|\[(?:별표|별지)[^\]\n]*\])/)?.[1]??snippet.label;
   found.push({label,snippet:snippet.snippet,score:sectionScore(article,label,query,weights)});
  }
  // A regulation whose name contains the query ranks ahead of passing mentions.
  const titleBonus=nameQuery.length>=2&&normalizeName(doc.title).includes(nameQuery)?30:0;
  if(found.length)results.push({regulationName:doc.title,reg_id:doc.regulation_id,fileNo:doc.fileNo,revisionDate:doc.revisionDate,updatedDate:doc.updatedDate,sourceUrl:doc.sourceUrl,indexedAt:doc.verifiedAt,sha256:doc.sha256,score:titleBonus+Math.max(...found.map(m=>m.score))+0.1*found.map(m=>m.score).sort((a,b)=>b-a).slice(0,3).reduce((sum,n)=>sum+n,0),matches:found.sort((a,b)=>b.score-a.score).slice(0,3)});
 }
 return results.sort((a,b)=>b.score-a.score||b.matches[0].score-a.matches[0].score||a.regulationName.localeCompare(b.regulationName,'ko'));
}
