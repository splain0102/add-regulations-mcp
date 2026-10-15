import {PARSER_VERSION} from '../../src/regulation-core/parser-version';
export function metadataUnchanged(catalog:any,checkpoint:any,items:any[],now=Date.now(),force=false){
 if(force||catalog?.format!==1||catalog.parser_version!==PARSER_VERSION||catalog.documents.length!==items.length)return false;
 return items.every(item=>{const d=catalog.documents.find((d:any)=>d.regulation_id===new URL(item.detailUrl).searchParams.get('idx'));
  return d&&d.title===item.title&&d.st_date===(item.revisionDate??null)&&d.i_date===(item.updatedDate??null)&&Number.isFinite(Date.parse(checkpoint.entries?.[d.document_id]?.raw_checked_at))&&now-Date.parse(checkpoint.entries[d.document_id].raw_checked_at)<7*86400000;
 });
}
