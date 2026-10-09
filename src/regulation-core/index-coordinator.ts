import {BUILD_VERSION} from '../build-info';
import {createIndexRequest,refreshCorpusIndex} from './regulations';
import {indexErrorCode,readIndex} from './corpus-index';

type Run = {run_id:string;build_version:string;trigger:'cron'|'manual';started_at:string;finished_at:string|null;processed:number;duration_ms:number;subrequests_used:number;subrequest_limit:number;status:string;error_code?:string;result?:unknown};
type History = {latest?:Run;last_cron_started_at?:string;last_cron_finished_at?:string};
export class CorpusIndexCoordinator {
 private running=false;
 private state:DurableObjectState;
 private env:{OAUTH_KV:KVNamespace};
 constructor(state:DurableObjectState,env:{OAUTH_KV:KVNamespace}){this.state=state;this.env=env;}
 async fetch(request:Request):Promise<Response>{
  const path=new URL(request.url).pathname;
  if(path==='/status'){
   const history=await this.state.storage.get<History>('runs')??{};
   return Response.json({last_cron_started_at:history.last_cron_started_at??null,last_cron_finished_at:history.last_cron_finished_at??null,
    processed_in_last_run:history.latest?.processed??0,last_index_run:history.latest??null});
  }
  if(path!=='/run'||request.method!=='POST')return new Response('Not found',{status:404});
  if(this.running)return Response.json({error_code:'index_busy'},{status:409});
  this.running=true;
  const started=Date.now(),transport=createIndexRequest();
  let history:History={},run:Run={run_id:crypto.randomUUID(),build_version:BUILD_VERSION,trigger:'manual',started_at:new Date(started).toISOString(),finished_at:null,processed:0,duration_ms:0,subrequests_used:0,subrequest_limit:40,status:'running'};
  try{
   const input=await request.json() as {trigger?:string};run.trigger=input.trigger==='cron'?'cron':'manual';
   history=await this.state.storage.get<History>('runs')??{};
   if(history.latest?.finished_at&&Date.now()-Date.parse(history.latest.finished_at)<1100){this.running=false;return Response.json({error_code:'index_rate_limited'},{status:429,headers:{'retry-after':'2'}});}
   if(history.latest?.status==='running')console.error('corpus_index_previous_run_interrupted',{...history.latest,error_code:'timeout'});
   history.latest=run;if(run.trigger==='cron')history.last_cron_started_at=run.started_at;
   await this.state.storage.put('runs',history);
   console.log('corpus_index_run_started',JSON.stringify(run));
   const result=await refreshCorpusIndex(this.env.OAUTH_KV,BUILD_VERSION,transport,{forceDocuments:run.trigger==='manual'});
   run.processed=result.processed;run.status=result.errors.count?'partial':'success';run.result=result;
  }catch(error){run.status='failed';run.error_code=indexErrorCode(error);run.result={message:String(error).slice(0,240)};}
  try{
   run.finished_at=new Date().toISOString();run.duration_ms=Date.now()-started;run.subrequests_used=transport.usage!().used;
   history.latest=run;if(run.trigger==='cron')history.last_cron_finished_at=run.finished_at;
   await this.state.storage.put('runs',history);
   console.log('corpus_index_run_finished',JSON.stringify(run));
   return Response.json(run,{status:run.status==='failed'?500:200});
  }finally{this.running=false;}
 }
}
type CoordinatorEnv={CORPUS_INDEX_COORDINATOR:DurableObjectNamespace;INDEX_ADMIN_TOKEN?:string;OAUTH_KV:KVNamespace};
function coordinator(env:CoordinatorEnv){return env.CORPUS_INDEX_COORDINATOR.get(env.CORPUS_INDEX_COORDINATOR.idFromName('add-corpus-index'));}
export async function runCoordinatedIndex(env:CoordinatorEnv,trigger:'cron'|'manual'){
 return coordinator(env).fetch('https://index.internal/run',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({trigger})});
}
export async function getIndexRuntimeStatus(env:CoordinatorEnv){
 try{const response=await coordinator(env).fetch('https://index.internal/status');if(!response.ok)throw Error('HTTP '+response.status);return await response.json() as {last_cron_started_at:string|null;last_cron_finished_at:string|null;processed_in_last_run:number;last_index_run:Run|null};}
 catch(error){return {last_cron_started_at:null,last_cron_finished_at:null,processed_in_last_run:0,last_index_run:null,cron_status_error:String(error).slice(0,200)};}
}
async function authorized(request:Request,secret:string){
 const supplied=request.headers.get('authorization')?.match(/^Bearer (.+)$/)?.[1];if(!supplied)return false;
 const encode=new TextEncoder();const [a,b]=await Promise.all([crypto.subtle.digest('SHA-256',encode.encode(secret)),crypto.subtle.digest('SHA-256',encode.encode(supplied))]);
 const first=new Uint8Array(a),second=new Uint8Array(b);let diff=0;for(let i=0;i<first.length;i++)diff|=first[i]^second[i];return diff===0;
}
export async function handleIndexAdmin(request:Request,env:CoordinatorEnv):Promise<Response|null>{
 const path=new URL(request.url).pathname;if(path!=='/admin/trigger-index'&&path!=='/admin/index-status')return null;
 if(!env.INDEX_ADMIN_TOKEN)return Response.json({error_code:'admin_token_not_configured'},{status:503});
 if(!await authorized(request,env.INDEX_ADMIN_TOKEN))return Response.json({error_code:'unauthorized'},{status:401});
 if(path==='/admin/trigger-index'){
  if(request.method!=='POST')return Response.json({error_code:'method_not_allowed'},{status:405,headers:{allow:'POST'}});
  return runCoordinatedIndex(env,'manual');
 }
 if(request.method!=='GET')return Response.json({error_code:'method_not_allowed'},{status:405,headers:{allow:'GET'}});
 const [index,status]=await Promise.all([readIndex(env.OAUTH_KV,Date.now(),BUILD_VERSION),getIndexRuntimeStatus(env)]);
 return Response.json({...status,index_build_version:index.index_build_version,indexedRegulations:index.documents.length,totalRegulations:index.total,
  partial:index.partial,lastVerifiedAt:index.lastVerifiedAt,lastCompletedAt:index.lastCompletedAt,errors:index.errors,
  last_list_verified_at:index.last_list_verified_at,next_list_refresh_at:index.next_list_refresh_at,next_retry_at:index.next_retry_at});
}
