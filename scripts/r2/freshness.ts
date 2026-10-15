import {PARSER_VERSION} from '../../src/regulation-core/parser-version';
export function rawProofFresh(value:string|undefined,now=Date.now()){const age=now-Date.parse(value??'');return Number.isFinite(age)&&age>=-300000&&age<7*86400000;}
export function preferredDocuments(documents:any[],checkpoint:any,active:any){
 const current=checkpoint.current??{},activeIds=new Set((active?.documents??[]).map((d:any)=>d.document_id));
 const activeTime=Date.parse(active?.verified_at??'1970-01-01T00:00:00Z');
 const priority=(d:any)=>current[d.regulation_id]===d.document_id&&rawProofFresh(checkpoint.entries?.[d.document_id]?.raw_checked_at)&&Date.parse(checkpoint.entries[d.document_id].raw_checked_at)>=activeTime?2:activeIds.has(d.document_id)?1:0;
 return documents.slice().sort((a,b)=>priority(b)-priority(a)||String(b.i_date).localeCompare(String(a.i_date))||Number(b.file_no)-Number(a.file_no));
}
export const regulationId=(item:{detailUrl:string})=>{const id=new URL(item.detailUrl).searchParams.get('idx');if(!id)throw Error('missing_alio_rule_id');return id;};
export const activeDocuments=(catalog:any)=>(catalog?.documents??[]).filter((d:any)=>d.status!=='repealed');
export function metadataUnchanged(catalog:any,checkpoint:any,items:any[],now=Date.now(),force=false){
 const active=activeDocuments(catalog);
 // A regulation that was missing once must be re-collected to clear or advance it.
 if(force||catalog?.format!==1||catalog.parser_version!==PARSER_VERSION||active.length!==items.length||active.some((d:any)=>d.missing_count>0))return false;
 return items.every(item=>{const d=active.find((d:any)=>d.regulation_id===regulationId(item));
  return d&&(!checkpoint.current?.[d.regulation_id]||checkpoint.current[d.regulation_id]===d.document_id)&&d.title===item.title&&d.st_date===(item.revisionDate??null)&&d.i_date===(item.updatedDate??null)&&rawProofFresh(checkpoint.entries?.[d.document_id]?.raw_checked_at,now);
 });
}
// A list that silently loses more than 5% (at least one) of the active
// regulations is treated as an ALIO fault, not as mass repeal.
export function listShrink(catalog:any,items:any[]){
 const active=activeDocuments(catalog),present=new Set(items.map(regulationId)),missing=active.filter((d:any)=>!present.has(d.regulation_id));
 return {blocked:active.length>0&&missing.length>Math.max(1,Math.floor(active.length*0.05)),active:active.length,listed:items.length,missing:missing.map((d:any)=>d.title)};
}
export type Membership={reg_id:string;status:'active'|'repealed';aliases:string[];first_seen:string;last_seen:string;missing_count:number;repealed_at:string|null};
// Identity is the ALIO idx. A new title on a known idx is a rename (the old
// title becomes an alias). An idx missing from one list stays active; missing
// from two consecutive complete lists it becomes repealed and is retained.
export function applyMembership(catalog:any,items:any[],now=new Date().toISOString()){
 const previous=new Map<string,any>((catalog?.documents??[]).map((d:any)=>[d.regulation_id,d])),states=new Map<string,Membership>(),present=new Set<string>();
 const summary={created:[] as string[],renamed:[] as {reg_id:string;from:string;to:string}[],revived:[] as string[],missing:[] as string[],repealed:[] as string[]};
 for(const item of items){const id=regulationId(item),old=previous.get(id);present.add(id);
  if(!old)summary.created.push(item.title);else{if(old.title!==item.title)summary.renamed.push({reg_id:id,from:old.title,to:item.title});if(old.status==='repealed')summary.revived.push(item.title);}
  const aliases=[...new Set([...(old?.aliases??[]),...(old&&old.title!==item.title?[old.title]:[])])].filter(a=>a!==item.title);
  states.set(id,{reg_id:id,status:'active',aliases,first_seen:old?.first_seen??now,last_seen:now,missing_count:0,repealed_at:null});
 }
 for(const [id,old]of previous){if(present.has(id))continue;
  const missing_count=(old.missing_count??0)+1,repealed=old.status==='repealed'||missing_count>=2;
  if(repealed&&old.status!=='repealed')summary.repealed.push(old.title);else if(!repealed)summary.missing.push(old.title);
  states.set(id,{reg_id:id,status:repealed?'repealed':'active',aliases:old.aliases??[],first_seen:old.first_seen??now,last_seen:old.last_seen??old.verified_at??now,missing_count,repealed_at:repealed?old.repealed_at??now:null});
 }
 return {states,absent:[...previous.keys()].filter(id=>!present.has(id)),summary};
}
