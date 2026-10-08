import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {build} from 'esbuild';
import {createHash} from 'node:crypto';
import {zipSync,strToU8} from 'fflate';
const xml='<hs:sec><hp:p><hp:run><hp:t>제8조(외국인 참여)</hp:t></hp:run></hp:p><hp:p><hp:run><hp:t>외국인은 승인을 받아야 한다.</hp:t></hp:run></hp:p></hs:sec>';
const bytes=zipSync({'Contents/section0.xml':strToU8(xml)});
let outbound=0;
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
const mf=new Miniflare(convertV4MiniflareOptions({modules:true,scriptPath:'.build-check/oauth-test.js',compatibilityDate:'2026-10-01',compatibilityFlags:['global_fetch_strictly_public'],kvNamespaces:['OAUTH_KV'],bindings:{ACCESS_CLIENT_ID:'test',ACCESS_CLIENT_SECRET:'test',COOKIE_ENCRYPTION_KEY:'0123456789abcdef0123456789abcdef'},outboundService:async request=>{
 outbound++;const url=new URL(request.url);
 if(url.pathname.endsWith('itemReportListSusi.json'))return Response.json({data:{result:[{title:'보안과제 관리요령',apbaId:'C0345',idx:'1',reportFormNo:'21110',tableName:'COMM_RULE',idxName:'RULE_NO',reportGbn:'N',bidType:'',stDate:'2026.01.01',idate:'2026.02.02'}],page:{totalPage:1,totalCount:1}}});
 if(url.pathname.includes('itemBoard'))return new Response('<a href="/download/rulefiledown.json?fileNo=100">보안과제 관리요령.hwpx</a>');
 if(url.pathname.includes('rulefiledown'))return new Response(bytes,{headers:{'content-disposition':'attachment; filename="test.hwpx"'}});
 throw Error('unexpected outbound '+url);
}}));
try{
 const discovery=await mf.dispatchFetch('https://add-regulations-mcp.splain0102.workers.dev/.well-known/oauth-authorization-server');assert.equal(discovery.status,200);const metadata=await discovery.json();assert(metadata.authorization_endpoint);assert(metadata.token_endpoint);
 const protectedResponse=await mf.dispatchFetch('https://add-regulations-mcp.splain0102.workers.dev/mcp',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});assert.equal(protectedResponse.status,401);
 const register=await mf.dispatchFetch('https://add-regulations-mcp.splain0102.workers.dev/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({client_name:'A regression client',redirect_uris:['https://example.com/callback'],grant_types:['authorization_code'],response_types:['code'],token_endpoint_auth_method:'none'})});assert.equal(register.status,201);const client=await register.json();assert(client.client_id);
 const kv=await mf.getKVNamespace('OAUTH_KV');const oauthBefore=(await kv.list()).keys.filter(k=>!k.name.startsWith('add:corpus:')).map(k=>k.name);assert(oauthBefore.length);
 const worker=await mf.getWorker();assert.equal(typeof worker.scheduled,'function');await worker.scheduled({cron:'*/5 * * * *',scheduledTime:Date.now()});
 const state=await kv.get<any>('add:corpus:v2:state','json');assert(state);assert.equal(state.items.length,1);assert.equal(Object.keys(state.errors).length,0);
 const shard=await kv.get<any>(Object.values(state.refs)[0] as string,'json');assert.equal(shard.documents['보안과제 관리요령'].fileNo,'100');assert.match(shard.documents['보안과제 관리요령'].sha256,/^[a-f0-9]{64}$/);
 for(const name of oauthBefore)assert(await kv.get(name));
 const after=await mf.dispatchFetch('https://add-regulations-mcp.splain0102.workers.dev/mcp',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});assert.equal(after.status,401);
 if(process.env.CORPUS_LIVE_CHECKPOINT){
  const entries=JSON.parse(readFileSync(process.env.CORPUS_LIVE_CHECKPOINT,'utf8')) as [string,string][];
  await new Promise(resolve=>setTimeout(resolve,1100));
  for(const [key,value] of entries)if(key.startsWith('add:corpus:v2:'))await kv.put(key,value);
 }
 const verifier='abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890-._~';
 const challenge=createHash('sha256').update(verifier).digest('base64url');
 const params=new URLSearchParams({response_type:'code',client_id:client.client_id,redirect_uri:'https://example.com/callback',scope:'mcp:read',state:'test',code_challenge:challenge,code_challenge_method:'S256',resource:'https://add-regulations-mcp.splain0102.workers.dev/mcp'});
 const grant=await mf.dispatchFetch('https://add-regulations-mcp.splain0102.workers.dev/test-grant?'+params);if(grant.status!==200)console.log('GRANT_ERROR',await grant.clone().text());assert.equal(grant.status,200);const approved=await grant.json();const code=new URL(approved.redirectTo).searchParams.get('code');assert(code);
 const tokenResponse=await mf.dispatchFetch('https://add-regulations-mcp.splain0102.workers.dev/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id:client.client_id,code,redirect_uri:'https://example.com/callback',code_verifier:verifier,resource:'https://add-regulations-mcp.splain0102.workers.dev/mcp'}).toString()});assert.equal(tokenResponse.status,200);const token=await tokenResponse.json();assert(token.access_token);
 const rpcHeaders={host:'add-regulations-mcp.splain0102.workers.dev','content-type':'application/json',accept:'application/json, text/event-stream',authorization:'Bearer '+token.access_token};
 const initialize=await mf.dispatchFetch('https://add-regulations-mcp.splain0102.workers.dev/mcp',{method:'POST',headers:rpcHeaders,body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'A-test',version:'1'}}})});assert.equal(initialize.status,200);await initialize.text();
 const beforeSearch=outbound;
 const search=await mf.dispatchFetch('https://add-regulations-mcp.splain0102.workers.dev/mcp',{method:'POST',headers:rpcHeaders,body:JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'search_all_regulations',arguments:{query:'외국인'}}})});assert.equal(search.status,200);const response=await search.text();assert(response.includes('"partial":false'));assert(response.includes('제8조'));assert.equal(outbound,beforeSearch);
 writeFileSync('reports/corpus-index-workers.json',JSON.stringify({passed:true,runtime:'workerd + Miniflare actual Worker bundle, local KV, mocked ALIO',oauthDiscovery:discovery.status,dynamicRegistration:register.status,unauthenticatedMcpBefore:protectedResponse.status,unauthenticatedMcpAfter:after.status,cron:state,outbound,pkceTokenExchange:tokenResponse.status,authenticatedSearchStatus:search.status,searchResponse:response,liveSnapshot:process.env.CORPUS_LIVE_CHECKPOINT??null},null,2));console.log('CORPUS_WORKERS_PASS',JSON.stringify({outbound,oauthKeysPreserved:oauthBefore.length}));
}finally{await mf.dispose();}
