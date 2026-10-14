import {handleOfflineIndex,offlineTick,readOfflineStatus,OFFLINE_INDEX_MODE,withOfflineHealth,offlineRefreshError} from './offline-index';
import {BUILD_VERSION} from '../build-info';
import {createIndexRequest,refreshCorpusIndex,searchAllRegulations} from './regulations';
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
  if(path.startsWith('/offline/')){try{return await handleOfflineIndex(path,request,this.state.storage,this.env.OAUTH_KV);}catch(error){return Response.json({error_code:'offline_request_failed',message:String(error).slice(0,200)},{status:500});}}
  if(path==='/search'){
   if(request.method!=='POST')return new Response('Method not allowed',{status:405});const raw=await request.text();if(raw.length>10000)return Response.json({error_code:'query_too_large'},{status:413});const input=JSON.parse(raw) as {query:string;limit:number;offset:number};
   if(typeof input.query!=='string'||!input.query.trim()||!Number.isInteger(input.limit)||input.limit<1||input.limit>50||!Number.isInteger(input.offset)||input.offset<0)return Response.json({error_code:'invalid_query'},{status:400});
   return Response.json(withOfflineHealth(await searchAllRegulations(input.query,input.limit,input.offset,this.env.OAUTH_KV,BUILD_VERSION),await readOfflineStatus(this.state.storage)));
  }
  if(path==='/full-status'){
   const [rawIndex,status]=await Promise.all([readIndex(this.env.OAUTH_KV,Date.now(),BUILD_VERSION),this.fetch(new Request('https://index.internal/status')).then(r=>r.json() as Promise<Record<string,unknown>>)]);
   const index=withOfflineHealth(rawIndex,await readOfflineStatus(this.state.storage));return Response.json({...status,index_build_version:index.index_build_version,indexedRegulations:index.documents.length,totalRegulations:index.total,partial:index.partial,lastVerifiedAt:index.lastVerifiedAt,lastCompletedAt:index.lastCompletedAt,errors:index.errors,last_list_verified_at:index.last_list_verified_at,next_list_refresh_at:index.next_list_refresh_at,next_retry_at:index.next_retry_at});
  }
  if(path==='/status'){
   await this.recoverInterrupted();
   const history=await this.state.storage.get<History>('runs')??{};const offline=await readOfflineStatus(this.state.storage);const activeOffline=offline.run?.build_version===BUILD_VERSION?offline.run:undefined;
   return Response.json({index_mode:OFFLINE_INDEX_MODE,index_refresh_status:activeOffline?.status??'not_started',index_refresh_error:offlineRefreshError(offline),refresh_requested_at:offline.refresh_requested_at??null,last_offline_success_at:offline.last_success_at??null,offline_run_url:offline.run?.url??null,last_interrupted_run:history.last_interrupted_run??null,hello_build_version:BUILD_VERSION,last_build_mismatch:history.last_build_mismatch??null,last_cron_started_at:history.last_cron_started_at??null,last_cron_finished_at:history.last_cron_finished_at??null,processed_in_last_run:activeOffline?.processed??history.latest?.processed??0,last_index_run:activeOffline??history.latest??null});
  }
  if(path==='/probe'&&request.method==='POST')return Response.json(await Promise.all([probeAlio('durable_object',false),probeAlio('durable_object',true)]));
  if(request.method!=='POST')return new Response('Not found',{status:404});
  if(this.busy)return Response.json({error_code:'index_busy'},{status:409});
  this.busy=true;
  try{
   await this.recoverInterrupted();
   const lease=await this.state.storage.get<Lease>('lease');
   if(path==='/offline-tick'){
    const input=await request.json() as {trigger?:string};const trigger=input.trigger==='manual'?'manual':'cron';const now=new Date().toISOString(),history=await this.state.storage.get<History>('runs')??{};
    const result=await offlineTick(this.state.storage,trigger);
    history.latest={run_id:crypto.randomUUID(),build_version:BUILD_VERSION,trigger,execution:'worker',started_at:now,finished_at:now,processed:0,duration_ms:0,subrequests_used:0,subrequest_limit:36,status:result.status,result:{index_mode:OFFLINE_INDEX_MODE}};
    if(trigger==='cron'){history.last_cron_started_at=now;history.last_cron_finished_at=now;}await this.state.storage.put('runs',history);console.log('corpus_index_external_heartbeat',JSON.stringify(result));return Response.json(result,{status:trigger==='manual'?202:200});
   }
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
export async function runOfflineHeartbeat(env:CoordinatorEnv,trigger:'cron'|'manual'){return coordinator(env).fetch('https://index.internal/offline-tick',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({trigger})});}
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
 // Forward raw bodies to the larger-CPU coordinator; OIDC validation occurs there.
 if(path==='/admin/offline-index/alio'){
  const url=new URL(request.url),value=url.searchParams.get('url');let target:URL;try{target=new URL(value??'');}catch{return Response.json({error_code:'invalid_alio_target'},{status:400});}
  if(target.origin!=='https://www.alio.go.kr'||target.username||target.password||!['/item/itemReportListSusi.json','/item/itemBoard21110.do','/download/rulefiledown.json'].includes(target.pathname)||value!.length>4000||!['GET','POST'].includes(request.method)||request.method==='POST'&&target.pathname!=='/item/itemReportListSusi.json')return Response.json({error_code:'invalid_alio_target'},{status:400});
  const verified=await coordinator(env).fetch('https://index.internal/offline/authorize',{method:'POST',headers:{authorization:request.headers.get('authorization')??''}});if(!verified.ok)return verified;
  // Only raw I/O here: never decode attachment bytes or forward the JWT to ALIO.
  const headers=new Headers();for(const name of ['accept','accept-language','content-type','user-agent','x-requested-with','referer','origin']){const v=request.headers.get(name);if(v)headers.set(name,v);}
  try{return await fetch(target.href,{method:request.method,headers,body:request.method==='POST'?request.body:undefined,redirect:'manual',signal:AbortSignal.timeout(25000)});}catch{return Response.json({error_code:'alio_proxy_fetch_failed'},{status:502});}
 }
 if(path.startsWith('/admin/offline-index/'))return coordinator(env).fetch(new Request('https://index.internal/offline/'+path.slice('/admin/offline-index/'.length),request));
 if(!['/admin/trigger-index','/admin/index-status','/admin/probe-alio','/admin/bootstrap-index/begin','/admin/bootstrap-index/shard','/admin/bootstrap-index/activate'].includes(path))return null;
 if(!env.INDEX_ADMIN_TOKEN)return Response.json({error_code:'admin_token_not_configured'},{status:503});
 if(!await authorized(request,env.INDEX_ADMIN_TOKEN))return Response.json({error_code:'unauthorized'},{status:401});
 const method=path==='/admin/index-status'?'GET':'POST';
 if(request.method!==method)return Response.json({error_code:'method_not_allowed'},{status:405,headers:{allow:method}});
 if(path==='/admin/trigger-index')return runOfflineHeartbeat(env,'manual');
 if(path==='/admin/probe-alio'){
  const [worker,object]=await Promise.all([Promise.all([probeAlio('worker',false),probeAlio('worker',true)]),coordinator(env).fetch('https://index.internal/probe',{method:'POST'})]);
  return Response.json({build_version:BUILD_VERSION,checked_at:new Date().toISOString(),worker_colo:request.cf?.colo??null,results:[...worker,...await object.json() as object[]]});
 }
 if(path.startsWith('/admin/bootstrap-index/'))return coordinator(env).fetch(new Request('https://index.internal/bootstrap/'+path.split('/').at(-1),request));
 return coordinator(env).fetch('https://index.internal/full-status');
}
