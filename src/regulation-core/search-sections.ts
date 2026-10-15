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
// Articles inside a supplementary provision carry its date, e.g.
// "부칙(2026.9.28.) 제2조(경과조치)"; the block itself shows its number and date.
export function supplementLabels(text:string,bounds:number[]){
 const labels=new Map<number,string>();let date:string|null=null,inside=false;
 for(let i=0;i<bounds.length-1;i++){let a=bounds[i];while(a<bounds[i+1]&&/\s/.test(text[a]))a++;const nl=text.indexOf('\n',a),first=text.slice(a,nl<0||nl>bounds[i+1]?bounds[i+1]:nl).trim();
  const head=first.match(/^부\s*칙\s*(?:[<〈(]\s*([^>〉)]*)[>〉)])?/);
  if(head){inside=true;const inner=(head[1]??'').trim(),d=inner.match(/(\d{4})\s*\.\s*(\d{1,2})\s*\.\s*(\d{1,2})\s*\.?/),no=inner.replace(d?.[0]??'','').replace(/[,，\s]+$/,'').trim();date=d?`${d[1]}.${Number(d[2])}.${Number(d[3])}.`:null;const effective=d?null:text.slice(bounds[i],Math.min(bounds[i+1],bounds[i]+400)).match(/(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일\s*부터\s*시행/);labels.set(bounds[i],date?`부칙(${no?no+', ':''}${date})`:effective?`부칙(시행 ${effective[1]}.${Number(effective[2])}.${Number(effective[3])}.)`:'부칙');continue;}
  if(/^\[?\s*별\s*[표지]|서식/.test(first))inside=false;
  else if(inside&&/^제\s*\d+\s*조/.test(first))labels.set(bounds[i],`${date?`부칙(${date})`:'부칙'} ${first.match(/^제\s*\d+\s*조(?:의\s*\d+)?(?:\s*\([^)\n]*\))?/)![0]}`);
 }
 return labels;
}
