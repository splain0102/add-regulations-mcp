import type {Bucket,ObjectRef} from './types';
// Only immutable content-addressed data is cached. The active pointer and health
// are read afresh for each request. Size accounting bounds retained JSON data.
export class R2Reader {
 private cache=new Map<string,{value:any;bytes:number}>();private bytes=0;
 requests=0;bytes_read=0;
 private bucket:Bucket;private maximum:number;
 constructor(bucket:Bucket,maximum=16_000_000){this.bucket=bucket;this.maximum=maximum;}
 async read(key:string,limit=2_000_000,immutable=false){
  const cached=immutable?this.cache.get(key):undefined;if(cached){this.cache.delete(key);this.cache.set(key,cached);return cached.value;}
  const object=await this.bucket.get(key);this.requests++;if(!object)throw Error('r2_missing_object:'+key);
  if((object.size??0)>limit)throw Error('r2_object_size_limit');const bytes=await object.arrayBuffer();this.bytes_read+=bytes.byteLength;if(bytes.byteLength>limit)throw Error('r2_object_size_limit');
  const value=JSON.parse(new TextDecoder().decode(bytes));if(immutable&&bytes.byteLength<=this.maximum){while(this.bytes+bytes.byteLength>this.maximum&&this.cache.size){const [old,entry]=this.cache.entries().next().value!;this.cache.delete(old);this.bytes-=entry.bytes;}this.cache.set(key,{value,bytes:bytes.byteLength});this.bytes+=bytes.byteLength;}return value;
 }
 async ref(ref:ObjectRef){if(!/^r2-index\/objects\/[a-f0-9]{64}\.json$/.test(ref.key)||ref.key!==`r2-index/objects/${ref.sha256}.json`||ref.bytes>2_000_000)throw Error('invalid_r2_reference');return this.read(ref.key,ref.bytes,true);}
 async optional(key:string){try{return await this.read(key);}catch(error){if(String(error).startsWith('Error: r2_missing_object:'))return undefined;throw error;}}
}
