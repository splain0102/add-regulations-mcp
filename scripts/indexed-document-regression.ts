import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
import {hwpToText} from '@ssabrojs/hwpxjs/browser';
import {prepareDocumentIndex,searchLatestRegulationTable} from '../src/regulation-core/regulations';
import {indexedDocumentTool} from '../src/regulation-core/indexed-document-tools';
import {unpackDocument} from '../src/regulation-core/document-index-codec';
import {INDEX_PREFIX,shardId,sha256} from '../src/regulation-core/corpus-index';
import {PARSER_VERSION} from '../src/regulation-core/parser-version';
import {BUILD_VERSION} from '../src/build-info';
import {TestKV} from './corpus-index-test-kv';
const fixture=process.env.DOCUMENT_FIXTURE??'reports/live-239154.hwp';
if(!existsSync(fixture)){
 const cache='reports/corpus-index-live-files/afda86e65d4a106a63176aba382814482de6265f7eda1997418d132a3d1adb86.json';
 if(existsSync(cache)){const saved=JSON.parse(readFileSync(cache,'utf8'));assert.equal(saved.document.fileNo,'239154');assert(Date.now()-Date.parse(saved.downloadedAt)<3600000);writeFileSync(fixture,Buffer.from(saved.document.bytes,'base64'));}
 else{const response=await fetch('https://www.alio.go.kr/download/rulefiledown.json?fileNo=239154',{signal:AbortSignal.timeout(25000)});assert(response.ok);writeFileSync(fixture,new Uint8Array(await response.arrayBuffer()));}
}
const bytes=new Uint8Array(readFileSync(fixture));
const item={title:'위임전결규정',detailUrl:'https://www.alio.go.kr/item/itemBoard21110.do?idx=25545',revisionDate:'2026.07.15',updatedDate:'2026.07.29'};
const attachment={fileNo:'239154',name:'위임전결규정 전문(2026년7월15일 개정).hwp',detectedDate:'2026-07-15'};
const loaded:any={match:item,detail:{title:item.title,sourceUrl:item.detailUrl,revisionDate:item.revisionDate,updatedDate:item.updatedDate,selection_reason:['verified_fixture'],other_attachments:[]},attachment,document:{file:{filename:attachment.name,extension:'hwp',bytes},text:''},cache:{key:'fixture',hit:false,scope:'offline',metadataRevalidated:true}};
const cpu=process.cpuUsage(),start=performance.now();loaded.document.text=await hwpToText(bytes);const textMs=performance.now()-start;const layoutStart=performance.now();const prepared=await prepareDocumentIndex(loaded);const preparationMs=performance.now()-layoutStart;
const baseline={textMs,preparationMs,cpu:process.cpuUsage(cpu),memory:process.memoryUsage(),bytes:bytes.length,compressedBytes:prepared.data.length,uncompressedBytes:prepared.uncompressedBytes};
assert(loaded.document.tables.length>0);assert(loaded.document.rows.length>0);assert.deepEqual(unpackDocument(prepared).tables,loaded.document.tables);assert.deepEqual(unpackDocument(prepared).rows,loaded.document.rows);
const kv=new TestKV(),now=new Date().toISOString(),id=shardId(item.title),ref=INDEX_PREFIX+'fixture:'+id;
const doc={...item,fileNo:attachment.fileNo,text:loaded.document.text,sha256:await sha256(bytes),verifiedAt:now,parserVersion:PARSER_VERSION,prepared};
const state:any={schema:2,items:[item],refs:{[id]:ref},checked:{[item.title]:now},errors:{},pending:[],lastCheckedAt:now,index_build_version:BUILD_VERSION};
kv.values.set(ref,JSON.stringify({documents:{[item.title]:doc}}));kv.values.set(INDEX_PREFIX+'state',JSON.stringify(state));
writeFileSync('reports/indexed-document-fixture.json',JSON.stringify({state,doc,ref}));
const original=globalThis.fetch;let outbound=0;globalThis.fetch=async()=>{outbound++;throw Error('Request-time network forbidden');};
const tests:any[]=[];
try{
 for(const query of ['전문가','내부승인','300만','전문가 300','외화 300','계약 승인','국내 출장','병가']){
  const expected=await searchLatestRegulationTable(item.title,query,loaded);const t=performance.now(),queryCpu=process.cpuUsage();const result=await indexedDocumentTool(kv.binding(),'search_regulation_table',{name:item.title,query,compact:false});
  assert(!result.isError,JSON.stringify(result));assert.equal(result.structuredContent.totalMatches,expected.rows.length,query);
  if(query==='전문가')assert.equal(expected.rows.length,2);
  for(const row of result.structuredContent.rows){const exact=expected.rows.find(r=>r.table_id===row.table_id&&r.row===row.row&&r.symbol===row.symbol);assert(exact);assert.equal(row.approver,exact.approver);assert.equal(row.symbol,exact.symbol);if(exact.footnotes)assert.deepEqual(row.footnotes,exact.footnotes);}
  tests.push({query,ms:performance.now()-t,matches:expected.rows.length,metrics:result.structuredContent.metrics,cpu:process.cpuUsage(queryCpu),memory:process.memoryUsage()});
 }
 for(const tool of ['get_regulation_text','search_regulation_text']){const t=performance.now();const r=await indexedDocumentTool(kv.binding(),tool,{name:item.title,query:'전문가활용'});assert(!r.isError);tests.push({tool,ms:performance.now()-t,metrics:r.structuredContent.metrics});}
 const stale=await indexedDocumentTool(kv.binding(),'search_regulation_table',{name:item.title,query:'전문가'},{error_code:'fetch_failed'});assert.equal(stale.structuredContent.partial,true);assert.equal(stale.structuredContent.index_status,'stale');assert.equal(stale.structuredContent.totalMatches,2);
 state.index_build_version='old';kv.values.set(INDEX_PREFIX+'state',JSON.stringify(state));assert.equal((await indexedDocumentTool(kv.binding(),'get_regulation_text',{name:item.title})).structuredContent.index_status,'stale');
 delete (doc as any).prepared;kv.values.set(ref,JSON.stringify({documents:{[item.title]:doc}}));const missing=await indexedDocumentTool(kv.binding(),'search_regulation_table',{name:item.title,query:'전문가'});assert.equal(missing.structuredContent.error.code,'index_preparing');assert.equal(outbound,0);
 assert.throws(()=>unpackDocument({...prepared,uncompressedBytes:1}));
}finally{globalThis.fetch=original;}
const report={passed:true,build:BUILD_VERSION,sourceSha256:doc.sha256,baseline,tests,outbound,notes:'Node measurements; CPU and memory are not Cloudflare production metrics. Real HWP row counts and serialized evidence compared. No authority inferred for absent rows.'};writeFileSync('reports/indexed-document-regression.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
