/* eslint-disable @typescript-eslint/no-explicit-any -- Assertions inspect heterogeneous MCP JSON and preserve it as evidence. */
import assert from 'node:assert/strict';
import {writeFileSync,readFileSync} from 'node:fs';
import {searchLatestRegulationTable} from '../src/regulation-core/regulations';
import {fetchWithRetry} from '../src/regulation-core/regulations';
import {extractHwpTables, type Cell} from '../src/regulation-core/table-layout';
import {extractPdfRichContent,searchPdfLayoutRows,buildPdfStructuredMatches,detectKnownPdfHeader} from '../src/regulation-core/pdf-regression-layout';
const path=process.env.REGULATION_TEST_REPORT??'reports/cloudflare-core-regression.json';
const report:any={head:'f8126642daa3aeea7bbe40b42f06440993b04688',execution:'Cloudflare shared regulation core in Node; actual ALIO downloads. Not a deployed Cloudflare MCP call.',startedAt:new Date().toISOString(),tests:[],publishRequested:false,publishReady:false};
const compact=(value:string)=>value.normalize('NFKC').replace(/\s+/g,'');
const pendingSources=new Map<string,Promise<ReturnType<typeof extractHwpTables>>>();
const sourceTables=new Map<string,ReturnType<typeof extractHwpTables>>();
async function call(name:string,query:string){return searchLatestRegulationTable(name,query);}
async function original(fileNo:string){
 if(sourceTables.has(fileNo))return sourceTables.get(fileNo)!;
 let promise=pendingSources.get(fileNo);
 if(!promise){promise=(async()=>{const response=await fetchWithRetry('https://www.alio.go.kr/download/rulefiledown.json?fileNo='+fileNo);assert(response.ok);const tables=extractHwpTables(new Uint8Array(await response.arrayBuffer()));sourceTables.set(fileNo,tables);return tables;})();pendingSources.set(fileNo,promise);}
 return promise;
}

