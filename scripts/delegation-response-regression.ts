import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {hwpToText} from '@ssabrojs/hwpxjs/browser';
import {extractHwpTables,structureTables,type Table} from '../src/regulation-core/table-layout';
import {searchGeneralTables,normalizeTableSearch as norm} from '../src/regulation-core/general-table-search';
import {tableToolResponse} from '../src/regulation-core/table-response';
import {fetchWithRetry,searchLatestRegulationTable} from '../src/regulation-core/regulations';
const bytes=process.env.DELEGATION_HWP_PATH?new Uint8Array(readFileSync(process.env.DELEGATION_HWP_PATH)):new Uint8Array(await(await fetchWithRetry('https://www.alio.go.kr/download/rulefiledown.json?fileNo=239154')).arrayBuffer());
const tables=extractHwpTables(bytes),structured=structureTables(tables,await hwpToText(bytes));
const find=(q:string)=>searchGeneralTables(tables,q,structured,'hwp');
const rows=find('계약 승인');
const contract=rows.filter(r=>norm(String(r.task))===norm('5) 계약 및 협약 승인'));
const foreign=rows.filter(r=>norm(String(r.task))===norm('5-2) 외화 계약 승인'));
assert.equal(contract.length,4);assert.equal(foreign.length,4);
assert(!rows.some(r=>norm(String(r.task)).includes('외화')&&norm(String(r.condition))===norm('3천만 원 이하')));
assert.equal(rows.filter(r=>r.table_id==='section1:table2').every(r=>r.analysis_type==='delegation_table'),true);
const verify=(source:typeof rows,cases:[string,string,string,string|null][])=>cases.forEach(([condition,approver,symbol,suffix])=>{
 const row=source.find(r=>norm(String(r.condition))===norm(condition));assert(row,condition);
 assert.equal(row.approver,approver);assert.equal(row.symbol,symbol);assert.equal(row.suffix,suffix);assert.equal(row.needs_review,false);assert.equal(row.confidence,0.98);
 if(symbol==='★')assert.equal(row.legend,'부설기구의 경우 부설기구장이 전결');
});
verify(contract,[['50억 원 이상','부소장','★',null],['30억 원 이상','부장(센터장)','◎',null],['30억 원 미만','실장','◎','책임원'],['3천만 원 이하','운영','◎',null]]);
verify(foreign,[['미화 500만달러 이상','부소장','★',null],['미화 300만달러 이상','부장(센터장)','◎',null],['미화 300만달러 미만','실장','◎','책임원'],['미화 2만5천달러 미만','운영','◎',null]]);
const audit=find('국정감사 중요사항');assert.equal(audit.length,1);assert.equal(norm(String(audit[0].category)),norm('정책기획부(기획조정)'));assert.equal(audit[0].task,'15) 국정감사');verify(audit,[['중요사항','소장','◎',null]]);
const cost=find('계약원가계산');verify(cost,[['5억 원 이상','실장','◎','책임원']]);assert(norm(String(cost[0].task)).includes(norm('10) 계약원가계산 및 협약 연구개발비 검토 승인')));
const liveResult=process.env.DELEGATION_HWP_PATH?{rows}:await searchLatestRegulationTable('위임전결규정','계약 승인');
assert.deepEqual(liveResult.rows.map(r=>[r.table_id,r.row,r.task,r.condition,r.approver,r.symbol,r.suffix,r.legend,r.confidence]),rows.map(r=>[r.table_id,r.row,r.task,r.condition,r.approver,r.symbol,r.suffix,r.legend,r.confidence]));
const compact=tableToolResponse(liveResult,'계약 승인');assert(JSON.stringify(compact).length<=15000);assert('tables' in compact.structuredContent);
const detailed=tableToolResponse(liveResult,'계약 승인',{compact:false});assert(JSON.stringify(detailed).length<=50000);
assert((detailed.structuredContent.rows as any[])[0].cells.length>0);
for(const row of detailed.structuredContent.rows as any[]){assert('header_evidence' in row);assert('raw_cells' in row);for(const c of row.cells){assert(c.text.trim());assert('header_path' in c);assert(!('row_span' in c));assert(!('col_span' in c));}}
for(const r of compact.structuredContent.rows as any[]){const prior=rows.find(p=>p.row===r.row&&p.table_id===r.table_id&&p.symbol===r.symbol)!;for(const k of ['approver','symbol','suffix','legend','confidence'])assert.equal(r[k],prior[k]??null);}
const syntheticRows=Array.from({length:200},(_,i)=>({...rows[0],row:i,task:'긴 업무 '.repeat(30),condition:String(i)}));
let offset=0;const seen:number[]=[];do{const page=tableToolResponse({rows:syntheticRows},'paging',{offset,limit:100});assert(JSON.stringify(page).length<=50000);seen.push(...(page.structuredContent.rows as any[]).map(r=>r.row));if(!page.structuredContent.has_more)break;const next=Number(page.structuredContent.next_offset);assert(next>offset);offset=next;}while(true);assert.deepEqual(seen,Array.from({length:200},(_,i)=>i));
// Explicit missing-symbol fixture: preserve delegation classification and require review.
const source=tables.find(t=>t.id==='section1:table2')!;
const missing:Table={...source,cells:source.cells.map(c=>c.row===406&&c.col===13?{...c,text:''}:c)};
const noSymbol=searchGeneralTables([missing],'3천만 원 이하',structureTables([missing],await hwpToText(bytes)),'hwp').filter(r=>r.row===406);assert.equal(noSymbol.length,1);assert.equal(noSymbol[0].analysis_type,'delegation_table');assert.equal(noSymbol[0].approver,null);assert.equal(noSymbol[0].needs_review,true);
const report={passed:true,source:{fileNo:'239154',kind:process.env.DELEGATION_HWP_PATH?'Previously downloaded actual ALIO HWP':'Live actual ALIO HWP'},compactCharacters:JSON.stringify(compact).length,detailedCharacters:JSON.stringify(detailed).length,totalContractQueryRows:rows.length,regressions:[{query:'국정감사 중요사항',rows:audit},{query:'계약 승인',rows:rows.map(r=>Object.fromEntries(['row','task','condition','approver','symbol','suffix','legend','confidence','needs_review','analysis_type'].map(k=>[k,r[k]])))},{query:'계약원가계산',rows:cost.map(r=>({row:r.row,task:r.task,condition:r.condition,approver:r.approver,suffix:r.suffix}))}],pagination:'200 rows; no duplicates or omissions',missingSymbol:'delegation_table, approver=null, needs_review=true'};
writeFileSync('reports/delegation-response-verification.json',JSON.stringify(report,null,2));console.log(JSON.stringify({...report,regressions:undefined}));

