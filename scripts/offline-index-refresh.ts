import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {BUILD_VERSION} from '../src/build-info';
import {buildOfflineIndex,offlineSource,type Stage} from './offline-index-build';
import {uploadSnapshot} from './bootstrap-index.mjs';
const origin='https://add-regulations-mcp.splain0102.workers.dev',audience=origin+'/admin/offline-index';
let cached:{value:string;expires:number}|undefined;
async function token(){
 if(cached&&cached.expires>Date.now()+30000)return cached.value;
 const url=process.env.ACTIONS_ID_TOKEN_REQUEST_URL,authorization=process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;if(!url||!authorization)throw Error('GitHub OIDC environment required');
 const target=new URL(url);target.searchParams.set('audience',audience);const response=await fetch(target,{headers:{authorization:'Bearer '+authorization},signal:AbortSignal.timeout(30000),redirect:'error'});if(!response.ok)throw Error('OIDC token request failed HTTP '+response.status);const value=await response.json() as {value:string};
 // Do not log the JWT or request-token. The server validates the signed claims.
 const claims=JSON.parse(Buffer.from(value.value.split('.')[1],'base64url').toString());cached={value:value.value,expires:claims.exp*1000};return cached.value;
}
async function send(path:string,body?:unknown){
 for(let attempt=0;attempt<3;attempt++){
  const response=await fetch(audience+'/'+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+await token(),'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(120000),redirect:'error'});
  const raw=await response.text();let result:any;try{result=JSON.parse(raw);}catch{throw Error('Offline endpoint returned non-JSON HTTP '+response.status);}
  if(response.ok)return result;
  if((response.status===429||response.status>=500)&&attempt<2&&!path.endsWith('/begin')){await new Promise(resolve=>setTimeout(resolve,2000*(attempt+1)));continue;}
  throw Error('Offline '+path+' HTTP '+response.status+': '+JSON.stringify(result).slice(0,300));
 }
 throw Error('offline_request_failed');
}
let progressQueue:Promise<unknown>=Promise.resolve();
const progress=(stage:Stage):Promise<void>=>{console.log('OFFLINE_STAGE',JSON.stringify(stage));if(process.env.OFFLINE_CHECKPOINT)return Promise.resolve();const pending=progressQueue.then(()=>send('progress',stage));progressQueue=pending.catch(()=>{});return pending.then(()=>{});};
let useWorkerTransport=false;
const transport:typeof fetch=async(input,init)=>{
 if(!useWorkerTransport){try{const response=await fetch(input,{...init,signal:AbortSignal.any([AbortSignal.timeout(8000),...(init?.signal?[init.signal]:[])])});if(response.status!==429&&response.status<500)return response;await response.body?.cancel();useWorkerTransport=true;}catch(error){if(init?.signal?.aborted)throw error;useWorkerTransport=true;}console.log('OFFLINE_TRANSPORT','Worker raw-I/O fallback');}
 const target=new URL(audience+'/alio');target.searchParams.set('url',String(input));const headers=new Headers(init?.headers);headers.set('authorization','Bearer '+await token());return fetch(target,{...init,headers,redirect:'manual'});
};
mkdirSync('reports',{recursive:true});let started=false;
try{
 let entries:[string,string][];let forceDocuments=process.env.OFFLINE_FORCE_DOCUMENTS==='true';
 if(process.env.OFFLINE_CHECKPOINT)entries=JSON.parse(readFileSync(process.env.OFFLINE_CHECKPOINT,'utf8'));
 else{
  // A push workflow may start before Cloudflare finishes deploying that exact SHA.
  let ready=false;for(let i=0;i<18;i++){try{const version=await send('version');if(version.build_version===BUILD_VERSION){ready=true;break;}}catch{ /* Wait without mutating the committed corpus. */ }await new Promise(resolve=>setTimeout(resolve,20000));}if(!ready)throw Error('deployed_build_not_ready');
  const previous=await send('snapshot');entries=previous.entries;const stateEntry=entries.find(([key])=>key==='add:corpus:v2:state');const previousState=stateEntry?JSON.parse(stateEntry[1]):undefined;
  if(previous.refresh_requested_at&&Date.parse(previous.refresh_requested_at)>Date.parse(previousState?.lastCompletedAt??''))forceDocuments=true;
  await send('start',{});started=true;
 }
 const {entries:next,report,snapshot}=await buildOfflineIndex(entries,process.env.OFFLINE_CHECKPOINT?undefined:offlineSource(transport),{forceDocuments,progress});
 writeFileSync('reports/offline-index-checkpoint.json',JSON.stringify(next));writeFileSync('reports/offline-index-result.json',JSON.stringify(report,null,2));writeFileSync('reports/offline-index-bootstrap.json',JSON.stringify(snapshot));
 if(!process.env.OFFLINE_CHECKPOINT){await progress({stage:'upload',processed:report.loadedDocuments});const activated=await uploadSnapshot(snapshot,(path:string,body:unknown)=>send('bootstrap/'+path,body));writeFileSync('reports/offline-index-published.json',JSON.stringify(activated,null,2));console.log('OFFLINE_PUBLISHED',JSON.stringify(activated));}
 else console.log('OFFLINE_DRY_RUN',JSON.stringify({passed:report.passed,indexed:report.indexed,loadedDocuments:report.loadedDocuments}));
}catch(error){
 console.error('OFFLINE_FAILED',String(error));if(started)try{await send('failure',{stage:'failed',title:(error as any)?.diagnostics?.sample?.[0]?.title,error_code:(error as any)?.diagnostics?.sample?.[0]?.error_code??'offline_failed',message:(error as any)?.diagnostics?.sample?.[0]?.message??String(error).slice(0,240)});}catch{console.error('OFFLINE_FAILURE_STATUS_UNAVAILABLE');}
 process.exitCode=1;
}
