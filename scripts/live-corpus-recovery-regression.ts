import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PARSER_VERSION} from '../src/regulation-core/parser-version';
import type {CorpusItem,CorpusSource} from '../src/regulation-core/corpus-index';
import {collectOfflineList} from './offline-index-build';
import {resumableSource} from './live-corpus-cache';

const directory=mkdtempSync(join(tmpdir(),'alio-recovery-')),tests:string[]=[];
const item:CorpusItem={title:'감사규정',detailUrl:'https://www.alio.go.kr/item/itemBoard21110.do?idx=1',updatedDate:'2026.10.13'};
let loads=0,clock=Date.now();
const source:CorpusSource={list:async()=>[item],load:async()=>{loads++;return {fileNo:'123',bytes:new Uint8Array([1,2,3]),text:'제1조 목적',parserVersion:PARSER_VERSION};}};
try{
 const first=resumableSource(source,directory,{now:()=>clock});await first.source.load(item);
 const restarted=resumableSource(source,directory,{now:()=>clock});await restarted.source.load(item);
 assert.equal(loads,1);assert.equal(restarted.stats.reused,1);tests.push('fresh raw documents survive process restart without redownload');
 await restarted.source.load({...item,updatedDate:'2026.10.14'});assert.equal(loads,2);tests.push('changed ALIO metadata invalidates restored raw bytes');
 clock+=60*60*1000;await restarted.source.load({...item,updatedDate:'2026.10.14'});assert.equal(loads,3);tests.push('one-hour evidence TTL is enforced using saved download time');
 const path=join(directory,readdirSync(directory)[0]),saved=JSON.parse(readFileSync(path,'utf8'));saved.document.text='tampered';writeFileSync(path,JSON.stringify(saved));
 await restarted.source.load({...item,updatedDate:'2026.10.14'});assert.equal(loads,4);tests.push('corrupt or modified cached content is redownloaded');
 let failures=0;const broken=resumableSource({...source,load:async()=>{failures++;throw Error('selection_error:timeout');}},join(directory,'broken'),{maxFailures:2});
 for(let n=0;n<10;n++)await assert.rejects(()=>broken.source.load({...item,title:'regulation-'+n}));
 assert.equal(failures,2);tests.push('persistent document outage stops new network loads');
 let calls=0;await assert.rejects(()=>collectOfflineList(async()=>{calls++;throw Error('fetch failed');},{sleep:async()=>{}}),/fetch failed/);
 assert.equal(calls,4);tests.push('persistent list outage fails after four attempts rather than forty');
 const pages:number[]=[];let interrupted=false;
 const list=await collectOfflineList(async(_input,init)=>{
  const page=JSON.parse(String(init?.body)).pageNo;pages.push(page);
  if(page===2&&!interrupted){interrupted=true;throw Error('fetch failed');}
  return Response.json({data:{result:[{title:'page'+page,apbaId:'C0345',idx:String(page),reportFormNo:'21110',tableName:'COMM_RULE',idxName:'RULE_NO',stDate:'2026.10.13'}],page:{totalPage:3,totalCount:3}}});
 },{sleep:async()=>{}});
 assert.equal(list.length,3);assert.deepEqual(pages,[1,2,2,3,1]);tests.push('transient list failure resumes failed page and revalidates page one');
 mkdirSync('reports',{recursive:true});writeFileSync('reports/live-corpus-recovery-regression.json',JSON.stringify({passed:true,tests},null,2));
 console.log('RECOVERY_PASS',tests.length,JSON.stringify(tests));
}finally{rmSync(directory,{recursive:true,force:true});}
