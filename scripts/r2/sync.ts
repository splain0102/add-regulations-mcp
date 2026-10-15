import {appendFileSync} from 'node:fs';
import {r2Store} from '../d1/remote';
import {collectOfflineList} from '../offline-index-build';
import {metadataUnchanged,rawProofFresh,preferredDocuments,regulationId,activeDocuments,listShrink,applyMembership} from './freshness';
import {collectCatalog,type Prior} from '../d1/collect';
import {hash} from '../d1/records';
import {BUILD_VERSION} from '../../src/build-info';
import {R2Reader} from '../../src/r2/read';
import {runR2Tool,rowMatches} from '../../src/r2/tools';
import {queryTerms,normalize} from '../../src/d1/normalize';
import {ROOT,STATUS,type R2Head} from '../../src/r2/types';
import {buildCrossAttachmentWarnings} from '../../src/regulation-core/cross-attachments';
import {buildR2Catalog,type StoredDocument} from './build';
import {optionalObject,publishR2} from './publish';
const store=r2Store(),run=crypto.randomUUID(),started_at=new Date().toISOString(),checkpointKey='r2-index/checkpoint.json',deadline=Date.now()+20*60000;
const saved=new Map<string,StoredDocument>(),details=new Map<string,any>();let pending_titles:string[]=[],pending_ids:string[]=[],removed_titles:string[]=[],processed=0,total=0,raw_verified=0;
const status=(data:any)=>store('PUT',STATUS,new TextEncoder().encode(JSON.stringify({run,started_at,build_version:BUILD_VERSION,pending_titles,pending_ids,removed_titles,processed,total,raw_verified,...data})));
const markPending=(id:string,title:string)=>{if(!pending_ids.includes(id)){pending_ids.push(id);pending_titles.push(title);}};
// Refuse a list that drops too many active regulations at once; the previous
// catalog keeps serving. R2_ALLOW_LIST_SHRINK=true accepts a confirmed mass repeal.
const guard=(catalog:any,items:any[])=>{const shrink=listShrink(catalog,items);if(shrink.blocked&&process.env.R2_ALLOW_LIST_SHRINK!=='true')throw Object.assign(Error('list_shrink_guard: '+shrink.missing.length+'/'+shrink.active+' active regulations missing from the ALIO list'),{code:'list_shrink_guard',shrink});};
try{
 const previous:R2Head|undefined=await optionalObject(store,ROOT),etag=store.etag(ROOT),checkpoint=await optionalObject(store,checkpointKey)??{entries:{}};
 if(process.env.R2_BOOTSTRAP_ONLY==='true'&&previous){console.log('R2_BOOTSTRAP_ALREADY_PUBLISHED',JSON.stringify({count:previous.count,snapshot:previous.catalog.sha256}));process.exit(0);}
 const entries:Record<string,{snapshot_key:string;raw_checked_at?:string}>=checkpoint.entries??{},current:Record<string,string>=checkpoint.current??{};let activeCatalog:any;
 await status({status:'building'});
 let skip=false;if(previous){activeCatalog=await optionalObject(store,previous.catalog.key);const items=await collectOfflineList();total=items.length;guard(activeCatalog,items);skip=metadataUnchanged(activeCatalog,checkpoint,items,Date.now(),process.env.R2_FORCE_SHA==='true');}
 if(skip){await status({status:'published',check_type:'metadata',catalog_sha:previous!.catalog.sha256,last_list_verified_at:new Date().toISOString(),finished_at:new Date().toISOString(),count:total});console.log('R2_METADATA_UNCHANGED',JSON.stringify({total,downloads:0,document_parses:0}));}
 else {
 const keys=await store.list('parsed/');
 for(const key of keys){const value=await optionalObject(store,key);if(!value?.records?.document?.document_id||!value.loaded?.text)continue;const d=value.records.document;if(hash(await store('GET',d.raw_r2_key))!==d.sha256)throw Error('imported_raw_checksum_mismatch:'+d.title);saved.set(d.document_id,value);}
 // Prefer the latest checkpoint over imported older/orphaned versions. Current
 // ALIO metadata and the shared selector are still checked for every document.
 const prior=preferredDocuments([...saved.values()].map(s=>s.records.document),checkpoint,activeCatalog) as Prior[];
 console.log('R2_SYNC_STARTED',JSON.stringify({run,imported_snapshots:saved.size,previous_count:previous?.count??0}));
 const flushCheckpoint=()=>store('PUT',checkpointKey,new TextEncoder().encode(JSON.stringify({format:1,updated_at:new Date().toISOString(),entries,current})));
 const activeById=(id:string)=>activeCatalog?.documents.find((d:any)=>d.regulation_id===id);
 const catalog=await collectCatalog({prior,shouldStop:()=>Date.now()>=deadline,
  forceSha:(p)=>process.env.R2_FORCE_SHA==='true'||!p||!rawProofFresh(entries[p.document_id]?.raw_checked_at),
  onList:async items=>{guard(activeCatalog,items);total=items.length;const listed=new Set(items.map(regulationId)),active=activeDocuments(activeCatalog);removed_titles=active.filter((d:any)=>!listed.has(d.regulation_id)).map((d:any)=>d.title);pending_ids=[];pending_titles=[];for(const d of active)if(!listed.has(d.regulation_id))markPending(d.regulation_id,d.title);for(const item of items){const d=activeById(regulationId(item));if(!d||d.status==='repealed'||d.title!==item.title||d.st_date!==(item.revisionDate??null)||d.i_date!==(item.updatedDate??null))markPending(regulationId(item),item.title);}await status({status:'building',last_list_verified_at:new Date().toISOString()});},
  onDetail:async(item,detail)=>{const id=regulationId(item);details.set(id,detail);const p=activeById(id);if(p&&p.file_no!==detail.latestAttachment?.fileNo)markPending(id,item.title);},
  readPrevious:async d=>({...saved.get(d.document_id)!.loaded,sha256:d.sha256,fileNo:d.file_no,parserVersion:d.parser_version}),
  save:async(item,loaded,records)=>{
   await store('PUT',records.document.raw_r2_key,loaded.bytes);if(hash(await store('GET',records.document.raw_r2_key))!==records.document.sha256)throw Error('raw_checksum_mismatch');
   const value={records,loaded:{...loaded,bytes:undefined}},bytes=new TextEncoder().encode(JSON.stringify(value));await store('PUT',records.document.snapshot_r2_key,bytes);if(hash(await store('GET',records.document.snapshot_r2_key))!==hash(bytes))throw Error('snapshot_checksum_mismatch');saved.set(records.document.document_id,value);
  },
  onVerified:async(_item,value)=>{const d=saved.get(value.document_id)?.records.document;if(!d)throw Error('missing_verified_snapshot');if(value.rawVerified)raw_verified++;entries[value.document_id]={snapshot_key:d.snapshot_r2_key,raw_checked_at:value.rawVerified?new Date().toISOString():entries[value.document_id]?.raw_checked_at};current[d.regulation_id]=d.document_id;const old=activeById(d.regulation_id);if(old&&old.document_id!==d.document_id)markPending(d.regulation_id,d.title);await flushCheckpoint();},
  progress:async progress=>{processed=progress.processed;total=progress.total;console.log('R2_SYNC_PROGRESS',JSON.stringify({...progress,raw_verified}));await status({status:'building',...progress});}
 });
 if(!catalog.complete){await status({status:'checkpointed',finished_at:new Date().toISOString()});console.log('R2_SYNC_CHECKPOINTED',JSON.stringify({processed,total,reused:catalog.reused,downloaded:catalog.downloaded}));}
 else{
  const membership=applyMembership(activeCatalog,catalog.items,catalog.verified_at);
  // Cross-entry attachment ownership is matched by title; entries whose title is
  // shared by another idx are ambiguous and are left out rather than guessed.
  const titleCount=new Map<string,number>();for(const i of catalog.items)titleCount.set(i.title,(titleCount.get(i.title)??0)+1);
  const unique=catalog.items.filter(i=>titleCount.get(i.title)===1),docById=new Map(catalog.documents.map(d=>[regulationId(d.item),d]));
  const warnings=buildCrossAttachmentWarnings(unique.map(i=>i.title),Object.fromEntries(unique.map(item=>{const id=regulationId(item),s=saved.get(docById.get(id)!.document_id)!,detail=details.get(id);return [item.title,{fileNo:s.records.document.file_no,selectedDate:s.loaded.selectedDate,attachments:detail?.attachments??s.loaded.attachments??[]}];})));
  const lifecycle=(m:any)=>({status:m.status,aliases:m.aliases,first_seen:m.first_seen,last_seen:m.last_seen,missing_count:m.missing_count,repealed_at:m.repealed_at});
  const documents=catalog.documents.map(d=>{const id=regulationId(d.item),s=saved.get(d.document_id)!,detail=details.get(id);if(detail.latestAttachment.fileNo!==s.records.document.file_no)throw Error('selection_changed_during_sync');return {...s,verified_at:d.verified_at,records:{...s.records,document:{...s.records.document,filename:detail.latestAttachment.name,selection_reason:detail.selection_reason,other_attachments:detail.other_attachments,cross_entry_warnings:titleCount.get(d.item.title)===1?warnings[d.item.title]??[]:[],...lifecycle(membership.states.get(id))}}};});
  // Regulations absent from this list keep their last verified version: active
  // after one miss, repealed (never deleted) after two consecutive misses.
  const carried=membership.absent.map(id=>{const old=activeById(id),s=saved.get(old.document_id);if(!s)throw Error('missing_snapshot_for_absent_regulation:'+old.title);const {document_id,regulation_id,title,title_normalized,search,verified_at,status:_s,aliases:_a,first_seen:_f,last_seen:_l,missing_count:_m,repealed_at:_r,...kept}=old;return {...s,verified_at,records:{...s.records,document:{...s.records.document,...kept,...lifecycle(membership.states.get(id))}}};});
  const revised=catalog.documents.filter(d=>{const old=activeById(regulationId(d.item));return old&&old.status!=='repealed'&&old.document_id!==d.document_id&&(old.file_no!==saved.get(d.document_id)!.records.document.file_no||old.st_date!==(d.item.revisionDate??null)||old.i_date!==(d.item.updatedDate??null));}).map(d=>d.item.title);
  const built=buildR2Catalog([...documents,...carried],BUILD_VERSION,catalog.verified_at);
  const reader=new R2Reader({get:async key=>{try{const bytes=await store('GET',key);return {size:bytes.length,arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength) as ArrayBuffer};}catch(error){if(String(error).includes('HTTP 404'))return null;throw error;}}});
  const head=await publishR2(store,built,previous,etag,async candidate=>{
   for(const name of ['기술용역 업무규정','여비규정','위임전결규정','감사규정']){const answer:any=await runR2Tool(reader,'get_regulation',{name},BUILD_VERSION,candidate);if(answer.isError||!answer.structuredContent.fileNo)throw Error('metadata_acceptance_failed:'+name);}
   const delegation=documents.find(d=>d.records.document.title==='위임전결규정')!;
   for(const query of ['전문가','내부승인']){const expected=delegation.records.rows.filter((r:any)=>r.analysis_type!=='text_box'&&rowMatches({kind:'table',match:r.match} as any,queryTerms(query))).length,source_phrase_present=normalize(delegation.loaded.text).includes(normalize(query)),answer:any=await runR2Tool(reader,'search_regulation_table',{name:'위임전결규정',query},BUILD_VERSION,candidate);if(answer.isError||answer.structuredContent.totalMatches!==expected||query==='전문가'&&!expected||!expected&&source_phrase_present)throw Error('table_acceptance_failed:'+query);console.log('R2_TABLE_ACCEPTANCE',JSON.stringify({query,totalMatches:expected,source_phrase_present,...!expected?{zero_reason:'phrase_absent_from_original_document'}:{}}));}
   const global:any=await runR2Tool(reader,'search_all_regulations',{query:'외국인',limit:10},BUILD_VERSION,candidate);if(global.isError||global.structuredContent.partial||!global.structuredContent.results.some((r:any)=>r.regulationName.endsWith('보안과제 관리요령')&&r.matches.some((m:any)=>m.label.includes('제8조'))))throw Error('global_acceptance_failed');
  });
  const changes={...membership.summary,revised,warnings:membership.summary.missing.length?[{code:'missing_from_source_once',titles:membership.summary.missing}]:[]};
  // A regulation missing once is flagged on its own record (missing_count),
  // not as a pending update that would mark the whole index stale.
  pending_ids=[];pending_titles=[];removed_titles=[];
  await status({status:'published',finished_at:new Date().toISOString(),count:head.count,active_count:built.catalog.documents.filter(d=>d.status!=='repealed').length,changes});console.log('R2_SYNC_PUBLISHED',JSON.stringify({...head,changes}));
 }
 }
}catch(error:any){console.error('R2_SYNC_FAILED',String(error));try{await status({status:'failed',error_code:error?.code??'r2_sync_failed',message:String(error).slice(0,300),...error?.shrink?{warnings:[{code:'list_shrink_guard',...error.shrink}]}:{},finished_at:new Date().toISOString()});}catch{console.error('R2_STATUS_WRITE_FAILED');}process.exitCode=1;}
finally{if(process.env.GITHUB_STEP_SUMMARY)appendFileSync(process.env.GITHUB_STEP_SUMMARY,`R2 sync: processed ${processed}/${total}. See R2_SYNC_PUBLISHED for full publication; checkpoint/failure preserves the previous active index.\n`);}
