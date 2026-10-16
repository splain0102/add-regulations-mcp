// Mirror the active R2 catalog into the derived D1 copy (docs/d1-derived-index.md).
// Reads only R2 (never ALIO). One row per article, per whole table and per
// delegation row; no FTS. Per regulation, new rows are written under a new
// generation and the regulation row is switched last, so readers of the
// current_* views never see a half-written version.
import {PARSER_VERSION} from '../../src/regulation-core/parser-version';
import {ROOT,type R2Head} from '../../src/r2/types';
import {delegationScopes} from '../../src/regulation-core/delegation-scope';
// Bumped when derived rows gain fields; regulations written by an older format are rewritten once.
export const MIRROR_FORMAT=2;
export type Database={query:(sql:string,params?:any[])=>Promise<any[]>;batch:(rows:{sql:string;params:any[]}[])=>Promise<void>};
export type Store=(method:'GET',key:string)=>Promise<Uint8Array>;
type Statement={sql:string;params:any[]};
const MAX_CELL=1_500_000;
const json=async(store:Store,key:string)=>JSON.parse(new TextDecoder().decode(await store('GET',key)));
const upsert=(table:string,row:Record<string,unknown>,verb='INSERT OR REPLACE')=>({sql:`${verb} INTO ${table} (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(()=>'?').join(',')})`,params:Object.values(row).map(v=>v===undefined?null:v)});
const size=(s:Statement)=>s.params.reduce((n:number,p)=>n+(typeof p==='string'?Buffer.byteLength(p):8),s.sql.length);

// Snapshot (records + loaded text) → rows for one regulation.
export function deriveRegulation(doc:any,snapshot:any,generation:string){
 const {sections,rows}=snapshot.records,reg=doc.regulation_id,units:any[]=[],approvals:any[]=[];
 for(const s of sections)units.push({reg_id:reg,generation,ordinal:units.length,unit_id:`${reg}:body:${s.ordinal}`,type:'body',label:s.section_label,article_no:s.article_number??null,table_id:null,text:s.text_original,rows_json:null});
 const scopes=delegationScopes(String(snapshot.loaded?.text??''),rows);
 const tables=new Map<string,any[]>();for(const r of rows){const list=tables.get(r.table_key)??[];list.push(r);tables.set(r.table_key,list);}
 for(const [table,list] of tables){
  // A whole table is one row; very large tables are split to stay under D1's row size.
  let part:any[]=[],bytes=0,piece=0;const flush=()=>{if(!part.length)return;const id=piece?`${table}#${piece}`:table;units.push({reg_id:reg,generation,ordinal:units.length,unit_id:`${reg}:table:${id}`,type:'table',label:id,article_no:null,table_id:table,text:part.map(p=>p.text).join('\n'),rows_json:JSON.stringify(part.map(p=>p.row))});part=[];bytes=0;piece++;};
  for(const r of list){const x=r.result??{},row={row_no:r.source_row_number,page:r.page_number??null,analysis_type:r.analysis_type,...x.analysis_type==='delegation_table'?{category:x.category??null,task:x.task??null,condition:x.condition??null,approver:x.approver??null,approvers:(x.approvers??[]).map((a:any)=>a.name),needs_review:Boolean(x.needs_review),...scopes.get(r.table_key)?{scope:scopes.get(r.table_key)!.delegation_scope}:{}}:{values:x.values??{}}},text=String(r.text_original??''),cost=Buffer.byteLength(text)+Buffer.byteLength(JSON.stringify(row));
   if(part.length&&bytes+cost>MAX_CELL/2)flush();part.push({row,text});bytes+=cost;}
  flush();
 }
 rows.forEach((r:any)=>{const x=r.result??{};if(x.analysis_type!=='delegation_table')return;const scope=scopes.get(r.table_key)?.delegation_scope??null;approvals.push({reg_id:reg,generation,ordinal:approvals.length,table_id:r.table_key,row_no:r.source_row_number,scope,department:scope==='individual'?x.category??null:null,category:x.category??null,task:x.task??null,condition_text:x.condition??null,approver:x.approver??null,approvers_json:JSON.stringify((x.approvers??[]).map((a:any)=>a.name)),multi_approver:x.multi_approver?1:0,needs_review:x.needs_review?1:0,review_reason:x.review_reason??null});});
 return {units,approvals,body:sections.length,tables:units.length-sections.length};
}
const regulationRow=(doc:any,generation:string,counts:{body:number;tables:number;approvals:number},now:string)=>({reg_id:doc.regulation_id,name:doc.title,aliases_json:JSON.stringify(doc.aliases??[]),status:doc.status==='repealed'?'repealed':'active',missing_count:doc.missing_count??0,current_file_no:doc.file_no,document_id:doc.document_id,revised_at:doc.st_date??null,updated_at:doc.i_date??null,extension:doc.extension,alio_url:doc.source_url,content_hash:doc.sha256,body_units:counts.body,table_units:counts.tables,approval_rows:counts.approvals,first_seen:doc.first_seen??null,last_seen:doc.last_seen??null,repealed_at:doc.repealed_at??null,generation,loaded_at:now,mirror_format:MIRROR_FORMAT});
// Fields that can change without a new document (renames are new documents).
const lifecycle=(r:any)=>JSON.stringify([r.status,r.aliases_json,r.missing_count,r.first_seen,r.last_seen,r.repealed_at]);

