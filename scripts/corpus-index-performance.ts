import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {searchAllRegulations as before} from './fixtures/corpus-search-v1.10.9';
import {searchAllRegulations as after} from '../src/regulation-core/regulations';
import {prepareSearchSections,searchBounds} from '../src/regulation-core/search-sections';
import {INDEX_PREFIX} from '../src/regulation-core/corpus-index';
import {BUILD_VERSION} from '../src/build-info';
const path=process.env.CORPUS_PERF_SNAPSHOT??'reports/corpus-index-bootstrap.json';
const snapshot=JSON.parse(readFileSync(path,'utf8'));
const values=new Map<string,string>();const refs:Record<string,string>={},checked:Record<string,string>={};
for(const shard of snapshot.shards){const key=INDEX_PREFIX+'perf:'+shard.id;refs[shard.id]=key;for(const doc of Object.values(shard.documents) as any[]){checked[doc.title]=doc.verifiedAt;doc.searchSections=prepareSearchSections(doc.text);}values.set(key,JSON.stringify({documents:shard.documents}));}
values.set(INDEX_PREFIX+'state',JSON.stringify({schema:2,cursor:0,items:snapshot.items,refs,checked,errors:{},sizes:{},pending:[],indexedTitles:snapshot.items.map((i:any)=>i.title),lastCheckedAt:new Date().toISOString(),lastCompletedAt:new Date().toISOString(),index_build_version:BUILD_VERSION,garbage:[]}));
class DelayedKV {
 reads=0;active=0;peak=0;
 private delay:number;
 constructor(delay:number){this.delay=delay;}
 async get(key:string,type:string){this.reads++;this.active++;this.peak=Math.max(this.peak,this.active);try{if(this.delay)await new Promise(r=>setTimeout(r,this.delay));const value=values.get(key);return value===undefined?null:type==='json'?JSON.parse(value):value;}finally{this.active--;}}
 binding(){return this as unknown as KVNamespace;}
}
const queries=['외국인','연구','부소장','계약 승인','존재하지않는검색어','제'];
for(const query of queries){const expected=await before(query,50,0,new DelayedKV(0).binding(),BUILD_VERSION);const result=await after(query,50,0,new DelayedKV(0).binding(),BUILD_VERSION);assert.deepEqual(result,expected,query);}
// Missing shard + fallback must keep identical errors, order and partial status.
const state=JSON.parse(values.get(INDEX_PREFIX+'state')!);const missing=refs[0],saved=values.get(missing)!;state.fallbackRefs={'0':INDEX_PREFIX+'fallback'};values.set(INDEX_PREFIX+'fallback',saved);values.delete(missing);values.set(INDEX_PREFIX+'state',JSON.stringify(state));
const fallbackKv=new DelayedKV(5);await after('외국인',10,0,fallbackKv.binding(),BUILD_VERSION);assert.equal(fallbackKv.reads,18);assert.equal(fallbackKv.peak,4);
const realNow=Date.now;Date.now=()=>0;try{assert.deepEqual(await after('외국인',10,0,new DelayedKV(0).binding(),BUILD_VERSION),await before('외국인',10,0,new DelayedKV(0).binding(),BUILD_VERSION));}finally{Date.now=realNow;}
values.set(missing,saved);delete state.fallbackRefs;values.set(INDEX_PREFIX+'state',JSON.stringify(state));
// Existing records need no migration. Malformed offsets fall back safely.
for(const [key,value] of values)if(key.includes(':perf:')){const shard=JSON.parse(value);for(const doc of Object.values(shard.documents) as any[])delete doc.searchSections;values.set(key,JSON.stringify(shard));}
assert.deepEqual(await after('외국인',10,0,new DelayedKV(0).binding(),BUILD_VERSION),await before('외국인',10,0,new DelayedKV(0).binding(),BUILD_VERSION));
const text='제1조(목적)\n일반\n제8조(외국인)\n외국인';assert.deepEqual(searchBounds(text,{version:1,textLength:text.length,bounds:[0,-1,text.length]}),prepareSearchSections(text).bounds);
for(const [key,value] of values)if(key.includes(':perf:')){const shard=JSON.parse(value);for(const doc of Object.values(shard.documents) as any[])doc.searchSections=prepareSearchSections(doc.text);values.set(key,JSON.stringify(shard));}
const runs:any[]=[];for(const delay of [0,40])for(const [name,search] of [['before',before],['after',after]] as const){const times:number[]=[];let last:any;for(let i=0;i<3;i++){const kv=new DelayedKV(delay),start=performance.now();const result=await search('외국인',10,0,kv.binding(),BUILD_VERSION);times.push(performance.now()-start);assert.equal(kv.reads,17);assert(kv.peak<=(name==='after'?4:1));assert.equal(result.partial,false);assert(result.results.some((r:any)=>r.regulationName.endsWith('보안과제 관리요령')&&r.matches.some((m:any)=>m.label.includes('제8조'))));last={reads:kv.reads,peak:kv.peak,resultBytes:Buffer.byteLength(JSON.stringify(result))};}runs.push({name,injectedKvDelayMs:delay,medianMs:times.sort((a,b)=>a-b)[1],...last});}
writeFileSync('reports/corpus-index-performance.json',JSON.stringify({passed:true,scope:'actual ALIO 213-document snapshot; identical CURRENT ranking with serial vs bounded-parallel IO; simulated KV latency, not production end-to-end timings',equivalentQueries:queries,runs},null,2));console.log('CORPUS_PERFORMANCE_PASS',JSON.stringify(runs));
