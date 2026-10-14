import {INDEX_AUDIENCE,INDEX_WORKFLOW} from '../src/regulation-core/github-index-auth';
import {searchAllRegulations} from '../src/regulation-core/regulations';
import {refreshIndex} from '../src/regulation-core/corpus-index';
import {PARSER_VERSION} from '../src/regulation-core/parser-version';
import {TestKV} from './corpus-index-test-kv';
import {BUILD_VERSION} from '../src/build-info';
import {exportSnapshot,uploadSnapshot} from './bootstrap-index.mjs';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {build} from 'esbuild';
import {createHash} from 'node:crypto';
import {zipSync,strToU8} from 'fflate';
const xml='<hs:sec><hp:p><hp:run><hp:t>제8조(외국인 참여)</hp:t></hp:run></hp:p><hp:p><hp:run><hp:t>외국인은 승인을 받아야 한다.</hp:t></hp:run></hp:p></hs:sec>';
const bytes=zipSync({'Contents/section0.xml':strToU8(xml)});
let outbound=0;
const oidcPair=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
const oidcJwk={...await crypto.subtle.exportKey('jwk',oidcPair.publicKey),kid:'workerd-index-test',alg:'RS256',use:'sig'};
async function indexToken(attempt='1'){
 const seconds=Math.floor(Date.now()/1000),header=Buffer.from(JSON.stringify({alg:'RS256',kid:oidcJwk.kid})).toString('base64url');const body=Buffer.from(JSON.stringify({iss:'https://token.actions.githubusercontent.com',aud:INDEX_AUDIENCE,exp:seconds+300,nbf:seconds-1,iat:seconds-1,repository:'splain0102/add-regulations-mcp',repository_id:'1401470477',repository_owner_id:'40254573',ref:'refs/heads/main',sha:BUILD_VERSION,workflow_sha:BUILD_VERSION,workflow_ref:INDEX_WORKFLOW,event_name:'push',run_id:'424242',run_attempt:attempt})).toString('base64url');
 const signature=await crypto.subtle.sign('RSASSA-PKCS1-v1_5',oidcPair.privateKey,new TextEncoder().encode(header+'.'+body));return header+'.'+body+'.'+Buffer.from(signature).toString('base64url');
}

