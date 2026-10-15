export function sectionAt(text:string, matchIndex:number) {
 const heading = /(?:^|\n)[ \t]*(\[(?:별표|별지)\s*제\s*\d+(?:-\d+)?\s*호\][^\n]*|제\s*\d+\s*조(?:의\s*\d+)?(?:\s*\([^\n)]*\))?|부\s*칙(?:\s*<[^\n>]+>)?)/g;
 const sections=[...text.matchAll(heading)].map(m=>({index:m.index??0,label:m[1].replace(/\s+/g,' ').trim()}));
 let current:typeof sections[number]|undefined,next=text.length;
 for(const section of sections){if(section.index<=matchIndex)current=section;else{next=section.index;break;}}
 return {label:current?.label??'관련 본문',start:current?.index??Math.max(0,text.lastIndexOf('\n',matchIndex)),end:next,id:current?.index??-1};
}
export function extractArticleSnippet(text:string,matchIndex:number,queryLength:number,compact=false){
 const section=sectionAt(text,matchIndex);
 const annex=/^\[(?:별표|별지)/.test(section.label);
 const cap=compact?850:2200;
 let from=section.start,to=section.end;
 if(annex||to-from>cap){
   from=Math.max(from,matchIndex-(compact?240:500));
   to=Math.min(to,matchIndex+queryLength+(compact?500:1200));
 }
 const snippet=text.slice(from,to).split('\n').filter(line=>line.trim()||!annex).join('\n').trim().slice(0,cap);
 return {label:section.label,snippet};
}

