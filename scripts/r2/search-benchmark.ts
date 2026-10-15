// Same-input comparison of the base (main) and this branch's search on the
// complete actual corpus. Both catalogs are built from the same current parsed
// snapshots in R2 (read-only), each with its own builder, and queried in the
// same Node process. Expected answers are defined up front and judged
// automatically. Usage (CI): BASE_DIR=.base node … scripts/r2/search-benchmark.ts
import {appendFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {r2Store} from '../d1/remote';
import {ROOT} from '../../src/r2/types';
const base=resolve(process.env.BASE_DIR??'.base'),load=(dir:string,file:string)=>import(pathToFileURL(resolve(dir,file)).href);
const [baseBuild,baseTools,baseRead,newBuild,newTools,newRead]=await Promise.all([load(base,'scripts/r2/build.ts'),load(base,'src/r2/tools.ts'),load(base,'src/r2/read.ts'),load('.','scripts/r2/build.ts'),load('.','src/r2/tools.ts'),load('.','src/r2/read.ts')]);
const store=r2Store(),json=async(key:string)=>JSON.parse(new TextDecoder().decode(await store('GET',key)));
const report:any={scope:'Complete actual corpus from R2 parsed snapshots; base=main and new=branch catalogs built from the same snapshots; Node process, not Cloudflare CPU',queries:[],compatibility:[],passed:false};
type Case={id:string;tool:string;input:any;expect:(r:any)=>boolean;allowed:string[]};
const body=(r:any)=>[...(r.results??[]),...(r.related??[]).map((x:any)=>({...x,matches:[{label:x.label,snippet:x.snippet,paragraph:x.paragraph}]}))];
const has=(r:any,reg:string,label:RegExp,top=5)=>body(r).slice(0,top+5).some((x:any)=>x.regulationName===reg&&(x.matches??[]).some((m:any)=>label.test(m.label??'')));
const CASES:Case[]=[
 {id:'모험연수 300만원',tool:'search_all_regulations',input:{query:'모험연수 300만원'},expect:r=>has(r,'포상금 지급방침',/^제9조/,3),allowed:['포상금 지급방침']},
 {id:'모험연수 국외출장비',tool:'search_all_regulations',input:{query:'모험연수 국외출장비'},expect:r=>has(r,'포상금 지급방침',/^제9조/)&&has(r,'여비규정',/^제23조/),allowed:['포상금 지급방침','여비규정','공무국외출장 업무방침']},
 {id:'모험연수 잔액 개인 지급',tool:'search_all_regulations',input:{query:'모험연수 잔액 개인 지급'},expect:r=>body(r).slice(0,3).some((x:any)=>x.regulationName==='포상금 지급방침'&&x.matches.some((m:any)=>/^제9조/.test(m.label)&&/잔액은\s*개인에게\s*지급/.test(m.snippet))),allowed:['포상금 지급방침']},
 {id:'기술용역 10억 승인권자',tool:'search_all_regulations',input:{query:'기술용역 10억 승인권자'},expect:r=>body(r).some((x:any)=>x.regulationName==='위임전결규정'&&x.matches.some((m:any)=>/10억\s*원\s*이상/.test((m.condition??'')+(m.snippet??''))&&/용역/.test((m.task??'')+(m.snippet??'')))),allowed:['위임전결규정','기술용역 업무규정']},
 {id:'직제 부소장',tool:'search_all_regulations',input:{query:'직제 부소장'},expect:r=>r.results?.[0]?.regulationName==='직제규정',allowed:['직제규정']},
 {id:'연구소차량 사고 보험',tool:'search_all_regulations',input:{query:'연구소차량 사고 보험'},expect:r=>r.results?.[0]?.regulationName==='연구소차량 관리방침'&&r.results[0].matches.some((m:any)=>/^제1[56]조/.test(m.label)),allowed:['연구소차량 관리방침']},
 {id:'외국인 보안과제',tool:'search_all_regulations',input:{query:'외국인 보안과제'},expect:r=>r.results?.[0]?.regulationName==='민군기술협력사업 보안과제 관리요령',allowed:['민군기술협력사업 보안과제 관리요령']},
 {id:'규정명 검색: 모험연수',tool:'search_regulations',input:{query:'모험연수'},expect:r=>(r.body_suggestions??[]).some((x:any)=>x.regulationName==='포상금 지급방침'),allowed:['포상금 지급방침']},
 {id:'기존: 외국인',tool:'search_all_regulations',input:{query:'외국인',limit:10},expect:r=>r.results?.some((x:any)=>x.regulationName.endsWith('보안과제 관리요령')&&x.matches.some((m:any)=>m.label.includes('제8조'))),allowed:[]},
 {id:'기존: 사고 보고',tool:'search_all_regulations',input:{query:'사고 보고',limit:10},expect:r=>!(r.results??[]).some((x:any)=>x.matches.some((m:any)=>/사고방식/.test(m.snippet)&&!/사고\s*보고/.test(m.snippet))),allowed:[]},
 {id:'기존: 결혼 휴가',tool:'search_all_regulations',input:{query:'결혼 휴가',limit:10},expect:r=>r.results?.some((x:any)=>x.regulationName==='취업규정'),allowed:[]},
 {id:'기존: 민·군',tool:'search_all_regulations',input:{query:'민·군',limit:10},expect:r=>(r.results??[]).length>0,allowed:[]},
];
const ITER=Number(process.env.BENCH_ITERATIONS??15);
const pct=(a:number[],p:number)=>{const s=[...a].sort((x,y)=>x-y);return Math.round(s[Math.min(s.length-1,Math.floor(p*(s.length-1)+0.5))]*10)/10;};
try{
 const checkpoint=await json('r2-index/checkpoint.json'),head=await json(ROOT),active=await json(head.catalog.key),current:Record<string,string>=checkpoint.current??{};
 const lifecycle=new Map(active.documents.map((d:any)=>[d.regulation_id,d]));
 // Current documents: checkpoint's verified version per regulation still listed in the active catalog.
 const ids=active.documents.map((d:any)=>d.regulation_id),stored:any[]=[];
 for(let i=0;i<ids.length;i+=8)stored.push(...await Promise.all(ids.slice(i,i+8).map(async(id:string)=>{const docId=current[id]??(lifecycle.get(id) as any).document_id,snap=await json(`parsed/${docId}.json`),old:any=lifecycle.get(id);return {...snap,records:{...snap.records,document:{...snap.records.document,status:old.status,aliases:old.aliases,first_seen:old.first_seen,last_seen:old.last_seen,missing_count:old.missing_count,repealed_at:old.repealed_at,filename:old.filename,selection_reason:old.selection_reason,other_attachments:old.other_attachments,cross_entry_warnings:old.cross_entry_warnings}}};})));
 const parsers=[...new Set(stored.map(s=>s.records.document.parser_version))];report.corpus={documents:stored.length,parser_versions:parsers};
 if(parsers.length!==1||parsers[0]!==(await load('.','src/regulation-core/parser-version.ts')).PARSER_VERSION)throw Error('reindex_incomplete: current snapshots carry parser versions '+parsers.join(',')+'; rerun after the R2 re-index publishes');
 const built={base:baseBuild.buildR2Catalog(stored,'base'),new:newBuild.buildR2Catalog(stored,'new')};
 const buckets:any={},sizes:any={};
 for(const name of ['base','new'] as const){const values=new Map<string,Uint8Array>(built[name].objects);values.set(ROOT,new TextEncoder().encode(JSON.stringify({format:1,catalog:built[name].catalogRef,published_at:new Date().toISOString(),build_version:name,count:built[name].catalog.documents.length})));
  buckets[name]={get:async(key:string)=>{const b=values.get(key);return b?{size:b.length,arrayBuffer:async()=>b.buffer.slice(b.byteOffset,b.byteOffset+b.length) as ArrayBuffer}:null;}};
  sizes[name]={objects:built[name].objects.size,bytes:[...built[name].objects.values()].reduce((n:number,b:Uint8Array)=>n+b.length,0),body_shard_bytes:built[name].catalog.body_shards.reduce((n:number,r:any)=>n+r.bytes,0)};}
 report.catalog_sizes=sizes;
 const tools:any={base:{run:baseTools.runR2Tool,Reader:baseRead.R2Reader},new:{run:newTools.runR2Tool,Reader:newRead.R2Reader}};
 for(const c of CASES){const row:any={id:c.id,tool:c.tool};let lastNew:any;
  for(const name of ['base','new'] as const){const {run,Reader}=tools[name];
   // Cold: a fresh reader per call (new isolate). Warm: one reader reused (DO cache).
   const cold:number[]=[],warm:number[]=[],warmReader=new Reader(buckets[name]);let answer:any,reads=0,bytes=0;
   for(let i=0;i<ITER;i++){const reader=new Reader(buckets[name]),t=performance.now();answer=(await run(reader,c.tool,c.input,name)).structuredContent;cold.push(performance.now()-t);reads=reader.requests;bytes=reader.bytes_read;}
   for(let i=0;i<ITER;i++){const t=performance.now();await run(warmReader,c.tool,c.input,name);warm.push(performance.now()-t);}
   const text=JSON.stringify(answer),top=(answer.results??[]).slice(0,5).map((r:any)=>r.regulationName),off=c.allowed.length?top.filter((t:string)=>!c.allowed.includes(t)).length:null;
   if(name==='new')lastNew=answer;
   row[name]={correct:c.expect(answer),cold_p50:pct(cold,0.5),cold_p95:pct(cold,0.95),warm_p50:pct(warm,0.5),warm_p95:pct(warm,0.95),r2_reads:reads,r2_bytes:bytes,response_chars:text.length,approx_tokens:Math.round(text.length/2),top5:top,outside_expected:off,...name==='new'&&answer.related?{related:answer.related.map((r:any)=>`${r.regulationName} ${r.label} (${r.relation?.type})`)}:{}};}
  row.calls={base:row.base.correct?1:'≥2',new:row.new.correct?1:'≥2'};
  if(!row.new.correct)row.new.answer=JSON.stringify({coverage:lastNew?.coverage,intent:lastNew?.intent,results:(lastNew?.results??[]).slice(0,6).map((r:any)=>({reg:r.regulationName,type:r.match_type,score:r.score,m:(r.matches??[]).slice(0,3).map((m:any)=>[m.label,m.condition,m.approver,String(m.snippet??'').slice(0,60)])})),body_suggestions:lastNew?.body_suggestions}).slice(0,3000);report.queries.push(row);console.log('BENCH',JSON.stringify(row));}
 // Unchanged tools must answer identically (same catalog content, same parser).
 for(const [tool,input] of [['search_regulation_table',{name:'위임전결규정',query:'국외출장',limit:100}],['search_regulation_text',{name:'여비규정',query:'제23조',limit:20}],['get_regulation',{name:'포상금 지급방침'}],['search_regulations',{query:'직제'}]] as const){
  const a=(await tools.base.run(new tools.base.Reader(buckets.base),tool,input,'base')).structuredContent,b=(await tools.new.run(new tools.new.Reader(buckets.new),tool,input,'new')).structuredContent;
  const same=JSON.stringify({...a,metrics:undefined})===JSON.stringify({...b,metrics:undefined});report.compatibility.push({tool,input,identical:same,...same?{}:{base_total:a.totalMatches,new_total:b.totalMatches}});}
 const sum=(k:string,n:'base'|'new')=>report.queries.filter((q:any)=>q.id.match(/^(모험|기술|직제|연구소|외국인 보)/)).map((q:any)=>q[n][k]);
 report.summary={first_call_success:{base:report.queries.filter((q:any)=>q.base.correct).length,new:report.queries.filter((q:any)=>q.new.correct).length,total:report.queries.length},required7_cold_p95_max:{base:Math.max(...sum('cold_p95','base')),new:Math.max(...sum('cold_p95','new'))},required7_warm_p95_max:{base:Math.max(...sum('warm_p95','base')),new:Math.max(...sum('warm_p95','new'))}};
 report.passed=report.queries.every((q:any)=>q.new.correct)&&report.compatibility.every((c:any)=>c.identical||c.tool==='search_regulations');
}catch(error){report.error=String(error);}
mkdirSync('reports',{recursive:true});writeFileSync('reports/search-benchmark.json',JSON.stringify(report,null,2));
const lines=['| 질문 | 기존 정답 | 개선 정답 | 기존 cold p95 | 개선 cold p95 | 기존 warm p95 | 개선 warm p95 | 기존 크기 | 개선 크기 |','|---|---|---|---|---|---|---|---|---|',...report.queries.map((q:any)=>`| ${q.id} | ${q.base.correct?'✅':'❌'} | ${q.new.correct?'✅':'❌'} | ${q.base.cold_p95} | ${q.new.cold_p95} | ${q.base.warm_p95} | ${q.new.warm_p95} | ${q.base.response_chars} | ${q.new.response_chars} |`)];
console.log(lines.join('\n'));console.log('SEARCH_BENCHMARK',JSON.stringify({passed:report.passed,error:report.error,summary:report.summary,compatibility:report.compatibility,catalog_sizes:report.catalog_sizes}));
if(process.env.GITHUB_STEP_SUMMARY)appendFileSync(process.env.GITHUB_STEP_SUMMARY,`## Search benchmark\n\n${lines.join('\n')}\n\n\`\`\`json\n${JSON.stringify({summary:report.summary,compatibility:report.compatibility,error:report.error},null,1)}\n\`\`\`\n`);
if(!report.passed)process.exitCode=1;