export async function mirrorToD1({store,db,now=()=>new Date().toISOString(),shouldStop=()=>false,log=console.log}:{store:Store;db:Database;now?:()=>string;shouldStop?:()=>boolean;log?:(event:string,data:any)=>void}){
 const head:R2Head=await json(store,ROOT),catalog=await json(store,head.catalog.key),stamp=now();
 // During a re-index the active catalog still carries the old parser; mirroring it
 // now would be rewritten again once the new catalog is published.
 if(catalog.parser_version!==PARSER_VERSION){log('D1_MIRROR_WAITING_FOR_REINDEX',{catalog_parser:catalog.parser_version,expected:PARSER_VERSION});return {status:'waiting_for_reindex'};}
 const [state]=await db.query('SELECT catalog_sha FROM sync_state WHERE singleton=1');
 if(state?.catalog_sha===head.catalog.sha256&&!(await db.query('SELECT 1 FROM regulations WHERE mirror_format IS NOT ? LIMIT 1',[MIRROR_FORMAT])).length){log('D1_MIRROR_UNCHANGED',{catalog:head.catalog.sha256});return {status:'unchanged'};}
 const generation=head.catalog.sha256.slice(0,16),current=new Map((await db.query('SELECT reg_id,document_id,generation,status,aliases_json,missing_count,first_seen,last_seen,repealed_at,mirror_format FROM regulations')).map((r:any)=>[r.reg_id,r]));
 let written=0,replaced=0,touched=0,units=0,approvals=0;
 const send=async(statements:Statement[])=>{let chunk:Statement[]=[],bytes=0;for(const s of statements){const n=size(s);if(chunk.length&&(chunk.length>=40||bytes+n>600_000)){await db.batch(chunk);chunk=[];bytes=0;}chunk.push(s);bytes+=n;}if(chunk.length)await db.batch(chunk);written+=statements.length;};
 for(const doc of catalog.documents){
  if(shouldStop()){log('D1_MIRROR_PAUSED',{reason:'time_budget',replaced,touched});return {status:'paused',replaced,touched};}
  const old=current.get(doc.regulation_id);
  if(old?.document_id===doc.document_id&&old.mirror_format===MIRROR_FORMAT){
   // Same version: only lifecycle fields (status, aliases, sightings) may differ.
   const row=regulationRow(doc,old.generation,{body:0,tables:0,approvals:0},stamp);
   if(lifecycle(old)!==lifecycle(row)){await send([{sql:'UPDATE regulations SET status=?,aliases_json=?,missing_count=?,first_seen=?,last_seen=?,repealed_at=? WHERE reg_id=?',params:[row.status,row.aliases_json,row.missing_count,row.first_seen,row.last_seen,row.repealed_at,doc.regulation_id]}]);touched++;}
   continue;
  }
  const snapshot=await json(store,doc.snapshot_r2_key),derived=deriveRegulation(doc,snapshot,generation);
  // Rows of the new generation first (INSERT OR REPLACE makes a resumed run idempotent),
  // then the switch, then removal of the superseded generation.
  await send([...derived.units.map(u=>upsert('units',u)),...derived.approvals.map(a=>upsert('approvals',a))]);
  await send([upsert('regulations',regulationRow(doc,generation,{body:derived.body,tables:derived.tables,approvals:derived.approvals.length},stamp)),upsert('versions',{reg_id:doc.regulation_id,file_no:doc.file_no,document_id:doc.document_id,revised_at:doc.st_date??null,updated_at:doc.i_date??null,filename:doc.filename??null,extension:doc.extension,sha256:doc.sha256,parser_version:doc.parser_version,raw_r2_key:doc.raw_r2_key,first_loaded_at:stamp},'INSERT OR IGNORE')]);
  if(old)await send([{sql:'DELETE FROM units WHERE reg_id=? AND generation<>?',params:[doc.regulation_id,generation]},{sql:'DELETE FROM approvals WHERE reg_id=? AND generation<>?',params:[doc.regulation_id,generation]}]);
  replaced++;units+=derived.units.length;approvals+=derived.approvals.length;
  log('D1_MIRROR_REGULATION',{reg_id:doc.regulation_id,title:doc.title,units:derived.units.length,approvals:derived.approvals.length});
 }
 // A regulation the catalog no longer carries at all (R2 keeps repealed ones) leaves D1 too.
 const listed=new Set(catalog.documents.map((d:any)=>d.regulation_id)),gone=[...current.keys()].filter(id=>!listed.has(id));
 for(const id of gone)await send([{sql:'DELETE FROM units WHERE reg_id=?',params:[id]},{sql:'DELETE FROM approvals WHERE reg_id=?',params:[id]},{sql:'DELETE FROM regulations WHERE reg_id=?',params:[id]}]);
 const [totals]=await db.query('SELECT (SELECT count(*) FROM regulations) AS regulations,(SELECT count(*) FROM current_units) AS units,(SELECT count(*) FROM current_approvals) AS approvals');
 await send([upsert('sync_state',{singleton:1,catalog_sha:head.catalog.sha256,parser_version:catalog.parser_version,loaded_at:stamp,status:'loaded',message:null,...totals})]);
 log('D1_MIRROR_LOADED',{catalog:head.catalog.sha256,replaced,touched,removed:gone.length,statements:written,...totals});
 return {status:'loaded',replaced,touched,removed:gone.length,statements:written,units,approvals,totals};
}
