import assert from 'node:assert/strict';
import {r2Store} from '../d1/remote';
import {R2Reader} from '../../src/r2/read';
import {runR2Tool,rowMatches} from '../../src/r2/tools';
import {queryTerms,normalizeName} from '../../src/d1/normalize';
import {ROOT} from '../../src/r2/types';
const store=r2Store(),reader=new R2Reader({get:async key=>{try{const b=await store('GET',key);return {size:b.length,arrayBuffer:async()=>b.buffer.slice(b.byteOffset,b.byteOffset+b.length) as ArrayBuffer};}catch(e){if(String(e).includes('HTTP 404'))return null;throw e;}}});
const report:any={passed:false,scope:'Actual private R2 data; Node serving handlers, not production Worker CPU',cases:[]};
async function call(tool:string,input:any={}){const t=performance.now(),r:any=await runR2Tool(reader,tool,input);report.cases.push({tool,input,elapsed_ms:performance.now()-t,isError:!!r.isError,totalMatches:r.structuredContent?.totalMatches,partial:r.structuredContent?.partial});return r;}
try{
 const head=await reader.read(ROOT),catalog=await reader.ref(head.catalog);assert.equal(head.count,catalog.documents.length);assert(head.count>=200);report.snapshot=head.catalog.sha256;report.count=head.count;report.index_build_version=catalog.build_version;
 for(const name of ['기술용역 업무규정','여비규정','위임전결규정','감사규정']){const r=await call('get_regulation',{name});assert(!r.isError&&r.structuredContent.fileNo);assert(!r.structuredContent.partial,JSON.stringify(r.structuredContent));}
 for(const name of ['기술용역 업무규정','여비규정','위임전결규정']){
  const d=catalog.documents.find((d:any)=>d.title===name)!;const s=JSON.parse(new TextDecoder().decode(await store('GET',d.snapshot_r2_key)));
  for(const query of ['식비','비고','제10조','전문가','내부승인','300만 원','계약 승인']){
   const expected=s.records.rows.filter((r:any)=>r.analysis_type!=='text_box'&&rowMatches({kind:'table',match:r.match} as any,queryTerms(query))).length;
   const r=await call('search_regulation_table',{name,query,limit:100,compact:false});assert(!r.isError);assert.equal(r.structuredContent.totalMatches,expected,name+'/'+query);
   for(const row of r.structuredContent.rows){const original=s.records.rows.find((r:any)=>r.result.table_id===row.table_id&&r.result.row===row.row)?.result;assert(original);assert.deepEqual(row.approvers,original.approvers);assert.equal(row.symbol,original.symbol);}
  }
 }
 const foreign:any=await call('search_all_regulations',{query:'외국인',limit:10});assert(!foreign.isError&&!foreign.structuredContent.partial);assert(foreign.structuredContent.results.some((r:any)=>r.regulationName.endsWith('보안과제 관리요령')&&r.matches.some((m:any)=>m.label.includes('제8조'))));assert(!foreign.structuredContent.results.some((r:any)=>r.regulationName==='여비규정'&&r.matches.some((m:any)=>m.label.includes('제21조'))));report.foreigner=foreign.structuredContent.results.map((r:any)=>({name:r.regulationName,labels:r.matches.map((m:any)=>m.label)}));
 const accident:any=await call('search_all_regulations',{query:'사고 보고',limit:5});assert(!accident.isError&&!accident.structuredContent.partial);assert(!accident.structuredContent.results.some((r:any)=>normalizeName(r.regulationName).includes(normalizeName('보고서 작성 및 관리요령'))));report.accident=accident.structuredContent.results.map((r:any)=>({name:r.regulationName,labels:r.matches.map((m:any)=>m.label)}));
 const ambiguous=await call('get_regulation',{name:'직제'});assert.equal(ambiguous.structuredContent.error?.code,'ambiguous_name');
 const missing=await call('get_regulation',{name:'보안업무규정'});assert.equal(missing.structuredContent.error?.code,'not_found');
 const names=await call('search_regulations',{query:'민·군',limit:100});assert(!names.isError&&names.structuredContent.totalMatches>=7);report.military_names=names.structuredContent.totalMatches;
 const body=await call('search_regulation_text',{name:'위임전결규정',query:'전문가활용'});assert(!body.isError);const full=await call('get_regulation_text',{name:'위임전결규정'});assert(!full.isError&&full.structuredContent.text);
 const status=await call('diagnose_alio_list');assert(!status.isError&&status.structuredContent.indexedRegulations>=200);
 report.passed=true;report.r2_reads=reader.requests;report.r2_bytes=reader.bytes_read;
}catch(e){report.error=String(e);process.exitCode=1;}finally{console.log('R2_REMOTE_ACCEPTANCE',JSON.stringify(report));}
