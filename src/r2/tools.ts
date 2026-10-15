import {normalizeName,queryTerms,normalize} from '../d1/normalize';
import {tableToolResponse} from '../regulation-core/table-response';
import {mightMatch} from './bloom';
import {searchBodies} from './global-search';
import {PARSER_VERSION} from '../regulation-core/parser-version';
import {R2Reader} from './read';
import {ROOT,STATUS,type R2Catalog,type R2Head,type SearchRecord,type R2Document} from './types';
import type {Input} from '../d1/tools';
export const envelope=(data:any,isError=false)=>({...isError?{isError:true}:{},structuredContent:data,content:[{type:'text' as const,text:JSON.stringify(data)}]});
export function rowMatches(r:SearchRecord,q:ReturnType<typeof queryTerms>){
 if(r.kind==='body')return q.terms.every(t=>r.n!.includes(t));
 const m=r.match!;return q.terms.length===1?[...m.cells,...m.aliases].some(c=>c.includes(q.joined)):m.row.includes(q.joined)||q.terms.every(t=>m.row.includes(t))||m.paths.some(p=>q.terms.every(t=>p.includes(t)));
}
function originalOffset(text:string,at:number){let n=0,pos=0;for(const char of text){if(n>=at)return pos;n+=normalize(char).length;pos+=char.length;}return pos;}
export async function runR2Tool(reader:R2Reader,tool:string,input:Input={},build='unstamped',candidate?:R2Head){
 const start=Date.now(),r0=reader.requests,b0=reader.bytes_read,limit=Math.min(500,Math.max(1,input.limit??5)),offset=Math.max(0,input.offset??0);
 try{
  if((input.query?.length??0)>256||(input.name?.length??0)>300)return envelope({error:{code:'invalid_input',message:'검색어는 256자, 규정명은 300자 이내로 입력하세요.'}},true);
  const q=input.query?queryTerms(input.query):undefined;
  if((q?.terms.length??0)>20)return envelope({warning:{code:'too_many_terms'},results:[],totalMatches:0});
  if(q?.warning)return envelope({warning:{code:q.warning,message:'문자·숫자 중심의 두 글자 이상 검색어를 입력하세요.'},results:[],rows:[],matches:[],totalMatches:0});
  const head:R2Head=candidate??await reader.read(ROOT,8192);if(head.format!==1)throw Error('index_version_mismatch');
  let catalog:R2Catalog,fallback=false;try{catalog=await reader.ref(head.catalog);}catch(error){if(!head.previous)throw error;catalog=await reader.ref(head.previous);fallback=true;}
  if(catalog.format!==1||!Array.isArray(catalog.documents)||catalog.documents.length!==(!fallback?head.count:catalog.documents.length))throw Error('invalid_catalog');
  const status=candidate?undefined:await reader.optional(STATUS).catch(()=>({status:'unknown'})),statusApplies=Date.parse(status?.started_at??status?.finished_at??'')>=Date.parse(catalog.verified_at),pending=statusApplies?status?.pending_titles??[]:[],failed=statusApplies&&status?.status==='failed',verifiedAt=!fallback&&status?.check_type==='metadata'&&status.catalog_sha===head.catalog.sha256?status.last_list_verified_at:catalog.verified_at,stale=fallback||failed||catalog.parser_version!==PARSER_VERSION||Boolean(pending.length)||Date.now()-Date.parse(verifiedAt)>2*3600000;
  const health={storage:'r2',snapshot_id:(!fallback?head.catalog:head.previous!).sha256,index_status:stale?'stale':'ready',partial:stale,lastVerifiedAt:verifiedAt,last_attachment_verified_at:catalog.verified_at,lastCompletedAt:head.published_at,index_build_version:catalog.build_version,serving_build_version:build,totalRegulations:Math.max(catalog.documents.length,statusApplies?status?.total??0:0),source_regulation_count:statusApplies?status?.total??catalog.documents.length:catalog.documents.length,indexedRegulations:catalog.documents.length,last_sync_status:statusApplies?status?.status??'unknown':'published',errors:{count:failed?1:0,sample:failed?[{code:status.error_code,checkedAt:status.finished_at,build_version:status.build_version}]:[],retry_cursor:null}};
  if(tool==='diagnose_alio_list')return envelope({...health,last_sync_started_at:status?.started_at,last_sync_finished_at:status?.finished_at,regulation_count:catalog.documents.length,pending_titles:pending,removed_titles:statusApplies?status?.removed_titles??[]:[],last_error:failed?status.message:null});
  let doc:R2Document|undefined;
  if(input.name){const n=normalizeName(input.name),all=catalog.documents.filter(d=>d.title_normalized.includes(n)),exact=all.filter(d=>d.title===input.name),normal=all.filter(d=>d.title_normalized===n),candidates=exact.length?exact:normal.length?normal:all;if(candidates.length!==1)return envelope({...health,error:{code:candidates.length?'ambiguous_name':pending.some((t:string)=>normalizeName(t).includes(n))?'index_preparing':'not_found',candidates:candidates.map(d=>({title:d.title,revisionDate:d.st_date}))}},true);doc=candidates[0];}
  const meta=(d:R2Document)=>({regulationName:d.title,revisionDate:d.st_date,updatedDate:d.i_date,fileNo:d.file_no,filename:d.filename,extension:d.extension,sourceUrl:d.source_url,sha256:d.sha256,parser_version:d.parser_version,version_check:JSON.parse(d.validation_json),version_warning:d.cross_entry_warnings?.find((w:any)=>w.code==='cross_entry_newer_attachment')??JSON.parse(d.validation_json).warning,selection_evidence:JSON.parse(d.selection_evidence_json),selection_reason:d.selection_reason??[],other_attachments:d.other_attachments??[],cross_entry_warnings:d.cross_entry_warnings??[],...health,...pending.includes(d.title)?{partial:true,index_status:'stale',source_latest_status:status?.removed_titles?.includes(d.title)?'removed_from_source_pending':'update_pending'}:{source_latest_status:failed?'verification_failed':stale?'verification_stale':'verified'}});
  if(tool==='get_regulation')return envelope(meta(doc!));
  if(tool==='list_regulations'||tool==='search_regulations'){const n=normalizeName(input.query??''),all=catalog.documents.filter(d=>d.title_normalized.includes(n)),items=all.slice(offset,offset+limit);return envelope({...health,results:items.map(meta),totalMatches:all.length,limit,offset,next_offset:offset+items.length<all.length?offset+items.length:null});}
  async function summaries(d:R2Document){const rows:SearchRecord[]=[];for(let i=0;i<d.search.length;i+=4)for(const part of await Promise.all(d.search.slice(i,i+4).map(ref=>reader.ref(ref))))rows.push(...part);return rows;}
  const page=(all:any[],size=limit)=>({totalMatches:all.length,limit,offset,has_more:offset+size<all.length,next_offset:offset+size<all.length?offset+size:null,next_cursor:offset+size<all.length?offset+size:null});
  if(tool==='search_all_regulations'){
   const bodies:any[]=[];if(input.scope!=='table')for(let i=0;i<catalog.body_shards.length;i+=4)for(const part of await Promise.all(catalog.body_shards.slice(i,i+4).map(ref=>reader.ref(ref))))bodies.push(...part);let all=searchBodies(bodies,input.query!);bodies.length=0;
   // Preserve existing body ranking, then include table matches by default.
   // Explicit body scope excludes tables. Search precomputed row summaries; no document parser.
   if(!input.scope||input.scope==='table'||input.scope==='all'){
    const grouped=new Map<string,{count:number;matches:any[]}>(),refs=catalog.table_shards.filter(ref=>mightMatch(ref.bloom,q!.terms));
    for(let i=0;i<refs.length;i+=4)for(const part of await Promise.all(refs.slice(i,i+4).map(ref=>reader.ref(ref))))for(const r of part){if(!input.include_text_box&&r.analysis_type==='text_box'||!rowMatches({...r,kind:'table'},q!))continue;const g=grouped.get(r.document_id)??{count:0,matches:[]};g.count++;if(g.matches.length<3)g.matches.push({label:r.label,snippet:r.match.row.slice(0,850),score:0.1,kind:'table'});grouped.set(r.document_id,g);}
    const tables=catalog.documents.filter(d=>grouped.has(d.document_id)).map(d=>({regulationName:d.title,fileNo:d.file_no,revisionDate:d.st_date,sourceUrl:d.source_url,score:0.1,matches:grouped.get(d.document_id)!.matches,tableMatches:grouped.get(d.document_id)!.count}));
    all=input.scope==='table'?tables:[...all,...tables.filter(t=>!all.some(a=>a.regulationName===t.regulationName))];
   }
   if(input.scope==='pdf'){const pdf=new Set(catalog.documents.filter(d=>d.extension==='pdf').map(d=>d.title));all=all.filter(d=>pdf.has(d.regulationName));}
   return envelope({...health,...page(all),query:input.query,results:all.slice(offset,offset+limit),metrics:{elapsed_ms:Date.now()-start,r2_reads:reader.requests-r0,r2_bytes:reader.bytes_read-b0,alio_requests:0,document_parses:0}});
  }
  if(!doc)return envelope({error:{code:'invalid_name'}},true);
  const all=(await summaries(doc)).filter(r=>{if(input.scope==='pdf'&&doc!.extension!=='pdf')return false;const wanted=tool==='get_regulation_text'?r.kind==='body':tool==='search_regulation_table'?r.kind==='table':input.scope==='body'?r.kind==='body':input.scope==='table'?r.kind==='table':true;return wanted&&(r.kind!=='table'||input.include_text_box||r.analysis_type!=='text_box')&&(!q||rowMatches(r,q));});
  const selected=all.slice(offset,offset+Math.min(100,limit)),results:any[]=[];
  for(const r of selected){const value=(await reader.ref(r.evidence))[r.evidence_index];if(!value)throw Error('missing_evidence');if(r.kind==='body'){const text=String(value.text),at=q?originalOffset(text,Math.max(0,r.n!.indexOf(q.terms[0]))):0,from=q?Math.max(0,at-100):0,size=input.compact===false?20000:1200;results.push({regulationName:doc.title,revisionDate:doc.st_date,fileNo:doc.file_no,sourceUrl:doc.source_url,kind:'body',label:r.label,snippet:text.slice(from,from+size),snippet_truncated:from>0||text.length>size});}else results.push({...value.result,regulationName:doc.title,revisionDate:doc.st_date,fileNo:doc.file_no,sourceUrl:doc.source_url,kind:'table',label:r.label});}
  let data:any={...meta(doc),...page(all,results.length),query:input.query,results,metrics:{elapsed_ms:Date.now()-start,r2_reads:reader.requests-r0,r2_bytes:reader.bytes_read-b0,alio_requests:0,document_parses:0}};
  if(tool==='search_regulation_table'){const formatted=tableToolResponse({...meta(doc),rows:results},input.query!,{...input,offset:0,limit:results.length||limit}).structuredContent;data={...data,...formatted,...page(all,(formatted.rows as any[]).length),results:formatted.rows,rows:formatted.rows};}
  else{if(input.compact!==false)for(let i=0;i<results.length;i++)if(results[i].kind==='table'){const r=results[i];results[i]={...(tableToolResponse({rows:[r]},input.query!,{compact:true,limit:1}).structuredContent.rows as any[])[0],regulationName:doc.title,revisionDate:doc.st_date,sourceUrl:doc.source_url,kind:'table',label:r.label};}if(tool==='get_regulation_text')data.text=results.map(r=>r.snippet).join('\n\n');if(tool==='search_regulation_text')Object.assign(data,{matches:results.filter(r=>r.kind==='body'),table:{rows:results.filter(r=>r.kind==='table')},history:[]});}
  if(input.include_history)Object.assign(data,{partial:true,errors:[{code:'historical_index_unavailable',message:'과거 첨부는 최신 검색 근거에 포함하지 않습니다.'}]});
  return envelope(data);
 }catch(error){console.error('r2_tool_failed',{tool,error:String(error)});return envelope({error:{code:String(error).includes('r2_missing_object:'+ROOT)?'index_preparing':'index_unavailable',message:'검증된 R2 색인을 준비하거나 복구하고 있습니다.'},partial:true},true);}
}
