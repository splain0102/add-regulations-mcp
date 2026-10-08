// In-process KV double; Workers runtime evidence is recorded separately.
export class TestKV {
 values=new Map<string,string>();reads=0;writes=0;deletes=0;failKey='';
 async get<T>(key:string,_type?:string):Promise<T|null>{this.reads++;const value=this.values.get(key);return value===undefined?null:JSON.parse(value);}
 async put(key:string,value:string){if(key.includes(this.failKey)&&this.failKey)throw Error('injected KV write failure');if(new TextEncoder().encode(value).length>25*1024*1024)throw Error('KV 25 MiB limit');this.writes++;this.values.set(key,value);}
 async delete(key:string){this.deletes++;this.values.delete(key);}
 binding(){return this as unknown as KVNamespace;}
}
