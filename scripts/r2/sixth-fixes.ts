// 6th-round fixes against the three real fixture HWPs (위임전결규정 fileNo 239154,
// 여비규정 194538, 기술용역 업무규정 228379) through the real catalog builder and
// runR2Tool. Live-ALIO cases (PDF 방침, 전문가활용경비 지급 방침) run in sixth-live.ts.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {hwpToText} from '@ssabrojs/hwpxjs/browser';
import {documentRecords,hash} from '../d1/records';
import {extractRevisionSection} from '../../src/regulation-core/revision-probe';
import {supplementLabels,prepareSearchSections} from '../../src/regulation-core/search-sections';
import {tokenWeights} from '../../src/regulation-core/search-ranking';
import {searchBodies} from '../../src/r2/global-search';
import {R2Reader} from '../../src/r2/read';
import {runR2Tool,snippetStart} from '../../src/r2/tools';
import {ROOT} from '../../src/r2/types';
import {buildR2Catalog,type StoredDocument} from './build';
const results:{case:string;pass:boolean;detail:string}[]=[];
const check=(name:string,pass:boolean,detail:unknown)=>{results.push({case:name,pass,detail:typeof detail==='string'?detail:JSON.stringify(detail).slice(0,300)});};
const samples=JSON.parse(gunzipSync(Buffer.from(readFileSync('scripts/fixtures/d1-samples.json.gz.b64','utf8'),'base64')).toString()),stored:StoredDocument[]=[];
for(const sample of samples){const loaded={...sample.document,bytes:new Uint8Array(Buffer.from(sample.document.bytes,'base64'))};assert.equal(hash(loaded.bytes),sample.raw_sha256);loaded.text=await hwpToText(loaded.bytes);stored.push({records:await documentRecords(sample.item,loaded),loaded});}
const built=buildR2Catalog(stored,'sixth'),values=new Map(built.objects);
values.set(ROOT,new TextEncoder().encode(JSON.stringify({format:1,catalog:built.catalogRef,published_at:new Date().toISOString(),build_version:'sixth',count:built.catalog.documents.length})));
const bucket={get:async(key:string)=>{const b=values.get(key);return b?{size:b.length,arrayBuffer:async()=>b.buffer.slice(b.byteOffset,b.byteOffset+b.length) as ArrayBuffer}:null;}};
const call=async(tool:string,input:any)=>((await runR2Tool(new R2Reader(bucket),tool,input,'sixth')) as any);
const tableRows=async(query:string,extra:any={})=>{const rows:any[]=[];let offset:number|null=0,last:any;while(offset!==null){last=(await call('search_regulation_table',{name:'위임전결규정',query,limit:100,offset,...extra})).structuredContent;rows.push(...last.results);offset=last.next_offset;}return {rows,last};};
const rowsOf=(rows:any[],table:string,from:number,to:number)=>rows.filter(r=>r.table_id===table&&r.row>=from&&r.row<=to).map(r=>r.row).sort((a,b)=>a-b);
const delegation=stored.find(s=>s.records.document.title==='위임전결규정')!.records.rows;
try{
 // 1. Merged category/task cells are searchable on every row they cover.
 let r=await tableRows('국외출장');const abroad=rowsOf(r.rows,'section1:table1',57,64);
 check('1 국외출장 → 8) 공무국외출장 8행(57–64, 세부과제책임자 row 60 포함)',JSON.stringify(abroad)===JSON.stringify([57,58,59,60,61,62,63,64]),{rows:abroad});
 check('1 row 60 세부과제책임자: 글자 전결 "직상위자 또는 PM"',r.rows.find(x=>x.table_id==='section1:table1'&&x.row===60)?.approvers?.map((a:any)=>a.name).join(',')==='직상위자,PM',r.rows.find(x=>x.row===60&&x.table_id==='section1:table1'));
 r=await tableRows('초빙');check('1 초빙 → 10) 국내외 전문가 초빙요구 2행',JSON.stringify(rowsOf(r.rows,'section1:table1',66,67))==='[66,67]',rowsOf(r.rows,'section1:table1',66,67));
 r=await tableRows('재무분야');const finance=delegation.filter((x:any)=>x.table_key==='section1:table1'&&x.result.category==='재무분야').map((x:any)=>x.source_row_number),got=r.rows.filter(x=>x.table_id==='section1:table1').map(x=>x.row);
 const tasks=[...new Set(r.rows.filter(x=>x.category==='재무분야').map(x=>String(x.task).match(/^(\d+)\)/)?.[1]))];
 check('1 재무분야 → 1)~9) 전 행',finance.every((n:number)=>got.includes(n))&&['1','2','3','4','5','6','7','8','9'].every(t=>tasks.includes(t)),{expected:finance.length,got:got.length,tasks});
 check('1 category·task 필드 유지',r.rows.every(x=>x.category==='재무분야'&&/^\d+\)/.test(x.task)),r.rows.slice(0,2));
 r=await tableRows('공무국외출장',{group_by:'task'});const g=r.last.groups?.find((x:any)=>x.task==='8) 공무국외출장');
 check('1 group_by=task → 8) 공무국외출장 하위 8행 묶음',g?.rows?.length===8,g);
 r=await tableRows('귀국보고',{group_by:'task'});check('1 group_by=task: 하위 행 하나만 일치해도 업무 전체 반환',rowsOf(r.rows,'section1:table1',57,64).length===8,rowsOf(r.rows,'section1:table1',57,64));
 // 2. Several approvers on one row need review.
 r=await tableRows('적성무기');const weapon=r.rows.find(x=>x.row===655);
 check('2 적성무기 row 655: multi_approver → needs_review, review_reason',weapon?.multi_approver===true&&weapon.needs_review===true&&weapon.review_reason==='multiple_approvers',weapon);
 // Delegation samples.
 const approver=async(query:string,pick:(x:any)=>boolean)=>(await tableRows(query)).rows.find(pick)?.approver;
 for(const [name,query,pick,want] of [['국내출장=운영','국내 출장',(x:any)=>/국내 출장 승인/.test(x.task),'운영'],['과제참여자 출장=사책/과책','과제참여자 출장',(x:any)=>/과제참여자 출장/.test(x.condition??''),'사책/과책'],['행정규칙 개정소요 중요=소장','행정규칙 개정소요',(x:any)=>/중요사항/.test(x.condition??''),'소장'],['결의서 소본부 1억 이상=실장','결의서 소본부',(x:any)=>/1억 원 이상/.test(x.condition??''),'실장']] as const){const got=await approver(query,pick);check('샘플 '+name,got===want,{got});}
 // 4. Compound-word prefix for long terms; N5 stays strict for short ones.
 check('4 "전문가활용" → "전문가활용경비" 접두 일치',tokenWeights('｢전문가활용경비 지급 방침｣',['전문가활용'])[0]>0,tokenWeights('｢전문가활용경비 지급 방침｣',['전문가활용']));
 check('4 N5 유지: "사고 보고" ↛ "사고방식 보고서"',searchBodies([{title:'견본',text:'[별지 제2호]\n사고방식 보고서 견본',fileNo:'1'}],'사고 보고').length===0,'');
 const ranked=searchBodies([{title:'기술료분쟁조정위원회 구성 및 운영 방침',fileNo:'1',text:'제13조(경비의 지급) ① 외부위원에게는 ｢전문가활용경비 지급 방침｣에 따라 경비를 지급한다.'},{title:'전문가활용경비 지급 방침',fileNo:'2',text:'제1조(목적) 이 방침은 외부전문가 활용에 관한 사항을 정한다.\n제3조(정의) 전문가활용경비란 자문료를 말한다.'}],'전문가활용');
 check('4 규정명 포함 가점 → 「전문가활용경비 지급 방침」 1순위',ranked[0]?.regulationName==='전문가활용경비 지급 방침',ranked.map(x=>[x.regulationName,x.score]));
 // 5·6. Compact responses and single text return.
 const article=await call('search_regulation_text',{name:'여비규정',query:'제10조'}),body=article.structuredContent,json=JSON.stringify(body);
 check('5 compact 기본: 상태·첨부 감사 필드 제외',!['selection_evidence','other_attachments','index_build_version','snapshot_id','version_check','matches','table'].some(k=>k in body)&&['regulationName','revisionDate','fileNo','sourceUrl','results'].every(k=>k in body),Object.keys(body));
 check('5 search_regulation_text("여비규정","제10조") 크기',true,`${json.length} chars / ${Buffer.byteLength(json)} bytes (structuredContent)`);
 const full=(await call('search_regulation_text',{name:'여비규정',query:'제10조',compact:false})).structuredContent;check('5 compact:false: 전체 메타데이터',['selection_evidence','other_attachments','index_status','version_check'].every(k=>k in full),Object.keys(full).length);
 const text=(await call('get_regulation_text',{name:'여비규정',limit:2})).structuredContent,textFull=(await call('get_regulation_text',{name:'여비규정',limit:2,format:'full'})).structuredContent;
 check('6 get_regulation_text: 기본 results만, format=full이면 text 추가',!('text' in text)&&text.results.length===2&&typeof textFull.text==='string',{default:Object.keys(text),full:'text' in textFull});
 // 7. Supplementary-provision labels (real 여비규정 부칙 <규제910호, 2024. 2. 16.>).
 const travel=stored.find(s=>s.records.document.title==='여비규정')!,supp=travel.records.sections.filter((x:any)=>/^부칙/.test(x.section_label)).map((x:any)=>x.section_label);
 check('7 여비규정 부칙 블록·조문 라벨',supp.includes('부칙(규제910호, 2024.2.16.)')&&supp.includes('부칙(2024.2.16.) 제1조(시행일)'),supp.slice(-4));
 const synthetic='제1조(목적) 본문\n부    칙<방침 제1012호, 2026. 9. 28.>\n제1조(시행일) 이 방침은 2026년 10월 1일부터 시행한다.\n제2조(경과조치) 이 방침은 시행일 이후 확정되는 경비에 적용한다.\n[별표 1] 지급기준\n',labels=[...supplementLabels(synthetic,prepareSearchSections(synthetic).bounds).values()];
 check('7 "부칙(2026.9.28.) 제2조(경과조치)" 형식',labels.includes('부칙(방침 제1012호, 2026.9.28.)')&&labels.includes('부칙(2026.9.28.) 제2조(경과조치)'),labels);
 const undated='제1조(목적) 본문\n부    칙\n제1조(시행일) 이 방침은 2018년 5월 1일부터 시행한다.\n제2조(경과조치) 종전\n',undatedLabels=[...supplementLabels(undated,prepareSearchSections(undated).bounds).values()];
 check('7 날짜 머리 없는 부칙: 시행일로 구분',JSON.stringify(undatedLabels)===JSON.stringify(['부칙(시행 2018.5.1.)','부칙(시행 2018.5.1.) 제1조(시행일)','부칙(시행 2018.5.1.) 제2조(경과조치)']),undatedLabels);
 const hit=(await call('search_regulation_text',{name:'여비규정',query:'시행일',scope:'body',limit:20})).structuredContent.results.map((x:any)=>x.label);
 check('7 검색 결과 라벨에 부칙 날짜',hit.some((l:string)=>l.startsWith('부칙(2024.2.16.) 제1조')),hit.slice(-3));
 // 8. Snippet boundaries and revision evidence limited to 부칙.
 const sample='제46조(건강진단결과조치) ① 소장은 건강진단 결과에 따라 필요한 조치를 하여야 한다. '+'가'.repeat(150)+' 진단결과조치 대상',at=sample.lastIndexOf('진단결과조치'),from=snippetStart(sample,at);
 check('8 snippet 시작점이 어절 경계',from===0||/\s/.test(sample[from-1]),{start:sample.slice(from,from+12)});
 for(const s of samples){const evidence=await extractRevisionSection(new Uint8Array(Buffer.from(s.document.bytes,'base64')),'hwp');check('8 revision_evidence 부칙만: '+s.item.title,/^\s*부\s*칙/.test(evidence)&&!/\n\s*\[?\s*별\s*[표지]/.test(evidence),evidence.slice(-120));}
}catch(error){check('harness',false,String(error));}
mkdirSync('reports',{recursive:true});writeFileSync('reports/r2-sixth-fixes.json',JSON.stringify(results,null,1));
console.table(results.map(r=>({case:r.case,result:r.pass?'PASS':'FAIL',detail:r.detail.slice(0,110)})));
if(results.some(r=>!r.pass))process.exitCode=1;
