// Unified search on documents built from the actual article texts of
// 포상금 지급방침 제9조, 여비규정 제23조, 직제규정 제8조 and distractors.
// The complete-corpus comparison with main runs in search-benchmark.ts (CI).
import assert from 'node:assert/strict';
import {unifiedSearch,searchBodies,extractCitations,prepareDocument,present} from '../../src/r2/global-search';
import {fold} from '../../src/regulation-core/search-ranking';
import {prepareSearchSections} from '../../src/regulation-core/search-sections';
import {normalizeName} from '../../src/d1/normalize';
import {amountOf,rangeOf,inRange} from '../../src/r2/amount';
const doc=(id:string,title:string,text:string)=>({regulation_id:id,title,fileNo:id,text,searchSections:prepareSearchSections(text)}) as any;
const docs=[
 doc('24638','포상금 지급방침','제3조(포상금의 종류) 포상금의 종류는 다음 각 호와 같다.\n6. 모범소원․공로연수․모험연수․직무향상연수 포상금\n제9조(모범소원․공로연수․모험연수․직무향상연수 포상금) ① 모범소원․모험연수․직무향상연수 포상금은 대상자로 선정된 직원에게 국내․외 연수 등에 필요한 경비를 지급하는 포상금을 말한다.\n② 목적은 다음과 같다. 3. 모험연수: 해외연수를 실시함으로써 도전의식 부여\n④ 포상금 지급액은 모범소원 400만원, 모험연수 300만 원 이내로 한다.\n⑤ 포상금 지급은 총 포상금에서 국내․외 연수에 필요한 직접 경비는 여행사에 일괄 지불하고, 잔액은 개인에게 지급한다.\n'),
 doc('25281','여비규정','제22조(국내출장) 국내 출장 여비는 별표에 따른다.\n제23조(국외출장) ① 국외에 출장할 때의 여비기준은 별표 제3호의 국외여비기준표에 따른다.\n제23조의2(여비의 결제와 정산 등) ① 국외출장자는 숙박비를 실비정산 또는 할인정액으로 선택하여 신청한다.\n'),
 doc('30001','공무국외출장 업무방침','제1조(목적) 이 방침은 공무국외출장에 관한 사항을 정한다.\n제5조(여비) 국외출장 여비는 「여비규정」 제23조에 따른다.\n'),
 doc('22800','직제규정','제6조(소장) ① 소장은 연구소를 대표한다.\n② 부소장은 소장이 직무를 수행할 수 없을 때 그 직무를 대행한다.\n제8조(부소장) ① 부소장은 소장의 업무를 보조한다.\n'),
 doc('25437','위원회 설치운영규정','제5조(구성) 위원장: 참모부서 운영위원회는 부소장, 그 외는 직제 순서에 따라 순번제로 운영\n'),
 doc('46926','연구소차량 관리방침','제15조(사고 보고) ① 연구소차량 운행 중 차량 사고가 발생한 경우 즉시 보고한다.\n③ 사고에 대하여 책임보험의 처리에 자기부담금이 발생한 때에는 부서에서 부담한다.\n'),
 doc('90001','견본','[별지 제2호]\n사고방식 보고서 견본\n'),
];
const titles=new Map<string,{reg_id:string;title:string}>(docs.map((d:any)=>[normalizeName(d.title),{reg_id:d.regulation_id,title:d.title}]));for(const d of docs)d.citations=extractCitations(d,titles);
const results:string[]=[];const ok=(name:string,cond:boolean,detail:unknown)=>{assert(cond,name+' '+JSON.stringify(detail).slice(0,300));results.push(name);};
let u=unifiedSearch(docs,'모험연수 300만원');ok('모험연수 300만원 → 포상금 지급방침 제9조④ (금액 띄어쓰기 무시)',u.results[0]?.regulationName==='포상금 지급방침'&&u.results[0].matches[0].paragraph==='④',u.results[0]);
u=unifiedSearch(docs,'모험연수 잔액 개인 지급');ok('모험연수 잔액 개인 지급 → 제9조⑤ snippet',u.results[0].matches[0].paragraph==='⑤'&&/잔액은 개인에게 지급/.test(u.results[0].matches[0].snippet),u.results[0].matches[0]);
u=unifiedSearch(docs,'모험연수 국외출장비');ok('모험연수 국외출장비 → 국외출장비 어간 처리, 포상금 제9조 + 여비규정 제23조 (각 단어 역할 표시)',u.coverage.resolved['국외출장비']==='국외출장'&&u.results.some(r=>r.regulationName==='포상금 지급방침'&&r.matched_terms.join()==='모험연수')&&u.results.some(r=>r.regulationName==='여비규정'&&/^제23조/.test(r.matches[0].label)&&r.matched_terms.join()==='국외출장'),u.results.map(r=>[r.regulationName,r.matches[0].label,r.matched_terms]));
u=unifiedSearch(docs,'직제 부소장');ok('직제 부소장 → 직제규정 제8조 1순위 (규정명 단어 라우팅)',u.results[0].regulationName==='직제규정'&&/^제8조/.test(u.results[0].matches[0].label)&&u.results[0].title_terms?.[0]==='직제',u.results.map(r=>[r.regulationName,r.score]));
u=unifiedSearch(docs,'연구소차량 사고 보험');ok('연구소차량 사고 보험 → 연구소차량 관리방침 제15조',u.results[0].regulationName==='연구소차량 관리방침',u.results[0]);
u=unifiedSearch(docs,'기술용역 10억 승인권자');ok('승인권자는 의도어로 분리',u.intent==='approver'&&u.coverage.ignored.includes('승인권자')&&!u.coverage.terms.includes('승인권자'),u.coverage);
u=unifiedSearch(docs,'포상금 모험연수');ok('공무국외출장 → 여비규정 인용 링크 추출',docs[2].citations.some((c:any)=>c.to==='25281'&&c.article==='제23조'&&c.label.startsWith('제5조')),docs[2].citations);
u=unifiedSearch(docs,'국외출장 여비');ok('인용된 조문이 이미 결과에 있으면 related 중복 없음',!u.related.some(r=>u.results.some(x=>x.reg_id===r.reg_id&&x.matches.some((m:any)=>m.label===r.label))),u.related);
u=unifiedSearch(docs,'공무국외출장 여비');ok('인용 링크: 공무국외출장 업무방침 제5조 → 여비규정 제23조 (citation, high)',u.related.some(r=>r.regulationName==='여비규정'&&/^제23조/.test(r.label)&&r.relation.type==='citation'&&r.relation.confidence==='high'),u.related);
ok('N5 유지: "사고 보고" ↛ "사고방식 보고서"',unifiedSearch(docs,'사고 보고').results.every(r=>r.regulationName!=='견본')&&searchBodies(docs,'사고 보고').every(r=>r.regulationName!=='견본'),'');
u=unifiedSearch(docs,'부소장 근무시간');ok('관련성 낮은 단어 부분일치는 근거로 제시하지 않음 (근무시간 미존재 → missing)',u.coverage.missing.includes('근무시간'),u.coverage);
// Raw-text prefilter equals full folding on characters folding rewrites.
{const texts=['제1조(목적) 민·군 기술협력','제2조 1,000만 원 이하','제3조 ＰＤＦ 파일과 Ｋ값','제4조 ㉮ 항목과 ㈎ 항목','제5조 ① 1억 5천만원','제6조 국외 출장비','제7조 ＩＩ단계 Ⅱ','제8조 KT 보고'],terms=['민군','1000만원','pdf','k','가','1억5천만원','국외출장','ii','kt','①'];let n=0;
 for(const text of texts){const p=prepareDocument({text,title:'시험'});for(const sec of p.sections)for(const t of terms){const f=fold(sec.text),ft=fold(t),want=/\d/.test(t)?f.replace(/[\s,]+/g,'').includes(ft.replace(/[\s,]+/g,'')):f.includes(ft);assert.equal(present(sec as any,t),want,t+' in '+sec.text);n++;}}
 results.push(`raw-text prefilter equals full folding on ${n} synthetic checks (middle dot, full-width, circled Hangul, amounts with spaces/commas)`);}
// Amount ranges for approver questions.
assert.equal(amountOf('10억'),1e9);assert.equal(amountOf('300만원'),3e6);assert.equal(amountOf('1억5천만'),1.5e8);assert.equal(amountOf('기술용역'),null);assert.equal(amountOf('2024'),null);
const within=(c:string,v:number)=>{const r=rangeOf(c);return r?inRange(v,r):null;};
assert.equal(within('용역비 5억 초과',1e9),true);assert.equal(within('2억 원 이상 5억 원 미만',1e9),false);assert.equal(within('2억 원 미만',1e9),false);assert.equal(within('10억 원 이상(수정계약의 경우 차액 기준)',1e9),true);assert.equal(within('10억 원 미만',1e9),false);assert.equal(within('5천만 원 이하',5e7),true);assert.equal(within('중요사항',1e9),null);
results.push('amount ranges: 10억 is within 5억 초과 and 10억 원 이상, outside 2억~5억 미만 and 10억 원 미만');
console.log(JSON.stringify({passed:true,cases:results},null,1));
