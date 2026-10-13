import {BUILD_VERSION} from '../build-info';
import {INDEX_PREFIX,type IndexState} from './corpus-index';
import {verifyIndexIdentity} from './github-index-auth';
import {handleBootstrap} from './index-bootstrap';
export const OFFLINE_INDEX_MODE='github_actions';
type Progress={stage:string;title?:string;fileNo?:string;processed?:number;error_code?:string;message?:string};
export type OfflineRun={run_id:string;run_attempt:string;build_version:string;trigger:'cron'|'manual';execution:'github_actions';started_at:string;finished_at:string|null;status:string;processed:number;duration_ms:number;subrequests_used:number;subrequest_limit:number;progress:Progress;last_progress_at:string;url:string;error_code?:string;result?:unknown};
export type OfflineStatus={run?:OfflineRun;last_failure?:OfflineRun;refresh_requested_at?:string;last_success_at?:string;session_id?:string};
export async function readOfflineStatus(storage:DurableObjectStorage){return await storage.get<OfflineStatus>('offline')??{};}
async function saveOfflineStatus(storage:DurableObjectStorage,status:OfflineStatus){
 await storage.transaction(async transaction=>{
  const latest=await transaction.get<OfflineStatus>('offline')??{};
  if(latest.refresh_requested_at&&(!status.refresh_requested_at||latest.refresh_requested_at>status.refresh_requested_at))status.refresh_requested_at=latest.refresh_requested_at;
  if(latest.last_success_at&&(!status.last_success_at||latest.last_success_at>status.last_success_at))status.last_success_at=latest.last_success_at;
  if(latest.run&&status.run&&latest.run.run_id===status.run.run_id&&latest.run.run_attempt===status.run.run_attempt){
   if(latest.run.finished_at&&!status.run.finished_at)status.run=latest.run;
   else{status.run.processed=Math.max(status.run.processed,latest.run.processed);if(!status.run.finished_at&&latest.run.last_progress_at>status.run.last_progress_at){status.run.progress=latest.run.progress;status.run.last_progress_at=latest.run.last_progress_at;}}
  }
  if(status.run?.status==='success')delete status.last_failure;else if(latest.last_failure&&(!status.last_failure||latest.last_failure.last_progress_at>status.last_failure.last_progress_at))status.last_failure=latest.last_failure;
  await transaction.put('offline',status);
 });
}

