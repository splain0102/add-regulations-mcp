import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,renameSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {PARSER_VERSION} from '../src/regulation-core/parser-version';
import type {CorpusSource,CorpusItem} from '../src/regulation-core/corpus-index';

export function writeJsonAtomic(path:string,value:unknown){
 const temporary=path+'.tmp';writeFileSync(temporary,JSON.stringify(value));renameSync(temporary,path);
}

// Test-only raw documents. Never restore a previous success report or manifest
// as proof for a new run; rebuild and compare a fresh ALIO list at both ends.
export function resumableSource(source:CorpusSource,directory:string,options:{now?:()=>number;maxFailures?:number}={}){
 mkdirSync(directory,{recursive:true});const now=options.now??Date.now;
 let failures=0,stopped=false;
 const stats={downloaded:0,reused:0,failed:0,oldestDownloadAt:null as string|null};
 function observed(at:string){if(!stats.oldestDownloadAt||at<stats.oldestDownloadAt)stats.oldestDownloadAt=at;}
 const load:CorpusSource['load']=async(item:CorpusItem,previous)=>{
  const path=join(directory,createHash('sha256').update(item.title).digest('hex')+'.json');
  if(existsSync(path))try{
   const saved=JSON.parse(readFileSync(path,'utf8')),age=now()-Date.parse(saved.downloadedAt);
   if(saved.schema===1&&(!source.prepareDocumentIndex||saved.document?.prepared?.schema===1)&&Number.isFinite(age)&&age>=0&&age<60*60*1000&&saved.document?.parserVersion===PARSER_VERSION&&JSON.stringify(saved.item)===JSON.stringify(item)){
    const bytes=new Uint8Array(Buffer.from(saved.document.bytes,'base64'));
    const digest=createHash('sha256').update(JSON.stringify({item:saved.item,document:saved.document,downloadedAt:saved.downloadedAt})).digest('hex');
    if(bytes.length&&digest===saved.digest){stats.reused++;observed(saved.downloadedAt);return {...saved.document,bytes};}
   }
  }catch{/* Corrupt or incompatible cache is a miss, never acceptance evidence. */}
  if(stopped)throw Error('live_alio_outage: document retries stopped; rerun with saved raw files');
  try{
   const document=await source.load(item,previous),downloadedAt=new Date(now()).toISOString();
   const saved={item,document:{...document,bytes:Buffer.from(document.bytes).toString('base64')},downloadedAt};
   writeJsonAtomic(path,{schema:1,...saved,digest:createHash('sha256').update(JSON.stringify(saved)).digest('hex')});
   stats.downloaded++;failures=0;observed(downloadedAt);return document;
  }catch(error){
   stats.failed++;
   if(/fetch|timeout|timed.?out|abort|HTTP (429|5\d\d)/i.test(String(error))&&++failures>=(options.maxFailures??4))stopped=true;
   throw error;
  }
 };
 return {source:{prepareDocumentIndex:source.prepareDocumentIndex,list:source.list,load} as CorpusSource,stats};
}

