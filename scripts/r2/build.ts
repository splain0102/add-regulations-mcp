import {bloom} from '../../src/r2/bloom';
import {hash} from '../d1/records';
import {PARSER_VERSION} from '../../src/regulation-core/parser-version';
import {prepareSearchSections} from '../../src/regulation-core/search-sections';
import type {ObjectRef,R2Catalog,R2Document,SearchRecord} from '../../src/r2/types';
export type StoredDocument={records:any;loaded:any;verified_at?:string};
export function buildR2Catalog(stored:StoredDocument[],build:string,now=new Date().toISOString()){
 const objects=new Map<string,Uint8Array>();
 const put=(value:any):ObjectRef=>{const bytes=new TextEncoder().encode(JSON.stringify(value));if(bytes.length>2_000_000)throw Error('r2_search_object_too_large');const sha256=hash(bytes),key=`r2-index/objects/${sha256}.json`;objects.set(key,bytes);return {key,sha256,bytes:bytes.length};};
 const chunks=(values:any[],target=200_000,filter=false)=>{const refs:ObjectRef[]=[];let part:any[]=[],bytes=2;const flush=()=>{const ref=put(part);refs.push(filter?{...ref,bloom:bloom(part.map(v=>[v.match.row,...v.match.cells,...v.match.aliases,...v.match.paths].join(' ')).join(' '))}:ref);};for(const v of values){const size=Buffer.byteLength(JSON.stringify(v))+1;if(part.length&&bytes+size>target){flush();part=[];bytes=2;}part.push(v);bytes+=size;}if(part.length)flush();return refs;};
 const documents:R2Document[]=[],bodies:any[]=[],tableRows:any[]=[];
 for(const saved of stored){const {document:d,sections,rows}=saved.records;if(!d?.document_id||d.parser_version!==PARSER_VERSION||!Array.isArray(sections)||!Array.isArray(rows))throw Error('invalid_parsed_snapshot');
  const summaries:SearchRecord[]=[];let evidenceBytes=2;
  const pending:{summary:any;payload:any}[]=[];
  const flush=()=>{if(!pending.length)return;const ref=put(pending.map(p=>p.payload));pending.forEach((p,i)=>summaries.push({...p.summary,evidence:ref,evidence_index:i}));pending.length=0;evidenceBytes=2;};
  const add=(summary:any,payload:any)=>{const size=Buffer.byteLength(JSON.stringify(payload))+1;if(pending.length&&evidenceBytes+size>300_000)flush();pending.push({summary,payload});evidenceBytes+=size;};
  for(const s of sections)add({id:s.ordinal,kind:'body',ordinal:s.ordinal,label:s.section_label,n:s.text_normalized},{text:s.text_original});
  rows.forEach((r:any,i:number)=>add({id:i,kind:'table',ordinal:i,label:r.table_key+':'+r.source_row_number,match:r.match,analysis_type:r.analysis_type},{result:r.result}));flush();
  for(const r of summaries.filter(r=>r.kind==='table'))tableRows.push({document_id:d.document_id,label:r.label,match:r.match,analysis_type:r.analysis_type});
  documents.push({...d,verified_at:saved.verified_at??now,search:chunks(summaries)});
  const text=String(saved.loaded.text??'');if(!text.trim())throw Error('missing_parsed_body:'+d.title);
  bodies.push({title:d.title,fileNo:d.file_no,revisionDate:d.st_date,updatedDate:d.i_date,sourceUrl:d.source_url,verifiedAt:saved.verified_at??now,sha256:d.sha256,text,searchSections:prepareSearchSections(text)});
 }
 documents.sort((a,b)=>a.title.localeCompare(b.title,'ko'));if(!documents.length||new Set(documents.map(d=>d.regulation_id)).size!==documents.length)throw Error('invalid_catalog_identity');
 if(Buffer.byteLength(JSON.stringify(bodies))>16_000_000)throw Error('r2_body_corpus_size_limit');
 const body_shards=chunks(bodies,900_000),table_shards=chunks(tableRows,400_000,true),catalog:R2Catalog={format:1,build_version:build,parser_version:PARSER_VERSION,verified_at:now,documents,body_shards,table_shards,objects:[...objects].map(([key,bytes])=>({key,bytes:bytes.length,sha256:key.split('/').pop()!.slice(0,-5)}))};
 const catalogRef=put(catalog);return {catalog,catalogRef,objects};
}
