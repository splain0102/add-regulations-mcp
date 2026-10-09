import {fold,tokenWeights,deletedSection,sectionScore} from '../../src/regulation-core/search-ranking';
import {searchBounds} from '../../src/regulation-core/search-sections';
// Frozen v1.10.9 SERIAL read algorithm with current ranking rules, for IO equivalence/benchmarks.
import {INDEX_PREFIX,INDEX_SHARDS,MAX_INDEX_AGE,MAX_LIST_AGE,indexErrorCode,type CorpusDocument,type CorpusItem,type IndexState} from '../../src/regulation-core/corpus-index';
import {extractArticleSnippet} from '../../src/regulation-core/regulations';
type ErrorEntry=any;type Shard={documents:Record<string,CorpusDocument>};
function sameMetadata(a:CorpusItem,b:CorpusItem){return a.title===b.title&&a.detailUrl===b.detailUrl&&a.revisionDate===b.revisionDate&&a.updatedDate===b.updatedDate;}
function emptyState():IndexState{return {schema:2,cursor:0,items:[],refs:{},sizes:{},checked:{},errors:{},lastCheckedAt:'',garbage:[]};}
async function readState(kv:KVNamespace){return await kv.get<IndexState>(INDEX_PREFIX+'state','json');}
async function readShard(kv:KVNamespace,state:IndexState,id:number):Promise<Shard>{
  const key=state.refs[id];if(!key)return {documents:{}};
  const shard=await kv.get<Shard>(key,'json');if(!shard||!shard.documents)throw Error('index_shard_unavailable:'+id);
  return shard;
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
export async function readIndex(kv:KVNamespace,now=Date.now(),expectedBuildVersion?:string){
  const state=await readState(kv);if(!state)return {documents:[] as CorpusDocument[],partial:true,index_status:'building',errors:{count:0,sample:[],retry_cursor:null},total:0,lastCheckedAt:null,lastVerifiedAt:null,lastCompletedAt:null,index_build_version:null,...timing(emptyState())};
  const documents:CorpusDocument[]=[];const failures:ErrorEntry[]=[];
  // Serial reads keep peak memory bounded; no ALIO fetch is performed here.
  for(let id=0;id<INDEX_SHARDS;id++){
    try{const shard=await readShard(kv,state,id);documents.push(...Object.values(shard.documents));}
    catch(error){failures.push({title:'KV shard '+id,message:String(error),checkedAt:new Date(now).toISOString(),error_code:'fetch_failed',build_version:expectedBuildVersion??state.index_build_version});
      if(state.fallbackRefs?.[id]){try{const old=await kv.get<Shard>(state.fallbackRefs[id],'json');if(old?.documents)documents.push(...Object.values(old.documents));}catch{ /* Error remains visible; no false ready state. */ }}
    }
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
export async function searchAllRegulations(query:string,limit=10,offset=0,kv?:KVNamespace,buildVersion?:string){
 const terms=query.toLowerCase().trim().split(/\s+/).filter(Boolean);
 if(!kv) return {query,limit,offset,results:[],errors:{count:1,sample:[{code:'index_unavailable'}],retry_cursor:null},partial:true,index_status:'unavailable',next_cursor:null};
 const index=await readIndex(kv,Date.now(),buildVersion);const docs=index.documents;
 const results:any[]=[];
 if(terms.length)for(const doc of docs){
  const content=doc.text;
  const bounds=searchBounds(content,doc.searchSections);
  const found:any[]=[];
  for(let i=0;i<bounds.length-1;i++){
   const part=content.slice(bounds[i],bounds[i+1]).toLowerCase();
   const article=content.slice(bounds[i],bounds[i+1]);
   if(deletedSection(article))continue;
   const folded=fold(article);if(!terms.every(t=>folded.includes(fold(t))))continue;
   const weights=tokenWeights(article,terms);if(weights.some(w=>!w))continue;
   const at=bounds[i]+Math.max(0,part.indexOf(terms[0]));
   const snippet=extractArticleSnippet(article,at-bounds[i],query.length,true);
   const label=article.match(/^\s*(제\s*\d+\s*조(?:의\s*\d+)?(?:\s*\([^\n)]*\))?|부\s*칙(?:\s*<[^\n>]+>)?|\[(?:별표|별지)[^\]\n]*\])/)?.[1]??snippet.label;
   const score=sectionScore(article,label,query,weights);
   found.push({label,snippet:snippet.snippet,score});
  }
  if(found.length)results.push({regulationName:doc.title,fileNo:doc.fileNo,revisionDate:doc.revisionDate,updatedDate:doc.updatedDate,indexedAt:doc.verifiedAt,sha256:doc.sha256,score:Math.max(...found.map(m=>m.score))+0.1*found.map(m=>m.score).sort((a,b)=>b-a).slice(0,3).reduce((sum,n)=>sum+n,0),matches:found.sort((a,b)=>b.score-a.score).slice(0,3)});
 }
 results.sort((a,b)=>b.score-a.score||b.matches[0].score-a.matches[0].score||a.regulationName.localeCompare(b.regulationName,'ko'));
 const next_cursor=offset+limit<results.length?offset+limit:null;
 return {query,limit,offset,totalRegulations:index.total,indexedRegulations:docs.length,totalMatches:results.length,results:results.slice(offset,offset+limit),
 errors:index.errors,partial:index.partial,index_status:index.index_status,lastVerifiedAt:index.lastVerifiedAt,index_build_version:index.index_build_version,lastCompletedAt:index.lastCompletedAt,next_cursor,
 last_list_verified_at:index.last_list_verified_at,next_list_refresh_at:index.next_list_refresh_at,next_retry_at:index.next_retry_at};
}
