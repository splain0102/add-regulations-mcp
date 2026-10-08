import assert from 'node:assert/strict';
import {versionCheck} from '../src/regulation-core/table-layout';
import {searchRegulationText} from '../src/regulation-core/text-search';
import {sectionAt,extractArticleSnippet,missingAnnexes,normalizeRegulationTitle,PARSER_VERSION} from '../src/regulation-core/regulations';
const sample='제7조(사고)\n사고 조치\n부 칙 <방침 제919호, 2023. 9. 15.>\n이 규정은 공포한 날부터 시행한다\n[별표 제4호] 차량운행일지\n사고 기록\n\n[별표 제6호] 사고처리\n사고 보고';
const a=sample.indexOf('사고 기록');
assert.equal(sectionAt(sample,a).label,'[별표 제4호] 차량운행일지');
assert.equal(extractArticleSnippet(sample,a,2,true).label,'[별표 제4호] 차량운행일지');
assert(!extractArticleSnippet(sample,a,2,true).snippet.includes('[별표 제6호]'));
assert.equal(sectionAt(sample,sample.indexOf('이 규정은')).label,'부 칙 <방침 제919호, 2023. 9. 15.>');
assert.equal(normalizeRegulationTitle('민·군'),normalizeRegulationTitle('민군'));
assert.equal(normalizeRegulationTitle('「민･군 (협력)」'),normalizeRegulationTitle('민군협력'));
assert(PARSER_VERSION.length>0);
assert(versionCheck('2021. 3. 29.',undefined,'연혁\n개정 2021. 3. 29. 방침 제811호').dates.some(d=>d.source==='body_last_revision_date'&&d.date==='2021-03-29'));
console.log('PASS annex section boundaries and title normalization');

const textResult={text:'제7조(사고)\n사고 신고\n제15조(보험)\n사고 처리 및 보험 적용\n제16조(기타)\n보험 일반',regulationName:'연구소차량 관리방침',fileNo:'123'};
const deps={text:async()=>textResult,table:async()=>({rows:[]}),history:async()=>[],metadata:async()=>textResult} as any;
const andResult=await searchRegulationText('연구소차량 관리방침','사고 보험',{compact:true},deps);
assert(andResult.structuredContent.matches.some((m:any)=>m.label.startsWith('제15조')));
assert(!andResult.structuredContent.matches.some((m:any)=>m.label.startsWith('제7조')));
const numberResult=await searchRegulationText('연구소차량 관리방침','제15조',{compact:true},deps);
assert(numberResult.structuredContent.matches[0].label.startsWith('제15조'));
const effective=versionCheck('2021. 3. 29.',undefined,'부 칙 <방침 제811호, 2021. 3. 29.>\n2021. 4. 1. 시행');
assert(!effective.warning||effective.warning.mismatches.every((m:any)=>m.kind!=='effective_date_difference'));
console.log('PASS token-AND, article priority and effective date classification');

assert.deepEqual(missingAnnexes('제4조(조직) 이 규정의 조직은 [별표 제1호]에 따른다.'),['[별표 제1호]']);
assert.deepEqual(missingAnnexes('제4조(조직) 이 규정의 조직은 [별표 제1호]에 따른다.\n[별표 제1호] 직제표\n표 본문'),[]);
console.log('PASS missing annex diagnostics');

const blankResult=await searchRegulationText('연구소차량 관리방침','   ',{compact:true},deps);
assert.equal(blankResult.structuredContent.code,'invalid_query');
assert.equal(blankResult.isError,true);
console.log('PASS blank query rejected without returning unrelated sections');

const pagedText={...textResult,text:Array.from({length:13},(_,i)=>`제${i+1}조(시험)\n반복 검색어`).join('\n')};
const pagedDeps={...deps,text:async()=>pagedText,metadata:async()=>pagedText};
const firstPage=await searchRegulationText('시험규정','반복',{offset:0},pagedDeps);
const secondPage=await searchRegulationText('시험규정','반복',{offset:10},pagedDeps);
assert.equal(firstPage.structuredContent.matches.length,10);
assert.equal(secondPage.structuredContent.matches.length,3);
assert(secondPage.structuredContent.matches[0].label.startsWith('제11조'));
console.log('PASS text search pagination offset and second page');
