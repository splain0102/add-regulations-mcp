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
