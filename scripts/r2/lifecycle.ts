// Lifecycle check of the current R2 pipeline: each step runs the unmodified
// scripts/r2/sync.ts against scripted ALIO list/detail/download responses and a
// file-backed R2, then queries the published index through runR2Tool.
// Expectations follow the target design (idx identity, aliases, repeal status).
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {gunzipSync} from 'node:zlib';
import {R2Reader} from '../../src/r2/read';
import {runR2Tool} from '../../src/r2/tools';
type Row={title:string;idx:string;stDate:string;idate:string;attachments:{name:string;fileNo:string}[]};
const dir=mkdtempSync(join(tmpdir(),'r2-lifecycle-'));
const samples=JSON.parse(gunzipSync(Buffer.from(readFileSync('scripts/fixtures/d1-samples.json.gz.b64','utf8'),'base64')).toString());
const bytes=(title:string)=>samples.find((s:any)=>s.item.title===title).document.bytes;
writeFileSync(join(dir,'files.json'),JSON.stringify({'239154':bytes('위임전결규정'),'194538':bytes('여비규정'),'228379':bytes('기술용역 업무규정'),'990001':bytes('여비규정'),'990002':bytes('기술용역 업무규정')}));
const A:Row={title:'위임전결규정',idx:'25545',stDate:'2026.07.15',idate:'2026.07.29',attachments:[{name:'위임전결규정(2026년도 7월 15일 개정).hwp',fileNo:'239154'}]};
const B:Row={title:'여비규정',idx:'25281',stDate:'2024.02.16',idate:'2024.02.21',attachments:[{name:'여비규정(2024년도 2월 16일 개정).hwp',fileNo:'194538'}]};
const C:Row={title:'기술용역 업무규정',idx:'24708',stDate:'2025.12.31',idate:'2026.01.07',attachments:[{name:'기술용역 업무규정(2025년도 12월 31일 개정).hwp',fileNo:'228379'}]};
const N:Row={title:'신설 시험규정',idx:'990001',stDate:'2024.02.16',idate:'2024.02.21',attachments:[{name:'신설 시험규정(2024년도 2월 16일 개정).hwp',fileNo:'990001'}]};
const B2={...B,title:'국내외 여비규정'};
const C2:Row={...C,title:'기술용역 관리규정',idate:'2026.10.15',attachments:[...C.attachments,{name:'기술용역 관리규정(2025년도 12월 31일 개정).hwp',fileNo:'990002'}]};
const bucket={get:async(key:string)=>{const f=join(dir,'r2',encodeURIComponent(key));if(!existsSync(f))return null;const b=readFileSync(f);return {size:b.length,arrayBuffer:async()=>b.buffer.slice(b.byteOffset,b.byteOffset+b.length) as ArrayBuffer};}};
const tool=async(name:string,input:any={})=>((await runR2Tool(new R2Reader(bucket),name,input,'lifecycle')) as any).structuredContent;
const results:{scenario:string;check:string;expected:string;actual:string;pass:boolean}[]=[];
const check=(scenario:string,name:string,expected:string,actual:unknown,pass:boolean)=>{results.push({scenario,check:name,expected,actual:typeof actual==='string'?actual:JSON.stringify(actual),pass});};
function sync(scenario:object){
 writeFileSync(join(dir,'scenario.json'),JSON.stringify(scenario));rmSync(join(dir,'requests.log'),{force:true});rmSync(join(dir,'acceptance.log'),{force:true});
 const run=spawnSync(process.execPath,['--import','./scripts/test-loader.mjs','--import','./scripts/r2/lifecycle-mock.mjs','scripts/r2/sync.ts'],{env:{...process.env,LIFECYCLE_DIR:dir,CLOUDFLARE_ACCOUNT_ID:'lifecycle',R2_BUCKET:'lifecycle',R2_ACCESS_KEY_ID:'x',R2_SECRET_ACCESS_KEY:'x',R2_FORCE_SHA:'false',R2_BOOTSTRAP_ONLY:'false',GITHUB_STEP_SUMMARY:''},encoding:'utf8',timeout:300000});
 const out=run.stdout+run.stderr,requests=existsSync(join(dir,'requests.log'))?readFileSync(join(dir,'requests.log'),'utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l)):[];
 return {code:run.status,published:/R2_SYNC_PUBLISHED/.test(out),unchanged:/R2_METADATA_UNCHANGED/.test(out),failed:out.match(/R2_SYNC_FAILED (.*)/)?.[1],downloads:requests.filter((r:any)=>r.alio==='download').length,downloadedFiles:requests.filter((r:any)=>r.alio==='download').map((r:any)=>r.fileNo),acceptance:existsSync(join(dir,'acceptance.log'))?readFileSync(join(dir,'acceptance.log'),'utf8').trim():''};
}
const names=async()=>(await tool('list_regulations',{limit:500})).results?.map((r:any)=>r.regulationName)??[];
const idxOf=(r:any)=>r?.sourceUrl?new URL(r.sourceUrl).searchParams.get('idx'):r?.error?.code;
try{
 let s=sync({rows:[A,B,C]});
 check('초기 적재','3건 게시',"published, 3건",{published:s.published,names:await names()},s.published&&(await names()).length===3);
 s=sync({rows:[A,B,C]});
 check('변경 없음','다운로드 없이 종료','R2_METADATA_UNCHANGED, 다운로드 0',{unchanged:s.unchanged,downloads:s.downloads},s.unchanged&&s.downloads===0);
 s=sync({rows:[A,B,C,N]});
 const created=await tool('get_regulation',{name:'신설 시험규정'});
 check('신설','새 idx 게시·조회','4건, idx=990001',{published:s.published,count:(await names()).length,idx:idxOf(created)},s.published&&(await names()).length===4&&idxOf(created)==='990001');
 check('신설','기존 규정 재다운로드 없음','다운로드 1(신규분만)',{downloads:s.downloads},s.downloads===1);
 s=sync({rows:[A,B2,C,N]});
 const renamed=await tool('get_regulation',{name:'국내외 여비규정'}),oldName=await tool('get_regulation',{name:'여비규정'}),oldSearch=await tool('search_regulations',{query:'여비규정'});
 check('명칭변경','새 이름으로 조회, 같은 idx 유지','idx=25281',{published:s.published,idx:idxOf(renamed)},s.published&&idxOf(renamed)==='25281');
 check('명칭변경','옛 이름 조회(aliases)','옛 이름 → idx 25281, aliases에 옛 이름',{idx:idxOf(oldName),aliases:renamed.aliases},idxOf(oldName)==='25281'&&renamed.aliases?.includes('여비규정'));
 check('명칭변경','search_regulations 옛 이름','옛 이름으로 1건',{total:oldSearch.totalMatches,names:oldSearch.results?.map((r:any)=>r.regulationName)},oldSearch.results?.some((r:any)=>idxOf(r)==='25281'));
 s=sync({rows:[A,B2,C2,N]});
 const revised=await tool('get_regulation',{name:'기술용역 관리규정'}),revisedOld=await tool('get_regulation',{name:'기술용역 업무규정'});
 check('명칭변경+개정','새 이름·새 file_no, 같은 idx','idx=24708, fileNo=990002',{published:s.published,idx:idxOf(revised),fileNo:revised.fileNo},s.published&&idxOf(revised)==='24708'&&revised.fileNo==='990002');
 check('명칭변경+개정','옛 이름 조회(aliases)','옛 이름 → idx 24708',{idx:idxOf(revisedOld)},idxOf(revisedOld)==='24708');
 const archived=existsSync(join(dir,'r2',encodeURIComponent('raw/228379/'+samples.find((x:any)=>x.item.title==='기술용역 업무규정').raw_sha256+'/'+C.attachments[0].name)));
 check('명칭변경+개정','이전 버전 원본 보관','raw/228379/… 유지',{retained:archived},archived);
 s=sync({rows:[A,B2,C2]});
 const gone1=await tool('get_regulation',{name:'신설 시험규정'});
 check('폐지(1회 미검출)','한 번 빠진 규정은 유지(일시누락 대비)','조회 가능, active, missing_count=1',{published:s.published,result:idxOf(gone1),status:gone1.status,missing:gone1.missing_count,source:gone1.source_latest_status},idxOf(gone1)==='990001'&&gone1.status==='active'&&gone1.missing_count===1);
 s=sync({rows:[A,B2,C2]});
 const gone2=await tool('get_regulation',{name:'신설 시험규정'}),listed=await names();
 check('폐지(2회 미검출)','status=repealed로 보존, 기본 목록에서 제외','repealed 표시, 물리 삭제 없음',{result:gone2.error?.code??gone2.status,repealed_at:gone2.repealed_at,listed:listed.includes('신설 시험규정')},gone2.status==='repealed'&&Boolean(gone2.repealed_at)&&!listed.includes('신설 시험규정'));
 const withRepealed=(await tool('list_regulations',{limit:500,include_repealed:true})).results.map((r:any)=>r.regulationName),globalDefault=await tool('search_all_regulations',{query:'여비',limit:100}),globalAll=await tool('search_all_regulations',{query:'여비',limit:100,include_repealed:true}),diag=await tool('diagnose_alio_list');
 check('폐지(2회 미검출)','include_repealed=true일 때만 포함','목록·전체검색 모두 옵트인',{list:withRepealed.includes('신설 시험규정'),global_default:globalDefault.results.some((r:any)=>r.reg_id==='990001'),global_opt_in:globalAll.results.some((r:any)=>r.reg_id==='990001')},withRepealed.includes('신설 시험규정')&&!globalDefault.results.some((r:any)=>r.reg_id==='990001')&&globalAll.results.some((r:any)=>r.reg_id==='990001'));
 check('폐지(2회 미검출)','diagnose_alio_list에 폐지 내역','repealed 1건, last_changes.repealed',{repealed:diag.repealed_regulations,changes:diag.last_changes?.repealed},diag.repealed_regulations?.length===1&&diag.last_changes?.repealed?.includes('신설 시험규정'));
 s=sync({rows:[A,B2,C2,N]});
 const back=await tool('get_regulation',{name:'신설 시험규정'});
 check('폐지 후 재등장','같은 idx로 active 복귀, 재다운로드 없음','idx=990001, active, 다운로드 0',{published:s.published,idx:idxOf(back),status:back.status,downloaded:s.downloadedFiles},idxOf(back)==='990001'&&back.status==='active'&&!s.downloadedFiles.includes('990001'));
 s=sync({rows:[A,B2,C2]});s=sync({rows:[A,B2,C2,N]});
 const blip=await tool('get_regulation',{name:'신설 시험규정'});
 check('일시누락(1회) 후 복귀','계속 검색 가능, 복귀 후 missing_count=0','active, missing_count 0',{status:blip.status,missing:blip.missing_count,downloaded:s.downloadedFiles},blip.status==='active'&&blip.missing_count===0&&!s.downloadedFiles.includes('990001'));
 const before=await names();s=sync({rows:[A,B2,C2,N],returnedRows:2,totalCount:4});
 check('목록 부분응답','반영 중단, 기존 유지','sync 실패, 4건 유지',{failed:s.failed,count:(await names()).length},!s.published&&(await names()).length===before.length);
 s=sync({rows:[A,B2,C2,N],listStatus:522});
 check('목록 조회 실패(522)','반영 중단, 기존 유지','sync 실패, 4건 유지',{failed:s.failed,count:(await names()).length},!s.published&&(await names()).length===before.length);
 s=sync({rows:[A]});
 const shrinkDiag=await tool('diagnose_alio_list');
 check('목록 급감(4→1)','반영 중단(누락 5% 초과)·경고','게시 안 함, 4건 유지, list_shrink_guard',{published:s.published,failed:s.failed,count:(await names()).length,warning:shrinkDiag.warnings?.[0]?.code},!s.published&&(await names()).length===before.length&&shrinkDiag.warnings?.[0]?.code==='list_shrink_guard');
 s=sync({rows:[A,B2,C2,N,{...N,idx:'990003',attachments:[{name:'신설 시험규정(2024년도 2월 16일 개정).hwp',fileNo:'990001'}]}]});
 const same=await tool('search_regulations',{query:'신설 시험규정'});
 check('동명규정(서로 다른 idx)','두 규정 모두 색인','같은 이름 2건(idx 990001, 990003)',{published:s.published,failed:s.failed,ids:same.results?.map(idxOf)},s.published&&same.results?.length===2);
 const ambiguous=await tool('get_regulation',{name:'신설 시험규정'}),byId=await tool('get_regulation',{name:'신설 시험규정',reg_id:'990003'});
 check('동명규정(서로 다른 idx)','이름 조회는 후보 안내, reg_id로 지정','ambiguous_name + reg_id 990003 조회',{error:ambiguous.error?.code,candidates:ambiguous.error?.candidates?.map((c:any)=>c.reg_id),by_id:idxOf(byId)},ambiguous.error?.code==='ambiguous_name'&&idxOf(byId)==='990003');
}catch(error){check('harness','예외 없음','',String(error),false);}
mkdirSync('reports',{recursive:true});writeFileSync('reports/r2-lifecycle.json',JSON.stringify({scope:'unmodified scripts/r2/sync.ts with scripted ALIO and file-backed R2; production acceptance gate recorded but bypassed (fixture corpus lacks its named regulations)',results},null,1));
console.table(results.map(r=>({scenario:r.scenario,check:r.check,pass:r.pass?'PASS':'FAIL',actual:r.actual.slice(0,90)})));
rmSync(dir,{recursive:true,force:true});
