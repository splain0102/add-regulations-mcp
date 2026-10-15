import {createHash,createHmac} from 'node:crypto';
import type {Database} from './load';
const required=(name:string)=>{const v=process.env[name];if(!v)throw Error('Missing secret/config: '+name);return v;};
export function remoteDatabase(runId:string):Database{
 const account=required('CLOUDFLARE_ACCOUNT_ID'),id=required('D1_DATABASE_ID'),token=required('CLOUDFLARE_D1_TOKEN');
 let nextRequestAt=0;const apiFetch:typeof fetch=async(input,init)=>{const delay=nextRequestAt-Date.now();if(delay>0)await new Promise(resolve=>setTimeout(resolve,delay));nextRequestAt=Date.now()+350;return fetch(input,init);};
 let written=0,priorWrites:number|undefined,usageDay=new Date().toISOString().slice(0,10);const budget=Number(process.env.D1_WRITE_BUDGET??80000);if(!Number.isFinite(budget)||budget<1||budget>90000)throw Error('invalid_write_budget');
 const rawExecute=async(statements:any[])=>{const day=new Date().toISOString().slice(0,10);if(day!==usageDay){usageDay=day;written=0;priorWrites=undefined;}if(priorWrites===undefined){const r=await apiFetch(`https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${id}/query`,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({sql:"SELECT coalesce(sum(rows_written),0) AS n FROM sync_usage WHERE day=date('now')"}),signal:AbortSignal.timeout(30000)});const j:any=await r.json();if(!r.ok||!j.success)throw Error('D1 quota read failed');priorWrites=j.result[0].results[0].n;}if(priorWrites+written>=budget&&!statements.some(s=>/status='failed'|INSERT INTO sync_failures|UPDATE sync_lease/.test(s.sql)))throw Error('d1_daily_write_budget_reached');const response=await apiFetch(`https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${id}/query`,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({batch:statements}),signal:AbortSignal.timeout(45000)});const data:any=await response.json();if(!response.ok||!data.success||data.result?.some((r:any)=>!r.success))throw Error('D1 request failed HTTP '+response.status);for(const r of data.result)written+=r.meta?.rows_written??0;const accounted=priorWrites+written;const countResponse=await apiFetch(`https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${id}/query`,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({sql:"INSERT INTO sync_usage(day,run_id,rows_written) VALUES(date('now'),?,?) ON CONFLICT(day,run_id) DO UPDATE SET rows_written=excluded.rows_written",params:[runId,written+1]}),signal:AbortSignal.timeout(30000)});const countData:any=await countResponse.json();if(!countResponse.ok||!countData.success)throw Error('D1 quota checkpoint failed');written++;if(accounted>=budget&&!statements.some(s=>/status='failed'|INSERT INTO sync_failures|UPDATE sync_lease/.test(s.sql)))throw Error('d1_daily_write_budget_reached');return data.result;};
 let queue:Promise<unknown>=Promise.resolve();const execute=(rows:any[])=>{const next=queue.then(()=>rawExecute(rows));queue=next.catch(()=>{});return next;};
 return {query:async(sql,params=[])=>{const r=await execute([{sql,params}]);return r[0].results;},batch:async rows=>{await execute(rows);}};
}
export function r2Store(){
 const account=required('CLOUDFLARE_ACCOUNT_ID'),bucket=required('R2_BUCKET'),access=required('R2_ACCESS_KEY_ID'),secret=required('R2_SECRET_ACCESS_KEY');
 const digest=(s:string|Uint8Array)=>createHash('sha256').update(s).digest('hex');const hmac=(key:string|Uint8Array,s:string)=>createHmac('sha256',key).update(s).digest();
 const encode=(s:string)=>encodeURIComponent(s).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase());
 const budget=Number(process.env.R2_BUCKET_BUDGET_BYTES??1000000000);if(!Number.isFinite(budget)||budget<1||budget>1000000000)throw Error('invalid_r2_bucket_budget');
 const objects=new Map<string,number>(),etags=new Map<string,string>();let used=0,inventory:Promise<void>|undefined;
 const request=async(method:'PUT'|'GET',key:string,body=new Uint8Array(),query:Record<string,string>={},condition:{ifMatch?:string;ifNoneMatch?:string}={})=>{
  const url=new URL(`https://${account}.r2.cloudflarestorage.com/${encode(bucket)}/${key.split('/').map(encode).join('/')}`);
  const canonicalQuery=Object.keys(query).sort().map(k=>encode(k)+'='+encode(query[k])).join('&');url.search=canonicalQuery;
  const date=new Date().toISOString().replace(/[:-]|\.\d{3}/g,''),day=date.slice(0,8),payload=digest(body),scope=`${day}/auto/s3/aws4_request`;
  const signedValues:Record<string,string>={host:url.host,'x-amz-content-sha256':payload,'x-amz-date':date,...(condition.ifMatch?{'if-match':condition.ifMatch}:{}),...(condition.ifNoneMatch?{'if-none-match':condition.ifNoneMatch}:{})};const keys=Object.keys(signedValues).sort(),headers=keys.map(k=>k+':'+signedValues[k]+'\n').join(''),names=keys.join(';'),canonical=[method,url.pathname,canonicalQuery,headers,names,payload].join('\n');
  const signed=hmac(hmac(hmac(hmac('AWS4'+secret,day),'auto'),'s3'),'aws4_request');const signature=createHmac('sha256',signed).update(['AWS4-HMAC-SHA256',date,scope,digest(canonical)].join('\n')).digest('hex');
  const response=await fetch(url,{method,headers:{...(condition.ifMatch?{'if-match':condition.ifMatch}:{}),...(condition.ifNoneMatch?{'if-none-match':condition.ifNoneMatch}:{}),'x-amz-date':date,'x-amz-content-sha256':payload,authorization:`AWS4-HMAC-SHA256 Credential=${access}/${scope}, SignedHeaders=${names}, Signature=${signature}`},body:method==='PUT'?body:undefined,signal:AbortSignal.timeout(60000)});if(!response.ok)throw Error('R2 '+method+' HTTP '+response.status);if(response.headers.get('etag'))etags.set(key,response.headers.get('etag')!);return new Uint8Array(await response.arrayBuffer());
 };
 const decode=(s:string)=>s.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&');
 async function measure(){let token='';for(let page=0;page<100;page++){
  const xml=new TextDecoder().decode(await request('GET','',new Uint8Array(),{'list-type':'2','max-keys':'1000',...(token?{'continuation-token':token}:{})}));
  for(const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)){const key=match[1].match(/<Key>([\s\S]*?)<\/Key>/)?.[1],size=match[1].match(/<Size>(\d+)<\/Size>/)?.[1];if(key===undefined||size===undefined)throw Error('invalid_r2_inventory');const bytes=Number(size);objects.set(decode(key),bytes);used+=bytes;}
  token=decode(xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/)?.[1]??'');if(!token)return;
 }throw Error('r2_inventory_page_limit');}
 // Inventory includes interrupted/unreferenced uploads. A separate archive bucket
 // and serialized PUT reservations prevent concurrent parser jobs exceeding the cap.
 let puts:Promise<unknown>=Promise.resolve();
 const store=async(method:'PUT'|'GET',key:string,body=new Uint8Array(),condition:{ifMatch?:string;ifNoneMatch?:string}={})=>{
  inventory??=measure();await inventory;
  if(method==='GET')return request(method,key,body);
  const pending=puts.then(async()=>{const next=used-(objects.get(key)??0)+body.byteLength;if(next>budget)throw Error('r2_bucket_budget_reached');const result=await request(method,key,body,{},condition);objects.set(key,body.byteLength);used=next;return result;});puts=pending.catch(()=>{});return pending;
 };
 return Object.assign(store,{list:async(prefix='')=>{inventory??=measure();await inventory;return [...objects.keys()].filter(key=>key.startsWith(prefix));},etag:(key:string)=>etags.get(key)});
}
