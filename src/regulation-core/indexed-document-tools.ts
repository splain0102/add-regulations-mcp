import {INDEX_PREFIX,shardId,MAX_LIST_AGE,MAX_INDEX_AGE,type IndexState,type CorpusDocument} from './corpus-index';
import {unpackDocument,DOCUMENT_INDEX_SCHEMA,type DocumentEvidence} from './document-index-codec';
import {normalizeRegulationTitle,searchLatestRegulationTable} from './regulations';
import {PARSER_VERSION} from './parser-version';
import {BUILD_VERSION} from '../build-info';
import {searchRegulationText} from './text-search';
import {tableToolResponse} from './table-response';
const failure=(code:string,message:string,extra:Record<string,unknown>={})=>({isError:true,structuredContent:{error:{code,message,...extra},partial:true},content:[{type:'text' as const,text:JSON.stringify({error:{code,message,...extra},partial:true})}]});
// One immutable document per isolate: a different manifest ref invalidates it.
let cached:{key:string;value:DocumentEvidence}|undefined;
export async function indexedDocumentTool(kv:KVNamespace,tool:string,input:Record<string,any>,refreshError?:unknown){
 const started=Date.now();let reads=0;
 try{
  if(!['get_regulation_text','search_regulation_text','search_regulation_table'].includes(tool)||typeof input.name!=='string'||input.name.length>300) return failure('invalid_query','Invalid document request');
  if(tool!=='get_regulation_text'&&(typeof input.query!=='string'||!input.query.trim()||input.query.length>1000))return failure('invalid_query','검색어를 입력해야 합니다.');
  const state=await kv.get<IndexState>(INDEX_PREFIX+'state','json');reads++;
  if(!state?.items?.length)return failure('index_preparing','규정 색인을 준비하고 있습니다.');
  const name=normalizeRegulationTitle(input.name),exact=state.items.filter(i=>normalizeRegulationTitle(i.title)===name),candidates=exact.length?exact:state.items.filter(i=>normalizeRegulationTitle(i.title).includes(name));
  if(!candidates.length)return failure('not_found','규정을 찾을 수 없습니다.');
  if(candidates.length!==1)return failure('ambiguous_name','정확한 규정명을 지정하세요.',{candidates:candidates.map(i=>({title:i.title,revisionDate:i.revisionDate}))});
  const item=candidates[0],ref=state.refs[shardId(item.title)];
  const shard=ref?await kv.get<{documents:Record<string,CorpusDocument>}>(ref,'json'):null;reads+=ref?1:0;
  const doc=shard?.documents[item.title];
  if(!doc||doc.prepared?.schema!==DOCUMENT_INDEX_SCHEMA)return failure('index_preparing','본문·표 사전 색인을 준비하고 있습니다. 원문은 요청 중 파싱하지 않습니다.');
  if(doc.parserVersion!==PARSER_VERSION)return failure('index_version_mismatch','파서 버전에 맞는 색인 갱신이 필요합니다.');
  const verified=state.checked[item.title]??doc.verifiedAt;
  const stale=!!refreshError||!!state.errors[item.title]||!!state.listError||!!state.sourceError||state.pending?.includes(item.title)||state.index_build_version!==BUILD_VERSION||!Number.isFinite(Date.parse(verified))||Date.now()-Date.parse(verified)>MAX_INDEX_AGE||!Number.isFinite(Date.parse(state.lastCheckedAt))||Date.now()-Date.parse(state.lastCheckedAt)>MAX_LIST_AGE||item.updatedDate!==doc.updatedDate||item.revisionDate!==doc.revisionDate;
  const key=ref+':'+item.title,hit=cached?.key===key;
  const evidence=hit?cached!.value:unpackDocument(doc.prepared);cached={key,value:evidence};
  const health={index_status:stale?'stale':'ready',partial:!!stale,index_build_version:state.index_build_version,lastVerifiedAt:verified,last_list_verified_at:state.lastCheckedAt,index_refresh_error:refreshError??state.errors[item.title]??state.listError??null,source_sha256:doc.sha256};
  const meta:any={...evidence.meta,...health,cache:{key,hit,scope:'persistent-index',metadataRevalidated:false},cache_hit:hit,parser_version:doc.parserVersion,...(stale?{version_warning:{code:'index_stale',message:'이전 검증본입니다. 현재 최신본 여부는 확인되지 않았습니다.'}}:{})};
  const text=async()=>({...meta,text:doc.text}) as any;
  const prepared={match:item,detail:{} as any,attachment:{} as any,document:{file:{extension:meta.extension,filename:meta.filename,bytes:new Uint8Array()},text:doc.text,rows:evidence.rows,tables:evidence.tables,pdfPages:evidence.pdfPages,layoutDebug:evidence.layoutDebug},cache:meta.cache} as any;
  // Supply stored metadata too: the shared query evaluator never selects/downloads a file.
  const table=async(_:string,query:string)=>({...await searchLatestRegulationTable(item.title,query,prepared,meta),...meta});
  let result:any;
  if(tool==='search_regulation_table'){
   const value=await table(item.title,input.query);result=tableToolResponse({...value,rows:input.include_text_box?value.rows:value.rows.filter((r:any)=>r.analysis_type!=='text_box')},input.query,input);
  }else if(tool==='search_regulation_text'){
   result=await searchRegulationText(item.title,input.query,input,{text,table,metadata:async()=>meta as any,history:async()=>{throw Object.assign(Error('과거 첨부는 사전 색인에 포함되지 않습니다.'),{code:'history_not_indexed'});}});
  }else{
   const body=doc.text.length>40000?doc.text.slice(0,40000)+'\n\n[본문이 길어 일부 생략됨]':doc.text;
   result={structuredContent:{...meta,text:body},content:[{type:'text',text:[`규정명: ${item.title}`,`제·개정일: ${doc.revisionDate??'확인 필요'}`,`최신파일: ${meta.filename}`,`fileNo: ${doc.fileNo}`,`version_check: ${JSON.stringify(meta.version_check)}`,`ALIO: ${doc.detailUrl}`,...(stale?['주의: 이전 검증본이며 현재 최신성은 확인되지 않았습니다.']:[]),'----- 최신 규정 본문 -----',body].join('\n')}]};
  }
  const metrics={elapsed_ms:Date.now()-started,kv_reads:reads,alio_requests:0,document_parses:0,cache_hit:hit};
  result.structuredContent={...result.structuredContent,...health,partial:!!stale||!!result.structuredContent?.partial,metrics};
  if(tool==='search_regulation_table')result.content=[{type:'text',text:JSON.stringify(result.structuredContent)}];
  if(stale)result.content.push({type:'text',text:JSON.stringify({warning:meta.version_warning,...health})});
  console.log('indexed_document_tool_finished',JSON.stringify({tool,fileNo:doc.fileNo,...metrics}));return result;
 }catch(error){console.error('indexed_document_tool_failed',{tool,error:String(error),elapsed_ms:Date.now()-started,kv_reads:reads});return failure('index_unavailable',String(error));}
}
export async function callIndexedDocumentTool(namespace:DurableObjectNamespace,tool:string,input:Record<string,unknown>){
 const stub=namespace.get(namespace.idFromName('add-corpus-index'));
 const response=await stub.fetch('https://index.internal/document-tool',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({tool,input})});
 if(!response.ok)return failure('index_unavailable','색인 조회 실패: HTTP '+response.status);
 return response.json() as Promise<any>;
}
