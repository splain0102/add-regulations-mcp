import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {call} from './registered-handlers';
const checks=[];
async function check(name,fn){
 try{const evidence=await fn();checks.push({name,status:'passed',evidence});console.log('DEFECT_ACCEPTANCE PASS',name);}
 catch(error){checks.push({name,status:'failed',error:String(error)});console.error('DEFECT_ACCEPTANCE FAIL',name,String(error));}
}
await check('version 1.10.4 and parser',async()=>{
 const r=await call('hello');assert.equal(r.structuredContent.version,'1.10.4');
 assert(r.structuredContent.parser_version);assert(r.structuredContent.build_version);return r.structuredContent;
});
await check('민·군 title normalization equals 민군',async()=>{
 const a=await call('search_regulations',{query:'민·군'});
 const b=await call('search_regulations',{query:'민군'});
 assert.equal(a.content[0].text,b.content[0].text);return {length:a.content[0].text.length};
});
await check('ambiguous 직제 name rejected',async()=>{
 const r=await call('search_regulation_text',{name:'직제',query:'부소장'}).catch(e=>({error:String(e)}));
 const raw=JSON.stringify(r);assert(raw.includes('ambiguous_name'));assert(raw.includes('직제규정'));return raw.slice(0,1000);
});
await check('not_found 보안업무규정',async()=>{
 const r=await call('search_regulation_text',{name:'보안업무규정',query:'보안'}).catch(e=>({error:String(e)}));
 assert(JSON.stringify(r).includes('not_found'));return JSON.stringify(r).slice(0,700);
});
await check('차량 사고 보험 matches article 15',async()=>{
 const r=await call('search_regulation_text',{name:'연구소차량 관리방침',query:'사고 보험'});
 assert(r.structuredContent.matches.some(m=>m.label.startsWith('제15조')));return r.structuredContent.matches.map(m=>m.label);
});
await check('vehicle 사고 appendix ownership',async()=>{
 const r=await call('search_regulation_text',{name:'연구소차량 관리방침',query:'사고'});
 const labels=r.structuredContent.matches.map(m=>m.label);
 assert(labels.some(x=>x.startsWith('[별표 제4호]')));
 assert(labels.some(x=>x.startsWith('[별표 제6호]')));
 assert(!labels.some(x=>x.startsWith('부칙')||x.startsWith('부 칙')));
 return labels;
});
await check('committee cross entry 140404',async()=>{
 const r=await call('get_regulation',{name:'민군협력사업 전문위원회 운영방침'});
 const raw=JSON.stringify(r.structuredContent.version_check);
 assert(raw.includes('140404'));assert(raw.includes('cross_entry_newer_attachment'));return r.structuredContent.version_check;
});
await check('committee PDF effective date 2021-03-29 with unverified revision',async()=>{
 const r=await call('get_regulation',{name:'민군협력사업 전문위원회 운영방침'});
 console.log('PDF_REVISION_DIAGNOSTIC',JSON.stringify({fileNo:r.structuredContent.fileNo,dates:r.structuredContent.version_check.dates,missing:r.structuredContent.version_check.missing,revision_evidence:r.structuredContent.version_check.revision_evidence,selection_reason:r.structuredContent.selection_reason}));
 assert(r.structuredContent.version_check.dates.some(x=>x.source==='body_last_effective_date'&&x.date==='2021-03-29'));
 assert(r.structuredContent.version_check.dates.some(x=>x.source==='alio_revision_date'&&x.date==='2021-03-29'));
 assert(r.structuredContent.version_check.missing.includes('body_last_revision_date'));
 return r.structuredContent.version_check.dates;
});
await check('PDF technical exchange raw row',async()=>{
 const r=await call('search_regulation_table',{name:'민군기술협력사업 기술교류회 운영방침',query:'교류회'});
 assert(r.structuredContent.rows.some(row=>Boolean(row.raw_text)||Object.values(row.values??{}).some(Boolean)));
 return {rows:r.structuredContent.rows.length};
});
await check('직제규정 annex present or diagnosed',async()=>{
 const r=await call('search_regulation_text',{name:'직제규정',query:'별표 제1호'});
 const data=r.structuredContent;
 assert(data.matches.some(m=>m.label.startsWith('[별표 제1호]'))||(data.missing_annexes??[]).includes('[별표 제1호]'));
 return {matches:data.matches.map(m=>m.label),missing_annexes:data.missing_annexes};
});
writeFileSync('reports/regulation-defects-acceptance.json',JSON.stringify({checks},null,2));
console.log('DEFECT_ACCEPTANCE_RESULT',JSON.stringify({passed:checks.filter(x=>x.status==='passed').length,total:checks.length}));
if(checks.some(x=>x.status!=='passed'))process.exitCode=1;