async function check(name:string,query:string,extra?:(r:any)=>void){
 const entry:any={name,query,status:'failed',structureAccurate:false};
 try{const r=await call(name,query);entry.result=r;assert(r.rows.length>0,'No matching table row');
  const tables=await original(r.fileNo);
  for(const row of r.rows){assert.equal(row.coordinate_type,'logical_cell');const table=tables.find(t=>t.id===row.table_id);assert(table,'table ID differs from original');
   for(const cell of row.cells){const source:Cell|undefined=table!.cells.find(c=>c.row===cell.row&&c.col===cell.col);assert(source);for(const key of ['row','col','rowSpan','colSpan','text'])assert.equal(cell[key],(source as any)[key],`source cell ${key} mismatch`);}
   const active=table!.cells.filter(c=>c.row<=row.row&&row.row<c.row+c.rowSpan);assert.equal(row.cells.length,active.length,'merged active cells lost');
   for(const band of row.header_evidence.rows)for(const cell of band.cells){assert(table!.cells.some(c=>c.row===cell.row&&c.col===cell.col&&c.text===cell.text&&c.rowSpan===cell.rowSpan&&c.colSpan===cell.colSpan),'header evidence differs');}
   if(name!=='위임전결규정'){assert.equal(row.analysis_type,'general_table');assert.equal(row.approver,undefined,'general table forced into approver mapping');}
  }
  extra?.(r);entry.status='passed';entry.structureAccurate=true;entry.needs_review=[...new Set(r.rows.map((row:any)=>row.needs_review))];
 }catch(e){entry.error=String(e);}report.tests.push(entry);writeFileSync(path,JSON.stringify(report,null,2));console.log(JSON.stringify({name,query,status:entry.status,error:entry.error,matches:entry.result?.rows?.length,fileNo:entry.result?.fileNo}));
}
await check('위임전결규정','30억원 미만',r=>{const row=r.rows.find((row:any)=>compact(row.task??'').includes('계약및협약승인'));assert(row,'contract approval task lost');assert.equal(row.condition,'30억 원 미만');assert.equal(row.symbol,'◎');assert.equal(row.approver,'실장');assert.equal(row.suffix,'책임원');assert.equal(row.needs_review,false);assert.equal(row.header_evidence.columns.length,7);report.actualHwpHeaders=row.header_evidence.columns;});
await Promise.all(['연구용역','군지원 기술용역','군수용 기술용역','민수용 기술용역','민군기술협력 담당부서','사업관리부서 예산관리부서'].map(q=>check('기술용역 업무규정',q,r=>{
const flat=compact(JSON.stringify(r.rows));assert(flat.includes('사업구분')&&flat.includes('사업관리부서')&&flat.includes('예산관리부서'),'business table headers lost');
})));
await Promise.all(['소내망','국방망','통제(R) 원문'].map(q=>check('보고서 작성 및 관리요령',q,r=>{const flat=compact(JSON.stringify(r.rows));for(const header of ['구분','관리등급','통제(R)','가(A)','나(B)','다(C)','원문','서지','공개대상'])assert(flat.includes(header),'missing multi-level header '+header);if(q==='소내망')assert(flat.includes('⊙'));})));
await check('연구시설·장비의 관리 등에 관한 요령','장비명 제작사 모델명',r=>{const flat=compact(JSON.stringify(r.rows));for(const h of ['순번','장비명','제작사','모델명','취득연도','취득금액','보유기관명','지역중복여부','공동활용여부','장비등록번호','자체검토의견'])assert(flat.includes(h),'missing equipment header '+h);});
await check('연구시설·장비의 관리 등에 관한 요령','기존 장비명 처분계획');
await Promise.all(['상호 구분','제 1 차','제 3 차','낙찰금액'].map(q=>check('계약요령',q)));
const pdfEntry:any={name:'위임전결규정 PDF fileNo166852',query:'30억원 미만',status:'failed'};
try{const pdf=await extractPdfRichContent(new Uint8Array(await (await fetchWithRetry('https://www.alio.go.kr/download/rulefiledown.json?fileNo=166852')).arrayBuffer()));const page=pdf.pages.find(p=>p.page===34)!;const matches=searchPdfLayoutRows([page],'30억원 미만',100).flatMap(({page,row})=>buildPdfStructuredMatches(page,row));const row=matches.find(r=>compact(r.task??'').includes('계약및협약승인')&&r.condition==='30억 원 미만')!;assert(row);assert.equal(row.symbol,'◎');assert.equal(row.suffix,'책임원');assert.equal(row.approver,'실장');assert.equal(row.needsReview,false);assert.equal(row.coordinate?.precision,'raw-item-exact');for(const [key,value] of Object.entries({x0:545.04,x1:554.04,xCenter:549.54,y:279.96}))assert(Math.abs((row.coordinate as any)[key]-value)<0.00001,key+' coordinate mismatch');assert.deepEqual(detectKnownPdfHeader(page.rows)?.order,['사책/과책','운영','실장']);pdfEntry.status='passed';pdfEntry.structureAccurate=true;pdfEntry.needs_review=[row.needsReview];pdfEntry.result=row;}catch(e){pdfEntry.error=String(e);}report.tests.push(pdfEntry);
report.requestedHwpHeaders=['사책/과책','운영','실장','부(센터)장','원장/기술센터장','부소장','소장'];report.hwpHeaderNamesMatchRequest=JSON.stringify(report.actualHwpHeaders?.map((h:any)=>h.name))===JSON.stringify(report.requestedHwpHeaders);
report.localPassed=report.tests.every((t:any)=>t.status==='passed');report.cloudflareDeployment='not_performed: Cloudflare credentials unavailable';report.finishedAt=new Date().toISOString();writeFileSync(path,JSON.stringify(report,null,2));console.log(JSON.stringify({localPassed:report.localPassed,publishReady:report.publishReady,pdf:pdfEntry.status,pdfError:pdfEntry.error,actualHwpHeaders:report.actualHwpHeaders},null,2));

if(!report.localPassed) process.exitCode=1;
