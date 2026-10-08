import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {transformSync} from 'esbuild';
import {z} from 'zod';
import {refreshIndex,readIndex,INDEX_PREFIX,MAX_INDEX_AGE,sha256,shardId,type CorpusItem} from '../src/regulation-core/corpus-index';
import {searchAllRegulations,createIndexRequest,createCorpusSource} from '../src/regulation-core/regulations';
import {TestKV} from './corpus-index-test-kv';
const kv=new TestKV(),base=Date.now();
const items:CorpusItem[]=Array.from({length:213},(_,i)=>({title:i===212?'보안과제 관리요령':'규정'+String(i).padStart(3,'0'),detailUrl:'https://www.alio.go.kr/test/'+i,revisionDate:'2026-01-01',updatedDate:'2026-02-02'}));
let fileNo='100',body='원문 바이트',fail='';
const source={list:async()=>items,load:async(item:CorpusItem)=>{if(item.title===fail)throw Error('injected parse failure');return {fileNo,text:item.title==='보안과제 관리요령'?'제1조(목적)\n목적\n제8조(외국인 참여)\n외국인 참여는 승인 대상이다.\n제9조(보안)\n보안 업무': '제1조(목적)\n일반 업무',bytes:new TextEncoder().encode(body),parserVersion:'test'}}};
const results:any[]=[];
async function test(name:string,fn:()=>unknown){await fn();results.push({name,status:'passed'});console.log('CORPUS_INDEX PASS',name);}
await test('213 documents complete; registered search defaults; zero external fetch; <=17 KV reads',async()=>{
 kv.values.set('oauth:sentinel','{"unchanged":true}');
 let now=base;for(let i=0;i<107;i++){await refreshIndex(kv.binding(),source,now);now+=1000;}
 const original=globalThis.fetch;globalThis.fetch=async()=>{throw Error('search must not fetch');};
 try{
  const text=readFileSync('src/index.ts','utf8');const start=text.indexOf('  server.registerTool(\n    "search_all_regulations"');const end=text.indexOf('  server.registerTool(\n    "search_regulation_text"',start);
  let registration:any;const server={registerTool:(_name:string,config:any,callback:any)=>{registration={config,callback};}};
  new Function('server','z','env','coreSearchAllRegulations','publicErrorCode',transformSync(text.slice(start,end),{loader:'ts'}).code)(server,z,{OAUTH_KV:kv.binding()},searchAllRegulations,()=> 'error');
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
 fail='';await refreshIndex(small.binding(),smallSource,++now);const recovered=await readIndex(small.binding(),now);assert.equal(recovered.partial,false);assert.equal(recovered.errors.count,0);assert.equal(recovered.documents.find(d=>d.title===two[0].title)!.updatedDate,'2026-04-04');
});
await test('KV shard write failure keeps manifest refs; reports failure',async()=>{
 const before=await small.get<any>(INDEX_PREFIX+'state');small.failKey='shard:';body='changed';await refreshIndex(small.binding(),smallSource,++now);small.failKey='';const after=await small.get<any>(INDEX_PREFIX+'state');assert.deepEqual(after.refs,before.refs);assert((await readIndex(small.binding(),now)).errors.count>0);await refreshIndex(small.binding(),smallSource,++now);
});
await test('list outage and empty list preserve snapshot; missing KV shard cannot report ready',async()=>{
 const before=(await readIndex(small.binding(),now)).documents;
 await refreshIndex(small.binding(),{...smallSource,list:async()=>{throw Error('ALIO 522');}},++now);assert.deepEqual((await readIndex(small.binding(),now)).documents,before);assert.equal((await readIndex(small.binding(),now)).partial,true);
 await refreshIndex(small.binding(),{...smallSource,list:async()=>[]},++now);assert.deepEqual((await readIndex(small.binding(),now)).documents,before);
 await refreshIndex(small.binding(),smallSource,++now);const state=await small.get<any>(INDEX_PREFIX+'state');const key=Object.values(state.refs)[0] as string;const saved=small.values.get(key)!;small.values.delete(key);assert.equal((await readIndex(small.binding(),now)).partial,true);small.values.set(key,saved);
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
writeFileSync('reports/corpus-index-regression.json',JSON.stringify({passed:true,tests:results,scope:'A only; synthetic failure injection; not live ALIO or deployed Workers'},null,2));
