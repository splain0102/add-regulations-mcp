// Test-only replay of real ALIO responses fetched in this exact acceptance run.
// Missing evidence still uses the live transport. No production import uses this.
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {writeJsonAtomic} from './live-corpus-cache';

function key(input:RequestInfo|URL,init?:RequestInit){
 if(input instanceof Request)return null;
 const url=new URL(String(input));
 if(url.origin!=='https://www.alio.go.kr'||!['/item/itemBoard21110.do','/download/rulefiledown.json'].includes(url.pathname))return null;
 if(init?.body!=null&&typeof init.body!=='string')return null;
 return createHash('sha256').update(JSON.stringify([(init?.method??'GET').toUpperCase(),url.href,init?.body??null])).digest('hex');
}
export function httpEvidence(directory:string,run:string,mode:'record'|'replay',transport:typeof fetch=fetch,now:()=>number=Date.now){
 mkdirSync(directory,{recursive:true});const stats={recorded:0,replayed:0,live:0};
 const request:typeof fetch=async(input,init)=>{
  const id=key(input,init),path=id?join(directory,id+'.json'):null;
  if(mode==='replay'&&path&&existsSync(path)){
   const record=JSON.parse(readFileSync(path,'utf8'));
   if(record.run!==run||now()-record.at<0||now()-record.at>30*60*1000)throw Error('ALIO HTTP evidence belongs to another run or is stale');
   const bytes=Buffer.from(record.body,'base64');
   if(createHash('sha256').update(bytes).digest('hex')!==record.sha256)throw Error('ALIO HTTP evidence body digest mismatch');
   stats.replayed++;
   return new Response(bytes,{status:record.status,headers:record.headers});
  }
  stats.live++;const response=await transport(input,init);
  if(mode==='record'&&path&&response.status>=200&&response.status<400){
   const bytes=Buffer.from(await response.clone().arrayBuffer());
   const headers=Object.fromEntries(['content-type','content-disposition','location'].flatMap(name=>{const value=response.headers.get(name);return value?[[name,value]]:[];}));
   writeJsonAtomic(path,{run,at:now(),status:response.status,headers,body:bytes.toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex')});stats.recorded++;
  }
  return response;
 };
 return {request,stats};
}
