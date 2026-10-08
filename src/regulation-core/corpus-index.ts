// Only the Cron writer contacts ALIO. Search reads a committed KV manifest.
export const INDEX_PREFIX = 'add:corpus:v2:';
export const INDEX_SHARDS = 16;
export const INDEX_BATCH = 2;
export const MAX_SHARD_BYTES = 2_000_000;
export const MAX_CORPUS_BYTES = 16_000_000;
export const MAX_INDEX_AGE = 24 * 60 * 60 * 1000;
export type CorpusItem = {title:string;detailUrl:string;revisionDate?:string;updatedDate?:string};
export type CorpusDocument = CorpusItem & {fileNo:string;text:string;sha256:string;verifiedAt:string;parserVersion:string};
type ErrorEntry = {title:string;message:string;checkedAt:string};
type Shard = {documents:Record<string,CorpusDocument>};
export type IndexState = {
  schema:2;cursor:number;items:CorpusItem[];refs:Record<string,string>;sizes:Record<string,number>;
  listWork?:unknown;checked:Record<string,string>;errors:Record<string,ErrorEntry>;lastCheckedAt:string;
  lastCompletedAt?:string;sourceError?:string;garbage:{key:string;after:number}[];
};
export type CorpusSource = {list(work?:unknown):Promise<CorpusItem[]|{items?:CorpusItem[];work?:unknown}>;load(item:CorpusItem):Promise<{fileNo:string;text:string;bytes:Uint8Array;parserVersion:string}>};
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
function errorSummary(state:IndexState){const errors=Object.values(state.errors);return {count:errors.length+(state.sourceError?1:0),sample:[...(state.sourceError?[{title:'ALIO/KV',message:state.sourceError}]:[]),...errors].slice(0,3),retry_cursor:errors.length||state.sourceError?state.cursor:null};}
// KV is not a lock: run one Cron writer. Immutable shards + one manifest prevent
// a failed multi-key write from destroying the preceding committed snapshot.
export async function refreshIndex(kv:KVNamespace,source:CorpusSource,now=Date.now()){
  const previous=await readState(kv)??emptyState();
  const state:IndexState=structuredClone(previous);
  const timestamp=new Date(now).toISOString();
  const changed=new Map<number,Shard>();const writtenKeys:string[]=[];let processed=0,updated=0;
  try{
    const listed=await source.list(state.listWork);
    const freshItems=Array.isArray(listed)?listed:listed.items;
    state.listWork=Array.isArray(listed)?undefined:listed.work;
    const items=freshItems??state.items;
    if(!items.length&&!freshItems){await kv.put(INDEX_PREFIX+'state',JSON.stringify(state));return {processed:0,updated:0,index_status:'building_list',errors:errorSummary(state)};}
    if(!items.length||new Set(items.map(i=>i.title)).size!==items.length)throw Error('invalid_or_empty_regulation_list');
    state.items=items;if(freshItems)state.lastCheckedAt=timestamp;delete state.sourceError;
    const titles=new Set(items.map(i=>i.title));
    for(const title of Object.keys(state.errors))if(!titles.has(title))delete state.errors[title];
    for(const title of Object.keys(state.checked))if(!titles.has(title))delete state.checked[title];
    const oldItems=new Map(previous.items.map(i=>[i.title,i]));
    const selected=[...items].sort((a,b)=>{
      const priority=(item:CorpusItem)=>!oldItems.has(item.title)||!sameMetadata(item,oldItems.get(item.title)!)?0:1;
      // Failed entries rotate with the sweep instead of starving other entries.
      return (state.errors[a.title]?1:priority(a))-(state.errors[b.title]?1:priority(b))||
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
        const doc:CorpusDocument={...item,fileNo:loaded.fileNo,text:loaded.text,sha256:hash,verifiedAt:timestamp,parserVersion:loaded.parserVersion};
        const old=shard.documents[item.title];
        const retained=Object.fromEntries(Object.entries(shard.documents).filter(([title])=>titles.has(title)));
        const candidate={documents:{...retained,[item.title]:doc}};
        const size=new TextEncoder().encode(JSON.stringify(candidate)).byteLength;
        if(size>MAX_SHARD_BYTES)throw Error('index_shard_size_limit');
        const total=Object.values(state.sizes).reduce((a,b)=>a+b,0)-(state.sizes[id]??0)+size;
        if(total>MAX_CORPUS_BYTES)throw Error('index_corpus_size_limit');
        state.sizes[id]=size;shard.documents=candidate.documents;
        if(!old||old.sha256!==hash||old.fileNo!==doc.fileNo||old.parserVersion!==doc.parserVersion||!sameMetadata(old,doc))updated++;
        delete state.errors[item.title];
      }catch(error){state.errors[item.title]={title:item.title,message:String(error).slice(0,240),checkedAt:timestamp};}
    }
    // New keys are written first; referenced old keys stay intact on any failure.
    for(const [id,shard] of changed){
      const key=INDEX_PREFIX+'shard:'+id+':'+crypto.randomUUID();
      await kv.put(key,JSON.stringify(shard));writtenKeys.push(key);
      if(state.refs[id])state.garbage.push({key:state.refs[id],after:now+15*60*1000});
      state.refs[id]=key;
    }
    state.cursor=items.filter(i=>!state.checked[i.title]).length;
    if(!state.cursor&&!Object.keys(state.errors).length)state.lastCompletedAt=timestamp;
    // GC waits beyond KV propagation, runs only in Cron, and never deletes refs.
    const due=state.garbage.filter(g=>g.after<=now).slice(0,INDEX_BATCH);
    for(const g of due)if(!Object.values(state.refs).includes(g.key))await kv.delete(g.key);
    state.garbage=state.garbage.filter(g=>!due.includes(g));
    await kv.put(INDEX_PREFIX+'state',JSON.stringify(state));
  }catch(error){
    // State records failure but points to exactly the old, valid snapshot.
    previous.sourceError=String(error).slice(0,240);
    previous.garbage.push(...writtenKeys.map(key=>({key,after:now+15*60*1000})));
    previous.listWork=/index_list_changed|incomplete_index_list/.test(String(error))?undefined:state.listWork;
    try{await kv.put(INDEX_PREFIX+'state',JSON.stringify(previous));}catch(writeError){throw Error('index_state_write_failed:'+String(writeError));}
    return {processed,updated:0,index_status:'stale',errors:errorSummary(previous)};
  }
  return {processed,updated,next_cursor:state.cursor||null,errors:errorSummary(state),lastCheckedAt:state.lastCheckedAt};
}
export async function readIndex(kv:KVNamespace,now=Date.now()){
  const state=await readState(kv);if(!state)return {documents:[] as CorpusDocument[],partial:true,index_status:'building',errors:{count:0,sample:[],retry_cursor:null},total:0,lastCheckedAt:null,lastCompletedAt:null};
  const documents:CorpusDocument[]=[];const failures:ErrorEntry[]=[];
  // Serial reads keep peak memory bounded; no ALIO fetch is performed here.
  for(let id=0;id<INDEX_SHARDS;id++){
    try{const shard=await readShard(kv,state,id);documents.push(...Object.values(shard.documents));}
    catch(error){failures.push({title:'KV shard '+id,message:String(error),checkedAt:''});}
  }
  const wanted=new Map(state.items.map(i=>[i.title,i]));
  const active=documents.filter(d=>wanted.has(d.title));
  const fresh=active.filter(d=>sameMetadata(d,wanted.get(d.title)!)&&now-Date.parse(d.verifiedAt)<=MAX_INDEX_AGE);
  const errors=errorSummary(state);errors.count+=failures.length;errors.sample=[...errors.sample,...failures].slice(0,3);
  if(failures.length)errors.retry_cursor=state.cursor;
  const listFresh=now-Date.parse(state.lastCheckedAt)<=45*60*1000;
  const partial=!state.items.length||fresh.length!==state.items.length||!!errors.count||!listFresh;
  return {documents:active,partial,index_status:partial?(active.length?'stale':'building'):'ready',errors,total:state.items.length,lastCheckedAt:state.lastCheckedAt,lastCompletedAt:state.lastCompletedAt??null};
}
