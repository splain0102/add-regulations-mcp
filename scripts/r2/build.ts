import {normalize,normalizeName} from '../../src/d1/normalize';
import {bloom} from '../../src/r2/bloom';
import {extractCitations} from '../../src/r2/global-search';
import {hash,refreshDerived} from '../d1/records';
import {PARSER_VERSION} from '../../src/regulation-core/parser-version';
import {prepareSearchSections} from '../../src/regulation-core/search-sections';
import {delegationScopes,scopeFields} from '../../src/regulation-core/delegation-scope';
import type {ObjectRef,R2Catalog,R2Document,SearchRecord} from '../../src/r2/types';
// Bumped when catalog-level search data changes without a parser change, so the
// next sync rebuilds the catalog from stored snapshots (no downloads).
export const SEARCH_FORMAT=5;
export type StoredDocument={records:any;loaded:any;verified_at?:string};
export function buildR2Catalog(stored:StoredDocument[],build:string,now=new Date().toISOString()){
 const objects=new Map<string,Uint8Array>();
 const put=(value:any):ObjectRef=>{const bytes=new TextEncoder().encode(JSON.stringify(value));if(bytes.length>2_000_000)throw Error('r2_search_object_too_large');const sha256=hash(bytes),key=`r2-index/objects/${sha256}.json`;objects.set(key,bytes);return {key,sha256,bytes:bytes.length};};
 const chunks=(values:any[],target=200_000,filter=false)=>{const refs:ObjectRef[]=[];let part:any[]=[],bytes=2;const flush=()=>{const ref=put(part);refs.push(filter?{...ref,bloom:bloom(part.map(v=>[v.match.row,...v.match.cells,...v.match.aliases,...v.match.paths].join(' ')).join(' '))}:ref);};for(const v of values){const size=Buffer.byteLength(JSON.stringify(v))+1;if(part.length&&bytes+size>target){flush();part=[];bytes=2;}part.push(v);bytes+=size;}if(part.length)flush();return refs;};
 // Repealed regulations keep their own shards so default global searches never
 // read them; include_repealed opts in.
 const documents:R2Document[]=[],bodies:any[]=[],tableRows:any[]=[],repealedBodies:any[]=[],repealedRows:any[]=[];
 for(const saved of stored){const {document:d,sections,rows}=saved.records?.document?refreshDerived(saved.records,String(saved.loaded?.text??'')):saved.records;if(!d?.document_id||d.parser_version!==PARSER_VERSION||!Array.isArray(sections)||!Array.isArray(rows))throw Error('invalid_parsed_snapshot');
  if(sections.some((s:any)=>normalize(s.text_original)!==s.text_normalized||!String(saved.loaded.text??'').includes(s.text_original)))throw Error('parsed_body_validation_failed:'+d.title);
  const summaries:SearchRecord[]=[];let evidenceBytes=2;
  const pending:{summary:any;payload:any}[]=[];
  const flush=()=>{if(!pending.length)return;const ref=put(pending.map(p=>p.payload));pending.forEach((p,i)=>summaries.push({...p.summary,evidence:ref,evidence_index:i}));pending.length=0;evidenceBytes=2;};
  const add=(summary:any,payload:any)=>{const size=Buffer.byteLength(JSON.stringify(payload))+1;if(pending.length&&evidenceBytes+size>300_000)flush();pending.push({summary,payload});evidenceBytes+=size;};
  for(const s of sections)add({id:s.ordinal,kind:'body',ordinal:s.ordinal,label:s.section_label,n:s.text_normalized},{text:s.text_original});
  // group links the sub-rows of one delegation task for group_by='task'.
  // 공통/개별 위임전결 scope of each delegation table, from the headings in the text.
  const scopes=delegationScopes(String(saved.loaded.text??''),rows),scoped=(r:any)=>scopeFields(scopes.get(r.table_key),r.result);
  rows.forEach((r:any,i:number)=>add({id:i,kind:'table',ordinal:i,label:r.table_key+':'+r.source_row_number,match:r.match,analysis_type:r.analysis_type,...r.result?.task?{group:r.table_key+':'+normalize(String(r.result.task))}:{},...scopes.get(r.table_key)&&r.analysis_type==='delegation_table'?{scope:scopes.get(r.table_key)!.delegation_scope}:{}},{result:{...r.result,...scoped(r)}}));flush();
  const repealed=d.status==='repealed';
  for(const r of summaries.filter(r=>r.kind==='table')){const res=rows[r.ordinal]?.result??{};(repealed?repealedRows:tableRows).push({document_id:d.document_id,label:r.label,match:r.match,analysis_type:r.analysis_type,text:String(rows[r.ordinal]?.text_original??'').slice(0,850),...res.analysis_type==='delegation_table'&&res.approver?{task:res.task??null,condition:res.condition??null,approver:res.approver,...scoped(rows[r.ordinal])}:{}});}
  documents.push({...d,verified_at:saved.verified_at??now,search:chunks(summaries)});
  const text=String(saved.loaded.text??'');if(!text.trim())throw Error('missing_parsed_body:'+d.title);
  (repealed?repealedBodies:bodies).push({regulation_id:d.regulation_id,title:d.title,fileNo:d.file_no,revisionDate:d.st_date,updatedDate:d.i_date,sourceUrl:d.source_url,sha256:d.sha256,text,searchSections:prepareSearchSections(text)});
 }
 documents.sort((a,b)=>a.title.localeCompare(b.title,'ko')||a.regulation_id.localeCompare(b.regulation_id));if(!documents.length||new Set(documents.map(d=>d.regulation_id)).size!==documents.length)throw Error('invalid_catalog_identity');
 // Explicit citations between regulations (「규정명」 [제N조]) for related-article
 // links. Each document's links depend only on its own text and the title list.
 const titles=new Map<string,{reg_id:string;title:string}>();for(const d of documents)for(const name of [d.title,...(d.aliases??[])])titles.set(normalizeName(name),{reg_id:d.regulation_id,title:d.title});
 for(const body of [...bodies,...repealedBodies])body.citations=extractCitations(body,titles);
 if(Buffer.byteLength(JSON.stringify(bodies))>16_000_000)throw Error('r2_body_corpus_size_limit');
 const body_shards=chunks(bodies,900_000),table_shards=chunks(tableRows,400_000,true),repealed_body_shards=chunks(repealedBodies,900_000),repealed_table_shards=chunks(repealedRows,400_000,true),catalog:R2Catalog={format:1,search_format:SEARCH_FORMAT,build_version:build,parser_version:PARSER_VERSION,verified_at:now,documents,body_shards,table_shards,repealed_body_shards,repealed_table_shards,objects:[...objects].map(([key,bytes])=>({key,bytes:bytes.length,sha256:key.split('/').pop()!.slice(0,-5)}))};
 const catalogRef=put(catalog);return {catalog,catalogRef,objects};
}
