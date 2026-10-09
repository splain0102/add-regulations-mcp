export type IndexedAttachment={name:string;fileNo:string;detectedDate?:string|null};
export type AttachmentCatalog=Record<string,{fileNo:string;selectedDate?:string|null;attachments:IndexedAttachment[]}>;
export function canonicalAttachmentTitle(value:string){
 return value.normalize('NFKC').toLowerCase().replace(/\.(?:hwpx?|pdf|docx?|zip)$/i,'').replace(/\([^)]*(?:개정|\d{2,4}\s*년|\d{2,4}\s*[.\-]\s*\d{1,2})[^)]*\)/g,'').replace(/(?:개정\s*전문|개정본|전문)\s*$/g,'').replace(/[·ㆍ･‧\s「」｢｣()（）]/g,'').replace(/민군기술협력사업/g,'민군협력사업');
}
export function buildCrossAttachmentWarnings(titles:string[],catalog:AttachmentCatalog){
 const owners=new Map<string,string[]>();for(const title of titles){const key=canonicalAttachmentTitle(title);owners.set(key,[...owners.get(key)??[],title]);}
 const warnings:Record<string,any[]>={};
 for(const [entry,data]of Object.entries(catalog))if(titles.includes(entry))for(const file of data.attachments){
  const matches=owners.get(canonicalAttachmentTitle(file.name))??[];
  // Ambiguous aliases are not guessed; expert and committee never substring-match.
  if(matches.length!==1||matches[0]===entry)continue;
  const belongs_to=matches[0];(warnings[entry]??=[]).push({code:'foreign_attachment',fileNo:file.fileNo,belongs_to,attachmentName:file.name});
  const current=catalog[belongs_to];const date=file.detectedDate;
  if(current&&date&&current.selectedDate&&date>current.selectedDate)(warnings[belongs_to]??=[]).push({code:'cross_entry_newer_attachment',fileNo:file.fileNo,entry,itemTitle:entry,date,attachmentName:file.name,selectedFileNo:current.fileNo});
 }
 return warnings;
}
