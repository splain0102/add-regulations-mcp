import {appendFileSync} from 'node:fs';
import {r2Store} from '../d1/remote';
import {collectOfflineList} from '../offline-index-build';
import {metadataUnchanged,rawProofFresh,preferredDocuments} from './freshness';
import {collectCatalog,type Prior} from '../d1/collect';
import {hash} from '../d1/records';
import {BUILD_VERSION} from '../../src/build-info';
import {R2Reader} from '../../src/r2/read';
import {runR2Tool} from '../../src/r2/tools';
import {ROOT,STATUS,type R2Head} from '../../src/r2/types';
import {buildCrossAttachmentWarnings} from '../../src/regulation-core/cross-attachments';
import {buildR2Catalog,type StoredDocument} from './build';
import {optionalObject,publishR2} from './publish';
const store=r2Store(),run=crypto.randomUUID(),started_at=new Date().toISOString(),checkpointKey='r2-index/checkpoint.json',deadline=Date.now()+20*60000;
const saved=new Map<string,StoredDocument>(),details=new Map<string,any>();let pending_titles:string[]=[],removed_titles:string[]=[],processed=0,total=0,raw_verified=0;
const status=(data:any)=>store('PUT',STATUS,new TextEncoder().encode(JSON.stringify({run,started_at,build_version:BUILD_VERSION,pending_titles,removed_titles,processed,total,raw_verified,...data})));
try{
 const previous:R2Head|undefined=await optionalObject(store,ROOT),etag=store.etag(ROOT),checkpoint=await optionalObject(store,checkpointKey)??{entries:{}};
 if(process.env.R2_BOOTSTRAP_ONLY==='true'&&previous){console.log('R2_BOOTSTRAP_ALREADY_PUBLISHED',JSON.stringify({count:previous.count,snapshot:previous.catalog.sha256}));process.exit(0);}
 const entries:Record<string,{snapshot_key:string;raw_checked_at?:string}>=checkpoint.entries??{},current:Record<string,string>=checkpoint.current??{};let activeCatalog:any;
 await status({status:'building'});
 let skip=false;if(previous){activeCatalog=await optionalObject(store,previous.catalog.key);const items=await collectOfflineList();total=items.length;skip=metadataUnchanged(activeCatalog,checkpoint,items,Date.now(),process.env.R2_FORCE_SHA==='true');}
 if(skip){await status({status:'published',check_type:'metadata',catalog_sha:previous!.catalog.sha256,last_list_verified_at:new Date().toISOString(),finished_at:new Date().toISOString(),count:total});console.log('R2_METADATA_UNCHANGED',JSON.stringify({total,downloads:0,document_parses:0}));}
 else {
 const keys=await store.list('parsed/');
 for(const key of keys){const value=await optionalObject(store,key);if(!value?.records?.document?.document_id||!value.loaded?.text)continue;const d=value.records.document;if(hash(await store('GET',d.raw_r2_key))!==d.sha256)throw Error('imported_raw_checksum_mismatch:'+d.title);saved.set(d.document_id,value);}
 // Prefer the latest checkpoint over imported older/orphaned versions. Current
 // ALIO metadata and the shared selector are still checked for every document.
 const prior=preferredDocuments([...saved.values()].map(s=>s.records.document),checkpoint,activeCatalog) as Prior[];
 console.log('R2_SYNC_STARTED',JSON.stringify({run,imported_snapshots:saved.size,previous_count:previous?.count??0}));
 const flushCheckpoint=()=>store('PUT',checkpointKey,new TextEncoder().encode(JSON.stringify({format:1,updated_at:new Date().toISOString(),entries,current})));
 const catalog=await collectCatalog({prior,shouldStop:()=>Date.now()>=deadline,
  forceSha:(p)=>process.env.R2_FORCE_SHA==='true'||!p||!rawProofFresh(entries[p.document_id]?.raw_checked_at),
  onList:async items=>{total=items.length;const active=activeCatalog?.documents??[];removed_titles=active.filter((d:any)=>!items.some(item=>new URL(item.detailUrl).searchParams.get('idx')===d.regulation_id)).map((d:any)=>d.title);pending_titles=[...removed_titles,...items.filter(item=>!active.some((d:any)=>d.title===item.title&&d.st_date===(item.revisionDate??null)&&d.i_date===(item.updatedDate??null))).map(item=>item.title)];await status({status:'building',last_list_verified_at:new Date().toISOString()});},
  onDetail:async(item,detail)=>{details.set(item.title,detail);const p=activeCatalog?.documents.find((d:any)=>d.title===item.title);if(p&&p.file_no!==detail.latestAttachment?.fileNo&&!pending_titles.includes(item.title))pending_titles.push(item.title);},
  readPrevious:async d=>({...saved.get(d.document_id)!.loaded,sha256:d.sha256,fileNo:d.file_no,parserVersion:d.parser_version}),
  save:async(item,loaded,records)=>{
   await store('PUT',records.document.raw_r2_key,loaded.bytes);if(hash(await store('GET',records.document.raw_r2_key))!==records.document.sha256)throw Error('raw_checksum_mismatch');
   const value={records,loaded:{...loaded,bytes:undefined}},bytes=new TextEncoder().encode(JSON.stringify(value));await store('PUT',records.document.snapshot_r2_key,bytes);if(hash(await store('GET',records.document.snapshot_r2_key))!==hash(bytes))throw Error('snapshot_checksum_mismatch');saved.set(records.document.document_id,value);
  },
  onVerified:async(_item,value)=>{const d=saved.get(value.document_id)?.records.document;if(!d)throw Error('missing_verified_snapshot');if(value.rawVerified)raw_verified++;entries[value.document_id]={snapshot_key:d.snapshot_r2_key,raw_checked_at:value.rawVerified?new Date().toISOString():entries[value.document_id]?.raw_checked_at};current[d.regulation_id]=d.document_id;if(activeCatalog?.documents.some((old:any)=>old.regulation_id===d.regulation_id&&old.document_id!==d.document_id)&&!pending_titles.includes(d.title))pending_titles.push(d.title);await flushCheckpoint();},
  progress:async progress=>{processed=progress.processed;total=progress.total;console.log('R2_SYNC_PROGRESS',JSON.stringify({...progress,raw_verified}));await status({status:'building',...progress});}
 });
 if(!catalog.complete){await status({status:'checkpointed',finished_at:new Date().toISOString()});console.log('R2_SYNC_CHECKPOINTED',JSON.stringify({processed,total,reused:catalog.reused,downloaded:catalog.downloaded}));}
 else{
  const warnings=buildCrossAttachmentWarnings(catalog.items.map(i=>i.title),Object.fromEntries(catalog.items.map(item=>{const s=saved.get(catalog.documents.find(d=>d.item.title===item.title)!.document_id)!;const detail=details.get(item.title);return [item.title,{fileNo:s.records.document.file_no,selectedDate:s.loaded.selectedDate,attachments:detail?.attachments??s.loaded.attachments??[]}];})));
  const documents=catalog.documents.map(d=>{const s=saved.get(d.document_id)!;const detail=details.get(d.item.title);if(detail.latestAttachment.fileNo!==s.records.document.file_no)throw Error('selection_changed_during_sync');return {...s,verified_at:d.verified_at,records:{...s.records,document:{...s.records.document,filename:detail.latestAttachment.name,selection_reason:detail.selection_reason,other_attachments:detail.other_attachments,cross_entry_warnings:warnings[d.item.title]??[]}}};});
  const built=buildR2Catalog(documents,BUILD_VERSION,catalog.verified_at);
  const reader=new R2Reader({get:async key=>{try{const bytes=await store('GET',key);return {size:bytes.length,arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength) as ArrayBuffer};}catch(error){if(String(error).includes('HTTP 404'))return null;throw error;}}});
  const head=await publishR2(store,built,previous,etag,async candidate=>{
   for(const name of ['기술용역 업무규정','여비규정','위임전결규정','감사규정']){const answer:any=await runR2Tool(reader,'get_regulation',{name},BUILD_VERSION,candidate);if(answer.isError||!answer.structuredContent.fileNo)throw Error('metadata_acceptance_failed:'+name);}
   for(const query of ['전문가','내부승인']){const answer:any=await runR2Tool(reader,'search_regulation_table',{name:'위임전결규정',query},BUILD_VERSION,candidate);if(answer.isError||!answer.structuredContent.totalMatches)throw Error('table_acceptance_failed:'+query);}
   const global:any=await runR2Tool(reader,'search_all_regulations',{query:'외국인',limit:10},BUILD_VERSION,candidate);if(global.isError||global.structuredContent.partial||!global.structuredContent.results.some((r:any)=>r.regulationName.endsWith('보안과제 관리요령')&&r.matches.some((m:any)=>m.label.includes('제8조'))))throw Error('global_acceptance_failed');
  });pending_titles=[];removed_titles=[];await status({status:'published',finished_at:new Date().toISOString(),count:head.count});console.log('R2_SYNC_PUBLISHED',JSON.stringify(head));
 }
 }
}catch(error){console.error('R2_SYNC_FAILED',String(error));try{await status({status:'failed',error_code:'r2_sync_failed',message:String(error).slice(0,300),finished_at:new Date().toISOString()});}catch{console.error('R2_STATUS_WRITE_FAILED');}process.exitCode=1;}
finally{if(process.env.GITHUB_STEP_SUMMARY)appendFileSync(process.env.GITHUB_STEP_SUMMARY,`R2 sync: processed ${processed}/${total}. See R2_SYNC_PUBLISHED for full publication; checkpoint/failure preserves the previous active index.\n`);}
