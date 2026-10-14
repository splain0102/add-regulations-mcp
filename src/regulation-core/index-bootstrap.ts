import {unpackDocument} from './document-index-codec';
import {buildCrossAttachmentWarnings,type AttachmentCatalog} from './cross-attachments';
import {BUILD_VERSION} from '../build-info';
import {PARSER_VERSION} from './parser-version';
import {INDEX_PREFIX,INDEX_SHARDS,MAX_SHARD_BYTES,MAX_CORPUS_BYTES,LIST_REFRESH_INTERVAL,shardId,sha256,type CorpusItem,type CorpusDocument,type IndexState} from './corpus-index';
type Session={id:string;build:string;items:CorpusItem[];verified:string;expires:number;completed?:number;refs:Record<string,string>;hashes:Record<string,string>;sizes:Record<string,number>};
const encode=new TextEncoder();
const fail=(code:string,status=400)=>Response.json({error_code:code},{status});
function validItem(item:CorpusItem){
 try{const url=new URL(item.detailUrl);return !!item.title?.trim()&&url.protocol==='https:'&&url.hostname==='www.alio.go.kr'&&url.pathname==='/item/itemBoard21110.do'&&!url.username&&!url.password;}catch{return false;}
}
function validateDocuments(documents:Record<string,CorpusDocument>,id:number,session:Session){
 if(!documents||typeof documents!=='object'||Array.isArray(documents))throw Error('invalid_documents');
 const wanted=new Map(session.items.map(item=>[item.title,item]));
 for(const [title,doc] of Object.entries(documents)){
  if(doc.prepared){const value=unpackDocument(doc.prepared);if(value.meta.fileNo!==doc.fileNo||value.meta.regulationName!==doc.title||value.meta.parser_version!==doc.parserVersion)throw Error('document_index_identity_mismatch:'+title);}
  const item=wanted.get(title);const verified=Date.parse(doc.verifiedAt);
  if(!item||shardId(title)!==id||doc.title!==title||doc.detailUrl!==item.detailUrl||doc.revisionDate!==item.revisionDate||doc.updatedDate!==item.updatedDate||!/^\d+$/.test(doc.fileNo)||!/^([a-f0-9]{64})$/.test(doc.sha256)||doc.parserVersion!==PARSER_VERSION||typeof doc.text!=='string'||!doc.text.trim()||!Number.isFinite(verified)||verified>Date.now()+300000||Date.now()-verified>24*3600000)throw Error('invalid_document:'+title);
 }
}
export async function bootstrapActive(storage:DurableObjectStorage){const session=await storage.get<Session>('bootstrap');return !!session&&session.build===BUILD_VERSION&&(!session.completed?session.expires>Date.now():Date.now()-session.completed<1100);}
export async function handleBootstrap(path:string,request:Request,storage:DurableObjectStorage,kv:KVNamespace){
 try{
  const raw=await request.text();if(encode.encode(raw).byteLength>MAX_SHARD_BYTES+10000)return fail('bootstrap_request_too_large',413);
  const input=JSON.parse(raw);let session=await storage.get<Session>('bootstrap');
  if(path==='/bootstrap/begin'){
   if(await bootstrapActive(storage))return fail('bootstrap_in_progress',409);
   const items=input.items as CorpusItem[];const verified=Date.parse(input.source_verified_at);
   if(input.parser_version!==PARSER_VERSION||!Array.isArray(items)||!items.length||items.length>500||new Set(items.map(item=>item.title)).size!==items.length||!items.every(validItem)||!Number.isFinite(verified)||Date.now()-verified>30*60000||verified>Date.now()+300000)return fail('invalid_bootstrap_manifest');
   session={id:crypto.randomUUID(),build:BUILD_VERSION,items,verified:new Date(verified).toISOString(),expires:Date.now()+30*60000,refs:{},hashes:{},sizes:{}};
   const previous=await kv.get<IndexState>(INDEX_PREFIX+'state','json');const reused:number[]=[];
   // Expired/cancelled import sessions may have uncommitted immutable shards.
   const abandoned=await storage.get<Session>('bootstrap');const protectedRefs=new Set([...Object.values(previous?.refs??{}),...Object.values(previous?.fallbackRefs??{})]);
   if(abandoned)for(const key of Object.values(abandoned.refs))if(!protectedRefs.has(key))try{await kv.delete(key);}catch(error){console.error('corpus_bootstrap_orphan_cleanup_failed',{message:String(error).slice(0,120)});}

   if(Array.isArray(input.reuse_shards)&&input.reuse_shards.length<=INDEX_SHARDS)for(const candidate of input.reuse_shards){
    const id=candidate.id;if(!Number.isInteger(id)||id<0||id>=INDEX_SHARDS||session.refs[id]||!/^[a-f0-9]{64}$/.test(candidate.sha256)||!previous?.refs[id])continue;
    const value=await kv.get(previous.refs[id],'text');if(!value)continue;const bytes=encode.encode(value);if(await sha256(bytes)!==candidate.sha256)continue;
    session.refs[id]=previous.refs[id];session.hashes[id]=candidate.sha256;session.sizes[id]=bytes.byteLength;reused.push(id);
   }
   await storage.put('bootstrap',session);return Response.json({session_id:session.id,totalRegulations:items.length,expires_at:new Date(session.expires).toISOString(),reused_shards:reused});
  }
  if(!session||session.id!==input.session_id)return fail('bootstrap_session_not_found',409);
  if(session.build!==BUILD_VERSION||session.expires<=Date.now())return fail('bootstrap_session_expired',409);
  if(path==='/bootstrap/shard'){
   if(session.completed)return fail('bootstrap_already_completed',409);
   const id=input.id;if(!Number.isInteger(id)||id<0||id>=INDEX_SHARDS)return fail('invalid_shard_id');
   validateDocuments(input.documents,id,session);
   const value=JSON.stringify({documents:input.documents}),bytes=encode.encode(value),hash=await sha256(bytes);
   if(hash!==input.sha256)return fail('bootstrap_checksum_mismatch');
   if(session.hashes[id])return session.hashes[id]===hash?Response.json({id,stored:true,reused:true}):fail('bootstrap_shard_conflict',409);
   if(bytes.byteLength>MAX_SHARD_BYTES||Object.values(session.sizes).reduce((a,b)=>a+b,0)+bytes.byteLength>MAX_CORPUS_BYTES)return fail('bootstrap_size_limit',413);
   const key=INDEX_PREFIX+'bootstrap:'+session.id+':shard:'+id;
   await kv.put(key,value);session.refs[id]=key;session.hashes[id]=hash;session.sizes[id]=bytes.byteLength;
   await storage.put('bootstrap',session);return Response.json({id,stored:true});
  }
  if(path==='/bootstrap/activate'){
   if(session.completed)return Response.json({activated:true,indexedRegulations:session.items.length,lastCompletedAt:new Date(session.completed).toISOString(),reused:true});
   if(Object.keys(session.refs).length!==INDEX_SHARDS)return fail('bootstrap_missing_shards',409);
   const checked:Record<string,string>={};const attachmentCatalog:AttachmentCatalog={};
   for(let id=0;id<INDEX_SHARDS;id++){
    const value=await kv.get(session.refs[id],'text');if(!value||await sha256(encode.encode(value))!==session.hashes[id])return fail('bootstrap_shard_unavailable',409);
    const shard=JSON.parse(value);validateDocuments(shard.documents,id,session);
    for(const [title,doc] of Object.entries(shard.documents) as [string,CorpusDocument][]){checked[title]=doc.verifiedAt;if(doc.attachments)attachmentCatalog[title]={fileNo:doc.fileNo,selectedDate:doc.selectedDate,attachments:doc.attachments};}
   }
   if(Object.keys(checked).length!==session.items.length||session.items.some(item=>!checked[item.title]))return fail('bootstrap_incomplete_corpus',409);
   const previous=await kv.get<IndexState>(INDEX_PREFIX+'state','json');const now=Date.now(),completed=new Date(now).toISOString();
   const protectedKeys=new Set([...Object.values(session.refs),...Object.values(previous?.refs??{}),...Object.values(previous?.fallbackRefs??{})]);
   const garbage=new Map((previous?.garbage??[]).map(g=>[g.key,g]));
   for(const key of Object.values(previous?.refs??{}))if(!Object.values(session.refs).includes(key)&&!garbage.has(key))garbage.set(key,{key,after:now+15*60000});
   // Bounded GC stays in the coordinator; no Worker Cron corpus processing.
   let deleted=0;for(const [key,g]of garbage)if(g.after<=now&&!protectedKeys.has(key)&&deleted<INDEX_SHARDS){try{await kv.delete(key);garbage.delete(key);deleted++;}catch(error){console.error('corpus_bootstrap_gc_failed',{key,message:String(error).slice(0,120)});}}
   for(const key of Object.values(session.refs))garbage.delete(key);
   const state:IndexState={attachmentCatalog,crossEntryWarnings:buildCrossAttachmentWarnings(session.items.map(i=>i.title),attachmentCatalog),schema:2,cursor:0,pending:[],items:session.items,refs:session.refs,sizes:session.sizes,checked,errors:{},lastCheckedAt:session.verified,lastVerifiedAt:completed,lastCompletedAt:completed,index_build_version:BUILD_VERSION,indexedTitles:session.items.map(item=>item.title),nextListAttemptAt:new Date(Date.parse(session.verified)+LIST_REFRESH_INTERVAL).toISOString(),fallbackRefs:previous?.refs,garbage:[...garbage.values()]};
   // The sole manifest write happens after every immutable shard is verified.
   await kv.put(INDEX_PREFIX+'state',JSON.stringify(state));session.completed=now;await storage.put('bootstrap',session);
   console.log('corpus_index_bootstrap_completed',JSON.stringify({build_version:BUILD_VERSION,indexedRegulations:session.items.length,lastCompletedAt:completed}));
   return Response.json({activated:true,indexedRegulations:session.items.length,lastCompletedAt:completed});
  }
  return fail('not_found',404);
 }catch(error){return fail(String(error).slice(0,200),/KV|storage|write failure/i.test(String(error))?500:400);}
}
