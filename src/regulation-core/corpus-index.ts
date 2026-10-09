import {buildCrossAttachmentWarnings,type AttachmentCatalog,type IndexedAttachment} from './cross-attachments';
import {prepareSearchSections,type SearchSections} from './search-sections';
// Only the Cron writer contacts ALIO. Search reads a committed KV manifest.
export const INDEX_PREFIX = 'add:corpus:v2:';
export const INDEX_SHARDS = 16;
export const INDEX_BATCH = 2;
export const MAX_SHARD_BYTES = 2_000_000;
export const MAX_CORPUS_BYTES = 16_000_000;
export const MAX_INDEX_AGE = 24 * 60 * 60 * 1000;
export const LIST_REFRESH_INTERVAL = 60 * 60 * 1000;
export const MAX_LIST_AGE = 2 * 60 * 60 * 1000;
export const DOCUMENT_CHECK_INTERVAL = 12 * 60 * 60 * 1000;
export const RETRY_BASE = 5 * 60 * 1000;
export function retryDelay(attempt:number){return Math.min(60 * 60 * 1000,RETRY_BASE * 2 ** Math.min(4,Math.max(0,attempt-1)));}
export type CorpusItem = {title:string;detailUrl:string;revisionDate?:string;updatedDate?:string};
export type CorpusDocument = CorpusItem & {fileNo:string;text:string;sha256:string;verifiedAt:string;parserVersion:string;searchSections?:SearchSections;attachments?:IndexedAttachment[];selectedDate?:string|null};
type ErrorEntry = {title:string;message:string;checkedAt:string;code?:string;error_code?:string;build_version?:string;retry_attempts?:number;next_retry_at?:string;diagnostics?:Record<string,unknown>};
export function errorDiagnostics(error:unknown){return error&&typeof error==='object'&&'diagnostics' in error?error.diagnostics as Record<string,unknown>:undefined;}
type Shard = {documents:Record<string,CorpusDocument>};
export type IndexState = {
  attachmentCatalog?:AttachmentCatalog;crossEntryWarnings?:Record<string,any[]>;
  schema:2;cursor:number;pending?:string[];fallbackRefs?:Record<string,string>;items:CorpusItem[];refs:Record<string,string>;sizes:Record<string,number>;
  listWork?:unknown;checked:Record<string,string>;errors:Record<string,ErrorEntry>;lastCheckedAt:string;
  listError?:ErrorEntry;listRetryAttempts?:number;nextListAttemptAt?:string;
  index_build_version?:string;lastVerifiedAt?:string;sourceErrorAt?:string;sourceErrorCode?:string;lastCompletedAt?:string;sourceError?:string;indexedTitles?:string[];garbage:{key:string;after:number}[];
  sourceErrorDetails?:Record<string,unknown>;
};
export type CorpusSource = {list(work?:unknown):Promise<CorpusItem[]|{items?:CorpusItem[];work?:unknown}>;load(item:CorpusItem):Promise<{fileNo:string;text:string;bytes:Uint8Array;parserVersion:string;attachments?:IndexedAttachment[];selectedDate?:string|null}>};
export function shardId(title:string){let hash=2166136261;for(const c of title){hash^=c.charCodeAt(0);hash=Math.imul(hash,16777619);}return (hash>>>0)%INDEX_SHARDS;}
export async function sha256(bytes:Uint8Array){const hash=await crypto.subtle.digest('SHA-256',bytes as BufferSource);return [...new Uint8Array(hash)].map(v=>v.toString(16).padStart(2,'0')).join('');}
function sameMetadata(a:CorpusItem,b:CorpusItem){return a.title===b.title&&a.detailUrl===b.detailUrl&&a.revisionDate===b.revisionDate&&a.updatedDate===b.updatedDate;}
function emptyState():IndexState{return {schema:2,cursor:0,items:[],refs:{},sizes:{},checked:{},errors:{},lastCheckedAt:'',garbage:[]};}
async function readState(kv:KVNamespace){return await kv.get<IndexState>(INDEX_PREFIX+'state','json');}
async function readShard(kv:KVNamespace,state:IndexState,id:number):Promise<Shard>{
  const key=state.refs[id];if(!key)return {documents:{}};
  const shard=await kv.get<Shard>(key,'json');if(!shard||!shard.documents)throw Error('index_shard_unavailable:'+id);
  return shard;
}
export function indexErrorCode(error:unknown){
 const text=String(error)+' '+(error&&typeof error==='object'&&'cause' in error?String(error.cause):'');
 if(/subrequest|index_request_budget_exhausted/i.test(text))return 'subrequest_limit';
 if(/timeout|timed.?out|abort|deadline_exhausted|lease_expired/i.test(text))return 'timeout';
 if(/no_attachment/i.test(text))return 'no_attachment';
 if(/fetch|HTTP|network|KV|index_.*(?:unavailable|write_failed)/i.test(text))return 'fetch_failed';
 return 'parse_failed';
}
function errorSummary(state:IndexState){
 const errors=Object.values(state.errors).filter(e=>!state.index_build_version||e.build_version===state.index_build_version);
 if(state.listError)errors.push(state.listError);
 if(state.sourceError)errors.push({title:'ALIO/KV',message:state.sourceError,checkedAt:state.sourceErrorAt??'',build_version:state.index_build_version,error_code:state.sourceErrorCode??indexErrorCode(state.sourceError),diagnostics:state.sourceErrorDetails});
 errors.sort((a,b)=>b.checkedAt.localeCompare(a.checkedAt));
 return {count:errors.length,sample:errors.slice(0,3),retry_cursor:errors.length?state.cursor:null};
}
function timing(state:IndexState){
 const retries=[state.listError?.next_retry_at,...Object.values(state.errors).map(e=>e.next_retry_at)].filter((v):v is string=>!!v).sort();
 return {last_list_verified_at:state.lastCheckedAt||null,next_list_refresh_at:state.nextListAttemptAt??null,next_retry_at:retries[0]??null};
}
// KV is not a lock: run one Cron writer. Immutable shards + one manifest prevent
// a failed multi-key write from destroying the preceding committed snapshot.
export async function refreshIndex(kv:KVNamespace,source:CorpusSource,now=Date.now(),options?:{buildVersion?:string;forceList?:boolean;forceDocuments?:boolean;beforeCommit?:()=>Promise<void>}){
  const previous=await readState(kv)??emptyState();
  const buildVersion=options?.buildVersion??previous.index_build_version??'test';
  if(previous.index_build_version!==buildVersion){
    // Start new build diagnostics without discarding committed documents or refs.
    previous.index_build_version=buildVersion;previous.errors={};delete previous.sourceError;delete previous.sourceErrorAt;delete previous.sourceErrorCode;
    delete previous.sourceErrorDetails;
    delete previous.listError;delete previous.listRetryAttempts;delete previous.nextListAttemptAt;
    previous.checked={};previous.pending=previous.items.map(item=>item.title);
  }
  const state:IndexState=structuredClone(previous);
  const timestamp=new Date(now).toISOString();
  const changed=new Map<number,Shard>();const writtenKeys:string[]=[];let processed=0,updated=0;
  try{
    let freshItems:CorpusItem[]|undefined;
    const nextList=state.nextListAttemptAt?Date.parse(state.nextListAttemptAt):state.listWork?0:Date.parse(state.lastCheckedAt)+LIST_REFRESH_INTERVAL;
    if(options?.forceList||!Number.isFinite(nextList)||now>=nextList){
      try{
        const listed=await source.list(state.listWork);
        freshItems=Array.isArray(listed)?listed:listed.items;
        if(freshItems&&(!freshItems.length||new Set(freshItems.map(i=>i.title)).size!==freshItems.length))throw Error('invalid_or_empty_regulation_list');
        state.listWork=Array.isArray(listed)?undefined:listed.work;
        state.listRetryAttempts=0;
        state.nextListAttemptAt=new Date(freshItems?now+LIST_REFRESH_INTERVAL:now+RETRY_BASE).toISOString();
        if(freshItems){state.lastCheckedAt=timestamp;delete state.listError;}
        else if(state.listError)state.listError.next_retry_at=state.nextListAttemptAt;
      }catch(error){
        if(error&&typeof error==='object'&&'listWork' in error)state.listWork=error.listWork;
        if(/index_list_changed|incomplete_index_list|invalid_index_list|invalid_or_empty_regulation_list/.test(String(error)))state.listWork=undefined;
        const attempts=(state.listRetryAttempts??0)+1;state.listRetryAttempts=attempts;
        state.nextListAttemptAt=new Date(now+retryDelay(attempts)).toISOString();
        state.listError={title:'ALIO list',message:String(error).slice(0,240),checkedAt:timestamp,build_version:buildVersion,error_code:indexErrorCode(error),retry_attempts:attempts,next_retry_at:state.nextListAttemptAt,diagnostics:errorDiagnostics(error)};
      }
    }
    const items=freshItems??state.items;
    if(!items.length&&!freshItems){await options?.beforeCommit?.();await kv.put(INDEX_PREFIX+'state',JSON.stringify(state));return {processed:0,updated:0,index_build_version:buildVersion,index_status:'building_list',errors:errorSummary(state),...timing(state)};}
    if(!items.length||new Set(items.map(i=>i.title)).size!==items.length)throw Error('invalid_or_empty_regulation_list');
    state.items=items;if(freshItems)state.lastCheckedAt=timestamp;delete state.sourceError;delete state.sourceErrorAt;delete state.sourceErrorCode;
    delete state.sourceErrorDetails;
    const titles=new Set(items.map(i=>i.title));
    const indexed=new Set((state.indexedTitles??[]).filter(title=>titles.has(title)));
    for(const title of Object.keys(state.errors))if(!titles.has(title))delete state.errors[title];
    for(const title of Object.keys(state.checked))if(!titles.has(title))delete state.checked[title];
    const oldItems=new Map(previous.items.map(i=>[i.title,i]));
    for(const item of items)if(!sameMetadata(item,oldItems.get(item.title)??item)){delete state.errors[item.title];delete state.checked[item.title];}
    state.pending=[...new Set([...(state.pending??[]),...items.filter(i=>!oldItems.has(i.title)||!sameMetadata(i,oldItems.get(i.title)!)).map(i=>i.title)])].filter(title=>titles.has(title));
    const selected=items.filter(item=>{
      const error=state.errors[item.title];
      if(error)return !error.next_retry_at||now>=Date.parse(error.next_retry_at);
      return options?.forceDocuments||state.pending!.includes(item.title)||!state.checked[item.title]||now-Date.parse(state.checked[item.title])>=DOCUMENT_CHECK_INTERVAL;
    }).sort((a,b)=>{
      const priority=(item:CorpusItem)=>state.pending!.includes(item.title)?0:1;
      // Failed entries rotate with the sweep instead of starving other entries.
      return (state.errors[a.title]?1:priority(a)*2)-(state.errors[b.title]?1:priority(b)*2)||
        (state.checked[a.title]??'').localeCompare(state.checked[b.title]??'')||a.title.localeCompare(b.title);
    }).slice(0,INDEX_BATCH);
    for(const item of selected){
      processed++;state.checked[item.title]=timestamp;
      try{
        const id=shardId(item.title);
        let shard=changed.get(id);if(!shard){shard=await readShard(kv,state,id);changed.set(id,shard);}
        const loaded=await source.load(item);
        if(!loaded.fileNo||!loaded.text.trim())throw Error('empty_or_unselected_document');
        const hash=await sha256(loaded.bytes);
        const doc:CorpusDocument={...item,fileNo:loaded.fileNo,text:loaded.text,sha256:hash,verifiedAt:timestamp,parserVersion:loaded.parserVersion,searchSections:prepareSearchSections(loaded.text),attachments:loaded.attachments,selectedDate:loaded.selectedDate};
        const old=shard.documents[item.title];
        const retained=Object.fromEntries(Object.entries(shard.documents).filter(([title])=>titles.has(title)));
        const candidate={documents:{...retained,[item.title]:doc}};
        const size=new TextEncoder().encode(JSON.stringify(candidate)).byteLength;
        if(size>MAX_SHARD_BYTES)throw Error('index_shard_size_limit');
        const total=Object.values(state.sizes).reduce((a,b)=>a+b,0)-(state.sizes[id]??0)+size;
        if(total>MAX_CORPUS_BYTES)throw Error('index_corpus_size_limit');
        state.sizes[id]=size;shard.documents=candidate.documents;
        if(loaded.attachments)(state.attachmentCatalog??={})[item.title]={fileNo:doc.fileNo,selectedDate:doc.selectedDate,attachments:loaded.attachments};
        for(const title of Object.keys(candidate.documents))indexed.add(title);
        if(!old||old.sha256!==hash||old.fileNo!==doc.fileNo||old.parserVersion!==doc.parserVersion||!sameMetadata(old,doc))updated++;
        delete state.errors[item.title];state.pending=state.pending.filter(title=>title!==item.title);
      }catch(error){const attempts=(state.errors[item.title]?.retry_attempts??0)+1;state.errors[item.title]={title:item.title,message:String(error).slice(0,240),checkedAt:timestamp,code:indexErrorCode(error),error_code:indexErrorCode(error),build_version:buildVersion,retry_attempts:attempts,next_retry_at:new Date(now+retryDelay(attempts)).toISOString(),diagnostics:errorDiagnostics(error)};}
    }
    if(state.attachmentCatalog){state.attachmentCatalog=Object.fromEntries(Object.entries(state.attachmentCatalog).filter(([title])=>titles.has(title)));state.crossEntryWarnings=buildCrossAttachmentWarnings(items.map(i=>i.title),state.attachmentCatalog);}
    // Verify the writer lease before any mutations and again before publication.
    await options?.beforeCommit?.();
    // New keys are written first; referenced old keys stay intact on any failure.
    for(const [id,shard] of changed){
      const key=INDEX_PREFIX+'shard:'+id+':'+crypto.randomUUID();
      await kv.put(key,JSON.stringify(shard));writtenKeys.push(key);
      if(state.refs[id]){(state.fallbackRefs??={})[id]=state.refs[id];state.garbage.push({key:state.refs[id],after:now+15*60*1000});}
      state.refs[id]=key;
    }
    state.cursor=new Set([...state.pending,...items.filter(i=>!state.checked[i.title]).map(i=>i.title)]).size;
    state.indexedTitles=[...indexed];if(processed)state.lastVerifiedAt=timestamp;
    if(!state.cursor&&!Object.keys(state.errors).length&&!state.listError&&(processed||freshItems))state.lastCompletedAt=timestamp;
    // GC waits beyond KV propagation, runs only in Cron, and never deletes refs.
    const protectedKeys=[...Object.values(state.refs),...Object.values(state.fallbackRefs??{})];
    const due=state.garbage.filter(g=>g.after<=now&&!protectedKeys.includes(g.key)).slice(0,INDEX_BATCH);
    for(const g of due)if(!Object.values(state.refs).includes(g.key))await kv.delete(g.key);
    state.garbage=state.garbage.filter(g=>!due.includes(g));
    await options?.beforeCommit?.();await kv.put(INDEX_PREFIX+'state',JSON.stringify(state));
  }catch(error){
    // State records failure but points to exactly the old, valid snapshot.
    previous.sourceError=String(error).slice(0,240);previous.sourceErrorAt=timestamp;previous.sourceErrorCode=indexErrorCode(error);
    previous.sourceErrorDetails=errorDiagnostics(error);
    previous.garbage.push(...writtenKeys.map(key=>({key,after:now+15*60*1000})));
    previous.listWork=/index_list_changed|incomplete_index_list/.test(String(error))?undefined:state.listWork;
    await options?.beforeCommit?.();
    try{await kv.put(INDEX_PREFIX+'state',JSON.stringify(previous));}catch(writeError){throw Error('index_state_write_failed:'+String(writeError));}
    return {processed,updated:0,indexedRegulations:previous.indexedTitles?.length??0,index_build_version:buildVersion,lastVerifiedAt:previous.lastVerifiedAt??null,lastCompletedAt:previous.lastCompletedAt??null,index_status:'stale',errors:errorSummary(previous),...timing(previous)};
  }
  return {processed,updated,indexedRegulations:state.indexedTitles?.length??0,next_cursor:state.cursor||null,errors:errorSummary(state),lastCheckedAt:state.lastCheckedAt,lastVerifiedAt:state.lastVerifiedAt??state.lastCheckedAt,index_build_version:state.index_build_version??null,lastCompletedAt:state.lastCompletedAt??null,...timing(state)};
}
export async function readIndex(kv:KVNamespace,now=Date.now(),expectedBuildVersion?:string){
  const state=await readState(kv);if(!state)return {documents:[] as CorpusDocument[],partial:true,index_status:'building',errors:{count:0,sample:[],retry_cursor:null},total:0,lastCheckedAt:null,lastVerifiedAt:null,lastCompletedAt:null,index_build_version:null,...timing(emptyState())};
  const documents:CorpusDocument[]=[];const failures:ErrorEntry[]=[];
  // At most four 2 MB shard reads in flight; retain shard order deterministically.
  for(let start=0;start<INDEX_SHARDS;start+=4){
    const batch=await Promise.all(Array.from({length:Math.min(4,INDEX_SHARDS-start)},async(_,offset)=>{
      const id=start+offset;
      try{return {documents:Object.values((await readShard(kv,state,id)).documents)};}
      catch(error){
        const failure:ErrorEntry={title:'KV shard '+id,message:String(error),checkedAt:new Date(now).toISOString(),error_code:'fetch_failed',build_version:expectedBuildVersion??state.index_build_version};
        if(state.fallbackRefs?.[id])try{const old=await kv.get<Shard>(state.fallbackRefs[id],'json');if(old?.documents)return {documents:Object.values(old.documents),failure};}catch{ /* Preserve the primary failure. */ }
        return {documents:[] as CorpusDocument[],failure};
      }
    }));
    for(const result of batch){documents.push(...result.documents);if(result.failure)failures.push(result.failure);}
  }
  const wanted=new Map(state.items.map(i=>[i.title,i]));
  const active=documents.filter(d=>wanted.has(d.title));
  const fresh=active.filter(d=>sameMetadata(d,wanted.get(d.title)!)&&now-Date.parse(d.verifiedAt)<=MAX_INDEX_AGE);
  const buildMatches=!expectedBuildVersion||state.index_build_version===expectedBuildVersion;
  const errors=buildMatches?errorSummary(state):{count:0,sample:[] as ErrorEntry[],retry_cursor:state.cursor};errors.count+=failures.length;errors.sample=[...errors.sample,...failures].sort((a,b)=>b.checkedAt.localeCompare(a.checkedAt)).slice(0,3);
  if(failures.length)errors.retry_cursor=state.cursor;
  const listFresh=now-Date.parse(state.lastCheckedAt)<=MAX_LIST_AGE;
  const partial=!buildMatches||!!state.pending?.length||!state.items.length||fresh.length!==state.items.length||!!errors.count||!listFresh;
  return {documents:active,partial,index_status:partial?(active.length?'stale':'building'):'ready',errors,total:state.items.length,lastCheckedAt:state.lastCheckedAt,lastVerifiedAt:state.lastVerifiedAt??state.lastCheckedAt,index_build_version:state.index_build_version??null,lastCompletedAt:state.lastCompletedAt??null,...timing(state)};
}
