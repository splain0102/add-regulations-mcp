import {handleBootstrap,bootstrapActive} from '../src/regulation-core/index-bootstrap';
import {CorpusIndexCoordinator,handleIndexAdmin,runCoordinatedIndex} from '../src/regulation-core/index-coordinator';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {transformSync} from 'esbuild';
import {z} from 'zod';
import {zipSync,strToU8} from 'fflate';
import {refreshIndex as scheduledRefresh,readIndex,INDEX_PREFIX,MAX_INDEX_AGE,MAX_LIST_AGE,LIST_REFRESH_INTERVAL,DOCUMENT_CHECK_INTERVAL,RETRY_BASE,retryDelay,sha256,shardId,indexErrorCode,type CorpusItem} from '../src/regulation-core/corpus-index';
import {searchAllRegulations,createIndexRequest,createCorpusSource,getRegulationDetail,PARSER_VERSION} from '../src/regulation-core/regulations';
import {TestKV} from './corpus-index-test-kv';
const kv=new TestKV(),base=Date.now();
const items:CorpusItem[]=Array.from({length:213},(_,i)=>({title:i===212?'보안과제 관리요령':'규정'+String(i).padStart(3,'0'),detailUrl:'https://www.alio.go.kr/test/'+i,revisionDate:'2026-01-01',updatedDate:'2026-02-02'}));
let fileNo='100',body='원문 바이트',fail='';
const source={list:async()=>items,load:async(item:CorpusItem)=>{if(item.title===fail)throw Error('injected parse failure');return {fileNo,text:item.title==='보안과제 관리요령'?'제1조(목적)\n목적\n제8조(외국인 참여)\n외국인 참여는 승인 대상이다.\n제9조(보안)\n보안 업무': '제1조(목적)\n일반 업무',bytes:new TextEncoder().encode(body),parserVersion:'test'}}};
const results:any[]=[];
// Existing content/integrity tests deliberately force revalidation; scheduling
// and persisted cooldowns are exercised below through the production defaults.
function refreshIndex(...args:Parameters<typeof scheduledRefresh>){return scheduledRefresh(args[0],args[1],args[2],{forceList:true,forceDocuments:true,...args[3]});}
async function test(name:string,fn:()=>unknown){await fn();results.push({name,status:'passed'});console.log('CORPUS_INDEX PASS',name);}
await test('213 documents complete; registered search defaults; zero external fetch; <=17 KV reads',async()=>{
 kv.values.set('oauth:sentinel','{"unchanged":true}');
 let now=base;for(let i=0;i<107;i++){await refreshIndex(kv.binding(),source,now);now+=1000;}
 const original=globalThis.fetch;globalThis.fetch=async()=>{throw Error('search must not fetch');};
 try{
  const text=readFileSync('src/index.ts','utf8');const start=text.indexOf('  server.registerTool(\n    "search_all_regulations"');const end=text.indexOf('  server.registerTool(\n    "search_regulation_text"',start);
  let registration:any;const server={registerTool:(_name:string,config:any,callback:any)=>{registration={config,callback};}};
  new Function('server','z','env','coreSearchAllRegulations','publicErrorCode','getIndexRuntimeStatus','BUILD_VERSION',transformSync(text.slice(start,end),{loader:'ts'}).code)(server,z,{OAUTH_KV:kv.binding()},searchAllRegulations,()=> 'error',async()=>({last_cron_started_at:null,last_cron_finished_at:null,processed_in_last_run:0}),'test');
  const args=z.object(registration.config.inputSchema).parse({query:'외국인'});const before=kv.reads;
  const r=await registration.callback(args);assert(!r.isError);assert.equal(r.structuredContent.partial,false);assert.equal(r.structuredContent.totalRegulations,213);assert.equal(r.structuredContent.indexedRegulations,213);assert.equal(r.structuredContent.results[0].regulationName,'보안과제 관리요령');assert(r.structuredContent.results[0].matches.some((m:any)=>m.label.includes('제8조')));assert(kv.reads-before<=17);
  assert.equal(kv.values.get('oauth:sentinel'),'{"unchanged":true}');assert(kv.writes<=107*3);
 }finally{globalThis.fetch=original;}
});
const small=new TestKV(),two=items.slice(0,2),smallSource={...source,list:async()=>two};let now=base;
await refreshIndex(small.binding(),smallSource,now);
await test('same stDate/idate detects replaced fileNo and same-file raw SHA changes',async()=>{
 const first=(await readIndex(small.binding(),now)).documents[0];fileNo='101';await refreshIndex(small.binding(),smallSource,++now);assert((await readIndex(small.binding(),now)).documents.every(d=>d.fileNo==='101'));
 body='same text, changed binary';await refreshIndex(small.binding(),smallSource,++now);const updated=(await readIndex(small.binding(),now)).documents[0];assert.notEqual(updated.sha256,first.sha256);assert.equal(updated.sha256,await sha256(new TextEncoder().encode(body)));
});
await test('metadata update failure preserves successful text; persists error; recovery clears it',async()=>{
 two[0].revisionDate='2026-03-03';two[0].updatedDate='2026-04-04';fail=two[0].title;
 await refreshIndex(small.binding(),smallSource,++now);const r=await readIndex(small.binding(),now);assert.equal(r.partial,true);assert.equal(r.errors.count,1);assert.equal(r.documents.find(d=>d.title===fail)!.revisionDate,'2026-01-01');
 fail='';now+=RETRY_BASE;await refreshIndex(small.binding(),smallSource,now);const recovered=await readIndex(small.binding(),now);assert.equal(recovered.partial,false);assert.equal(recovered.errors.count,0);assert.equal(recovered.documents.find(d=>d.title===two[0].title)!.updatedDate,'2026-04-04');
});
await test('KV shard write failure keeps manifest refs; reports failure',async()=>{
 const before=await small.get<any>(INDEX_PREFIX+'state');small.failKey='shard:';body='changed';await refreshIndex(small.binding(),smallSource,++now);small.failKey='';const after=await small.get<any>(INDEX_PREFIX+'state');assert.deepEqual(after.refs,before.refs);assert((await readIndex(small.binding(),now)).errors.count>0);await refreshIndex(small.binding(),smallSource,++now);
});
await test('list outage and empty list preserve snapshot; missing KV shard cannot report ready',async()=>{
 const before=(await readIndex(small.binding(),now)).documents;
 const contents=(docs:any[])=>docs.map(({verifiedAt,...doc})=>doc);
 await refreshIndex(small.binding(),{...smallSource,list:async()=>{throw Error('ALIO HTTP 522');}},++now);assert.deepEqual(contents((await readIndex(small.binding(),now)).documents),contents(before));assert.equal((await readIndex(small.binding(),now)).partial,true);
 await refreshIndex(small.binding(),{...smallSource,list:async()=>[]},++now);assert.deepEqual(contents((await readIndex(small.binding(),now)).documents),contents(before));
 await refreshIndex(small.binding(),smallSource,++now);const state=await small.get<any>(INDEX_PREFIX+'state');const key=Object.values(state.refs)[0] as string;const saved=small.values.get(key)!;small.values.delete(key);const missing=await readIndex(small.binding(),now);assert.equal(missing.partial,true);assert(missing.errors.count>0);assert(missing.documents.length>0,'fallback keeps preceding committed data');small.values.set(key,saved);
});
await test('removed titles excluded; new title never hidden by prior completion',async()=>{
 const fewer={...smallSource,list:async()=>[two[0]]};await refreshIndex(small.binding(),fewer,++now);assert.equal((await readIndex(small.binding(),now)).documents.length,1);
 const additions=[...two,...items.slice(2,5)];await refreshIndex(small.binding(),{...smallSource,list:async()=>additions},++now);assert.equal((await readIndex(small.binding(),now)).partial,true);
});
await test('size overflow retains data; stale documents/list cannot report ready',async()=>{
 const r=await refreshIndex(small.binding(),{...smallSource,load:async item=>({...await source.load(item),text:'가'.repeat(800_000)})},++now);assert(r.errors.count>0);assert.equal((await readIndex(small.binding(),now+MAX_INDEX_AGE+1)).partial,true);
});
await test('network budget includes redirects/retries and stops before 41st call',async()=>{
 let requests=0;const request=createIndexRequest(async()=>{requests++;return new Response('ok');});for(let i=0;i<40;i++)await request('https://www.alio.go.kr/test');await assert.rejects(()=>request('https://www.alio.go.kr/test'),/budget/);assert.equal(requests,40);
 let retries=0;const retry=createIndexRequest(async()=>{retries++;return new Response('bad',{status:522});});await assert.rejects(()=>retry('https://www.alio.go.kr/test'));assert.equal(retries,3);
 let redirects=0;const redirect=createIndexRequest(async()=>{redirects++;return new Response(null,{status:302,headers:{location:'/redirect'}});});await assert.rejects(()=>redirect('https://www.alio.go.kr/test'),/redirect_limit/);assert.equal(redirects,6);
});
await test('ALIO adapter bypasses list cache and maps stDate/idate correctly',async()=>{
 let calls=0;const adapter=createCorpusSource(async()=>{calls++;return Response.json({data:{result:[{title:'test',apbaId:'C0345',idx:'1',reportFormNo:'21110',tableName:'T',idxName:'idx',reportGbn:'A',bidType:'',stDate:'2026-01-01',idate:'2026-02-02'}],page:{totalPage:1,totalCount:1}}});});
 const list=await adapter.list();await adapter.list();assert.equal(calls,2);assert.equal(list[0].revisionDate,'2026-01-01');assert.equal(list[0].updatedDate,'2026-02-02');
});
await test('incremental 22-page list stays staged until complete; changed count restarts safely',async()=>{
 let calls=0;let changed=false;
 const request=async(_url:string,init?:RequestInit)=>{calls++;const page=JSON.parse(String(init?.body)).pageNo;return Response.json({data:{result:[{title:'page'+page,apbaId:'C0345',idx:String(page),reportFormNo:'21110',tableName:'T',idxName:'idx',reportGbn:'A',bidType:'',stDate:'2026-01-01',idate:'2026-02-02'}],page:{totalPage:changed?23:22,totalCount:changed?23:22}}});};
 let work:unknown,complete:any;for(let i=0;i<8;i++){const before=calls;const r=await createCorpusSource(request).listBatch(work);assert(calls-before<=4);if(r.items){complete=r.items;break;}work=r.work;assert(!r.items);}
 assert.equal(complete.length,22);
 const staged=new TestKV();let listCalls=0;const stagedSource={...source,list:async()=>++listCalls===1?items:{work:{nextPage:4}}};await refreshIndex(staged.binding(),stagedSource,base);await refreshIndex(staged.binding(),stagedSource,base+1000);assert.equal((await readIndex(staged.binding(),base+1000)).total,213);
 const first=await createCorpusSource(request).listBatch();changed=true;await assert.rejects(()=>createCorpusSource(request).listBatch(first.work),/index_list_changed/);
});
await test('rank relevant multi-article matches ahead of alphabetical single-hit decoys; appendix label isolated',async()=>{
 const all=[...items.slice(0,20).map(i=>({...i,title:'가'+i.title})),items[212]], ranked=new TestKV();
 const rankedSource={list:async()=>all,load:async(item:CorpusItem)=>({...await source.load(item),text:item.title==='보안과제 관리요령'?'제6조(보고)\n외국인 접촉 결과와 외국인 참여 현황\n제8조(자료 취급 의무)\n외국인 접촉을 보고한다.\n[별지 제2호 서식] 외국인 접촉 결과 보고서\n외국인 정보': '제1조(정의)\n외국인도 포함한다.'})};
 for(let i=0;i<11;i++)await refreshIndex(ranked.binding(),rankedSource,base+i*1000);
 const r=await searchAllRegulations('외국인',10,0,ranked.binding());assert.equal(r.partial,false);assert.equal(r.results[0].regulationName,'보안과제 관리요령');assert(r.results[0].matches.some(m=>m.label.includes('제8조')));assert(r.results[0].matches.some(m=>m.label==='[별지 제2호 서식]'));
});
await test('A-2 shared detail headers and selection; one successful document increments persisted coverage',async()=>{
 const xml='<hs:sec><hp:p><hp:run><hp:t>제8조(외국인 참여) 외국인 승인을 받아야 한다.</hp:t></hp:run></hp:p></hs:sec>';
 const bytes=zipSync({'Contents/section0.xml':strToU8(xml)});
 const detailUrl='https://www.alio.go.kr/item/itemBoard21110.do?idx=audit';
 const html='<p>제목 감사규정 파일 제·개정일 2026.01.01 최종수정일 2026.02.02</p>'+[1,2,3].map(n=>`<a href="/download/rulefiledown.json?fileNo=${n}">감사규정.hwpx</a>`).join('');
 let detailCalls=0;
 const raw=async(url:any,init?:RequestInit)=>{
  if(String(url)===detailUrl){detailCalls++;const h=new Headers(init?.headers);return new Response(h.get('accept-language')==='ko-KR,ko;q=0.9'?html:'<html>no files</html>');}
  return new Response(bytes,{headers:{'content-disposition':'attachment; filename="audit.hwpx"'}});
 };
 const request=createIndexRequest(raw as typeof fetch);
 const normal=await getRegulationDetail(detailUrl,undefined,{request,probe:async()=>''});
 assert.equal(normal.attachments.length,3);assert.equal(normal.latestAttachment?.fileNo,'3');
 const item={title:'감사규정',detailUrl,revisionDate:'2026.01.01',updatedDate:'2026.02.02'};
 const indexed=await createCorpusSource(request).load(item);assert.equal(indexed.fileNo,normal.latestAttachment?.fileNo);assert.equal(indexed.parserVersion,'1.10.5-parser.1');assert.equal(detailCalls,2);
 const single=new TestKV();const result=await refreshIndex(single.binding(),{list:async()=>[item],load:async()=>indexed},base);
 assert.equal(result.indexedRegulations,1);assert(result.lastCompletedAt);assert.equal((await readIndex(single.binding(),base)).documents.length,1);
 assert.deepEqual((await single.get<any>(INDEX_PREFIX+'state')).indexedTitles,['감사규정']);
});
await test('A-2 empty/HTTP/network/subrequest failures expose distinct codes and response diagnostics',async()=>{
 const logs:any[]=[];const warn=console.warn;console.warn=(name,...args)=>{if(name==='alio_attachment_collection_failed')logs.push(args[0]);};
 const item={title:'감사규정',detailUrl:'https://www.alio.go.kr/item/itemBoard21110.do'};
 try{
  await assert.rejects(()=>createCorpusSource(createIndexRequest((async()=>new Response('<html>empty</html>')) as typeof fetch)).load(item),/selection_error:no_attachment/);
  assert.equal(logs.at(-1).http_status,200);assert.equal(logs.at(-1).response_bytes,18);assert.equal(logs.at(-1).subrequests_used,1);assert.equal(logs.at(-1).subrequest_limit,40);
  await assert.rejects(()=>createCorpusSource(createIndexRequest((async()=>new Response('denied',{status:403})) as typeof fetch)).load(item),/selection_error:fetch_failed/);
  assert.equal(logs.at(-1).http_status,403);assert.equal(logs.at(-1).response_bytes,6);
  await assert.rejects(()=>createCorpusSource(createIndexRequest((async()=>{throw Error('Too many subrequests by single Worker invocation');}) as typeof fetch)).load(item),/selection_error:subrequest_limit/);
  assert.equal(logs.at(-1).subrequests_used,1);
  const budget=createIndexRequest((async()=>new Response('ok')) as typeof fetch);for(let n=0;n<40;n++)await budget('https://www.alio.go.kr/test');
  await assert.rejects(()=>createCorpusSource(budget).load(item),/selection_error:subrequest_limit/);assert.equal(logs.at(-1).subrequests_used,40);
  const bad=createIndexRequest((async()=>{throw Error('network down');}) as typeof fetch);
  const broken=new TestKV();await refreshIndex(broken.binding(),{list:async()=>[item],load:createCorpusSource(bad).load},base);
  const state=await broken.get<any>(INDEX_PREFIX+'state');assert.equal(state.errors['감사규정'].code,'fetch_failed');assert.equal((await readIndex(broken.binding(),base)).partial,true);assert.equal(state.lastCompletedAt,undefined);
 }finally{console.warn=warn;}
});
await test('A-3 build rollover clears old errors without deleting documents; pending sweep remains partial',async()=>{
 const buildKV=new TestKV();for(let n=0;n<107;n++)await refreshIndex(buildKV.binding(),source,base+n*1000,{buildVersion:'old-build'});
 const old=await buildKV.get<any>(INDEX_PREFIX+'state');for(const item of items.slice(0,110))old.errors[item.title]={title:item.title,message:'selection_error:no_attachment',checkedAt:'2026-10-08T20:05:00Z',build_version:'old-build',error_code:'no_attachment'};
 await buildKV.put(INDEX_PREFIX+'state',JSON.stringify(old));const before=(await readIndex(buildKV.binding(),base+107000)).documents.length;
 const failedItem=items[0].title;
 await refreshIndex(buildKV.binding(),{...source,load:async item=>{if(item.title===failedItem)throw Error('HWP parse failed');return source.load(item);}},base+108000,{buildVersion:'new-build'});
 const read=await readIndex(buildKV.binding(),base+108000,'new-build');assert.equal(read.documents.length,before);assert.equal(read.index_build_version,'new-build');assert.equal(read.errors.count,1);assert.equal(read.errors.sample[0].error_code,'parse_failed');assert(read.errors.sample.every(e=>e.build_version==='new-build'));assert.equal(read.partial,true);assert.equal(read.lastVerifiedAt,new Date(base+108000).toISOString());
 const notRun=await readIndex(buildKV.binding(),base+108000,'next-build');assert.equal(notRun.errors.count,0);assert.equal(notRun.partial,true);assert.equal(notRun.index_build_version,'new-build');
});
await test('A-3 latest-first samples contain build and codes; timeout/fetch/parse/budget classification',async()=>{
 const snapshot=new TestKV();await refreshIndex(snapshot.binding(),smallSource,base,{buildVersion:'current'});const state=await snapshot.get<any>(INDEX_PREFIX+'state');
 state.errors={};for(let n=0;n<5;n++)state.errors['failure'+n]={title:'failure'+n,message:'selection_error:no_attachment',checkedAt:new Date(base+n*1000).toISOString(),build_version:'current',error_code:'no_attachment'};
 state.errors.old={title:'old',message:'old',checkedAt:new Date(base+100000).toISOString(),build_version:'old-build'};await snapshot.put(INDEX_PREFIX+'state',JSON.stringify(state));
 const index=await readIndex(snapshot.binding(),base+5000);assert.equal(index.errors.count,5);assert.deepEqual(index.errors.sample.map(e=>e.title),['failure4','failure3','failure2']);assert(index.errors.sample.every(e=>e.build_version==='current'&&e.error_code==='no_attachment'));
 const cases=[['selection_error:no_attachment','no_attachment'],['fetch failed','fetch_failed'],['HWP parse failed','parse_failed'],['Too many subrequests','subrequest_limit'],['index_request_deadline_exhausted','timeout']];for(const [input,code] of cases)assert.equal(indexErrorCode(Error(input)),code);
 assert.equal(indexErrorCode(new Error('fetch failed',{cause:Error('ConnectTimeoutError')})),'timeout');
});
await test('A-3 coordinator preserves start and finish on early failure, rejects concurrent writer; token absence fails closed',async()=>{
 const values=new Map<string,unknown>();let startReady!:()=>void;const started=new Promise<void>(resolve=>startReady=resolve);let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);
 const storage={get:async(key:string)=>structuredClone(values.get(key)),put:async(key:any,value?:unknown)=>{const entries=typeof key==='string'?[[key,value]]:Object.entries(key);for(const [name,data] of entries){values.set(name,structuredClone(data));if((data as any)?.latest?.status==='running')startReady();}}};
 const badKV={get:async()=>{await gate;throw Error('KV unavailable');}};
 const coordinator=new CorpusIndexCoordinator({storage} as any,{OAUTH_KV:badKV as any});
 const request=()=>new Request('https://internal/begin',{method:'POST',body:JSON.stringify({trigger:'cron'})});
 const env={OAUTH_KV:badKV as any,CORPUS_INDEX_COORDINATOR:{idFromName:()=> 'test',get:()=>({fetch:(url:any,init:any)=>coordinator.fetch(url instanceof Request?url:new Request(url,init))})} as any};
 const first=runCoordinatedIndex(env,'cron');await started;const second=await coordinator.fetch(request());assert.equal(second.status,409);release();assert.equal((await first).status,500);
 const status=await (await coordinator.fetch(new Request('https://internal/status'))).json() as any;assert(status.last_cron_started_at);assert(status.last_cron_finished_at);assert.equal(status.last_index_run.error_code,'fetch_failed');assert.equal(status.last_index_run.processed,0);assert(status.last_index_run.finished_at);
 const disabled=await handleIndexAdmin(new Request('https://worker/admin/trigger-index',{method:'POST'}),{OAUTH_KV:badKV as any,CORPUS_INDEX_COORDINATOR:{} as any});assert.equal(disabled?.status,503);
});
await test('A-4 list 522 does not block cached-list indexing; cooldown and error remain visible',async()=>{
 const store=new TestKV(),six=items.slice(0,6);let listCalls=0,offline=false;
 const adapter={list:async()=>{listCalls++;if(offline)throw Error('ALIO HTTP 522');return six;},load:source.load};
 await scheduledRefresh(store.binding(),adapter,base,{buildVersion:'current'});offline=true;
 const failedAt=base+LIST_REFRESH_INTERVAL;
 const result=await scheduledRefresh(store.binding(),adapter,failedAt,{buildVersion:'current'});
 assert.equal(result.processed,2);assert.equal(result.indexedRegulations,4);assert.equal(result.errors.count,1);assert.equal(result.errors.sample[0].error_code,'fetch_failed');assert.equal(result.next_retry_at,new Date(failedAt+RETRY_BASE).toISOString());
 const waiting=await scheduledRefresh(store.binding(),adapter,failedAt+60000,{buildVersion:'current'});
 assert.equal(listCalls,2);assert.equal(waiting.indexedRegulations,6);assert.equal(waiting.processed,2);assert.equal(waiting.lastCompletedAt,null);assert.equal((await readIndex(store.binding(),failedAt+60000,'current')).partial,true);
 offline=false;await scheduledRefresh(store.binding(),adapter,failedAt+RETRY_BASE,{buildVersion:'current'});const ready=await readIndex(store.binding(),failedAt+RETRY_BASE,'current');assert.equal(ready.errors.count,0);assert.equal(ready.partial,false);assert(ready.lastCompletedAt);
});
await test('A-4 failed document retries persist 5/10/20/40/60 minute backoff and resume after recovery',async()=>{
 const store=new TestKV(),one=items.slice(0,1);let calls=0,offline=true;
 const adapter={list:async()=>one,load:async(item:CorpusItem)=>{calls++;if(offline)throw Error('ALIO HTTP 522');return source.load(item);}};
 let at=base;
 for(let attempt=1;attempt<=6;attempt++){
  const result=await scheduledRefresh(store.binding(),adapter,at,{buildVersion:'current'});assert.equal(result.processed,1);
  const state=await store.get<any>(INDEX_PREFIX+'state');const error=state.errors[one[0].title];assert.equal(error.retry_attempts,attempt);assert.equal(Date.parse(error.next_retry_at)-at,retryDelay(attempt));
  await scheduledRefresh(store.binding(),adapter,at+60000,{buildVersion:'current'});assert.equal(calls,attempt,'cooldown survives a new refresh invocation');at=Date.parse(error.next_retry_at);
 }
 assert.equal(retryDelay(1),5*60000);assert.equal(retryDelay(4),40*60000);assert.equal(retryDelay(20),60*60000);
 offline=false;await scheduledRefresh(store.binding(),adapter,at,{buildVersion:'current'});const ready=await readIndex(store.binding(),at,'current');assert.equal(ready.documents.length,1);assert.equal(ready.errors.count,0);assert.equal(ready.partial,false);assert(ready.lastCompletedAt);
});
await test('A-4 list backoff survives events and a resumed page advances the next retry time',async()=>{
 const store=new TestKV();let calls=0;let at=base;
 const failing={...source,list:async()=>{calls++;throw Error('ALIO HTTP 522');}};
 for(let attempt=1;attempt<=5;attempt++){
  const result=await scheduledRefresh(store.binding(),failing,at);assert.equal(result.errors.sample[0].retry_attempts,attempt);assert.equal(Date.parse(result.next_retry_at!)-at,retryDelay(attempt));
  await scheduledRefresh(store.binding(),failing,at+60000);assert.equal(calls,attempt);at=Date.parse(result.next_retry_at!);
 }
 const progress=await scheduledRefresh(store.binding(),{...source,list:async()=>({work:{nextPage:2}})},at);assert.equal(progress.next_retry_at,new Date(at+RETRY_BASE).toISOString());assert.equal((await store.get<any>(INDEX_PREFIX+'state')).listRetryAttempts,0);
});
await test('A-4 completed corpus skips healthy downloads until due; unchanged metadata still detects SHA replacement',async()=>{
 const store=new TestKV(),one=items.slice(0,1);let lists=0,loads=0,bytes='old';
 const adapter={list:async()=>{lists++;return one;},load:async(item:CorpusItem)=>{loads++;return {...await source.load(item),bytes:new TextEncoder().encode(bytes)};}};
 await scheduledRefresh(store.binding(),adapter,base);const first=(await readIndex(store.binding(),base)).documents[0];
 const idle=await scheduledRefresh(store.binding(),adapter,base+RETRY_BASE);assert.equal(idle.processed,0);assert.equal(lists,1);assert.equal(loads,1);
 await scheduledRefresh(store.binding(),adapter,base+LIST_REFRESH_INTERVAL);assert.equal(lists,2);assert.equal(loads,1);
 bytes='replacement';const due=await scheduledRefresh(store.binding(),adapter,base+DOCUMENT_CHECK_INTERVAL);assert.equal(due.processed,1);assert.equal(due.updated,1);assert.equal(loads,2);assert.notEqual((await readIndex(store.binding(),base+DOCUMENT_CHECK_INTERVAL)).documents[0].sha256,first.sha256);
});
await test('A-4 changed metadata bypasses obsolete failed-document cooldown; newly discovered titles are prioritized',async()=>{
 const store=new TestKV(),one=[{...items[0]}];let offline=true;
 const adapter={list:async()=>one.map(i=>({...i})),load:async(item:CorpusItem)=>{if(offline)throw Error('ALIO HTTP 522');return source.load(item);}};
 await scheduledRefresh(store.binding(),adapter,base);offline=false;one[0].updatedDate='new';
 const fresh=await scheduledRefresh(store.binding(),adapter,base+60000,{forceList:true});assert.equal(fresh.processed,1);assert.equal(fresh.errors.count,0);assert.equal((await readIndex(store.binding(),base+60000)).documents[0].updatedDate,'new');
 one.push({...items[1]});const added=await scheduledRefresh(store.binding(),adapter,base+120000,{forceList:true});assert.equal(added.processed,1);assert.equal(added.indexedRegulations,2);
});
await test('A-4 empty/stale list cannot fabricate completion; existing documents stay searchable',async()=>{
 const empty=new TestKV();let loads=0;const adapter={list:async()=>{throw Error('ALIO HTTP 522');},load:async(item:CorpusItem)=>{loads++;return source.load(item);}};
 const first=await scheduledRefresh(empty.binding(),adapter,base);assert.equal(first.processed,0);assert.equal(loads,0);assert.equal(first.errors.count,1);assert.equal((await readIndex(empty.binding(),base)).partial,true);
 const saved=new TestKV();await scheduledRefresh(saved.binding(),{...source,list:async()=>items.slice(0,2)},base);
 const at=base+MAX_LIST_AGE+1;await scheduledRefresh(saved.binding(),adapter,at);const stale=await readIndex(saved.binding(),at);assert.equal(stale.documents.length,2);assert.equal(stale.partial,true);assert.equal(stale.last_list_verified_at,new Date(base).toISOString());assert.equal(stale.errors.count,1);
});
await test('A-4 partial list page progress survives 522 and resumes without replacing committed list',async()=>{
 let failPage=true;const pages:number[]=[];
 const request=async(_url:string,init?:RequestInit,maxAttempts?:number)=>{assert.equal(maxAttempts,1);const page=JSON.parse(String(init?.body)).pageNo;pages.push(page);if(page===2&&failPage)throw Error('ALIO HTTP 522');return Response.json({data:{result:[{title:'page'+page,apbaId:'C0345',idx:String(page),reportFormNo:'21110',tableName:'T',idxName:'idx',reportGbn:'A',bidType:'',stDate:'2026-01-01',idate:'2026-02-02'}],page:{totalPage:3,totalCount:3}}});};
 const store=new TestKV(),adapter={list:createCorpusSource(request).listBatch,load:source.load};
 await scheduledRefresh(store.binding(),adapter,base);const state=await store.get<any>(INDEX_PREFIX+'state');assert.equal(state.listWork.nextPage,2);assert.equal(state.listWork.rows.length,1);assert.equal(state.items.length,0);
 failPage=false;const recovered=await scheduledRefresh(store.binding(),adapter,base+RETRY_BASE);assert.equal(recovered.processed,2);assert.equal(recovered.indexedRegulations,2);assert.equal((await store.get<any>(INDEX_PREFIX+'state')).items.length,3);assert.deepEqual(pages,[1,2,2,3,1]);
});
await test('A-5 HTTP and network diagnostics persist; redirects use browser method rules',async()=>{
 const transport=createIndexRequest(async()=>new Response('origin connection timeout',{status:522,headers:{'cf-ray':'test-ray','server':'cloudflare'}}),Date.now,36);
 const store=new TestKV();const result=await scheduledRefresh(store.binding(),{...source,list:async()=>items.slice(0,1),load:async()=>{await transport('https://www.alio.go.kr/item/test',undefined,1);throw Error('unreachable');}},base);
 const diagnostics=result.errors.sample[0].diagnostics!;assert.equal(diagnostics.http_status,522);assert.equal(diagnostics.response_bytes,25);assert.equal(diagnostics.cf_ray,'test-ray');assert.equal(result.errors.sample[0].error_code,'fetch_failed');
 const network=createIndexRequest(async()=>{throw new TypeError('fetch failed');});await assert.rejects(network('https://www.alio.go.kr/item/test',undefined,1),(error:any)=>error.diagnostics.http_status===null&&error.diagnostics.request_url.includes('alio'));
 const methods:string[]=[];const redirected=createIndexRequest(async(_url,init)=>{methods.push(String(init?.method));return methods.length===1?new Response(null,{status:302,headers:{location:'/item/final'}}):new Response('OK');});await redirected('https://www.alio.go.kr/item/test',{method:'POST',body:'request'},1);assert.deepEqual(methods,['POST','GET']);
});
await test('A-5 expired writer lease cannot mutate or replace a committed snapshot',async()=>{
 const store=new TestKV();await scheduledRefresh(store.binding(),smallSource,base);const previous=store.values.get(INDEX_PREFIX+'state');const writes=store.writes;
 await assert.rejects(scheduledRefresh(store.binding(),smallSource,base+60000,{forceDocuments:true,beforeCommit:async()=>{throw Error('index_lease_expired');}}),/index_lease_expired/);
 assert.equal(store.values.get(INDEX_PREFIX+'state'),previous);assert.equal(store.writes,writes);assert.equal(indexErrorCode(Error('index_lease_expired')),'timeout');
});
await test('A-5 administrator bootstrap validates all 213 documents before atomic activation and preserves OAuth',async()=>{
 const store=new TestKV();await scheduledRefresh(store.binding(),smallSource,base);const before=store.values.get(INDEX_PREFIX+'state');store.values.set('oauth:sentinel','{"preserved":true}');
 const values=new Map<string,unknown>(),storage={get:async(key:string)=>structuredClone(values.get(key)),put:async(key:string,value:unknown)=>values.set(key,structuredClone(value))} as any;
 const send=(path:string,body:any)=>handleBootstrap('/bootstrap/'+path,new Request('https://internal/bootstrap/'+path,{method:'POST',body:JSON.stringify(body)}),storage,store.binding());
 const fresh=items.map(item=>({...item,detailUrl:'https://www.alio.go.kr/item/itemBoard21110.do?idx=1'}));
 assert.equal((await send('begin',{items:fresh,parser_version:'old',source_verified_at:new Date().toISOString()})).status,400);
 const begin=await send('begin',{items:fresh,parser_version:PARSER_VERSION,source_verified_at:new Date().toISOString()});assert.equal(begin.status,200);const {session_id}=await begin.json() as any;assert(await bootstrapActive(storage));
 assert.equal((await send('activate',{session_id})).status,409);assert.equal(store.values.get(INDEX_PREFIX+'state'),before);
 for(let id=0;id<16;id++){
  const documents=Object.fromEntries(fresh.filter(item=>shardId(item.title)===id).map(item=>[item.title,{...item,fileNo:'100',text:item.title==='보안과제 관리요령'?'제8조(외국인 참여)\n외국인 승인':'제1조(목적)\n업무',sha256:'a'.repeat(64),verifiedAt:new Date().toISOString(),parserVersion:PARSER_VERSION}]));
  const hash=await sha256(new TextEncoder().encode(JSON.stringify({documents})));const input={session_id,id,documents,sha256:hash};
  assert.equal((await send('shard',{...input,sha256:'b'.repeat(64)})).status,400);assert.equal((await send('shard',input)).status,200);assert.equal((await send('shard',input)).status,200);
 }
 const stage=values.get('bootstrap') as any;const saved=store.values.get(stage.refs[0])!;store.values.delete(stage.refs[0]);assert.equal((await send('activate',{session_id})).status,409);assert.equal(store.values.get(INDEX_PREFIX+'state'),before);store.values.set(stage.refs[0],saved);
 store.failKey=':state';assert.equal((await send('activate',{session_id})).status,500);assert.equal(store.values.get(INDEX_PREFIX+'state'),before);store.failKey='';
 assert.equal((await send('activate',{session_id})).status,200);assert.equal((await send('activate',{session_id})).status,200);
 const index=await readIndex(store.binding());assert.equal(index.documents.length,213);assert.equal(index.partial,false);assert(index.lastCompletedAt);assert.equal(index.errors.count,0);assert.equal(store.values.get('oauth:sentinel'),'{"preserved":true}');
});
writeFileSync('reports/corpus-index-regression.json',JSON.stringify({passed:true,tests:results,scope:'A only; synthetic failure injection; not live ALIO or deployed Workers'},null,2));
