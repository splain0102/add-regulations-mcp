import {hash} from '../d1/records';
import {ROOT,type ObjectRef,type R2Head} from '../../src/r2/types';
import type {buildR2Catalog} from './build';
export type Store=((method:'PUT'|'GET',key:string,body?:Uint8Array,condition?:{ifMatch?:string;ifNoneMatch?:string})=>Promise<Uint8Array>)&{list:(prefix?:string)=>Promise<string[]>;etag:(key:string)=>string|undefined};
export async function optionalObject(store:Store,key:string){try{return JSON.parse(new TextDecoder().decode(await store('GET',key)));}catch(error){if(String(error).includes('R2 GET HTTP 404'))return undefined;throw error;}}
export async function publishR2(store:Store,built:ReturnType<typeof buildR2Catalog>,previous:R2Head|undefined,expectedEtag:string|undefined,validate:(head:R2Head)=>Promise<void>){
 const known=new Set(await store.list('r2-index/objects/'));
 for(const [key,bytes]of built.objects){if(!known.has(key))await store('PUT',key,bytes);const back=await store('GET',key);if(hash(back)!==hash(bytes))throw Error('r2_artifact_checksum_mismatch');}
 const head:R2Head={format:1,catalog:built.catalogRef,published_at:new Date().toISOString(),build_version:built.catalog.build_version,previous:previous?.catalog,count:built.catalog.documents.length};
 await validate(head);
 if(previous&&!expectedEtag)throw Error('missing_publication_etag');
 await store('PUT',ROOT,new TextEncoder().encode(JSON.stringify(head)),expectedEtag?{ifMatch:expectedEtag}:{ifNoneMatch:'*'});
 const current=await optionalObject(store,ROOT);if(current?.catalog?.sha256!==head.catalog.sha256)throw Error('publication_not_visible');return head;
}
