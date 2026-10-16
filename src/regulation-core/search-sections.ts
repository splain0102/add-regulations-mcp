import {deletedSection} from './search-ranking';
// Only whole-corpus search uses these offsets; parser identity stays unchanged.
export type SearchSections={version:1;textLength:number;bounds:number[];excluded?:number[]};
export function prepareSearchSections(text:string):SearchSections {
 const headings=[...text.matchAll(/(?:^|\n)[ \t]*(?:제\s*\d+\s*조(?:의\s*\d+)?(?:\s*\([^\n)]*\))?|부\s*칙(?:\s*<[^\n>]+>)?|\[(?:별표|별지)\s*(?:제\s*)?\d+(?:-\d+)?\s*(?:호)?[^\]\n]*\][^\n]*)/g)].map(m=>m.index??0);
 const bounds=[...new Set([0,...headings,text.length])].sort((a,b)=>a-b);
 return {version:1,textLength:text.length,bounds,excluded:bounds.slice(0,-1).filter((at,i)=>deletedSection(text.slice(at,bounds[i+1])))};
}
export function searchBounds(text:string,sections?:SearchSections){
 const b=sections?.bounds;
 // Old or malformed records fall back to the original heading algorithm.
 if(sections?.version===1&&sections.textLength===text.length&&Array.isArray(b)&&b[0]===0&&b[b.length-1]===text.length&&b.every((v,i)=>Number.isInteger(v)&&v>=0&&v<=text.length&&(i===0||v>b[i-1])))return b;
 return prepareSearchSections(text).bounds;
}
// Undated 부칙 that stack one enforcement line per amendment:
//   이 방침은 2016년 1월 12일부터 시행한다.
//   이 방침은 2025년 4월 8일부터 시행한다.   ← current
// Returns the last such line of the block starting at `from` (null unless 2+ lines).
export function lastStackedEffective(text:string,from:number){
 const block=text.slice(from,from+4000),end=block.slice(1).search(/\n\s*(?:[<\[〈]\s*별\s*[표지]|부\s*칙)/),win=end>=0?block.slice(0,end+1):block;
 const lines=[...win.matchAll(/^[ \t]*이[ \t]*[^\n]{0,24}?[은는][ \t]*(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일\s*부터\s*시행한다/gm)];
 return lines.length>1?lines.at(-1)!:null;
}
// Articles inside a supplementary provision carry its date, e.g.
// "부칙(2026.9.28.) 제2조(경과조치)"; the block itself shows its number and date.
export function supplementLabels(text:string,bounds:number[]){
 const labels=new Map<number,string>();let date:string|null=null,prefix='부칙',inside=false;
 for(let i=0;i<bounds.length-1;i++){let a=bounds[i];while(a<bounds[i+1]&&/\s/.test(text[a]))a++;const nl=text.indexOf('\n',a),first=text.slice(a,nl<0||nl>bounds[i+1]?bounds[i+1]:nl).trim();
  const head=first.match(/^부\s*칙\s*(?:[<〈(]\s*([^>〉)]*)[>〉)])?/);
  if(head){inside=true;const inner=(head[1]??'').trim(),d=inner.match(/(\d{4})\s*\.\s*(\d{1,2})\s*\.\s*(\d{1,2})\s*\.?/),no=inner.replace(d?.[0]??'','').replace(/[,，\s]+$/,'').trim();date=d?`${d[1]}.${Number(d[2])}.${Number(d[3])}.`:null;// An undated block is named by its 시행일, which often sits in its first article.
  // A block that lists one "이 방침은 …부터 시행한다" line per amendment is named by the last (current) one.
  const effective=d?null:lastStackedEffective(text,bounds[i])??text.slice(bounds[i],Math.min(bounds[i+2]??text.length,bounds[i]+600)).match(/(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일\s*부터\s*시행/);prefix=date?`부칙(${date})`:effective?`부칙(시행 ${effective[1]}.${Number(effective[2])}.${Number(effective[3])}.)`:'부칙';labels.set(bounds[i],date?`부칙(${no?no+', ':''}${date})`:prefix);continue;}
  if(/^\[?\s*별\s*[표지]|서식/.test(first))inside=false;
  else if(inside&&/^제\s*\d+\s*조/.test(first))labels.set(bounds[i],`${prefix} ${first.match(/^제\s*\d+\s*조(?:의\s*\d+)?(?:\s*\([^)\n]*\))?/)![0]}`);
 }
 return labels;
}
