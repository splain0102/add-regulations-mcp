import {normalizeName,queryTerms,normalize} from '../d1/normalize';
import {tableToolResponse} from '../regulation-core/table-response';
import {mightMatch} from './bloom';
import {unifiedSearch,type Unified} from './global-search';
import {amountOf,rangeOf,inRange} from './amount';
import {tokenWeights,sectionScore} from '../regulation-core/search-ranking';
import {PARSER_VERSION} from '../regulation-core/parser-version';
import {R2Reader} from './read';
import {ROOT,STATUS,type R2Catalog,type R2Head,type SearchRecord,type R2Document,type Input} from './types';
export const envelope=(data:any,isError=false)=>({...isError?{isError:true}:{},structuredContent:data,content:[{type:'text' as const,text:JSON.stringify(data)}]});
export function rowMatches(r:SearchRecord,q:ReturnType<typeof queryTerms>){
 if(r.kind==='body')return q.terms.every(t=>r.n!.includes(t));
 const m=r.match!;return q.terms.length===1?[...m.cells,...m.aliases].some(c=>c.includes(q.joined)):m.row.includes(q.joined)||q.terms.every(t=>m.row.includes(t))||m.paths.some(p=>q.terms.every(t=>p.includes(t)));
}
// Start a snippet at the line holding the match when it is near, else at a word
// boundary about 100 characters before it, never inside a word.
export function snippetStart(text:string,at:number){const line=text.lastIndexOf('\n',at-1)+1;if(at-line<=200)return line;const from=at-100,space=text.lastIndexOf(' ',from);return space>=0&&from-space<40?space+1:Math.max(0,text.indexOf(' ',from)+1||from);}
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
  const status=candidate?undefined:await reader.optional(STATUS).catch(()=>({status:'unknown'})),statusApplies=Date.parse(status?.started_at??status?.finished_at??'')>=Date.parse(catalog.verified_at),pending=statusApplies?status?.pending_titles??[]:[],pendingIds:string[]|undefined=statusApplies?status?.pending_ids:undefined,active=catalog.documents.filter(d=>d.status!=='repealed'),failed=statusApplies&&status?.status==='failed',verifiedAt=!fallback&&status?.check_type==='metadata'&&status.catalog_sha===head.catalog.sha256?status.last_list_verified_at:catalog.verified_at,stale=fallback||failed||catalog.parser_version!==PARSER_VERSION||Boolean(pending.length)||Date.now()-Date.parse(verifiedAt)>2*3600000;
  const health={storage:'r2',snapshot_id:(!fallback?head.catalog:head.previous!).sha256,index_status:stale?'stale':'ready',partial:stale,lastVerifiedAt:verifiedAt,last_attachment_verified_at:catalog.verified_at,lastCompletedAt:head.published_at,index_build_version:catalog.build_version,serving_build_version:build,totalRegulations:Math.max(active.length,statusApplies?status?.total??0:0),source_regulation_count:statusApplies?status?.total??active.length:active.length,indexedRegulations:active.length,repealedRegulations:catalog.documents.length-active.length,last_sync_status:statusApplies?status?.status??'unknown':'published',errors:{count:failed?1:0,sample:failed?[{code:status.error_code,checkedAt:status.finished_at,build_version:status.build_version}]:[],retry_cursor:null},...statusApplies&&status?.warnings?.length?{warnings:status.warnings}:{}};
  if(tool==='diagnose_alio_list')return envelope({...health,last_sync_started_at:status?.started_at,last_sync_finished_at:status?.finished_at,regulation_count:active.length,repealed_regulations:catalog.documents.filter(d=>d.status==='repealed').map(d=>({reg_id:d.regulation_id,title:d.title,repealed_at:d.repealed_at})),missing_from_source:active.filter(d=>d.missing_count>0).map(d=>({reg_id:d.regulation_id,title:d.title,missing_count:d.missing_count})),last_changes:status?.status==='published'&&Date.parse(status.finished_at??'')>=Date.parse(catalog.verified_at)?status.changes??null:null,pending_titles:pending,removed_titles:statusApplies?status?.removed_titles??[]:[],last_error:failed?status.message:null});
  // Identity is the ALIO idx (reg_id). Names resolve against current titles and
  // former titles (aliases); active regulations win over repealed ones.
  const aliasesOf=(d:R2Document)=>(d.aliases??[]) as string[];
  const nameMatches=(docs:R2Document[],name:string)=>{const n=normalizeName(name),all=docs.filter(d=>d.title_normalized.includes(n)||aliasesOf(d).some(a=>normalizeName(a).includes(n))),exact=all.filter(d=>d.title===name),normal=all.filter(d=>d.title_normalized===n),alias=all.filter(d=>aliasesOf(d).some(a=>a===name||normalizeName(a)===n));return exact.length?exact:normal.length?normal:alias.length?alias:all;};
  let doc:R2Document|undefined,matchedAlias:string|undefined;
  if(input.reg_id&&tool!=='list_regulations'&&tool!=='search_regulations'&&tool!=='search_all_regulations'){doc=catalog.documents.find(d=>d.regulation_id===input.reg_id);if(!doc)return envelope({...health,error:{code:'not_found',reg_id:input.reg_id}},true);}
  else if(input.name){const n=normalizeName(input.name),activeHits=nameMatches(active,input.name),candidates=activeHits.length?activeHits:nameMatches(catalog.documents.filter(d=>d.status==='repealed'),input.name);if(candidates.length!==1)return envelope({...health,error:{code:candidates.length?'ambiguous_name':pending.some((t:string)=>normalizeName(t).includes(n))?'index_preparing':'not_found',...candidates.length?{message:'같은 이름의 규정이 여러 개입니다. reg_id로 지정하세요.'}:{},candidates:candidates.map(d=>({title:d.title,reg_id:d.regulation_id,revisionDate:d.st_date,status:d.status??'active',aliases:aliasesOf(d)}))}},true);doc=candidates[0];if(doc.title!==input.name&&doc.title_normalized!==n)matchedAlias=aliasesOf(doc).find(a=>normalizeName(a).includes(n));}
  const compactOn=input.compact!==false,healthBrief=stale?{index_status:'stale',partial:true}:{};
  const meta=(d:R2Document,withHealth=true)=>({regulationName:d.title,reg_id:d.regulation_id,status:d.status??'active',aliases:aliasesOf(d),...d===doc&&matchedAlias?{matched_alias:matchedAlias}:{},first_seen:d.first_seen??null,last_seen:d.last_seen??null,missing_count:d.missing_count??0,repealed_at:d.repealed_at??null,revisionDate:d.st_date,updatedDate:d.i_date,fileNo:d.file_no,filename:d.filename,extension:d.extension,sourceUrl:d.source_url,sha256:d.sha256,parser_version:d.parser_version,version_check:JSON.parse(d.validation_json),version_warning:d.cross_entry_warnings?.find((w:any)=>w.code==='cross_entry_newer_attachment')??JSON.parse(d.validation_json).warning,selection_evidence:JSON.parse(d.selection_evidence_json),selection_reason:d.selection_reason??[],other_attachments:d.other_attachments??[],cross_entry_warnings:d.cross_entry_warnings??[],...withHealth?health:healthBrief,...d.status==='repealed'?{source_latest_status:'repealed'}:(pendingIds?pendingIds.includes(d.regulation_id):pending.includes(d.title))?{partial:true,index_status:'stale',source_latest_status:status?.removed_titles?.includes(d.title)?'removed_from_source_pending':'update_pending'}:d.missing_count>0?{source_latest_status:'missing_from_source',source_warning:{code:'missing_from_source_once',message:'최근 ALIO 목록에서 확인되지 않았습니다. 다음 동기화에서도 없으면 폐지로 표시됩니다.'}}:{source_latest_status:failed?'verification_failed':stale?'verification_stale':'verified'}});
  // compact (default): identification, version warnings and results only. Index
  // and build state live in hello/diagnose_alio_list unless the index is stale.
  const brief=(d:R2Document)=>{const full=meta(d,false);return {regulationName:d.title,reg_id:d.regulation_id,revisionDate:d.st_date,fileNo:d.file_no,sourceUrl:d.source_url,...full.version_warning?{version_warning:full.version_warning}:{},...full.cross_entry_warnings.length?{cross_entry_warnings:full.cross_entry_warnings}:{},...d.status==='repealed'?{status:'repealed',repealed_at:d.repealed_at}:{},...(full as any).source_warning?{source_warning:(full as any).source_warning}:{},...d===doc&&matchedAlias?{matched_alias:matchedAlias}:{},...healthBrief};};
  if(tool==='get_regulation')return envelope(meta(doc!,!compactOn));
  if(tool==='list_regulations'||tool==='search_regulations'){const n=normalizeName(input.query??''),all=(input.include_repealed?catalog.documents:active).filter(d=>d.title_normalized.includes(n)||aliasesOf(d).some(a=>normalizeName(a).includes(n))),items=all.slice(offset,offset+limit);
   // A name search that finds nothing returns the best body articles instead of an
   // empty list, so a topic word ("모험연수") needs no second call.
   let suggestions:any[]|undefined;if(tool==='search_regulations'&&!all.length&&q){const bodies:any[]=[];for(let i=0;i<catalog.body_shards.length;i+=4)for(const part of await Promise.all(catalog.body_shards.slice(i,i+4).map(ref=>reader.ref(ref))))bodies.push(...part);suggestions=unifiedSearch(bodies,input.query!,3).results.slice(0,3).map(r=>({regulationName:r.regulationName,reg_id:r.reg_id,fileNo:r.fileNo,revisionDate:r.revisionDate,sourceUrl:r.sourceUrl,match_type:r.match_type,label:r.matches[0].label,...r.matches[0].paragraph?{paragraph:r.matches[0].paragraph}:{},snippet:r.matches[0].snippet.slice(0,300)}));}
   return envelope({...compactOn?healthBrief:health,...suggestions?{body_suggestions:suggestions}:{},results:items.map(d=>compactOn?{...brief(d),updatedDate:d.i_date,...aliasesOf(d).length?{aliases:aliasesOf(d)}:{}}:meta(d)),totalMatches:all.length,limit,offset,next_offset:offset+items.length<all.length?offset+items.length:null});}
  async function summaries(d:R2Document){const rows:SearchRecord[]=[];for(let i=0;i<d.search.length;i+=4)for(const part of await Promise.all(d.search.slice(i,i+4).map(ref=>reader.ref(ref))))rows.push(...part);return rows;}
  const page=(all:any[],size=limit)=>({totalMatches:all.length,limit,offset,has_more:offset+size<all.length,next_offset:offset+size<all.length?offset+size:null,next_cursor:offset+size<all.length?offset+size:null});
  if(tool==='search_all_regulations'){
   const bodies:any[]=[];const bodyShards=[...catalog.body_shards,...input.include_repealed?catalog.repealed_body_shards??[]:[]],byFile=new Map(catalog.documents.map(d=>[d.file_no,d]));if(input.scope!=='table')for(let i=0;i<bodyShards.length;i+=4)for(const part of await Promise.all(bodyShards.slice(i,i+4).map(ref=>reader.ref(ref))))bodies.push(...part);// Unified search: full matches, per-term coverage and citation links in one call.
   const unified:Unified=unifiedSearch(bodies,input.query!,limit),withDoc=(r:any)=>{const d=byFile.get(r.fileNo);return {...r,reg_id:d?.regulation_id??r.reg_id,...d?.status==='repealed'?{status:'repealed'}:{},indexedAt:d?.verified_at??catalog.verified_at};};
   let all=unified.results.map(withDoc);const related=unified.related.map(withDoc);bodies.length=0;
   // Preserve existing body ranking, then include table matches by default.
   // Explicit body scope excludes tables. Search precomputed row summaries; no document parser.
   if(!input.scope||input.scope==='table'||input.scope==='all'){
    // Table rows use the same resolved terms (intent words such as 승인권자 removed,
    // compounds stemmed); delegation rows rank first for approver questions.
    // Approver questions compare amounts as ranges: "기술용역 10억" matches the
    // 기술용역 row whose condition covers 10억 ("용역비 5억 초과"), not any row that
    // merely contains the text "10억" under another task.
    const nameQuery=normalizeName(unified.coverage.terms.join('')),approver=unified.intent==='approver',amounts=approver?unified.coverage.terms.map(amountOf).filter((v):v is number=>v!==null):[];
    const terms=amounts.length&&unified.coverage.terms.some(t=>amountOf(t)===null)?unified.coverage.terms.filter(t=>amountOf(t)===null):unified.coverage.terms,amount=terms.length<unified.coverage.terms.length?amounts[0]:null;
    const rangeScore=(r:any,text:string)=>{if(amount===null||!r.approver)return {};const range=rangeOf(r.condition??text);return range?{amount_match:inRange(amount,range)}:{};};
    const scan=async(t:string[])=>{const tq=queryTerms(t.join(' ')),grouped=new Map<string,{count:number;score:number;matches:any[]}>(),refs=[...catalog.table_shards,...input.include_repealed?catalog.repealed_table_shards??[]:[]].filter(ref=>mightMatch(ref.bloom,tq.terms));
     for(let i=0;i<refs.length;i+=4)for(const part of await Promise.all(refs.slice(i,i+4).map(ref=>reader.ref(ref))))for(const r of part){if(!input.include_text_box&&r.analysis_type==='text_box'||!rowMatches({...r,kind:'table'},tq))continue;const text=r.text||r.match.row,weights=t.map(x=>/\d/.test(x)?(normalize(text).includes(normalize(x))?1:0):tokenWeights(text,[x])[0]),range=rangeScore(r,text),score=(weights.every(w=>w>0)?0.5*sectionScore(text,'',t.join(' '),weights):0.05)+(approver&&r.analysis_type==='delegation_table'&&r.approver?40:0)+(range.amount_match===true?60:range.amount_match===false?-35:0),g=grouped.get(r.document_id)??{count:0,score:0,matches:[]};g.count++;g.score=Math.max(g.score,score);g.matches.push({label:r.label,snippet:text.slice(0,850),score,kind:'table',...r.approver?{task:r.task??null,condition:r.condition??null,approver:r.approver,...range}:{}});grouped.set(r.document_id,g);}
     return grouped;};
    let grouped=await scan(terms);
    // Approver questions with no delegation row retry once with a long compound's
    // head noun ("기술용역 10억 승인권자" → 용역 10억). Other questions do not, so
    // they read no extra table shards.
    const delegationFound=[...grouped.values()].some(g=>g.matches.some((m:any)=>m.approver));
    if(approver&&!delegationFound&&(terms.length>1||amount!==null)){const long=terms.findIndex(t=>!/\d/.test(t)&&Array.from(t).length>=4);if(long>=0){const head=Array.from(terms[long]).slice(-2).join(''),relaxed=await scan(terms.map((t,i)=>i===long?head:t));if(relaxed.size){unified.coverage.resolved[terms[long]]=head;for(const [id,g] of relaxed){const old=grouped.get(id);grouped.set(id,old?{count:old.count+g.count,score:Math.max(old.score,g.score),matches:[...old.matches,...g.matches]}:g);}}}}
    const tables=catalog.documents.filter(d=>grouped.has(d.document_id)).map(d=>({regulationName:d.title,reg_id:d.regulation_id,...d.status==='repealed'?{status:'repealed'}:{},fileNo:d.file_no,revisionDate:d.st_date,sourceUrl:d.source_url,score:Math.round((grouped.get(d.document_id)!.score+(nameQuery.length>=2&&d.title_normalized.includes(nameQuery)?30:0))*100)/100,match_type:'table',matches:grouped.get(d.document_id)!.matches.sort((a:any,b:any)=>b.score-a.score).slice(0,3),tableMatches:grouped.get(d.document_id)!.count}));
    // A regulation found both in body text and in tables keeps one entry; the
    // stronger side's matches come first so a delegation row is not hidden by a
    // weak body hit of the same regulation.
    if(input.scope!=='table')all=all.map(a=>{const t=tables.find(x=>x.fileNo===a.fileNo);return t?{...a,score:Math.max(a.score,t.score),matches:t.score>a.score?[...t.matches,...a.matches]:[...a.matches,...t.matches],tableMatches:t.tableMatches}:a;});
    all=(input.scope==='table'?tables:[...all,...tables.filter(t=>!all.some(a=>a.fileNo===t.fileNo))]).sort((a,b)=>b.score-a.score||a.regulationName.localeCompare(b.regulationName,'ko'));
   }
   if(input.scope==='pdf'){const pdf=new Set(catalog.documents.filter(d=>d.extension==='pdf').map(d=>d.file_no));all=all.filter(d=>pdf.has(d.fileNo));}
   const metrics={elapsed_ms:Date.now()-start,r2_reads:reader.requests-r0,r2_bytes:reader.bytes_read-b0,alio_requests:0,document_parses:0};
   // Identical scores across several results mean the ranking formula broke down.
   if(all.length>1&&new Set(all.map(r=>r.score)).size===1)console.warn('search_score_degenerate',JSON.stringify({query:input.query,results:all.length,score:all[0].score}));
   console.log('r2_search_metrics',JSON.stringify({tool,...metrics}));
   return envelope({...compactOn?healthBrief:health,...page(all),query:input.query,results:all.slice(offset,offset+limit).map(r=>compactOn?{regulationName:r.regulationName,reg_id:r.reg_id,...r.status?{status:r.status}:{},fileNo:r.fileNo,revisionDate:r.revisionDate,sourceUrl:r.sourceUrl,score:r.score,...r.match_type?{match_type:r.match_type}:{},...r.matched_terms?{matched_terms:r.matched_terms}:{},...r.missing_terms?{missing_terms:r.missing_terms}:{},...r.title_terms?{title_terms:r.title_terms}:{},matches:r.matches,...r.tableMatches?{tableMatches:r.tableMatches}:{}}:r),...offset===0&&related.length?{related}:{},coverage:unified.coverage,...unified.intent?{intent:unified.intent}:{},...compactOn?{}:{metrics}});
  }
  if(!doc)return envelope({error:{code:'invalid_name'}},true);
  const all=(await summaries(doc)).filter(r=>{if(input.scope==='pdf'&&doc!.extension!=='pdf')return false;const wanted=tool==='get_regulation_text'?r.kind==='body':tool==='search_regulation_table'?r.kind==='table':input.scope==='body'?r.kind==='body':input.scope==='table'?r.kind==='table':true;return wanted&&(r.kind!=='table'||input.include_text_box||r.analysis_type!=='text_box')&&(!q||rowMatches(r,q));});
  // group_by='task' widens each matched delegation row to every row of its task.
  let rowsInScope=all;
  if(tool==='search_regulation_table'&&input.group_by==='task'){const groups=new Set(all.map(r=>r.group).filter(Boolean)),seen=new Set(all.map(r=>r.id));rowsInScope=(await summaries(doc)).filter(r=>r.kind==='table'&&(seen.has(r.id)||r.group&&groups.has(r.group))&&(input.include_text_box||r.analysis_type!=='text_box'));}
  const selected=rowsInScope.slice(offset,offset+Math.min(100,limit)),results:any[]=[];
  for(const r of selected){const value=(await reader.ref(r.evidence))[r.evidence_index];if(!value)throw Error('missing_evidence');if(r.kind==='body'){const text=String(value.text),at=q?originalOffset(text,Math.max(0,r.n!.indexOf(q.terms[0]))):0,from=q?snippetStart(text,at):0,size=compactOn?1200:20000;results.push({...compactOn?{}:{regulationName:doc.title,revisionDate:doc.st_date,fileNo:doc.file_no,sourceUrl:doc.source_url},kind:'body',label:r.label,snippet:text.slice(from,from+size),snippet_truncated:from>0||text.length>from+size});}else results.push({...value.result,...compactOn?{}:{regulationName:doc.title,revisionDate:doc.st_date,fileNo:doc.file_no,sourceUrl:doc.source_url},kind:'table',label:r.label});}
  const metrics={elapsed_ms:Date.now()-start,r2_reads:reader.requests-r0,r2_bytes:reader.bytes_read-b0,alio_requests:0,document_parses:0};console.log('r2_search_metrics',JSON.stringify({tool,...metrics}));
  let data:any={...compactOn?brief(doc):meta(doc),...page(rowsInScope,results.length),query:input.query,results,...compactOn?{}:{metrics}};
  if(tool==='search_regulation_table'){const formatted=tableToolResponse({...meta(doc),rows:results},input.query!,{...input,offset:0,limit:results.length||limit}).structuredContent,rows=formatted.rows as any[];
   const groups=input.group_by==='task'?[...rows.reduce((m:Map<string,any>,r:any)=>{const k=r.table_id+'\0'+(r.task??'');const g=m.get(k)??{table_id:r.table_id,category:r.category??null,task:r.task??null,rows:[] as number[]};g.rows.push(r.row);return m.set(k,g);},new Map()).values()]:undefined;
   data=compactOn?{...data,...page(rowsInScope,rows.length),results:rows,...groups?{groups}:{},...formatted.truncated?{truncated:true}:{},...formatted.layout_error?{layout_error:formatted.layout_error}:{}}:{...data,...formatted,...page(rowsInScope,rows.length),results:rows,rows,...groups?{groups}:{}};}
  else{if(compactOn)for(let i=0;i<results.length;i++)if(results[i].kind==='table'){const r=results[i];results[i]={...(tableToolResponse({rows:[r]},input.query!,{compact:true,limit:1}).structuredContent.rows as any[])[0],kind:'table',label:r.label};}
   // get_regulation_text returns the text once, in results; format='full' adds the joined text.
   if(tool==='get_regulation_text'&&(input.format==='full'||!compactOn))data.text=results.map(r=>r.snippet).join('\n\n');
   if(tool==='search_regulation_text'&&!compactOn)Object.assign(data,{matches:results.filter(r=>r.kind==='body'),table:{rows:results.filter(r=>r.kind==='table')},history:[]});}
  if(input.include_history)Object.assign(data,{partial:true,errors:[{code:'historical_index_unavailable',message:'과거 첨부는 최신 검색 근거에 포함하지 않습니다.'}]});
  return envelope(data);
 }catch(error){console.error('r2_tool_failed',{tool,error:String(error)});return envelope({error:{code:String(error).includes('r2_missing_object:'+ROOT)?'index_preparing':'index_unavailable',message:'검증된 R2 색인을 준비하거나 복구하고 있습니다.'},partial:true},true);}
}
