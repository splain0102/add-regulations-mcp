import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {r2Store} from '../d1/remote';
import {ROOT,STATUS} from '../../src/r2/types';
const store=r2Store();let mf:Miniflare|undefined;
const report:any={passed:false,scope:'Actual complete R2 corpus in local workerd/DO; not production CPU or memory measurement',cases:[]};
try{
 const root=await store('GET',ROOT),head=JSON.parse(new TextDecoder().decode(root)),catalogBytes=await store('GET',head.catalog.key),catalog=JSON.parse(new TextDecoder().decode(catalogBytes));report.count=head.count;assert(head.count>=200);
 mkdirSync('.build-check',{recursive:true});
 await build({stdin:{contents:"export {CorpusIndexCoordinator} from './src/r2-worker'; export default {fetch(request,env){return env.CORPUS_INDEX_COORDINATOR.get(env.CORPUS_INDEX_COORDINATOR.idFromName('full-r2-regression')).fetch(request)}};",resolveDir:process.cwd(),loader:'ts'},bundle:true,format:'esm',platform:'browser',conditions:['workerd','worker','browser'],external:['cloudflare:*','node:async_hooks'],outfile:'.build-check/r2-full-worker.js'});
 mf=new Miniflare(convertV4MiniflareOptions({modules:true,scriptPath:'.build-check/r2-full-worker.js',compatibilityDate:'2026-10-01',compatibilityFlags:['global_fetch_strictly_public'],r2Buckets:{REGULATIONS_ARCHIVE:'full-r2-regression'},durableObjects:{CORPUS_INDEX_COORDINATOR:{className:'CorpusIndexCoordinator',useSQLite:true}},outboundService:()=>{throw Error('Serving outbound network forbidden');}}));
 const bucket=await mf.getR2Bucket('REGULATIONS_ARCHIVE');await bucket.put(ROOT,root);await bucket.put(head.catalog.key,catalogBytes);
 try{await bucket.put(STATUS,await store('GET',STATUS));}catch(e){if(!String(e).includes('HTTP 404'))throw e;}
 for(let i=0;i<catalog.objects.length;i+=4){const settled=await Promise.allSettled(catalog.objects.slice(i,i+4).map(async(ref:any)=>{const b=await store('GET',ref.key);assert.equal(createHash('sha256').update(b).digest('hex'),ref.sha256);await bucket.put(ref.key,b);}));for(const result of settled)if(result.status==='rejected')throw result.reason;}
 console.log('R2_FULL_CORPUS_LOADED',JSON.stringify({count:head.count,objects:catalog.objects.length+1,bytes:catalog.objects.reduce((n:number,r:any)=>n+r.bytes,0)+catalogBytes.length}));
 const cases=[['search_regulation_table',{name:'위임전결규정',query:'전문가'}],['search_regulation_table',{name:'위임전결규정',query:'내부승인'}],['search_regulation_table',{name:'위임전결규정',query:'300만 원'}],['search_regulation_table',{name:'여비규정',query:'식비'}],['search_all_regulations',{query:'외국인',limit:10}],['search_all_regulations',{query:'사고 보고',limit:5}]] as const;
 for(const [tool,input]of cases){const times:number[]=[];let first:any,last:any;for(let i=0;i<20;i++){const t=performance.now(),response=await mf.dispatchFetch('https://full-r2.test/tool',{method:'POST',body:JSON.stringify({tool,input})}),r:any=await response.json();assert.equal(response.status,200);assert(!r.isError&&!r.structuredContent.partial,JSON.stringify(r).slice(0,300));if(!i)first=r.structuredContent;last=r.structuredContent;times.push(performance.now()-t);}const sorted=times.slice().sort((a,b)=>a-b);report.cases.push({tool,input,cold_ms:times[0],p95_ms:sorted[18],max_ms:sorted[19],totalMatches:last.totalMatches,first_metrics:first.metrics,last_metrics:last.metrics});assert(sorted[18]<2000,tool+' full corpus local p95 exceeds 2s');}
 report.passed=true;
}catch(e){report.error=String(e);process.exitCode=1;}finally{console.log('R2_FULL_WORKERD_ACCEPTANCE',JSON.stringify(report));await mf?.dispose();}
