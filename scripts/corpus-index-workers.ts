import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {zipSync,strToU8} from 'fflate';
const xml='<hs:sec><hp:p><hp:run><hp:t>제8조(외국인 참여)</hp:t></hp:run></hp:p><hp:p><hp:run><hp:t>외국인은 승인을 받아야 한다.</hp:t></hp:run></hp:p></hs:sec>';
const bytes=zipSync({'Contents/section0.xml':strToU8(xml)});
let outbound=0;
const mf=new Miniflare(convertV4MiniflareOptions({modules:true,scriptPath:'.build-check/index.js',compatibilityDate:'2026-10-01',compatibilityFlags:['global_fetch_strictly_public'],kvNamespaces:['OAUTH_KV'],bindings:{ACCESS_CLIENT_ID:'test',ACCESS_CLIENT_SECRET:'test',COOKIE_ENCRYPTION_KEY:'0123456789abcdef0123456789abcdef'},outboundService:async request=>{
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
 writeFileSync('reports/corpus-index-workers.json',JSON.stringify({passed:true,runtime:'workerd + Miniflare actual Worker bundle, local KV, mocked ALIO',oauthDiscovery:discovery.status,dynamicRegistration:register.status,unauthenticatedMcpBefore:protectedResponse.status,unauthenticatedMcpAfter:after.status,cron:state,outbound},null,2));console.log('CORPUS_WORKERS_PASS',JSON.stringify({outbound,oauthKeysPreserved:oauthBefore.length}));
}finally{await mf.dispose();}
