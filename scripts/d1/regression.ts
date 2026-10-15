import {lease,release} from './lease';
import {zipSync,strToU8} from 'fflate';
import {searchRegulationText} from '../../src/regulation-core/text-search';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {hash} from './records';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {build} from 'esbuild';
import {readFileSync,readdirSync,mkdirSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {documentRecords} from './records';
import {loadDocument,publishCatalog} from './load';
import {runD1Tool} from '../../src/d1/tools';
import {extractHwpTables,structureTables} from '../../src/regulation-core/table-layout';
import {searchGeneralTables} from '../../src/regulation-core/general-table-search';
import {hwpToText} from '@ssabrojs/hwpxjs/browser';
mkdirSync('reports',{recursive:true});mkdirSync('.build-check',{recursive:true});
const workerSource=readFileSync('src/d1-worker.ts','utf8').replace('export default {fetch:', 'const productionWorker = {fetch:')+`
export default {...productionWorker,async fetch(request,env,ctx){const url=new URL(request.url);if(url.pathname==='/test-grant'){await provider.fetch(new Request(url.origin+'/test-initialize'),env,ctx);const auth=await env.OAUTH_PROVIDER.parseAuthRequest(new Request(url.origin+'/authorize'+url.search));return Response.json(await env.OAUTH_PROVIDER.completeAuthorization({request:auth,userId:'test',metadata:{},scope:['mcp:read'],props:{}}));}const canonical=new URL(request.url);canonical.protocol='https:';canonical.host='add-regulations-mcp.splain0102.workers.dev';const headers=new Headers(request.headers);headers.set('host',canonical.host);return productionWorker.fetch(new Request(new Request(canonical,request),{headers}),env,ctx);}};
`;
await build({stdin:{contents:workerSource,loader:'ts',resolveDir:process.cwd()+'/src'},bundle:true,format:'esm',platform:'browser',conditions:['workerd','worker','browser'],external:['cloudflare:*','node:async_hooks'],outfile:'.build-check/d1-oauth.js'});
const mf=new Miniflare(convertV4MiniflareOptions({modules:true,scriptPath:'.build-check/d1-oauth.js',compatibilityDate:'2026-10-01',compatibilityFlags:['global_fetch_strictly_public'],d1Databases:{REGULATIONS_DB:'regression'},kvNamespaces:['OAUTH_KV'],bindings:{ACCESS_CLIENT_ID:'test',ACCESS_CLIENT_SECRET:'test',COOKIE_ENCRYPTION_KEY:'0123456789abcdef0123456789abcdef'},outboundService:()=>{throw Error('No outbound network permitted');}}));
const db=await mf.getD1Database('REGULATIONS_DB');let writtenRows=0;const adapter={query:async(sql:string,params:any[]=[])=>{const r=await db.prepare(sql).bind(...params).all();return r.results;},batch:async(rows:any[])=>{const results=await db.batch(rows.map(r=>db.prepare(r.sql).bind(...r.params)));writtenRows+=results.reduce((n,r)=>n+(r.meta.rows_written??0),0);}};
const report:any={passed:false,scope:'Local workerd D1; stored actual ALIO files, not current-source or production CPU evidence',comparison:[],tests:[]};
try{
 await db.exec(readFileSync('migrations/0001_regulation_index.sql','utf8').split('\n').filter(l=>!l.startsWith('--')).join(' '));
 const samples=JSON.parse(gunzipSync(Buffer.from(readFileSync('scripts/fixtures/d1-samples.json.gz.b64','utf8'),'base64')).toString('utf8')),wanted=['기술용역 업무규정','여비규정','위임전결규정'];const catalog:any={items:[],documents:[],verified_at:new Date().toISOString()};
 await adapter.batch([{sql:"INSERT INTO sync_runs(run_id,build_sha,started_at,status) VALUES('test','test',?,'running')",params:[catalog.verified_at]}]);
 const baselines=new Map();
 for(const title of wanted){const saved=samples.find(d=>d.item?.title===title);assert(saved,title);const loaded={...saved.document,bytes:new Uint8Array(Buffer.from(saved.document.bytes,'base64'))};assert.equal(hash(loaded.bytes),saved.raw_sha256);loaded.text=await hwpToText(loaded.bytes);const records=await documentRecords(saved.item,loaded);await loadDocument(adapter,records);await loadDocument(adapter,records);catalog.items.push(saved.item);catalog.documents.push({item:saved.item,document_id:records.document.document_id,verified_at:catalog.verified_at});const tables=extractHwpTables(loaded.bytes),rows=structureTables(tables,loaded.text);baselines.set(title,{tables,rows,loaded,records,item:saved.item});}
 await lease(adapter,'test',true);await assert.rejects(()=>lease(adapter,'other',true));
 const snapshot=await publishCatalog(adapter,'test',catalog,null);report.tests.push('complete snapshot published');
 const cell=(text:string,row:number,col:number,rowSpan=1)=>`<hp:tc><hp:cellAddr rowAddr="${row}" colAddr="${col}"/><hp:cellSpan rowSpan="${rowSpan}" colSpan="1"/><hp:subList><hp:p><hp:run><hp:t>${text}</hp:t></hp:run></hp:p></hp:subList></hp:tc>`;
 const hwpxBytes=zipSync({'Contents/section0.xml':strToU8(`<hs:sec><hp:tbl>${cell('구분',0,0)}${cell('비고',0,1)}${cell('출장',1,0,2)}${cell('식비',1,1)}${cell('전문가',2,1)}</hp:tbl></hs:sec>`)});
 const hwpx=await documentRecords({title:'HWPX 구조 시험',detailUrl:'https://www.alio.go.kr/item/itemBoard21110.do?idx=999999',revisionDate:'2026.01.01',updatedDate:'2026.01.01'},{fileNo:'999999',bytes:hwpxBytes,text:'제1조(시험)\n출장 식비 전문가',parserVersion:'1.10.5-parser.1',selectedDate:'2026-01-01'});
 assert(hwpx.rows.some(r=>(r.result.raw_cells as any[]).some(c=>c.row===1&&c.col===0&&c.rowSpan===2&&c.colSpan===1)));await loadDocument(adapter,hwpx);report.tests.push('synthetic HWPX original merged-cell coordinates persist through D1 ingestion');

 const original=globalThis.fetch;globalThis.fetch=async()=>{throw Error('ALIO access forbidden');};
 try{for(const name of wanted)for(const query of ['식비','비고','제10조']){
  const baseline=baselines.get(name),expected=searchGeneralTables(baseline.tables,query,baseline.rows,'hwp').filter(r=>r.analysis_type!=='text_box');
  const times:number[]=[];let actual:any;for(let i=0;i<20;i++){const t=performance.now();actual=await runD1Tool(db,'search_regulation_table',{name,query,limit:100,compact:false},'test');times.push(performance.now()-t);assert(!actual.isError,JSON.stringify(actual));}
  const got=actual.structuredContent.totalMatches;report.comparison.push({name,query,old:expected.length,new:got,p95_ms:times.sort((a,b)=>a-b)[18],matches:got===expected.length});assert.equal(got,expected.length,name+'/'+query);
 }
 for(const name of wanted)for(const query of ['식비','비고','제10조']){
  const baseline=baselines.get(name),old:any[]=[];for(let offset=0;offset<1000;offset+=10){const legacy:any=await searchRegulationText(name,query,{compact:false,offset},{text:async()=>({...baseline.item,regulationName:name,text:baseline.loaded.text}) as any,table:async()=>({rows:[]}) as any,metadata:async()=>({}) as any,history:async()=>[]});old.push(...legacy.structuredContent.matches);if(legacy.structuredContent.matches.length<10)break;}
  const actual=await runD1Tool(db,'search_regulation_text',{name,query,scope:'body',limit:100,compact:false});assert(!actual.isError,JSON.stringify(actual));const count=actual.structuredContent.totalMatches;
  const expanded=count!==old.length&&count>old.length&&actual.structuredContent.results.every((r:any)=>{const raw=baseline.loaded.text;const normalized=raw.replace(/[\s,]+/g,'');return normalized.includes(query)&&new RegExp([...query].join('[\\s,]*')).test(r.snippet);});
  report.comparison.push({kind:'body',name,query,old:old.length,new:count,matches:count===old.length,normalization_expansion:expanded,evidence:expanded?actual.structuredContent.results.map((r:any)=>({label:r.label,snippet:r.snippet.slice(0,300)})):undefined});assert(count===old.length||expanded,'body '+name+'/'+query+' unexplained mismatch');
 }
 for(const tool of ['list_regulations','search_regulations','get_regulation','get_regulation_text','search_regulation_text','search_all_regulations','diagnose_alio_list']){const r=await runD1Tool(db,tool,{name:tool==='list_regulations'||tool==='search_regulations'||tool==='search_all_regulations'||tool==='diagnose_alio_list'?undefined:'위임전결규정',query:'전문가'},'test');assert(!r.isError,JSON.stringify(r));report.tests.push(tool);}
 const warning=await runD1Tool(db,'search_all_regulations',{query:'◎★'});assert.equal(warning.structuredContent.warning.code,'symbol_query');
 assert.equal((await runD1Tool(db,'search_all_regulations',{query:'가'.repeat(257)})).structuredContent.warning.code,'query_too_long');
 const short=await runD1Tool(db,'search_all_regulations',{query:'가'});assert.equal(short.structuredContent.warning.code,'query_too_short');
 }finally{globalThis.fetch=original;}
 // Publication failure and concurrent publisher must leave the prior pointer intact.
 await adapter.batch([{sql:"INSERT INTO sync_runs(run_id,build_sha,started_at,status) VALUES('bad','test',?,'running')",params:[catalog.verified_at]}]);
 await release(adapter,'test');await lease(adapter,'bad',true);
 await assert.rejects(()=>publishCatalog(adapter,'bad',catalog,'wrong'));await release(adapter,'bad');await lease(adapter,'test',true);assert.equal((await adapter.query('SELECT active_snapshot_id FROM service_state'))[0].active_snapshot_id,snapshot);
 report.tests.push('publication conflict rollback preserves committed snapshot');
 const sourceDoc=(await adapter.query('SELECT * FROM documents WHERE document_id=?',[catalog.documents[0].document_id]))[0],partial={...sourceDoc,document_id:'interrupted-test',metadata_sha256:'interrupted-test',indexed_at:null};const columns=Object.keys(partial);
 await adapter.batch([{sql:`INSERT INTO documents(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`,params:Object.values(partial)}]);
 await assert.rejects(()=>publishCatalog(adapter,'bad',{...catalog,items:[catalog.items[0]],documents:[{...catalog.documents[0],document_id:partial.document_id}]},snapshot));
 assert.equal((await adapter.query('SELECT active_snapshot_id FROM service_state'))[0].active_snapshot_id,snapshot);
 report.tests.push('interrupted incomplete document cannot publish');
 const originalRecords=baselines.get(catalog.items[0].title).records;await loadDocument(adapter,{...originalRecords,document:{...originalRecords.document,document_id:partial.document_id,metadata_sha256:partial.metadata_sha256}});assert((await adapter.query('SELECT indexed_at FROM documents WHERE document_id=?',[partial.document_id]))[0].indexed_at);report.tests.push('interrupted document resumes and validates without changing active catalog');

 const page1=await runD1Tool(db,'search_regulation_table',{name:'위임전결규정',query:'계약 승인',limit:5,offset:0});const page2=await runD1Tool(db,'search_regulation_table',{name:'위임전결규정',query:'계약 승인',limit:5,offset:5});assert(!page1.isError&&!page2.isError);assert.equal(page1.structuredContent.next_offset,5);report.tests.push('offset pagination');
 report.ingestion_rows_written_including_fault_fixtures=writtenRows;report.database_bytes=(await db.prepare('SELECT 1').all()).meta.size_after??null;
 const bundle=await build({entryPoints:['src/d1-worker.ts'],bundle:true,format:'esm',platform:'browser',conditions:['workerd','worker','browser'],external:['cloudflare:*','node:async_hooks'],outfile:'.build-check/d1-worker.js',metafile:true});assert(!Object.keys(bundle.metafile!.inputs).some(p=>/regulation-core\/(?:regulations|table-layout|pdf-)|hwpxjs|unpdf|fflate/.test(p)));report.tests.push('serving bundle has no ALIO client or document parsers');
 const origin='https://add-regulations-mcp.splain0102.workers.dev';
 assert.equal((await mf.dispatchFetch(origin+'/mcp',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,401);
 const registration=await mf.dispatchFetch(origin+'/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({client_name:'D1 regression',redirect_uris:['https://example.com/callback'],grant_types:['authorization_code','refresh_token'],response_types:['code'],token_endpoint_auth_method:'none'})});assert.equal(registration.status,201);const client:any=await registration.json();
 const verifier='abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890-._~',challenge=createHash('sha256').update(verifier).digest('base64url');
 const grant=await mf.dispatchFetch(origin+'/test-grant?'+new URLSearchParams({response_type:'code',client_id:client.client_id,redirect_uri:'https://example.com/callback',scope:'mcp:read',state:'test',code_challenge:challenge,code_challenge_method:'S256',resource:origin+'/mcp'}));assert.equal(grant.status,200);const approved:any=await grant.json();const code=new URL(approved.redirectTo).searchParams.get('code')!;
 const tokenReply=await mf.dispatchFetch(origin+'/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id:client.client_id,code,redirect_uri:'https://example.com/callback',code_verifier:verifier,resource:origin+'/mcp'}).toString()});assert.equal(tokenReply.status,200);const token:any=await tokenReply.json();
 report.mcp=[];
 for(const tool of ['hello','list_regulations','search_regulations','get_regulation','get_regulation_text','search_regulation_text','search_regulation_table','search_all_regulations','diagnose_alio_list']){
  const times:number[]=[];for(let i=0;i<20;i++){const t=performance.now(),response=await mf.dispatchFetch(origin+'/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream',authorization:'Bearer '+token.access_token},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:tool,arguments:{name:'위임전결규정',query:'전문가'}}})});const raw=await response.text();assert.equal(response.status,200,raw.slice(0,200));const json=JSON.parse(raw.includes('data:')?raw.split('\n').find(l=>l.startsWith('data:'))!.slice(5):raw);assert(!json.error&&!json.result?.isError,raw.slice(0,200));times.push(performance.now()-t);}
  const p95=times.sort((a,b)=>a-b)[18];assert(p95<1000,tool+' p95');report.mcp.push({tool,p95_ms:p95,execution:'local workerd OAuth MCP; no outbound ALIO'});
 }
 report.tests.push('all nine actual OAuth MCP tools; twenty calls each; no outbound network');
 report.passed=true;
}catch(error){report.error=String(error);process.exitCode=1;}finally{writeFileSync('reports/d1-regression.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));await mf.dispose();}
