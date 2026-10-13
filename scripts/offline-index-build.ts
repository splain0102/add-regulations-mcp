import assert from 'node:assert/strict';
import {refreshIndex,readIndex,INDEX_PREFIX,DOCUMENT_CHECK_INTERVAL,indexErrorCode,type CorpusSource,type CorpusItem,type CorpusDocument} from '../src/regulation-core/corpus-index';
import {BUILD_VERSION} from '../src/build-info';
import {PARSER_VERSION} from '../src/regulation-core/parser-version';
import {createCorpusSource,searchAllRegulations} from '../src/regulation-core/regulations';
import {TestKV} from './corpus-index-test-kv';
import {exportSnapshot} from './bootstrap-index.mjs';
export type Stage={stage:string;title?:string;fileNo?:string;processed?:number;error_code?:string;message?:string};
function metadataEqual(a:CorpusItem,b:CorpusItem){return a.title===b.title&&a.detailUrl===b.detailUrl&&a.revisionDate===b.revisionDate&&a.updatedDate===b.updatedDate;}
export async function collectOfflineList(){let work:unknown;for(let i=0;i<40;i++){const result=await createCorpusSource().listBatch(work);if(result.items)return result.items;work=result.work;}throw Error('offline_list_incomplete');}
export const liveOfflineSource:CorpusSource={list:collectOfflineList,load:(item,previous)=>createCorpusSource().load(item,previous)};
export async function buildOfflineIndex(entries:[string,string][],source:CorpusSource=liveOfflineSource,options:{buildVersion?:string;forceDocuments?:boolean;now?:()=>number;progress?:(stage:Stage)=>Promise<void>}={}){
 const now=options.now??Date.now,build=options.buildVersion??BUILD_VERSION,progress=options.progress??(async()=>{}),kv=new TestKV();kv.values=new Map(entries);
 // Only corpus entries can be restored/exported. OAuth credentials never leave KV.
 for(const key of kv.values.keys())if(!key.startsWith(INDEX_PREFIX))kv.values.delete(key);
 await progress({stage:'list'});const items=await source.list();if(!Array.isArray(items)||!items.length||new Set(items.map(i=>i.title)).size!==items.length)throw Error('invalid_or_empty_regulation_list');
 const old=await kv.get<any>(INDEX_PREFIX+'state'),oldItems=new Map<string,CorpusItem>((old?.items??[]).map((item:CorpusItem)=>[item.title,item]));const docs=new Map<string,CorpusDocument>();
 for(const ref of Object.values(old?.refs??{}) as string[]){const value=await kv.get<any>(ref);for(const [title,doc]of Object.entries(value?.documents??{}))docs.set(title,doc as CorpusDocument);}
 const due=items.filter(item=>{
  const doc=docs.get(item.title),previous=oldItems.get(item.title),error=old?.errors[item.title];
  return options.forceDocuments||!doc||!previous||!metadataEqual(item,previous)||doc.parserVersion!==PARSER_VERSION||old?.index_build_version!==build||old?.pending?.includes(item.title)||error&&(!error.next_retry_at||now()>=Date.parse(error.next_retry_at))||!error&&(!old?.checked[item.title]||now()-Date.parse(old.checked[item.title])>=DOCUMENT_CHECK_INTERVAL);
 });
 type Loaded=Awaited<ReturnType<CorpusSource['load']>>;const loaded=new Map<string,{value?:Loaded;error?:unknown}>();let cursor=0,processed=0;
 // All parser work is in Node. Independent loads are bounded at four.
 await Promise.all(Array.from({length:Math.min(4,due.length)},async()=>{while(cursor<due.length){const item=due[cursor++];await progress({stage:'document',title:item.title,fileNo:docs.get(item.title)?.fileNo,processed});try{const value=await source.load(item,docs.get(item.title));loaded.set(item.title,{value});processed++;await progress({stage:'document_ready',title:item.title,fileNo:value.fileNo,processed});}catch(error){loaded.set(item.title,{error});await progress({stage:'document_failed',title:item.title,error_code:indexErrorCode(error),message:String(error).slice(0,180),processed});}}}));
 const adapter:CorpusSource={list:async()=>items,load:async(item,previous)=>{const saved=loaded.get(item.title);if(saved?.error)throw saved.error;if(saved?.value)return saved.value;return source.load(item,previous);}};
 if(old&&due.length){old.pending=[...new Set([...(old.pending??[]),...due.map(i=>i.title)])];for(const item of due)delete old.errors[item.title];kv.values.set(INDEX_PREFIX+'state',JSON.stringify(old));}
 let index:Awaited<ReturnType<typeof readIndex>>|undefined;
 for(let batch=0;batch<Math.ceil(items.length/2)+2;batch++){
  const result=await refreshIndex(kv.binding(),adapter,now(),{buildVersion:build,forceList:true,forceDocuments:options.forceDocuments&&batch===0,beforeCommit:()=>progress({stage:'validate',processed})});
  index=await readIndex(kv.binding(),now(),build);
  if(!index.partial)break;if(result.errors.count||!result.processed)throw Object.assign(Error('offline_index_incomplete'),{diagnostics:result.errors});
 }
 assert(index&&!index.partial&&index.documents.length===items.length,'Offline corpus must be complete before publication');
 // Confirm the list did not change while changed documents were being parsed.
 const latest=await source.list();assert.deepEqual(latest,items,'ALIO list changed during offline build; retry next run');
 await refreshIndex(kv.binding(),{...adapter,list:async()=>latest},now(),{buildVersion:build,forceList:true});
 const result=await searchAllRegulations('외국인',10,0,kv.binding(),build);const security=result.results.find((r:any)=>r.regulationName.endsWith('보안과제 관리요령'));const audit=index.documents.find(d=>d.title==='감사규정');
 const report={passed:result.partial===false&&result.errors.count===0&&!!audit?.fileNo&&!!security?.matches.some((m:any)=>m.label.includes('제8조')),finishedAt:new Date(now()).toISOString(),total:items.length,indexed:index.documents.length,result,security,audit,loadedDocuments:processed};
 assert(report.passed,'Search/audit acceptance required before publication');
 const snapshot=exportSnapshot([...kv.values],report);
 return {entries:[...kv.values] as [string,string][],report,snapshot};
}
