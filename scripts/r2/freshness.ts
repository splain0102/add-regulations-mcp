import {PARSER_VERSION} from '../../src/regulation-core/parser-version';
export function rawProofFresh(value:string|undefined,now=Date.now()){const age=now-Date.parse(value??'');return Number.isFinite(age)&&age>=-300000&&age<7*86400000;}
export function preferredDocuments(documents:any[],checkpoint:any,active:any){
 const current=checkpoint.current??{},activeIds=new Set((active?.documents??[]).map((d:any)=>d.document_id));
 const priority=(d:any)=>current[d.regulation_id]===d.document_id?2:activeIds.has(d.document_id)?1:0;
 return documents.slice().sort((a,b)=>priority(b)-priority(a)||String(b.i_date).localeCompare(String(a.i_date))||Number(b.file_no)-Number(a.file_no));
}
export function metadataUnchanged(catalog:any,checkpoint:any,items:any[],now=Date.now(),force=false){
 if(force||catalog?.format!==1||catalog.parser_version!==PARSER_VERSION||catalog.documents.length!==items.length)return false;
 return items.every(item=>{const d=catalog.documents.find((d:any)=>d.regulation_id===new URL(item.detailUrl).searchParams.get('idx'));
  return d&&(!checkpoint.current?.[d.regulation_id]||checkpoint.current[d.regulation_id]===d.document_id)&&d.title===item.title&&d.st_date===(item.revisionDate??null)&&d.i_date===(item.updatedDate??null)&&rawProofFresh(checkpoint.entries?.[d.document_id]?.raw_checked_at,now);
 });
}
