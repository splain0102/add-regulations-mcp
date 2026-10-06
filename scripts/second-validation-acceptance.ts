import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {listRegulations,getLatestRegulationText,getRegulationMetadata,searchLatestRegulationTable,extractArticleSnippet,extractDateFromFilename} from '../src/regulation-core/regulations';
import {normalizedText,normalizeTableSearch as norm} from '../src/regulation-core/general-table-search';
import {tableToolResponse} from '../src/regulation-core/table-response';

import {call} from './registered-handlers';
import {versionCheck} from '../src/regulation-core/table-layout';
const table=(name:string,query:string,extra:Record<string,unknown>={})=>call('search_regulation_table',{name,query,...extra});
const report:any={execution:'Actual registered MCP handlers and Zod defaults in Node; real ALIO downloads; no production OAuth call',tests:[]};
async function test(id:number,label:string,fn:()=>Promise<unknown>){const entry:any={id,label};try{entry.evidence=await fn();entry.status='passed';}catch(error){entry.status='failed';entry.error=String(error);}report.tests.push(entry);console.log('SECOND_ACCEPTANCE',id,entry.status,label,entry.error??'');}
const noSnake=(response:any)=>{const s=JSON.stringify(response);assert(!/"(?:row_span|col_span)"\s*:/.test(s));};
const queries=new Map<string,any>();
async function contract(){if(!queries.has('contract'))queries.set('contract',await table('위임전결규정','계약 승인'));return queries.get('contract');}

