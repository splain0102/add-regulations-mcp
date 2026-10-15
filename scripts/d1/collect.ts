import {createCorpusSource,createIndexRequest,getRegulationDetail} from '../../src/regulation-core/regulations';
import {collectOfflineList} from '../offline-index-build';
import {extractRevisionSection} from '../../src/regulation-core/revision-probe';
import {PARSER_VERSION} from '../../src/regulation-core/parser-version';
import {documentRecords,hash} from './records';
export type Prior={document_id:string;regulation_id:string;title:string;st_date:string;i_date:string;file_no:string;sha256:string;parser_version:string;index_schema_version:number;validation_json:string};
export async function collectCatalog(io:{prior:Prior[];request?:typeof fetch;forceSha?:boolean|((prior:Prior|undefined,item:any)=>boolean);onList?:(items:any[])=>Promise<void>;onDetail?:(item:any,detail:any)=>Promise<void>;onVerified?:(item:any,value:{document_id:string;rawVerified:boolean})=>Promise<void>;shouldStop?:()=>boolean;readPrevious?:(doc:Prior)=>Promise<any>;save:(item:any,loaded:any,records:any)=>Promise<void>;progress?:(value:any)=>Promise<void>}){
 const transport=io.request??fetch,items=await collectOfflineList(transport),documents:any[]=[],now=new Date().toISOString();
 await io.onList?.(items);
 let cursor=0,processed=0,reused=0,downloadedCount=0;const failures:any[]=[];
 await Promise.all(Array.from({length:Math.min(3,items.length)},async()=>{while(cursor<items.length&&!failures.length&&!io.shouldStop?.()){const position=cursor++,item=items[position];try{
  await io.progress?.({title:item.title,stage:'metadata',processed,total:items.length});
  const prior=io.prior.find(p=>p.regulation_id===new URL(item.detailUrl).searchParams.get('idx'));
  const equal=prior&&prior.title===item.title&&prior.st_date===(item.revisionDate??null)&&prior.i_date===(item.updatedDate??null)&&prior.parser_version===PARSER_VERSION&&prior.index_schema_version===1;
  const downloaded=new Map<string,Response>();const documentFetch:typeof fetch=async(input,init)=>{const key=String(input),cacheable=key.startsWith('https://www.alio.go.kr/download/')&&(!init?.method||init.method==='GET');const cached=cacheable?downloaded.get(key):undefined;if(cached)return cached.clone();const response=await transport(input,init);if(cacheable&&response.ok)downloaded.set(key,response.clone());return response;};
  const request=createIndexRequest(documentFetch);
  // Only trust prior revision evidence when ALIO metadata is unchanged. New
  // attachments go through the same original selector and revision probe.
  const detail=await getRegulationDetail(item.detailUrl,item.updatedDate,{request,requireAttachments:true,fallbackRevisionDate:item.revisionDate,probe:async file=>{
   if(equal&&file.fileNo===prior.file_no)return JSON.parse(prior.validation_json).revision_evidence??'';
   const response=await request(file.url);if(!response.ok)throw Error('ALIO HTTP '+response.status);return extractRevisionSection(new Uint8Array(await response.arrayBuffer()),file.extension??'');
  }});
  await io.onDetail?.(item,detail);
  let rawVerified=false;const forceRaw=typeof io.forceSha==='function'?io.forceSha(prior,item):io.forceSha;
  const selected=detail.latestAttachment;if(!selected)throw Error('selection_error:'+item.title);
  if(equal&&selected.fileNo===prior.file_no&&!forceRaw){documents[position]={item,document_id:prior.document_id,verified_at:now,reused:true};}
  else{
   rawVerified=true;const previous=equal&&io.readPrevious?await io.readPrevious(prior):undefined;
   const loaded=await createCorpusSource(createIndexRequest(documentFetch)).load(item,previous);
   if(equal&&loaded.fileNo===prior.file_no&&hash(loaded.bytes)===prior.sha256){documents[position]={item,document_id:prior.document_id,verified_at:now,reused:true};}
   else{const records=await documentRecords(item,loaded);await io.save(item,loaded,records);documents[position]={item,document_id:records.document.document_id,verified_at:now,reused:false};}
  }
  await io.onVerified?.(item,{document_id:documents[position].document_id,rawVerified});
  processed++;if(documents[position].reused)reused++;else downloadedCount++;await io.progress?.({title:item.title,processed,total:items.length,reused,downloaded:downloadedCount});
 }catch(error){failures.push(Object.assign(new Error(String(error)),{title:item.title,stage:'document',cause:error}));}}}));
 if(failures.length)throw failures[0];
 if(processed<items.length)return {complete:false,items,documents:documents.filter(Boolean),verified_at:new Date().toISOString(),processed,reused,downloaded:downloadedCount};
 const latest=await collectOfflineList(transport);if(JSON.stringify(latest)!==JSON.stringify(items))throw Error('list_changed_during_sync');
 return {complete:true,items,documents,verified_at:new Date().toISOString(),processed,reused,downloaded:downloadedCount};
}
