// 6th-round acceptance on real ALIO documents (CI; needs ALIO access). A subset of
// the current list goes through the producer's own steps: list → detail/attachment
// selection → download/parse → documentRecords → buildR2Catalog → runR2Tool.
import {writeFileSync,mkdirSync} from 'node:fs';
import {collectOfflineList} from '../offline-index-build';
import {createCorpusSource,createIndexRequest,getRegulationDetail} from '../../src/regulation-core/regulations';
import {buildCrossAttachmentWarnings} from '../../src/regulation-core/cross-attachments';
import {documentRecords} from '../d1/records';
import {R2Reader} from '../../src/r2/read';
import {runR2Tool} from '../../src/r2/tools';
import {ROOT} from '../../src/r2/types';
import {buildR2Catalog,type StoredDocument} from './build';
const TITLES=['기술료분쟁조정위원회 구성 및 운영 방침','전문가활용경비 지급 방침','취업규정','민군기술협력사업 보안과제 관리요령','회계규정','공익근무요원 관리방침','민군기술협력사업 기술교류회 운영방침','직제규정','부설 국방신속획득기술연구원 직제운영요령','민군협력사업 전문위원회 운영방침','민군기술협력사업 전문위원 운영방침','위임전결규정'];
const results:{case:string;pass:boolean;detail:string}[]=[];
const check=(name:string,pass:boolean,detail:unknown)=>{results.push({case:name,pass,detail:typeof detail==='string'?detail:JSON.stringify(detail).slice(0,400)});};
try{
 const items=(await collectOfflineList()).filter(i=>TITLES.includes(i.title));
 check('ALIO 목록에서 대상 규정 확보',items.length===TITLES.length,{missing:TITLES.filter(t=>!items.some(i=>i.title===t))});
 const stored:StoredDocument[]=[],details:Record<string,any>={};
 for(const item of items){
  const detail=await getRegulationDetail(item.detailUrl,item.updatedDate,{request:createIndexRequest(fetch),requireAttachments:true,fallbackRevisionDate:item.revisionDate});
  const loaded=await createCorpusSource(createIndexRequest(fetch)).load(item),records=await documentRecords(item,loaded);
  details[item.title]={fileNo:records.document.file_no,selectedDate:loaded.selectedDate,attachments:detail.attachments};
  stored.push({records:{...records,document:{...records.document,filename:detail.latestAttachment?.name??records.document.filename,selection_reason:detail.selection_reason,other_attachments:detail.other_attachments}},loaded});
 }
 const warnings=buildCrossAttachmentWarnings(items.map(i=>i.title),details);
 for(const s of stored)s.records.document.cross_entry_warnings=warnings[s.records.document.title]??[];
 const built=buildR2Catalog(stored,'sixth-live'),values=new Map(built.objects);
 values.set(ROOT,new TextEncoder().encode(JSON.stringify({format:1,catalog:built.catalogRef,published_at:new Date().toISOString(),build_version:'sixth-live',count:built.catalog.documents.length})));
 const bucket={get:async(key:string)=>{const b=values.get(key);return b?{size:b.length,arrayBuffer:async()=>b.buffer.slice(b.byteOffset,b.byteOffset+b.length) as ArrayBuffer}:null;}};
 const call=async(tool:string,input:any)=>((await runR2Tool(new R2Reader(bucket),tool,input,'sixth-live')) as any).structuredContent;
 // 3 + 4.
 const expert=await call('search_all_regulations',{query:'전문가활용',limit:10});
 check('4 "전문가활용" 1순위 「전문가활용경비 지급 방침」',expert.results?.[0]?.regulationName==='전문가활용경비 지급 방침',expert.results?.map((r:any)=>[r.regulationName,r.score]));
 const fee=expert.results?.find((r:any)=>r.regulationName==='기술료분쟁조정위원회 구성 및 운영 방침'),art=fee?.matches?.find((m:any)=>/^제\s*13\s*조/.test(m.label));
 check('3 기술료분쟁조정위원회 방침 제13조: body, 정상 띄어쓰기',Boolean(art)&&art.kind!=='table'&&/외부위원에게는\s*｢?전문가활용경비 지급 방침/.test(art.snippet),art??fee);
 check('3 score 산식: 결과 점수가 모두 같지 않음',new Set((expert.results??[]).map((r:any)=>r.score)).size>1,(expert.results??[]).map((r:any)=>r.score));
 const prose=await call('search_regulation_table',{name:'기술료분쟁조정위원회 구성 및 운영 방침',query:'외부위원'});
 check('3 PDF 본문 줄이 표로 색인되지 않음',prose.totalMatches===0,{totalMatches:prose.totalMatches,first:prose.results?.[0]});
 // 7.
 const labels:string[]=[];let offset:number|null=0;while(offset!==null){const page=await call('get_regulation_text',{name:'전문가활용경비 지급 방침',limit:100,offset});labels.push(...page.results.map((r:any)=>r.label));offset=page.next_offset;}
 check('7 "부칙(2026.9.28.) 제2조(경과조치)"',labels.includes('부칙(2026.9.28.) 제2조(경과조치)'),labels.filter(l=>l.startsWith('부칙')));
 // 5 (reported, not a CI gate).
 const article=await call('search_regulation_text',{name:'취업규정',query:'제12조'});
 check('5 search_regulation_text("취업규정","제12조") 크기(보고용)',true,`${JSON.stringify(article).length} chars / ${Buffer.byteLength(JSON.stringify(article))} bytes; keys=${Object.keys(article).join(',')}`);
 // Earlier fixes.
 const foreigner=await call('search_all_regulations',{query:'외국인',limit:10});
 check('기존 "외국인" → 보안과제 관리요령 제8조',foreigner.results?.some((r:any)=>r.regulationName.endsWith('보안과제 관리요령')&&r.matches.some((m:any)=>m.label.includes('제8조'))),foreigner.results?.map((r:any)=>r.regulationName));
 const wedding=await call('search_all_regulations',{query:'결혼 휴가',limit:10});
 check('기존 "결혼 휴가" → 취업규정 제26조',wedding.results?.some((r:any)=>r.regulationName==='취업규정'&&r.matches.some((m:any)=>m.label.includes('제26조'))),wedding.results?.map((r:any)=>[r.regulationName,r.matches?.[0]?.label]));
 const accident=await call('search_all_regulations',{query:'사고 보고',limit:10});
 check('기존 "사고 보고" N5: "사고방식" 서식 미검출',!(accident.results??[]).some((r:any)=>r.matches.some((m:any)=>/사고방식/.test(m.snippet)&&!/사고\s*보고/.test(m.snippet))),accident.results?.map((r:any)=>r.regulationName));
 const middot=await call('search_all_regulations',{query:'민·군',limit:10});
 check('기존 "민·군" 가운뎃점 질의',middot.results?.some((r:any)=>r.regulationName==='민군기술협력사업 기술교류회 운영방침'),middot.results?.map((r:any)=>r.regulationName));
 const org=await call('get_regulation',{name:'직제'});
 check('기존 name="직제" 모호성 후보 안내',org.error?.code==='ambiguous_name'&&['직제규정','부설 국방신속획득기술연구원 직제운영요령'].every(t=>org.error.candidates.some((c:any)=>c.title===t)),org.error??org.regulationName);
 const committee=await call('get_regulation',{name:'민군협력사업 전문위원회 운영방침'});
 check('기존 전문위원회 cross_entry 경고',committee.version_warning?.code==='cross_entry_newer_attachment'&&committee.version_warning.entry==='민군기술협력사업 전문위원 운영방침',committee.version_warning);
 const delegation=await call('search_regulation_table',{name:'위임전결규정',query:'국외출장',limit:100});
 check('1 실제 최신본 "국외출장" → 8) 공무국외출장 하위 8행',delegation.results.filter((r:any)=>r.task==='8) 공무국외출장').length===8,delegation.results.filter((r:any)=>r.task==='8) 공무국외출장').map((r:any)=>r.row));
}catch(error){check('harness',false,String(error));}
mkdirSync('reports',{recursive:true});writeFileSync('reports/r2-sixth-live.json',JSON.stringify(results,null,1));
console.table(results.map(r=>({case:r.case,result:r.pass?'PASS':'FAIL',detail:r.detail.slice(0,120)})));
if(results.some(r=>!r.pass))process.exitCode=1;
