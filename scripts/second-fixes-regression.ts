import {call} from './registered-handlers';
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {getRegulationMetadata,searchLatestRegulationTable,selectLatestAttachment,type Attachment} from '../src/regulation-core/regulations';
import {tableToolResponse} from '../src/regulation-core/table-response';
import {extractRevisionSection} from '../src/regulation-core/revision-probe';
import {versionCheck} from '../src/regulation-core/table-layout';

const evidence:any={execution:'Actual registered metadata/table handlers using actual ALIO originals in Node; not authenticated production MCP',tests:[]};
const queries=['계약 승인','귀국보고','병가','국내 출장'];
for(let iteration=0;iteration<10;iteration++){
 const meta=(await call('get_regulation',{name:'위임전결규정'})).structuredContent;assert.equal(meta.fileNo,'239154');
 const response=await call('search_regulation_table',{name:'위임전결규정',query:queries[iteration%queries.length]});
 const result=response.structuredContent;
 assert.equal(result.fileNo,'239154');assert(result.rows.length>0);
 const data=response.structuredContent;assert.equal(data.compact,true);assert(JSON.stringify(response).length<=15000);
 for(const row of data.rows as any[]){for(const key of ['cells','raw_cells','header_evidence','header_path','columns'])assert(!(key in row),key);}
 console.log('SECOND_FIXES_ITERATION',iteration+1,'passed');
 evidence.tests.push({iteration:iteration+1,query:queries[iteration%queries.length],fileNo:meta.fileNo,rows:(data.rows as any[]).length,characters:JSON.stringify(response).length,cache:result.cache});
}
const general=await searchLatestRegulationTable('직제규정','직종');
const compact=tableToolResponse(general,'직종');
assert.equal(compact.structuredContent.compact,true);assert(JSON.stringify(compact).length<=3000);
assert((compact.structuredContent.rows as any[]).some(r=>r.values?.['직종']==='연구직'&&r.values?.['직명']==='연구원'));
for(const row of compact.structuredContent.rows as any[])assert(!('cells' in row));
const detailed=tableToolResponse(general,'직종',{compact:false});
assert((detailed.structuredContent.rows as any[]).some(r=>r.cells?.length));
for(const row of detailed.structuredContent.rows as any[]){assert('raw_cells' in row);for(const cell of row.cells){assert(cell.text.trim());assert(!('row_span' in cell));assert(!('col_span' in cell));assert('header_path' in cell);}}
evidence.general={compactCharacters:JSON.stringify(compact).length,detailedCharacters:JSON.stringify(detailed).length};

// Controlled attachment failure, cache reuse/invalidation, and metadata isolation.
// The source is the real ALIO HWP just selected above, not a generated document.
const meta=await getRegulationMetadata('위임전결규정');
const originalFetch=globalThis.fetch;
const response=await originalFetch(`https://www.alio.go.kr/download/rulefiledown.json?fileNo=${meta.fileNo}`);
assert(response.ok);const bytes=new Uint8Array(await response.arrayBuffer());
const section=await extractRevisionSection(bytes,'hwp');assert(section.length<64000);
assert(versionCheck('2026-07-15','2026-07-15',section).dates.some(d=>d.source==='body_last_effective_date'&&d.date==='2026-07-15'));
let downloads=0;
globalThis.fetch=async(input,init)=>{
 const url=String(input);if(url.includes('probe-bad'))return new Response('invalid hwp',{headers:{'content-disposition':'attachment; filename=broken.hwp'}});
 if(url.includes('probe-good')){downloads++;return new Response(bytes,{headers:{'content-disposition':'attachment; filename=good.hwp'}});}
 if(url.includes('probe-old'))throw new Error('historical attachment must not be opened once latest is confirmed');
 return originalFetch(input,init);
};
try{
 const bad:Attachment={name:'broken.hwp',fileNo:'second-fixes-bad',extension:'hwp',detectedDate:'2026-07-15',url:'https://example.invalid/probe-bad'};
 const good:Attachment={name:'good.hwp',fileNo:'second-fixes-good',extension:'hwp',detectedDate:'2026-07-15',url:'https://example.invalid/probe-good'};
 const old:Attachment={name:'old.pdf',fileNo:'second-fixes-old',extension:'pdf',url:'https://example.invalid/probe-old'};
 const selected=await selectLatestAttachment([bad,good,old],'2026-07-15','2026-07-29');
 assert.equal(selected.selected?.fileNo,good.fileNo);assert.equal(selected.other_attachments.find(f=>f.fileNo===bad.fileNo)?.selection_reason,'parse_failed');
 await selectLatestAttachment([good],'2026-07-15','2026-07-29');assert.equal(downloads,1);
 await selectLatestAttachment([good],'2026-07-15','2026-07-30');assert.equal(downloads,2);
 evidence.faultIsolation={failedAttachment:'parse_failed',laterAttachmentSelected:true,oldAttachmentsSkipped:true,probeCacheHit:true,idateInvalidation:true};
}finally{globalThis.fetch=originalFetch;}
writeFileSync('reports/second-fixes-regression.json',JSON.stringify(evidence,null,2));
console.log('SECOND_FIXES_REGRESSION_RESULT',JSON.stringify({passed:true,consecutiveIterations:10,failures:0,...evidence.general,faultIsolation:evidence.faultIsolation}));
