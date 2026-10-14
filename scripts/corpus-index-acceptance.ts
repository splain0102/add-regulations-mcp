import {BUILD_VERSION} from '../src/build-info';
import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
import {searchAllRegulations} from '../src/regulation-core/regulations';
import {buildOfflineIndex,offlineSource,type Stage} from './offline-index-build';
import {resumableSource,writeJsonAtomic} from './live-corpus-cache';
import {TestKV} from './corpus-index-test-kv';
import {httpEvidence} from './alio-http-evidence';

mkdirSync('reports',{recursive:true});
const startedAt=new Date().toISOString();
const evidenceRun=BUILD_VERSION+':'+(process.env.GITHUB_RUN_ID??'local')+':'+(process.env.GITHUB_RUN_ATTEMPT??'1');
const http=httpEvidence('reports/alio-http-evidence',evidenceRun,'record');
const {source,stats}=resumableSource(offlineSource(http.request),'reports/corpus-index-live-files');
let lastStage:Stage={stage:'starting'};
const progress=async(stage:Stage)=>{lastStage=stage;console.log('LIVE_CORPUS_STAGE',JSON.stringify(stage));};
try{
 // Rebuild from validated raw files, never trust a restored success manifest.
 // The producer collector uses a fresh complete ALIO list before AND after load.
 const {entries,report}=await buildOfflineIndex([],source,{progress});
 const kv=new TestKV();kv.values=new Map(entries);
 const original=globalThis.fetch;globalThis.fetch=async()=>{throw Error('request-time ALIO download forbidden');};
 let result:any;try{result=await searchAllRegulations('외국인',10,0,kv.binding(),BUILD_VERSION);}finally{globalThis.fetch=original;}
 assert.equal(result.partial,false);assert.equal(report.indexed,report.total);
 assert(result.results.some((r:any)=>r.regulationName.endsWith('보안과제 관리요령')&&r.matches.some((m:any)=>m.label.includes('제8조'))));
 // Reject an overlong run: even the oldest reused raw document must still be
 // within the original one-hour test cache window at acceptance time.
 assert(stats.oldestDownloadAt&&Date.now()-Date.parse(stats.oldestDownloadAt)<60*60*1000,'Raw evidence expired during acceptance; rerun required');
 writeJsonAtomic('reports/corpus-index-live-checkpoint.json',entries);
 const evidence={...report,startedAt,finishedAt:new Date().toISOString(),build_version:BUILD_VERSION,evidenceRun,http:http.stats,execution:'Live ALIO list checked at both ends; raw downloads may resume within one hour; all documents reindexed; request-time network forbidden; no production publish',cache:stats,result};
 writeJsonAtomic('reports/corpus-index-acceptance.json',evidence);
 console.log('LIVE_CORPUS_RESULT',JSON.stringify({passed:true,total:report.total,indexed:report.indexed,cache:stats}));
}catch(error){
 writeJsonAtomic('reports/corpus-index-acceptance.json',{passed:false,startedAt,finishedAt:new Date().toISOString(),build_version:BUILD_VERSION,lastStage,cache:stats,error:String(error),diagnostics:(error as any)?.diagnostics??null});
 console.error('LIVE_CORPUS_FAILED',String(error),JSON.stringify(stats));process.exitCode=1;
}
