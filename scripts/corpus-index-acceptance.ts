import {BUILD_VERSION} from '../src/build-info';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {existsSync,readFileSync,writeFileSync,mkdirSync,statSync} from 'node:fs';
import {createCorpusSource,searchAllRegulations} from '../src/regulation-core/regulations';
import {refreshIndex,readIndex,INDEX_PREFIX} from '../src/regulation-core/corpus-index';
import {TestKV} from './corpus-index-test-kv';
const checkpoint='reports/corpus-index-live-checkpoint.json';const kv=new TestKV();
if(existsSync(checkpoint))kv.values=new Map(JSON.parse(readFileSync(checkpoint,'utf8')));
const startedAt=new Date().toISOString();
// Bootstrap the current ALIO list as one snapshot. Production Cron fetches a
// fresh full list each event; this test saves repeated unchanged list downloads.
let stage:unknown,items:any[]=existsSync('reports/corpus-index-live-list.json')&&Date.now()-statSync('reports/corpus-index-live-list.json').mtimeMs<45*60*1000?JSON.parse(readFileSync('reports/corpus-index-live-list.json','utf8')):[];for(let pass=0;!items.length&&pass<40;pass++){const r=await createCorpusSource().listBatch(stage);if(r.items){items=r.items;break;}stage=r.work;console.log('LIVE_LIST_PROGRESS',JSON.stringify(stage&&{nextPage:(stage as any).nextPage,totalPage:(stage as any).totalPage}));} writeFileSync('reports/corpus-index-live-list.json',JSON.stringify(items));console.log('LIVE_CORPUS_LIST',items.length,items.filter(i=>i.title.includes('보안과제')).map(i=>i.title));
assert(items.some(i=>i.title.endsWith('보안과제 관리요령')));
// Four bounded loaders accelerate only this acceptance bootstrap. The production
// Cron retains its two-document limit. Cache raw bytes for resumable testing.
const dir='reports/corpus-index-live-files';mkdirSync(dir,{recursive:true});
async function liveLoad(item:any){
 const path=dir+'/'+createHash('sha256').update(item.title).digest('hex')+'.json';
 if(existsSync(path)&&Date.now()-statSync(path).mtimeMs<60*60*1000){const saved=JSON.parse(readFileSync(path,'utf8'));if(JSON.stringify(saved.item)===JSON.stringify(item))return {...saved.document,bytes:new Uint8Array(Buffer.from(saved.document.bytes,'base64'))};}
 const document=await createCorpusSource().load(item);writeFileSync(path,JSON.stringify({item,document:{...document,bytes:Buffer.from(document.bytes).toString('base64')}}));return document;
}
let cursor=0;await Promise.all(Array.from({length:4},async()=>{while(cursor<items.length){const item=items[cursor++];try{await liveLoad(item);console.log('LIVE_FILE_OK',item.title);}catch(error){console.log('LIVE_FILE_RETRY',item.title,String(error));}}}));
let complete=false;const acceptanceDeadline=Date.now()+45*60*1000;
for(let batch=0;batch<Math.ceil(items.length/2)+20;batch++){
 const source=createCorpusSource();const r=await refreshIndex(kv.binding(),{list:async()=>items,load:liveLoad},Date.now(),{buildVersion:BUILD_VERSION});
 writeFileSync(checkpoint,JSON.stringify([...kv.values]));
 const state=await kv.get<any>(INDEX_PREFIX+'state');
 console.log('LIVE_CORPUS_BATCH',JSON.stringify({batch,...r,verified:Object.keys(state?.checked??{}).length}));
 const index=await readIndex(kv.binding(),Date.now(),BUILD_VERSION);if(!index.partial){complete=true;break;}
 if(!r.processed&&r.next_retry_at&&Date.parse(r.next_retry_at)>Date.now()){
  assert(Date.now()<acceptanceDeadline,'live retry acceptance deadline exceeded');
  await new Promise(resolve=>setTimeout(resolve,Math.min(30000,Date.parse(r.next_retry_at)-Date.now())));batch--;
 }
}
// Revalidate the complete list at the end; changed metadata cannot be hidden.
let latest:any[]=[];stage=undefined;for(let pass=0;pass<40;pass++){const r=await createCorpusSource().listBatch(stage);if(r.items){latest=r.items;break;}stage=r.work;}assert.deepEqual(latest,items,'ALIO list changed during acceptance; rebuild required');
const final=await refreshIndex(kv.binding(),{list:async()=>latest,load:createCorpusSource().load},Date.now(),{buildVersion:BUILD_VERSION});
const index=await readIndex(kv.binding(),Date.now(),BUILD_VERSION);
const original=globalThis.fetch;globalThis.fetch=async()=>{throw Error('request-time ALIO download forbidden');};
let result:any;try{result=await searchAllRegulations('외국인',10,0,kv.binding(),BUILD_VERSION);}finally{globalThis.fetch=original;}
const security=result.results.find((r:any)=>r.regulationName.endsWith('보안과제 관리요령'));
const audit=index.documents.find(d=>d.title==='감사규정');assert(audit?.fileNo,'감사규정 must be indexed');assert(index.lastCompletedAt);assert.equal(index.index_build_version,BUILD_VERSION);
const passed=complete&&index.documents.length>=200&&result.partial===false&&!!security?.matches.some((m:any)=>m.label.includes('제8조'));
const report={passed,startedAt,finishedAt:new Date().toISOString(),execution:'Actual ALIO current list and raw HWP/HWPX/PDF. In-process KV; no production deployment. Bootstrap list captured once and fresh list equality checked at end.',total:items.length,indexed:index.documents.length,finalRefresh:final,result,security,audit:{title:audit.title,fileNo:audit.fileNo,sha256:audit.sha256},sizes:(await kv.get<any>(INDEX_PREFIX+'state'))?.sizes};
writeFileSync('reports/corpus-index-acceptance.json',JSON.stringify(report,null,2));console.log('LIVE_CORPUS_RESULT',JSON.stringify({passed,total:items.length,indexed:index.documents.length,partial:result.partial,security}));assert(passed,'A live acceptance incomplete: see report');
