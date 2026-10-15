import {normalizeName,queryTerms,normalize} from './normalize';
import {tableToolResponse} from '../regulation-core/table-response';
export type Input={name?:string;query?:string;limit?:number;offset?:number;scope?:'body'|'table'|'pdf'|'all';compact?:boolean;include_history?:boolean;includeRegion?:boolean;include_text_box?:boolean};
export const envelope=(data:any,isError=false)=>({...isError?{isError:true}:{},structuredContent:data,content:[{type:'text' as const,text:JSON.stringify(data)}]});
export async function runD1Tool(db:D1Database,tool:string,input:Input={},build='unstamped'){
 const start=Date.now(),limit=Math.min(100,Math.max(1,input.limit??5)),offset=Math.max(0,input.offset??0);let reads=0,queries=0;
 async function sql(query:string,args:any[]=[]){const result=await db.prepare(query).bind(...args).all<any>();queries++;reads+=result.meta.rows_read??0;return result.results;}
 try{
  const [status]=await sql(`SELECT s.*,r.status AS sync_status,r.failure_count,r.started_at AS last_sync_started_at,r.finished_at AS last_sync_finished_at FROM service_state s LEFT JOIN sync_runs r ON r.run_id=(SELECT run_id FROM sync_runs ORDER BY started_at DESC,run_id DESC LIMIT 1) WHERE singleton=1`);
  if(tool==='diagnose_alio_list'){const [count]=await sql('SELECT count(*) AS regulation_count FROM catalog_entries WHERE snapshot_id=? AND is_current=1',[status?.active_snapshot_id??'']);return envelope({...status,...count,storage:'d1'});}
  if(!status?.active_snapshot_id)return envelope({error:{code:'index_preparing',message:'검증된 D1 색인을 준비하고 있습니다.'},partial:true},true);
  // Pin the snapshot once so pagination/count/data never mix two publications.
  const snapshot=status.active_snapshot_id,stale=status.sync_status==='failed'||Date.now()-Date.parse(status.last_success_at??'')>2*3600000;
  const health={index_status:stale?'stale':'ready',partial:stale,lastVerifiedAt:status.last_success_at,index_build_version:build,last_sync_status:status.sync_status};
  const active=`FROM catalog_entries c JOIN documents d ON d.document_id=c.document_id WHERE c.snapshot_id=? AND c.is_current=1`;
  let doc:any;
  if(input.name){const name=normalizeName(input.name),all=await sql(`SELECT d.* ${active} AND (d.title=? OR d.title_normalized=? OR instr(d.title_normalized,?)>0) ORDER BY CASE WHEN d.title=? THEN 0 WHEN d.title_normalized=? THEN 1 ELSE 2 END,d.title`,[snapshot,input.name,name,name,input.name,name]);
   const exact=all.filter(d=>d.title===input.name),normal=all.filter(d=>d.title_normalized===name),candidates=exact.length?exact:normal.length?normal:all;
   if(candidates.length!==1)return envelope({error:{code:candidates.length?'ambiguous_name':'not_found',candidates:candidates.map(d=>({title:d.title,revisionDate:d.st_date}))}},true);doc=candidates[0];
  }
  const meta=(d:any)=>({regulationName:d.title,revisionDate:d.st_date,updatedDate:d.i_date,fileNo:d.file_no,filename:d.filename,extension:d.extension,sourceUrl:d.source_url,parser_version:d.parser_version,version_check:JSON.parse(d.validation_json),...health});
  if(tool==='get_regulation')return envelope({...meta(doc),selection_evidence:JSON.parse(doc.selection_evidence_json)});
  if(tool==='list_regulations'||tool==='search_regulations'){
   const q=normalizeName(input.query??''),rows=await sql(`SELECT d.*,count(*) OVER() AS total ${active} AND instr(d.title_normalized,?)>0 ORDER BY CASE WHEN d.title_normalized=? THEN 0 ELSE 1 END,d.title LIMIT ? OFFSET ?`,[snapshot,q,q,limit,offset]);
   return envelope({...health,results:rows.map(meta),totalMatches:rows[0]?.total??0,limit,offset,next_offset:offset+rows.length<(rows[0]?.total??0)?offset+rows.length:null});
  }
  const query=input.query?queryTerms(input.query):undefined;
  if(query?.warning)return envelope({...health,warning:{code:query.warning,message:'검색어는 문자·숫자 중심으로 두 글자 이상 입력하세요.'},results:[],rows:[],matches:[],totalMatches:0});
  const wantBody=tool==='get_regulation_text'||tool==='search_regulation_text'&&input.scope!=='table'||tool==='search_all_regulations'&&input.scope!=='table';
  const wantTable=tool==='search_regulation_table'||tool==='search_regulation_text'&&input.scope!=='body'||tool==='search_all_regulations'&&input.scope!=='body';
  const pieces:string[]=[],args:any[]=[];
  const constraints=(alias:string)=>{const p=['c.snapshot_id=?','c.is_current=1'];args.push(snapshot);if(doc){p.push('d.document_id=?');args.push(doc.document_id);}if(input.scope==='pdf')p.push("d.extension='pdf'");return p;};
  if(wantBody){const snippetSize=tool==='get_regulation_text'&&input.compact===false?20000:1200;const bodyText=query?"substr(s.text_original,max(1,coalesce(json_extract(s.evidence_json,'$.normalization_map['||max(0,instr(s.text_normalized,?)-1)||']'),1)-100),?)":"substr(s.text_original,1,?)";if(query)args.push(query.terms[0]);args.push(snippetSize);const p=constraints('s');if(query){p.push('s.section_id IN (SELECT rowid FROM body_fts WHERE body_fts MATCH ?)');args.push(query.fts);for(const term of query.terms){p.push('instr(s.text_normalized,?)>0');args.push(term);}}
   pieces.push(`SELECT 'body' AS kind,s.section_id AS id,s.ordinal AS ordinal,d.document_id,d.title,d.st_date,d.file_no,d.source_url,d.extension,s.section_label AS label,${bodyText} AS text,NULL AS payload,length(s.text_original) AS source_length FROM sections s JOIN documents d ON d.document_id=s.document_id JOIN catalog_entries c ON c.document_id=d.document_id WHERE ${p.join(' AND ')}`);
  }
  if(wantTable&&query){const p=constraints('r');p.push('r.row_id IN (SELECT rowid FROM table_fts WHERE table_fts MATCH ?)');args.push(query.fts);
   if(!input.include_text_box)p.push("t.analysis_type!='text_box'");
   if(query.terms.length===1){p.push(`(EXISTS(SELECT 1 FROM json_each(r.match_json,'$.cells') j WHERE instr(j.value,?)>0) OR EXISTS(SELECT 1 FROM json_each(r.match_json,'$.aliases') j WHERE instr(j.value,?)>0))`);args.push(query.joined,query.joined);}
   else{p.push(`(instr(r.text_normalized,?)>0 OR (${query.terms.map(()=>"instr(json_extract(r.match_json,'$.row'),?)>0").join(' AND ')}) OR EXISTS(SELECT 1 FROM json_each(r.match_json,'$.paths') j WHERE ${query.terms.map(()=>"instr(j.value,?)>0").join(' AND ')}))`);args.push(query.joined,...query.terms,...query.terms);}
   pieces.push(`SELECT 'table' AS kind,r.row_id AS id,r.record_number AS ordinal,d.document_id,d.title,d.st_date,d.file_no,d.source_url,d.extension,t.table_key||':'||r.source_row_number AS label,r.text_original AS text,r.parser_result_json AS payload,length(r.text_original) AS source_length FROM table_rows r JOIN table_definitions t ON t.table_pk=r.table_pk JOIN documents d ON d.document_id=t.document_id JOIN catalog_entries c ON c.document_id=d.document_id WHERE ${p.join(' AND ')}`);
  }
  if(!pieces.length)return envelope({...health,results:[],totalMatches:0});
  const rows=await sql(`SELECT *,count(*) OVER() AS total FROM (${pieces.join(' UNION ALL ')}) ORDER BY title,kind,ordinal,id LIMIT ? OFFSET ?`,[...args,limit,offset]);
  const total=rows[0]?.total??0,next=offset+rows.length<total?offset+rows.length:null;
  const metrics={elapsed_ms:Date.now()-start,d1_queries:queries,rows_read:reads,alio_requests:0,document_parses:0};
  let results=rows.map(r=>({regulationName:r.title,revisionDate:r.st_date,fileNo:r.file_no,sourceUrl:r.source_url,kind:r.kind,label:r.label,...(r.kind==='body'?{snippet:r.text.slice(0,input.compact===false?20000:1200),snippet_truncated:r.source_length>r.text.length}:{...JSON.parse(r.payload)})}));
  if(tool!=='search_regulation_table'&&input.compact!==false)results=results.map(r=>r.kind!=='table'?r:{...(tableToolResponse({rows:[r] as any},input.query!,{compact:true,limit:1}).structuredContent.rows as any[])[0],regulationName:r.regulationName,revisionDate:r.revisionDate,fileNo:r.fileNo,sourceUrl:r.sourceUrl,kind:r.kind,label:r.label});
  let response:any={...doc?meta(doc):{},...health,query:input.query,results,totalMatches:total,limit,offset,has_more:next!==null,next_offset:next,metrics};
  if(tool==='search_regulation_table'){
   const formatted=tableToolResponse({...meta(doc),rows:results as any},input.query!,{...input,limit:rows.length||limit,offset:0}).structuredContent;
   const compactRows=(formatted.rows as any[]).map(r=>({...r,regulationName:doc.title,revisionDate:doc.st_date,sourceUrl:doc.source_url}));response={...response,...formatted,results:compactRows,rows:compactRows,totalMatches:total,offset,next_offset:offset+compactRows.length<total?offset+compactRows.length:null,has_more:offset+compactRows.length<total};
  }else if(tool==='get_regulation_text')response={...response,text:results.map(r=>r.snippet).join('\n\n')};
  else if(tool==='search_regulation_text')response={...response,matches:results.filter(r=>r.kind==='body'),table:{rows:results.filter(r=>r.kind==='table')},history:[]};
  if(input.include_history)response={...response,partial:true,errors:[{code:'historical_index_unavailable',message:'과거 첨부는 현재 카탈로그에 포함되지 않습니다.'}]};
  console.log('d1_tool_finished',JSON.stringify({tool,...metrics}));return envelope(response);
 }catch(error){console.error('d1_tool_failed',{tool,error:String(error)});return envelope({error:{code:'index_unavailable',message:'규정 색인을 조회할 수 없습니다.'},partial:true},true);}
}
