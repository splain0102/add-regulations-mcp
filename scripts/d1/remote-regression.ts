import assert from 'node:assert/strict';
import {r2Store,remoteDatabase} from './remote';
const names=['CLOUDFLARE_ACCOUNT_ID','D1_DATABASE_ID','CLOUDFLARE_D1_TOKEN','D1_WRITE_BUDGET','R2_BUCKET','R2_ACCESS_KEY_ID','R2_SECRET_ACCESS_KEY','R2_BUCKET_BUDGET_BYTES'];const saved=Object.fromEntries(names.map(n=>[n,process.env[n]]));const original=globalThis.fetch;
try{
 Object.assign(process.env,{CLOUDFLARE_ACCOUNT_ID:'test-account',D1_DATABASE_ID:'test-database',CLOUDFLARE_D1_TOKEN:'test-only',D1_WRITE_BUDGET:'1000',R2_BUCKET:'test-archive',R2_ACCESS_KEY_ID:'test-only',R2_SECRET_ACCESS_KEY:'test-only',R2_BUCKET_BUDGET_BYTES:'1000'});
 let puts=0,queries=0;
 globalThis.fetch=async(input,init)=>{
  const url=new URL(String(input));if(url.hostname.endsWith('r2.cloudflarestorage.com')){
   assert(new Headers(init?.headers).get('authorization')?.startsWith('AWS4-HMAC-SHA256 '));
   if(url.searchParams.get('list-type')==='2')return new Response('<ListBucketResult><Contents><Key>old.bin</Key><Size>900</Size></Contents></ListBucketResult>');
   if(init?.method==='PUT'){puts++;return new Response(null,{status:200});}return new Response('bytes');
  }
  const body=JSON.parse(String(init?.body));queries++;
  if(body.sql?.startsWith('SELECT coalesce'))return Response.json({success:true,result:[{success:true,results:[{n:0}]}]});
  if(body.sql?.startsWith('UPDATE sync_runs SET rows_written'))return Response.json({success:true,result:[{success:true}]});
  assert(Array.isArray(body.batch));return Response.json({success:true,result:body.batch.map(()=>({success:true,results:[{n:1}],meta:{rows_written:1}}))});
 };
 const r2=r2Store();await assert.rejects(()=>r2('PUT','new.bin',new Uint8Array(101)),/r2_bucket_budget_reached/);assert.equal(puts,0);
 await r2('PUT','old.bin',new Uint8Array(50));await r2('PUT','new.bin',new Uint8Array(950));assert.equal(puts,2);await assert.rejects(()=>r2('PUT','more.bin',new Uint8Array(1)),/r2_bucket_budget_reached/);
 const db=remoteDatabase('test');assert.equal((await db.query('SELECT 1'))[0].n,1);await db.batch([{sql:'UPDATE example SET value=?',params:[1]}]);assert(queries>=5);
 console.log('D1_REMOTE_MOCK_PASS R2 budget includes existing objects; overwrite reservations; D1 batch protocol. Not a real Cloudflare call.');
}finally{globalThis.fetch=original;for(const name of names){if(saved[name]===undefined)delete process.env[name];else process.env[name]=saved[name];}}
