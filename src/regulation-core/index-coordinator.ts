import {BUILD_VERSION} from '../build-info';
import {createIndexRequest,refreshCorpusIndex} from './regulations';
import {indexErrorCode,errorDiagnostics,readIndex} from './corpus-index';
import {probeAlio} from './network-probe';
import {bootstrapActive,handleBootstrap} from './index-bootstrap';

type Run={run_id:string;build_version:string;trigger:'cron'|'manual';execution:'worker';started_at:string;finished_at:string|null;processed:number;duration_ms:number;subrequests_used:number;subrequest_limit:number;status:string;error_code?:string;result?:unknown};
export const INDEX_LEASE_MS=5*60*1000;
type History={latest?:Run;last_interrupted_run?:Run;last_build_mismatch?:Run;last_cron_started_at?:string;last_cron_finished_at?:string};
type Lease={run_id:string;token:string;expires_at:number;build_version:string};
export class CorpusIndexCoordinator {
 private busy=false;
 private state:DurableObjectState;
 private env:{OAUTH_KV:KVNamespace};
 constructor(state:DurableObjectState,env:{OAUTH_KV:KVNamespace}){this.state=state;this.env=env;}
 private async recoverInterrupted(){
  const lease=await this.state.storage.get<Lease>('lease');
  if(!lease||lease.expires_at<=0)return;
  if(lease.build_version===BUILD_VERSION&&lease.expires_at>Date.now())return;
  const history=await this.state.storage.get<History>('runs')??{};
  if(history.latest?.run_id===lease.run_id&&history.latest.status==='running'){
   const run={...history.latest,status:'interrupted',error_code:'execution_interrupted',finished_at:new Date().toISOString(),duration_ms:Date.now()-Date.parse(history.latest.started_at)};
   history.latest=run;history.last_interrupted_run=run;
   if(run.trigger==='cron')history.last_cron_finished_at=run.finished_at;
   await this.state.storage.put({runs:history,lease:{...lease,expires_at:0}});
   console.error('corpus_index_run_recovered',JSON.stringify(run));
  }else await this.state.storage.put('lease',{...lease,expires_at:0});
 }
 async alarm(){
  await this.recoverInterrupted();
  const lease=await this.state.storage.get<Lease>('lease');
  if(lease&&lease.expires_at>Date.now())await this.state.storage.setAlarm(lease.expires_at);
 }
 async fetch(request:Request):Promise<Response>{
  const path=new URL(request.url).pathname;
  if(path==='/status'){
   await this.recoverInterrupted();
   const history=await this.state.storage.get<History>('runs')??{};
   return Response.json({last_interrupted_run:history.last_interrupted_run??null,hello_build_version:BUILD_VERSION,last_build_mismatch:history.last_build_mismatch??null,last_cron_started_at:history.last_cron_started_at??null,last_cron_finished_at:history.last_cron_finished_at??null,processed_in_last_run:history.latest?.processed??0,last_index_run:history.latest??null});
  }
  if(path==='/probe'&&request.method==='POST')return Response.json(await Promise.all([probeAlio('durable_object',false),probeAlio('durable_object',true)]));
  if(request.method!=='POST')return new Response('Not found',{status:404});
  if(this.busy)return Response.json({error_code:'index_busy'},{status:409});
  this.busy=true;
  try{
   await this.recoverInterrupted();
   const lease=await this.state.storage.get<Lease>('lease');
   if(path.startsWith('/bootstrap/')){
    if(lease&&lease.build_version===BUILD_VERSION&&lease.expires_at>Date.now())return Response.json({error_code:'index_busy'},{status:409});
    return await handleBootstrap(path,request,this.state.storage,this.env.OAUTH_KV);
   }
   if(path==='/begin'){
    const input=await request.json() as {trigger?:string;build_version?:string};
    if(input.build_version&&input.build_version!==BUILD_VERSION){
     const now=new Date().toISOString(),history=await this.state.storage.get<History>('runs')??{};
     const run:Run={run_id:crypto.randomUUID(),build_version:input.build_version,trigger:input.trigger==='cron'?'cron':'manual',execution:'worker',started_at:now,finished_at:now,processed:0,duration_ms:0,subrequests_used:0,subrequest_limit:36,status:'build_mismatch',error_code:'build_mismatch',result:{hello_build_version:BUILD_VERSION}};
     history.last_build_mismatch=run;history.latest=run;if(run.trigger==='cron'){history.last_cron_started_at=now;history.last_cron_finished_at=now;}await this.state.storage.put('runs',history);
     console.error('corpus_index_build_mismatch',JSON.stringify(run));return Response.json(run,{status:409});
    }
    if(lease&&lease.build_version===BUILD_VERSION&&lease.expires_at>Date.now())return Response.json({error_code:'index_busy'},{status:409});
    if(await bootstrapActive(this.state.storage))return Response.json({error_code:'bootstrap_in_progress'},{status:409});
    const history=await this.state.storage.get<History>('runs')??{};
    if(history.latest?.finished_at&&Date.now()-Date.parse(history.latest.finished_at)<1100)return Response.json({error_code:'index_rate_limited'},{status:429,headers:{'retry-after':'2'}});
    if(history.latest?.status==='running')console.error('corpus_index_previous_run_interrupted',{...history.latest,error_code:'timeout'});
    const started=Date.now();
    const run:Run={run_id:crypto.randomUUID(),build_version:BUILD_VERSION,trigger:input.trigger==='cron'?'cron':'manual',execution:'worker',started_at:new Date(started).toISOString(),finished_at:null,processed:0,duration_ms:0,subrequests_used:0,subrequest_limit:36,status:'running'};
    history.latest=run;if(run.trigger==='cron')history.last_cron_started_at=run.started_at;
    const next:Lease={run_id:run.run_id,token:crypto.randomUUID(),expires_at:started+INDEX_LEASE_MS,build_version:BUILD_VERSION};
    await this.state.storage.put({runs:history,lease:next});
    await this.state.storage.setAlarm(next.expires_at);
    console.log('corpus_index_run_started',JSON.stringify(run));
    return Response.json({run,lease_token:next.token});
   }
   if(path==='/assert'||path==='/finish'){
    const input=await request.json() as {run_id:string;lease_token:string;run?:Run};
    if(!lease||lease.build_version!==BUILD_VERSION||lease.run_id!==input.run_id||lease.token!==input.lease_token||lease.expires_at<=Date.now())return Response.json({error_code:'index_lease_expired'},{status:409});
    if(path==='/assert')return new Response(null,{status:204});
    const history=await this.state.storage.get<History>('runs')??{};
    const run={...history.latest!,...input.run,run_id:lease.run_id};history.latest=run;
    if(run.trigger==='cron')history.last_cron_finished_at=run.finished_at??undefined;
    await this.state.storage.put({runs:history,lease:{...lease,expires_at:0}});
    console.log('corpus_index_run_finished',JSON.stringify(run));
    return Response.json(run,{status:run.status==='failed'?500:200});
   }
   return new Response('Not found',{status:404});
  }finally{this.busy=false;}
 }
}
type CoordinatorEnv={CORPUS_INDEX_COORDINATOR:DurableObjectNamespace;INDEX_ADMIN_TOKEN?:string;OAUTH_KV:KVNamespace};
function coordinator(env:CoordinatorEnv){return env.CORPUS_INDEX_COORDINATOR.get(env.CORPUS_INDEX_COORDINATOR.idFromName('add-corpus-index'));}
export async function runCoordinatedIndex(env:CoordinatorEnv,trigger:'cron'|'manual'){
 const stub=coordinator(env);const send=(path:string,body:unknown)=>stub.fetch('https://index.internal'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
 const acquired=await send('/begin',{trigger,build_version:BUILD_VERSION});if(!acquired.ok)return acquired;
 const {run,lease_token}=await acquired.json() as {run:Run;lease_token:string};
 const transport=createIndexRequest(fetch,Date.now,36),started=Date.now();
 const identity={run_id:run.run_id,lease_token};
 try{
  const result=await refreshCorpusIndex(env.OAUTH_KV,BUILD_VERSION,transport,{forceDocuments:trigger==='manual',batchSize:trigger==='cron'?1:2,beforeCommit:async()=>{const response=await send('/assert',identity);if(!response.ok)throw Error('index_lease_expired');}});
  run.processed=result.processed;run.status=result.errors.count?'partial':'success';run.result=result;
 }catch(error){run.status='failed';run.error_code=indexErrorCode(error);run.result={message:String(error).slice(0,240),diagnostics:errorDiagnostics(error)};}
 run.finished_at=new Date().toISOString();run.duration_ms=Date.now()-started;run.subrequests_used=transport.usage!().used;
 return send('/finish',{...identity,run});
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
 const path=new URL(request.url).pathname;
 if(!['/admin/trigger-index','/admin/index-status','/admin/probe-alio','/admin/bootstrap-index/begin','/admin/bootstrap-index/shard','/admin/bootstrap-index/activate'].includes(path))return null;
 if(!env.INDEX_ADMIN_TOKEN)return Response.json({error_code:'admin_token_not_configured'},{status:503});
 if(!await authorized(request,env.INDEX_ADMIN_TOKEN))return Response.json({error_code:'unauthorized'},{status:401});
 const method=path==='/admin/index-status'?'GET':'POST';
 if(request.method!==method)return Response.json({error_code:'method_not_allowed'},{status:405,headers:{allow:method}});
 if(path==='/admin/trigger-index')return runCoordinatedIndex(env,'manual');
 if(path==='/admin/probe-alio'){
  const [worker,object]=await Promise.all([Promise.all([probeAlio('worker',false),probeAlio('worker',true)]),coordinator(env).fetch('https://index.internal/probe',{method:'POST'})]);
  return Response.json({build_version:BUILD_VERSION,checked_at:new Date().toISOString(),worker_colo:request.cf?.colo??null,results:[...worker,...await object.json() as object[]]});
 }
 if(path.startsWith('/admin/bootstrap-index/'))return coordinator(env).fetch(new Request('https://index.internal/bootstrap/'+path.split('/').at(-1),request));
 const [index,status]=await Promise.all([readIndex(env.OAUTH_KV,Date.now(),BUILD_VERSION),getIndexRuntimeStatus(env)]);
 return Response.json({...status,index_build_version:index.index_build_version,indexedRegulations:index.documents.length,totalRegulations:index.total,partial:index.partial,lastVerifiedAt:index.lastVerifiedAt,lastCompletedAt:index.lastCompletedAt,errors:index.errors,last_list_verified_at:index.last_list_verified_at,next_list_refresh_at:index.next_list_refresh_at,next_retry_at:index.next_retry_at});
}
