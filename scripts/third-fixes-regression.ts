import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {zipSync,strToU8} from 'fflate';
import {extractHwpTables,extractHwpxTables,structureTables} from '../src/regulation-core/table-layout';
import {resolveCellFootnotes} from '../src/regulation-core/hwp-runs';
import {searchGeneralTables,normalizeTableSearch as norm} from '../src/regulation-core/general-table-search';
import {tableToolResponse} from '../src/regulation-core/table-response';
import {searchRegulationText} from '../src/regulation-core/text-search';
import {call} from './registered-handlers';
const bytes=process.env.DELEGATION_HWP_PATH?new Uint8Array(readFileSync(process.env.DELEGATION_HWP_PATH)):new Uint8Array(await(await fetch('https://www.alio.go.kr/download/rulefiledown.json?fileNo=239154')).arrayBuffer());
const tables=extractHwpTables(bytes),rows=structureTables(tables,''),find=(q:string)=>searchGeneralTables(tables,q,rows,'hwp');
const report:any={execution:'Real ALIO HWP records; Node registered handlers. Not production OAuth or exception-log evidence.',fileNo:'239154',tests:[],debug:tables.flatMap(t=>t.cells.filter(c=>c.nativeNotes?.length||c.text.includes('국내 출장')).map(c=>({table_id:t.id,row:c.row,col:c.col,text:c.text,runs:c.runs,definitions:c.nativeNotes}))),sizeRule:{threshold:0.85,changed:false,reason:'Actual body and native anchor baseSize are both 9pt. Numeric marks are native footnote controls; ※ has CharShape bit15. Keep 85% only as secondary evidence.'}};
async function test(id:number,label:string,fn:()=>unknown){try{const evidence=await fn();report.tests.push({id,label,status:'passed',evidence});console.log('THIRD_FIX',id,'passed',label);}catch(e){report.tests.push({id,label,status:'failed',error:String(e)});console.log('THIRD_FIX',id,'failed',label,String(e));}}
const notes=(r:any)=>r.footnotes??[];
await test(1,'domestic/foreign contract four stages without task footnotes',()=>{const r=find('계약 승인');for(const prefix of ['5)','5-2)']){const stages=r.filter(r=>norm(String(r.task)).startsWith(prefix));assert.equal(stages.length,4);assert.deepEqual(stages.map(r=>[r.approver,r.symbol,r.suffix]),[['부소장','★',null],['부장(센터장)','◎',null],['실장','◎','책임원'],['운영','◎',null]]);assert(stages.every(r=>notes(r).length===0));}return r.map(r=>({task:r.task,condition:r.condition,approver:r.approver,footnotes:r.footnotes}));});
await test(2,'audit director and empty notes',()=>{const r=find('국정감사 중요사항');assert.equal(r[0].approver,'소장');assert.deepEqual(notes(r[0]),[]);});
await test(3,'return report text approver and empty notes',()=>{const r=find('귀국보고');assert(r.some(r=>r.approver==='직상위자'&&r.approver_type==='text'));assert(r.every(r=>notes(r).length===0));});
await test(4,'domestic trip native note 4 and superscript ※',()=>{const r=find('국내 출장')[0];assert.equal(r.approver,'운영');assert.deepEqual(notes(r).map((n:any)=>n.mark).sort(),['4)','※'].sort());assert(notes(r).every((n:any)=>n.detected_by==='superscript'));assert(!String(r.task).includes('4)'));assert(!String(r.task).includes('※'));return {task:r.task,footnotes:r.footnotes};});
await test(5,'sick leave preserves multiple approvers and safe notes',()=>{const r=find('병가');assert.equal(r.length,1);assert.equal(r[0].multi_approver,true);assert.deepEqual(notes(r[0]),[]);});
await test(6,'actual latest transfer note, not legacy numbering',()=>{const r=find('부/실 내 이동');assert(r.length);assert(r.every(r=>!String(r.condition).includes('2)')));assert(r.some(r=>notes(r).some((n:any)=>n.mark==='2)'&&n.text.includes('부내 이동은 부장'))));return {requestedLegacyMark:'3)',actualLatestMark:'2)',rows:r.map(r=>({task:r.task,condition:r.condition,footnotes:r.footnotes}))};});
await test(7,'actual latest deputy leave note, not legacy numbering',()=>{const r=find('부소장').filter(r=>notes(r).some((n:any)=>n.text.includes('구두보고')));assert(r.length);assert(r.every(r=>notes(r).some((n:any)=>n.mark==='1)')));return {requestedLegacyMark:'2)',actualLatestMark:'1)',rows:r.map(r=>({task:r.task,condition:r.condition,footnotes:r.footnotes}))};});
await test(8,'ten consecutive registered text calls use latest HWP, no history',async()=>{
 if(process.env.THIRD_OFFLINE)return {status:'not_run_offline'};
 const evidence=[];for(let i=0;i<10;i++){const r=await call('search_regulation_text',{name:'위임전결규정',query:'국내 출장'});assert.equal(r.structuredContent.fileNo,'239154');assert.equal(r.structuredContent.extension,'hwp');assert.deepEqual(r.structuredContent.history,[]);assert.deepEqual(r.structuredContent.errors,[]);assert(r.structuredContent.table.rows.length);assert(!JSON.stringify(r).includes('pdf_point'));evidence.push({iteration:i+1,fileNo:r.structuredContent.fileNo,characters:JSON.stringify(r).length});}return evidence;
});
await test(9,'limit pagination differs from response-budget truncation',async()=>{if(process.env.THIRD_OFFLINE){const sample=tableToolResponse({rows:find('계약 승인')},'contract',{limit:1});assert.equal(sample.structuredContent.truncated,false);assert.equal(sample.structuredContent.has_more,true);return {status:'synthetic_pagination_only'};}const r=(await call('search_regulation_table',{name:'시작품 업무방침',query:'평가기준가격97%',limit:1})).structuredContent;assert.equal(r.has_more,true);assert.equal(r.truncated,false);assert.equal(r.next_offset,1);return r;});
await test(10,'ALL delegation tables: notes cannot equal any table data cell',()=>{const cells=new Set(tables.flatMap(t=>t.cells.map(c=>norm(c.text))));const all=rows.flatMap(notes);assert(all.length>0);for(const n of all){assert(!cells.has(norm(n.text)),n.text);assert(!/^\d+\)\s/.test(n.text));assert(['superscript','font_size','unicode','position'].includes(n.detected_by));}const position=all.filter(n=>n.detected_by==='position').length;return {tables:tables.length,structuredRows:rows.length,linkedNotes:all.length,positionDetected:position,positionRatio:position/all.length};});
await test(11,'shape precedence, ambiguous numbering, isolated definitions and HWPX runs',()=>{
 const block=[{mark:'4)',text:'Actual definition'}];
 assert.deepEqual(resolveCellFootnotes({text:'4) ordinary task',runs:[{text:'4) ordinary task',size:9,superscript:false}]},block).footnotes,[]);
 assert.deepEqual(resolveCellFootnotes({text:'task4)',runs:[{text:'task4)',size:9,superscript:false}]},block).footnotes,[]);
 const small=resolveCellFootnotes({text:'task4)',runs:[{text:'task',size:10,superscript:false},{text:'4)',size:8.5,superscript:false}]},block);assert.equal(small.footnotes[0].detected_by,'font_size');assert.equal(small.text,'task');
 assert.equal(resolveCellFootnotes({text:'task4)'},block).footnotes[0].detected_by,'position');
 assert.equal(resolveCellFootnotes({text:'task⁴'},block).footnotes[0].detected_by,'unicode');
 assert.deepEqual(resolveCellFootnotes({text:'task4)'},[]).footnotes,[]);
 const zip=zipSync({'Contents/header.xml':strToU8('<hh:head><hh:charPr id="0" height="1000"/><hh:charPr id="1" height="800"/></hh:head>'),'Contents/section0.xml':strToU8('<hs:sec><hp:p><hp:tbl><hp:tc><hp:cellAddr rowAddr="0" colAddr="0"/><hp:cellSpan rowSpan="1" colSpan="1"/><hp:p><hp:run charPrIDRef="0"><hp:t>Task </hp:t></hp:run><hp:run charPrIDRef="1"><hp:t>4)</hp:t></hp:run></hp:p></hp:tc></hp:tbl></hp:p><hp:p><hp:run><hp:t>4) Actual definition</hp:t></hp:run></hp:p></hs:sec>')});
 const t=extractHwpxTables(zip)[0];assert.equal(t.cells[0].runs?.[1].size,8);assert.equal(resolveCellFootnotes(t.cells[0],t.footnoteBlock??[]).footnotes[0].text,'Actual definition');return {fixture:'synthetic HWPX; not real ALIO HWPX'};
});
await test(12,'text/table/history component failures remain isolated',async()=>{
 const source:any={regulationName:'test',fileNo:'239154',filename:'test.hwp',extension:'hwp',text:'국내 출장',rows:find('국내 출장')};
 let historyCalls=0;const deps:any={text:async()=>source,table:async()=>source,metadata:async()=>source,history:async()=>{historyCalls++;return []}};
 const error=()=>{throw Object.assign(new Error('injected table failure'),{code:'layout_error'});};
 const partial=await searchRegulationText('test','국내 출장',{}, {...deps,table:error});assert(!partial.isError);assert(partial.structuredContent.matches.length);assert.equal(partial.structuredContent.errors[0].stage,'table');assert.equal(historyCalls,0);
 const textFailed=await searchRegulationText('test','국내 출장',{}, {...deps,text:error});assert(!textFailed.isError);assert(textFailed.structuredContent.table.rows.length);
 await searchRegulationText('test','국내 출장',{include_history:true},deps);assert.equal(historyCalls,1);return {textSurvivesTableFailure:true,tableSurvivesTextFailure:true,historyOptIn:true};
});
await test(13,'compact=false exposes actual source runs and body shape',()=>{const r=tableToolResponse({rows:find('국내 출장')},'국내 출장',{compact:false});const cells=(r.structuredContent.rows as any[])[0].cells;assert(cells.every((c:any)=>Array.isArray(c.runs)));assert(cells.some((c:any)=>c.runs.some((r:any)=>r.text==='※'&&r.size===9&&r.superscript===true)));return cells.filter((c:any)=>c.runs.some((r:any)=>r.superscript));});
report.passed=report.tests.every((t:any)=>t.status==='passed');writeFileSync('reports/third-fixes-regression.json',JSON.stringify(report,null,2));console.log('THIRD_FIXES_RESULT',JSON.stringify({passed:report.passed,passedCount:report.tests.filter((t:any)=>t.status==='passed').length,total:report.tests.length,offline:!!process.env.THIRD_OFFLINE}));if(!report.passed)process.exitCode=1;