// Test-only identity grant endpoint; never shipped in the production bundle.
const source=readFileSync('src/index.ts','utf8').replace('export default {','const productionWorker = {')+`
export default {
 ...productionWorker,
 async fetch(request,env,ctx){
  const url=new URL(request.url);
  if(url.pathname==='/test-grant'){
   await oauthProvider.fetch(new Request(url.origin+'/test-initialize'),env,ctx);
   const helpers=env.OAUTH_PROVIDER;
   const auth=await helpers.parseAuthRequest(new Request(url.origin+'/authorize'+url.search));
   return Response.json(await helpers.completeAuthorization({request:auth,userId:'test-user',metadata:{},scope:['mcp:read'],props:{}}));
  }
  const canonical=new URL(request.url);canonical.protocol='https:';canonical.host='add-regulations-mcp.splain0102.workers.dev';
  const headers=new Headers(request.headers);headers.set('host',canonical.host);
  return productionWorker.fetch(new Request(new Request(canonical,request),{headers}),env,ctx);
 }
};`;
await build({stdin:{contents:source,loader:'ts',resolveDir:process.cwd()+'/src'},bundle:true,format:'esm',platform:'browser',conditions:['workerd','worker','browser'],external:['cloudflare:*','node:async_hooks'],outfile:'.build-check/oauth-test.js'});
const mf=new Miniflare(convertV4MiniflareOptions({modules:true,scriptPath:'.build-check/oauth-test.js',compatibilityDate:'2026-10-01',compatibilityFlags:['global_fetch_strictly_public'],kvNamespaces:['OAUTH_KV'],durableObjects:{CORPUS_INDEX_COORDINATOR:{className:'CorpusIndexCoordinator',useSQLite:true}},bindings:{INDEX_ADMIN_TOKEN:'test-index-admin-token',ACCESS_CLIENT_ID:'test',ACCESS_CLIENT_SECRET:'test',COOKIE_ENCRYPTION_KEY:'0123456789abcdef0123456789abcdef'},outboundService:async request=>{
 outbound++;const url=new URL(request.url);if(url.hostname==='token.actions.githubusercontent.com'&&url.pathname==='/.well-known/jwks')return Response.json({keys:[oidcJwk]});
 if(url.pathname.endsWith('itemReportListSusi.json'))return Response.json({data:{result:[{title:'보안과제 관리요령',apbaId:'C0345',idx:'1',reportFormNo:'21110',tableName:'COMM_RULE',idxName:'RULE_NO',reportGbn:'N',bidType:'',stDate:'2026.01.01',idate:'2026.02.02'}],page:{totalPage:1,totalCount:1}}});
 if(url.pathname.includes('itemBoard')){
  assert.match(request.headers.get('user-agent')??'',/ADD-Regulations-MCP/);assert.match(request.headers.get('accept')??'',/text\/html/);assert.match(request.headers.get('accept-language')??'',/ko-KR/);
  return new Response('<a href="/download/rulefiledown.json?fileNo=100">보안과제 관리요령.hwpx</a>');
 }
 if(url.pathname.includes('rulefiledown'))return new Response(bytes,{headers:{'content-disposition':'attachment; filename="test.hwpx"'}});
 throw Error('unexpected outbound '+url);
}}));
try{
 const discovery=await mf.dispatchFetch('https://add-regulations-mcp.splain0102.workers.dev/.well-known/oauth-authorization-server');assert.equal(discovery.status,200);const metadata=await discovery.json();assert(metadata.authorization_endpoint);assert(metadata.token_endpoint);
 const protectedResponse=await mf.dispatchFetch('https://add-regulations-mcp.splain0102.workers.dev/mcp',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});assert.equal(protectedResponse.status,401);
 const register=await mf.dispatchFetch('https://add-regulations-mcp.splain0102.workers.dev/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({client_name:'A regression client',redirect_uris:['https://example.com/callback'],grant_types:['authorization_code'],response_types:['code'],token_endpoint_auth_method:'none'})});assert.equal(register.status,201);const client=await register.json();assert(client.client_id);
 const kv=await mf.getKVNamespace('OAUTH_KV');const oauthBefore=(await kv.list()).keys.filter(k=>!k.name.startsWith('add:corpus:')).map(k=>k.name);assert(oauthBefore.length);
 const adminUrl='https://add-regulations-mcp.splain0102.workers.dev/admin/trigger-index';
 const adminHeaders={'authorization':'Bearer test-index-admin-token'};
 const denied=await mf.dispatchFetch(adminUrl,{method:'POST'});assert.equal(denied.status,401);
 const wrong=await mf.dispatchFetch(adminUrl,{method:'POST',headers:{authorization:'Bearer wrong'}});assert.equal(wrong.status,401);
 const wrongMethod=await mf.dispatchFetch(adminUrl,{headers:adminHeaders});assert.equal(wrongMethod.status,405);
 const probe=await mf.dispatchFetch('https://add-regulations-mcp.splain0102.workers.dev/admin/probe-alio',{method:'POST',headers:adminHeaders});assert.equal(probe.status,200);const probeResult=await probe.json();assert.equal(probeResult.results.length,4);assert(probeResult.results.every((r:any)=>r.http_status===200&&r.response_bytes>0));assert.deepEqual([...new Set(probeResult.results.map((r:any)=>r.scope))].sort(),['durable_object','worker']);
 const seed=new TestKV();await refreshIndex(seed.binding(),{list:async()=>[{title:'보안과제 관리요령',detailUrl:'https://www.alio.go.kr/item/itemBoard21110.do?idx=1',revisionDate:'2026.01.01',updatedDate:'2026.02.02'}],load:async()=>({fileNo:'100',text:'제8조(외국인 참여)\n외국인은 승인을 받아야 한다.',bytes,parserVersion:PARSER_VERSION})},Date.now(),{buildVersion:BUILD_VERSION});for(const [key,value]of seed.values)await kv.put(key,value);
 const beforeCronOutbound=outbound;
 const worker=await mf.getWorker();assert.equal(typeof worker.scheduled,'function');await worker.scheduled({cron:'*/5 * * * *',scheduledTime:Date.now()});
 const firstCronStatus=await (await mf.dispatchFetch('https://add-regulations-mcp.splain0102.workers.dev/admin/index-status',{headers:adminHeaders})).json();assert.equal(firstCronStatus.last_index_run.build_version,BUILD_VERSION);
 await new Promise(resolve=>setTimeout(resolve,1150));await worker.scheduled({cron:'*/5 * * * *',scheduledTime:Date.now()});
 const secondCronStatus=await (await mf.dispatchFetch('https://add-regulations-mcp.splain0102.workers.dev/admin/index-status',{headers:adminHeaders})).json();assert.equal(secondCronStatus.last_index_run.build_version,BUILD_VERSION);assert.notEqual(firstCronStatus.last_index_run.run_id,secondCronStatus.last_index_run.run_id);assert.equal(outbound,beforeCronOutbound);assert.equal(secondCronStatus.last_index_run.status,'waiting_external');
 const state=await kv.get<any>('add:corpus:v2:state','json');assert(state);assert.equal(state.items.length,1);assert.equal(Object.keys(state.errors).length,0);
 assert.equal(state.indexedTitles.length,1);assert(state.lastCompletedAt);assert(state.index_build_version);
 await new Promise(resolve=>setTimeout(resolve,1150));
 const manual=await mf.dispatchFetch(adminUrl,{method:'POST',headers:adminHeaders});assert.equal(manual.status,202);const manualRun=await manual.json();assert.equal(manualRun.processed,0);assert.equal(manualRun.status,'queued_external');assert.equal(manualRun.index_mode,'github_actions');assert.equal(manualRun.trigger,'manual');assert(manualRun.finished_at);assert(manualRun.subrequests_used<=36);assert.equal(manualRun.execution,'worker');
 const runtime=await mf.dispatchFetch('https://add-regulations-mcp.splain0102.workers.dev/admin/index-status',{headers:adminHeaders});assert.equal(runtime.status,200);const runStatus=await runtime.json();assert(runStatus.last_cron_started_at);assert(runStatus.last_cron_finished_at);assert.equal(runStatus.processed_in_last_run,0);assert.equal(runStatus.index_build_version,manualRun.build_version);
 const rateLimited=await mf.dispatchFetch(adminUrl,{method:'POST',headers:adminHeaders});assert.equal(rateLimited.status,202);assert.equal(outbound,beforeCronOutbound);
 const afterManual=await kv.get<any>('add:corpus:v2:state','json');assert(afterManual.lastVerifiedAt);assert.equal(afterManual.lastVerifiedAt,state.lastVerifiedAt);
 const shard=await kv.get<any>(Object.values(state.refs)[0] as string,'json');assert.equal(shard.documents['보안과제 관리요령'].fileNo,'100');assert.match(shard.documents['보안과제 관리요령'].sha256,/^[a-f0-9]{64}$/);
 for(const name of oauthBefore)assert(await kv.get(name));
 const after=await mf.dispatchFetch('https://add-regulations-mcp.splain0102.workers.dev/mcp',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});assert.equal(after.status,401);
 if(process.env.CORPUS_LIVE_CHECKPOINT){
  const entries=JSON.parse(readFileSync(process.env.CORPUS_LIVE_CHECKPOINT,'utf8')) as [string,string][];
  await new Promise(resolve=>setTimeout(resolve,1100));
  const report=JSON.parse(readFileSync('reports/corpus-index-acceptance.json','utf8'));
  const snapshot=exportSnapshot(entries,report);
  const activated=await uploadSnapshot(snapshot,async(path:string,body:any)=>{const response=await mf.dispatchFetch('https://add-regulations-mcp.splain0102.workers.dev/admin/bootstrap-index/'+path,{method:'POST',headers:{...adminHeaders,'content-type':'application/json'},body:JSON.stringify(body)});const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));return result;});
  assert.equal(activated.indexedRegulations,213);for(const name of oauthBefore)assert(await kv.get(name));
 }
 const verifier='abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890-._~';
 const challenge=createHash('sha256').update(verifier).digest('base64url');
 const params=new URLSearchParams({response_type:'code',client_id:client.client_id,redirect_uri:'https://example.com/callback',scope:'mcp:read',state:'test',code_challenge:challenge,code_challenge_method:'S256',resource:'https://add-regulations-mcp.splain0102.workers.dev/mcp'});
 const grant=await mf.dispatchFetch('https://add-regulations-mcp.splain0102.workers.dev/test-grant?'+params);if(grant.status!==200)console.log('GRANT_ERROR',await grant.clone().text());assert.equal(grant.status,200);const approved=await grant.json();const code=new URL(approved.redirectTo).searchParams.get('code');assert(code);
 const tokenResponse=await mf.dispatchFetch('https://add-regulations-mcp.splain0102.workers.dev/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id:client.client_id,code,redirect_uri:'https://example.com/callback',code_verifier:verifier,resource:'https://add-regulations-mcp.splain0102.workers.dev/mcp'}).toString()});assert.equal(tokenResponse.status,200);const token=await tokenResponse.json();assert(token.access_token);
 const rpcHeaders={host:'add-regulations-mcp.splain0102.workers.dev','content-type':'application/json',accept:'application/json, text/event-stream',authorization:'Bearer '+token.access_token};
 const initialize=await mf.dispatchFetch('https://add-regulations-mcp.splain0102.workers.dev/mcp',{method:'POST',headers:rpcHeaders,body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'A-test',version:'1'}}})});assert.equal(initialize.status,200);await initialize.text();
 const helloResponse=await mf.dispatchFetch('https://add-regulations-mcp.splain0102.workers.dev/mcp',{method:'POST',headers:rpcHeaders,body:JSON.stringify({jsonrpc:'2.0',id:99,method:'tools/call',params:{name:'hello',arguments:{}}})});assert.equal(helloResponse.status,200);const helloText=await helloResponse.text();assert(helloText.includes(BUILD_VERSION));assert.equal(manualRun.build_version,BUILD_VERSION);
 const beforeSearch=outbound;
 const search=await mf.dispatchFetch('https://add-regulations-mcp.splain0102.workers.dev/mcp',{method:'POST',headers:rpcHeaders,body:JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'search_all_regulations',arguments:{query:'외국인'}}})});assert.equal(search.status,200);const response=await search.text();assert(response.includes('"partial":false'));assert(response.includes('제8조'));assert.equal(outbound,beforeSearch);
 if(process.env.DOCUMENT_INDEX_FIXTURE){
  const fixture=JSON.parse(readFileSync(process.env.DOCUMENT_INDEX_FIXTURE,'utf8')),saved=await kv.get('add:corpus:v2:state','text');
  await kv.put(fixture.ref,JSON.stringify({documents:{[fixture.doc.title]:fixture.doc}}));await new Promise(resolve=>setTimeout(resolve,1100));await kv.put('add:corpus:v2:state',JSON.stringify(fixture.state));
  const evidence:any[]=[];const before=outbound;
  for(const [tool,args] of [['search_regulation_table',{name:'위임전결규정',query:'전문가'}],['search_regulation_table',{name:'위임전결규정',query:'전문가'}],['search_regulation_table',{name:'위임전결규정',query:'내부승인'}],['search_regulation_text',{name:'위임전결규정',query:'전문가활용'}],['get_regulation_text',{name:'위임전결규정'}]] as const){
   const t=performance.now();const reply=await mf.dispatchFetch('https://add-regulations-mcp.splain0102.workers.dev/mcp',{method:'POST',headers:rpcHeaders,body:JSON.stringify({jsonrpc:'2.0',id:88,method:'tools/call',params:{name:tool,arguments:args}})});const raw=await reply.text();assert.equal(reply.status,200,raw.slice(0,300));
   const payload=JSON.parse(raw.includes('data:')?raw.split('\n').find(line=>line.startsWith('data:'))!.slice(5):raw);assert(!payload.error,raw.slice(0,300));assert(!payload.result?.isError,raw.slice(0,300));assert.equal(payload.result.structuredContent.metrics.document_parses,0);if('query' in args&&args.query==='전문가')assert.equal(payload.result.structuredContent.totalMatches,2);
   evidence.push({tool,args,elapsed_ms:performance.now()-t,metrics:payload.result.structuredContent.metrics});
  }
  assert.equal(outbound,before);writeFileSync('reports/indexed-document-workers.json',JSON.stringify({passed:true,evidence,outbound:outbound-before},null,2));
  await new Promise(resolve=>setTimeout(resolve,1100));await kv.put('add:corpus:v2:state',saved!);
 }
 const offlineOrigin='https://add-regulations-mcp.splain0102.workers.dev/admin/offline-index/';
 const missingIdentity=await mf.dispatchFetch(offlineOrigin+'snapshot');assert.equal(missingIdentity.status,401);
 let oidc=await indexToken();const external=async(path:string,body?:any)=>mf.dispatchFetch(offlineOrigin+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+oidc,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
 const exportResponse=await external('snapshot');assert.equal(exportResponse.status,200,await exportResponse.clone().text());const exported=await exportResponse.json();assert(exported.entries.length>0);assert(exported.entries.every(([key]:[string,string])=>key.startsWith('add:corpus:v2:')));
 assert.equal((await external('start',{})).status,200);assert.equal((await external('progress',{stage:'document',title:'감사규정',fileNo:'100'})).status,200);
 const originalManifest=await kv.get('add:corpus:v2:state','text');assert.equal((await external('failure',{stage:'failed',title:'감사규정',error_code:'fetch_failed',message:'fixture 522'})).status,200);assert.equal(await kv.get('add:corpus:v2:state','text'),originalManifest);
 const failedStatus=await (await mf.dispatchFetch('https://add-regulations-mcp.splain0102.workers.dev/admin/index-status',{headers:adminHeaders})).json();assert.equal(failedStatus.partial,true);assert.equal(failedStatus.index_refresh_error.error_code,'fetch_failed');assert.equal(failedStatus.last_index_run.execution,'github_actions');
 // A new signed workflow attempt validates/activates the unchanged corpus and clears the error.
 await new Promise(resolve=>setTimeout(resolve,1150));oidc=await indexToken('2');assert.equal((await external('start',{})).status,200);
 const restored=new TestKV();restored.values=new Map(exported.entries);const localResult=await searchAllRegulations('외국인',10,0,restored.binding(),BUILD_VERSION);const manifest=JSON.parse(originalManifest!);const security=localResult.results.find((r:any)=>r.regulationName.endsWith('보안과제 관리요령'));assert(security?.matches.some((m:any)=>m.label.includes('제8조')));
 const snapshot=exportSnapshot(exported.entries,{passed:true,indexed:manifest.items.length,total:manifest.items.length,result:localResult,audit:{fileNo:'100'},security,finishedAt:new Date().toISOString()});
 const offlineActivated=await uploadSnapshot(snapshot,async(path:string,body:any)=>{const reply=await external('bootstrap/'+path,body);assert.equal(reply.status,200,await reply.clone().text());return reply.json();});assert.equal(offlineActivated.indexedRegulations,manifest.items.length);
 const completeStatus=await (await mf.dispatchFetch('https://add-regulations-mcp.splain0102.workers.dev/admin/index-status',{headers:adminHeaders})).json();assert.equal(completeStatus.partial,false);assert.equal(completeStatus.index_refresh_error,null);assert.equal(completeStatus.last_index_run.status,'success');assert.equal(completeStatus.last_index_run.execution,'github_actions');
 for(const key of oauthBefore)assert(await kv.get(key));
 writeFileSync('reports/corpus-index-workers.json',JSON.stringify({passed:true,runtime:'workerd + Miniflare actual Worker bundle, local KV, mocked ALIO',oauthDiscovery:discovery.status,dynamicRegistration:register.status,unauthenticatedMcpBefore:protectedResponse.status,unauthenticatedMcpAfter:after.status,cron:state,outbound,pkceTokenExchange:tokenResponse.status,authenticatedSearchStatus:search.status,searchResponse:response,liveSnapshot:process.env.CORPUS_LIVE_CHECKPOINT??null,adminManualRun:manualRun,runStatus,offlineOidc:{passed:true,missingIdentity:missingIdentity.status,completeStatus}},null,2));console.log('CORPUS_WORKERS_PASS',JSON.stringify({outbound,oauthKeysPreserved:oauthBefore.length}));
}finally{await mf.dispose();}