await test(1,'all seven public tools, delegation latest HWP 239154',async()=>{
 const hello=await call('hello');assert.equal(hello.structuredContent.version,'1.10.2');
 const list=await call('list_regulations');assert(JSON.stringify(list).includes('위임전결규정'));
 const search=await call('search_regulations',{query:'위임전결규정'});assert(JSON.stringify(search).includes('위임전결규정'));
 const meta=await call('get_regulation',{name:'위임전결규정'});assert.equal(meta.structuredContent.fileNo,'239154');
 for(const tool of ['get_regulation_text','search_regulation_text']){const r=await call(tool,{name:'위임전결규정',...(tool==='search_regulation_text'?{query:'국내 출장'}:{})});assert(JSON.stringify(r).includes('fileNo: 239154'));}
 const result=await contract();assert.equal(result.structuredContent.fileNo,'239154');return {tools:7,fileNo:'239154'};
});
await test(2,'metadata, body, text/table tools use organization HWP 209393',async()=>{
 const m=await call('get_regulation',{name:'직제규정'});assert.equal(m.structuredContent.fileNo,'209393');
 for(const tool of ['get_regulation_text','search_regulation_text']){const r=await call(tool,{name:'직제규정',...(tool==='search_regulation_text'?{query:'직종'}:{})});assert(JSON.stringify(r).includes('fileNo: 209393'));}
 const r=await table('직제규정','직종');queries.set('organization',r);assert.equal(r.structuredContent.fileNo,'209393');return {fileNo:'209393'};
});
await test(3,'domestic contract four stages and no carried-condition ghost',async()=>{
 const r=await contract(),rows=r.structuredContent.rows;assert.equal(rows.filter((x:any)=>norm(x.task??'').startsWith('5)')).length,4);
 const cases=[['50억 원 이상','부소장','★',null],['30억 원 이상','부장(센터장)','◎',null],['30억 원 미만','실장','◎','책임원'],['3천만 원 이하','운영','◎',null]];
 for(const [condition,approver,symbol,suffix]of cases){const row=rows.find((x:any)=>norm(x.task??'').startsWith('5)')&&norm(x.condition??'')===norm(condition!));assert(row,condition!);assert.equal(row.approver,approver);assert.equal(row.symbol,symbol);assert.equal(row.suffix,suffix);assert.equal(row.needs_review,false);}
 assert(!rows.some((x:any)=>norm(x.task??'').startsWith('5-2)')&&norm(x.condition??'')===norm('3천만 원 이하')));
 assert(rows.filter((x:any)=>x.table_id==='section1:table2').every((x:any)=>x.analysis_type==='delegation_table'));return cases;
});
await test(4,'foreign contract four stages',async()=>{const rows=(await contract()).structuredContent.rows.filter((x:any)=>norm(x.task??'').startsWith('5-2)'));assert.equal(rows.length,4);assert.deepEqual(rows.map((x:any)=>[x.approver,x.symbol,x.suffix]),[['부소장','★',null],['부장(센터장)','◎',null],['실장','◎','책임원'],['운영','◎',null]]);return rows;});
await test(5,'audit ownership and director approval',async()=>{const r=await table('위임전결규정','국정감사 중요사항'),row=r.structuredContent.rows[0];assert.equal(norm(row.category),norm('정책기획부(기획조정)'));assert.equal(row.task,'15) 국정감사');assert.equal(row.approver,'소장');return row;});
await test(6,'return report text approver',async()=>{const r=await table('위임전결규정','귀국보고'),row=r.structuredContent.rows.find((x:any)=>x.approver==='직상위자');assert(row);assert.equal(row.approver_type,'text');return row;});
await test(7,'sick leave single multi-approver result',async()=>{const r=await table('위임전결규정','병가');assert.equal(r.structuredContent.rows.length,1);assert.equal(r.structuredContent.rows[0].multi_approver,true);assert(r.structuredContent.rows[0].approvers.length>=2);return r.structuredContent.rows;});
await test(8,'cost calculation approval thresholds',async()=>{const r=await table('위임전결규정','계약원가계산 및 협약');for(const [condition,approver,suffix]of [['5억 원 이상','실장','책임원'],['5억 원 미만','운영',null]]){const row=r.structuredContent.rows.find((x:any)=>norm(x.condition??'')===norm(condition!));assert(row);assert.equal(row.approver,approver);assert.equal(row.suffix,suffix);}return r.structuredContent.rows;});
await test(9,'organization compact values <=3000 chars and detailed evidence',async()=>{
 const r=queries.get('organization'),size=JSON.stringify(r).length;assert(size<=3000,String(size));noSnake(r);assert(r.structuredContent.rows.some((x:any)=>x.values?.['직종']==='연구직'&&x.values?.['직명']==='연구원'));
 for(const row of r.structuredContent.rows)for(const key of ['cells','raw_cells','header_evidence','header_path','bounding_box','columns'])assert(!(key in row));
 const detailed=await table('직제규정','직종',{compact:false});noSnake(detailed);assert(detailed.structuredContent.rows[0].cells.length);assert(detailed.structuredContent.rows[0].raw_cells.length);assert(detailed.structuredContent.rows[0].header_evidence);return {size,detailedSize:JSON.stringify(detailed).length};
});
await test(10,'prototype rating values and spaced header',async()=>{const r=await table('시작품 업무방침','평가기준가격97%');const columns=Object.values(r.structuredContent.tables).flatMap((t:any)=>t.columns);assert(columns.some((c:any)=>c.name==='배점한도 대비 비율 (%)'),JSON.stringify(columns));assert(r.structuredContent.rows.some((x:any)=>Object.values(x.values??{}).includes('84')));for(const [input,expected]of [['직    종','직종'],['연 구 직','연구직'],['기 술 기 사 직','기술기사직'],['배점한도 대비 비율 (%)','배점한도 대비 비율 (%)'],['경영관리\n센터\n(재무)','경영관리 센터 (재무)']])assert.equal(normalizedText(input),expected);return {columns,rows:r.structuredContent.rows};});
await test(11,'nonexistent query produces empty rows without error',async()=>{const r=await table('위임전결규정','존재하지않는업무xyz');assert.deepEqual(r.structuredContent.rows,[]);return r.structuredContent;});
await test(12,'text search HWP file, compact table evidence and no PDF coordinates',async()=>{const r=await call('search_regulation_text',{name:'위임전결규정',query:'국내 출장'}),text=r.content[0].text;assert(text.includes('fileNo: 239154'));assert(text.includes('파일형식: hwp'));assert(!text.includes('pdf_point'));assert(text.includes('"compact":true'));assert(!text.includes('"raw_cells":'));noSnake(r);return {fileNo:'239154',compact:true};});
await test(13,'contract default compact <=15000 chars without duplicate detail keys',async()=>{const r=await contract(),size=JSON.stringify(r).length;assert(size<=15000,String(size));assert.equal(r.structuredContent.compact,true);noSnake(r);for(const row of r.structuredContent.rows)for(const key of ['cells','raw_cells','header_evidence','header_path','bounding_box','columns'])assert(!(key in row));return {size,rows:r.structuredContent.rows.length};});
await test(14,'committee selection states effective/filename evidence, not missing revision',async()=>{const r=await call('get_regulation',{name:'계약심의위원회 구성 및 운영방침'}),m=r.structuredContent;assert(Array.isArray(m.selection_reason));assert(!m.selection_reason.includes('body_revision_date_matches_alio'));assert(m.selection_reason.includes('body_effective_date_matches_alio'));assert(m.selection_reason.includes('attachment_filename_date_matches_alio'));return {selection_reason:m.selection_reason,version_check:m.version_check};});
await test(15,'historical attachment dates and actual organization revision evidence',async()=>{
 const revisionText='부칙 <규제929호, 2024. 12. 30.>\n이 규정은 2025년 1월 1일부터 시행한다.';
 assert.equal(versionCheck('2024-12-30','2024-12',revisionText).warning,null);
 assert(versionCheck('2024-12-30','2024-11',revisionText).warning);
 const m=(await call('get_regulation',{name:'직제규정'})).structuredContent;assert(m.selection_reason.includes('body_revision_date_matches_alio'));assert(m.other_attachments.every((f:any)=>f.detectedDate));
 assert.equal(m.other_attachments.find((f:any)=>f.name==='직제규정(21년 6월 개정).pdf')?.detectedDate,'2021-06');
 const prototype=(await call('get_regulation',{name:'시작품 업무방침'})).structuredContent;assert.equal(prototype.other_attachments.find((f:any)=>f.name==='시작품 업무방침(2024년도 2월 개정).hwp')?.detectedDate,'2024-02');
 for(const [input,expected]of [['2026년7월15일','2026-07-15'],['2024년도 12월','2024-12'],['21년 6월','2021-06'],['22년 5월 제정','2022-05'],['no date',null]])assert.equal(extractDateFromFilename(input!),expected);return {selection_reason:m.selection_reason,other_attachments:m.other_attachments};
});
report.passed=report.tests.every((t:any)=>t.status==='passed');writeFileSync('reports/second-validation-acceptance.json',JSON.stringify(report,null,2));console.log('SECOND_VALIDATION_RESULT',JSON.stringify({passed:report.passed,passedCount:report.tests.filter((t:any)=>t.status==='passed').length,total:15}));if(!report.passed)process.exitCode=1;