export async function offlineTick(storage:DurableObjectStorage,trigger:'cron'|'manual'){
 const state=await readOfflineStatus(storage),now=new Date().toISOString();if(state.run&&!state.run.finished_at&&Date.now()-Date.parse(state.run.started_at)>=55*60000){state.run.status='interrupted';state.run.error_code='external_timeout';state.run.finished_at=now;state.run.duration_ms=Date.now()-Date.parse(state.run.started_at);state.last_failure=structuredClone(state.run);await saveOfflineStatus(storage,state);console.error('corpus_offline_run_interrupted',JSON.stringify(state.run));}if(trigger==='manual'){state.refresh_requested_at=now;await saveOfflineStatus(storage,state);}
 return {build_version:BUILD_VERSION,trigger,execution:'worker',status:trigger==='manual'?'queued_external':'waiting_external',index_mode:OFFLINE_INDEX_MODE,processed:0,subrequests_used:0,subrequest_limit:36,finished_at:now,refresh_requested_at:state.refresh_requested_at??null,last_offline_run:state.run??null};
}
export async function handleOfflineIndex(path:string,request:Request,storage:DurableObjectStorage,kv:KVNamespace){
 const token=request.headers.get('authorization')?.match(/^Bearer (.+)$/)?.[1];if(!token)return Response.json({error_code:'unauthorized'},{status:401});
 let identity;try{identity=await verifyIndexIdentity(token,BUILD_VERSION);}catch(error){console.error('corpus_offline_auth_failed',{code:String(error).slice(0,160)});return Response.json({error_code:String(error).includes('unavailable')?'oidc_keys_unavailable':'unauthorized'},{status:String(error).includes('unavailable')?503:401});}
 if(path==='/offline/version'&&request.method==='GET')return Response.json({build_version:BUILD_VERSION,index_mode:OFFLINE_INDEX_MODE});
 const status=await readOfflineStatus(storage),run=status.run,now=Date.now(),timestamp=new Date(now).toISOString();
 if(path==='/offline/snapshot'){
  if(request.method!=='GET')return Response.json({error_code:'method_not_allowed'},{status:405});
  const value=await kv.get(INDEX_PREFIX+'state','text');if(!value)return Response.json({entries:[],refresh_requested_at:status.refresh_requested_at??null});
  const manifest=JSON.parse(value) as IndexState;const entries:[string,string][]=[[INDEX_PREFIX+'state',value]];
  for(const key of [...new Set(Object.values(manifest.refs))]){const shard=await kv.get(key,'text');if(!shard)return Response.json({error_code:'committed_shard_unavailable'},{status:409});entries.push([key,shard]);}
  return Response.json({entries,refresh_requested_at:status.refresh_requested_at??null});
 }
 if(request.method!=='POST')return Response.json({error_code:'method_not_allowed'},{status:405});
 if(path==='/offline/start'){
  if(run&&run.build_version===BUILD_VERSION&&!run.finished_at&&run.run_id!==identity.run_id&&now-Date.parse(run.started_at)<55*60000)return Response.json({error_code:'offline_index_busy'},{status:409});
  if(run?.run_id===identity.run_id&&run.run_attempt===identity.run_attempt&&!run.finished_at)return Response.json({accepted:true,reused:true});
  if(run&&!run.finished_at)console.error('corpus_offline_previous_run_interrupted',JSON.stringify(run));
  status.run={run_id:identity.run_id,run_attempt:identity.run_attempt,build_version:BUILD_VERSION,trigger:identity.event_name==='schedule'?'cron':'manual',execution:'github_actions',started_at:timestamp,finished_at:null,status:'running',processed:0,duration_ms:0,subrequests_used:0,subrequest_limit:0,progress:{stage:'list'},last_progress_at:timestamp,url:'https://github.com/splain0102/add-regulations-mcp/actions/runs/'+identity.run_id};delete status.session_id;
  await saveOfflineStatus(storage,status);return Response.json({accepted:true});
 }
 if(path==='/offline/bootstrap/activate'&&run?.status==='success'&&run.run_id===identity.run_id&&run.run_attempt===identity.run_attempt){const copy=await request.clone().json() as {session_id?:string};if(copy.session_id===status.session_id)return Response.json({...run.result as object,reused:true});}
 if(!run||run.run_id!==identity.run_id||run.run_attempt!==identity.run_attempt||run.finished_at)return Response.json({error_code:'offline_run_not_active'},{status:409});
 if(path==='/offline/progress'||path==='/offline/failure'){
  const raw=await request.text();if(raw.length>4096)return Response.json({error_code:'progress_too_large'},{status:413});const input=JSON.parse(raw) as Progress;
  if(typeof input.stage!=='string'||input.stage.length>80||input.title!==undefined&&(typeof input.title!=='string'||input.title.length>500)||input.fileNo!==undefined&&(typeof input.fileNo!=='string'||!/^\d+$/.test(input.fileNo))||input.message!==undefined&&typeof input.message!=='string')return Response.json({error_code:'invalid_progress'},{status:400});
  run.progress={stage:input.stage,title:input.title,fileNo:input.fileNo,processed:input.processed,error_code:input.error_code,message:input.message?.slice(0,240)};run.last_progress_at=timestamp;
  if(typeof input.processed==='number'&&Number.isFinite(input.processed)&&input.processed>=0)run.processed=Math.max(run.processed,input.processed);
  if(path==='/offline/failure'){run.status='failed';run.finished_at=timestamp;run.duration_ms=now-Date.parse(run.started_at);run.error_code=input.error_code??'offline_failed';status.last_failure=structuredClone(run);console.error('corpus_offline_run_failed',JSON.stringify(run));}
  await saveOfflineStatus(storage,status);return Response.json({recorded:true});
 }
 if(path.startsWith('/offline/bootstrap/')){
  const operation=path.slice('/offline/bootstrap/'.length);
  if(!['begin','shard','activate'].includes(operation))return new Response('Not found',{status:404});
  // Bind every mutating bootstrap call to this signed workflow run's own session.
  if(operation!=='begin'){const copy=await request.clone().json() as {session_id?:string};if(!status.session_id||copy.session_id!==status.session_id)return Response.json({error_code:'offline_session_mismatch'},{status:409});}
  run.progress={stage:'bootstrap_'+operation};run.last_progress_at=timestamp;await saveOfflineStatus(storage,status);
  const response=await handleBootstrap('/bootstrap/'+operation,request,storage,kv);
  if(response.ok&&operation==='begin'){const result=await response.clone().json() as {session_id:string};status.session_id=result.session_id;await saveOfflineStatus(storage,status);}
  if(response.ok&&operation==='activate'){
   const result=await response.clone().json() as {indexedRegulations:number;lastCompletedAt:string};run.status='success';run.finished_at=timestamp;run.duration_ms=now-Date.parse(run.started_at);run.processed=result.indexedRegulations;run.result=result;run.progress={stage:'complete',processed:run.processed};status.last_success_at=result.lastCompletedAt;await saveOfflineStatus(storage,status);console.log('corpus_offline_run_completed',JSON.stringify(run));
  }
  return response;
 }
 return new Response('Not found',{status:404});
}

export function offlineRefreshError(status:OfflineStatus){
 const run=status.last_failure??(status.run&&['failed','interrupted'].includes(status.run.status)?status.run:undefined);
 if(!run||run.build_version!==BUILD_VERSION)return null;
 return {title:run.progress.title??'GitHub Actions index',message:run.progress.message??'External index refresh did not complete',checkedAt:run.finished_at??run.last_progress_at,build_version:run.build_version,error_code:run.error_code??'offline_failed',execution:run.execution,workflow_url:run.url};
}
export function withOfflineHealth<T extends {partial:boolean;index_status?:string;errors:{count:number;sample:any[];retry_cursor:unknown}}>(result:T,status:OfflineStatus):T{
 const error=offlineRefreshError(status);if(!error)return result;
 return {...result,partial:true,index_status:'stale',errors:{...result.errors,count:result.errors.count+1,sample:[error,...result.errors.sample].sort((a,b)=>b.checkedAt.localeCompare(a.checkedAt)).slice(0,3)}};
}
