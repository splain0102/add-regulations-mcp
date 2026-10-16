// Derived D1 mirror against local workerd D1 with both migrations applied and the
// three real fixture HWPs (위임전결규정, 여비규정, 기술용역 업무규정).
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {hwpToText} from '@ssabrojs/hwpxjs/browser';
import {documentRecords,hash} from './records';
import {mirrorToD1,type Database} from './mirror';
import {buildR2Catalog,type StoredDocument} from '../r2/build';
import {ROOT} from '../../src/r2/types';
const report:any={passed:false,scope:'Local workerd D1 with the three fixture regulations; production row counts are measured on the first real load',tests:[],rows_written:{}};
const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("")}}',d1Databases:{DB:'mirror'}}));
try{
 const d1=await mf.getD1Database('DB');
 const migrate=async(file:string)=>d1.exec(readFileSync(file,'utf8').split('\n').filter(l=>!l.trim().startsWith('--')).join(' '));
 // Old schema with data, then the new migration: old tables go, the usage ledger stays.
 await migrate('migrations/0001_regulation_index.sql');
 await d1.prepare("INSERT INTO sync_usage(day,run_id,rows_written) VALUES('2026-10-15','old',79999)").run();
 await migrate('migrations/0002_derived_index.sql');
 await migrate('migrations/0003_delegation_scope.sql');
 const tables=(await d1.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name").all()).results.map((r:any)=>r.name);
 assert(!tables.some((t:string)=>/fts|sections|table_rows|catalog_entries|documents/.test(t)),tables.join());assert(['regulations','versions','units','approvals','sync_state','sync_usage','current_units','current_approvals'].every(t=>tables.includes(t)),tables.join());
 assert.equal((await d1.prepare('SELECT rows_written FROM sync_usage').first<any>())?.rows_written,79999);
 report.tests.push('0002 drops the FTS-based schema, keeps the daily write ledger and creates the derived tables and views');
 let written=0,failAfter=Infinity,batches=0;
 const db:Database={query:async(sql,params=[])=>(await d1.prepare(sql).bind(...params).all()).results,batch:async rows=>{if(++batches>failAfter)throw Error('d1_daily_write_budget_reached');const r=await d1.batch(rows.map(x=>d1.prepare(x.sql).bind(...x.params)));written+=r.reduce((n,x)=>n+(x.meta.rows_written??0),0);}};
 const samples=JSON.parse(gunzipSync(Buffer.from(readFileSync('scripts/fixtures/d1-samples.json.gz.b64','utf8'),'base64')).toString()),stored:StoredDocument[]=[];
 for(const s of samples){const loaded={...s.document,bytes:new Uint8Array(Buffer.from(s.document.bytes,'base64'))};assert.equal(hash(loaded.bytes),s.raw_sha256);loaded.text=await hwpToText(loaded.bytes);stored.push({records:await documentRecords(s.item,loaded),loaded});}
 const values=new Map<string,Uint8Array>();
 const publish=(docs:StoredDocument[],tag:string,patch:(c:any)=>any=c=>c)=>{const built=buildR2Catalog(docs,tag);for(const [k,v] of built.objects)values.set(k,v);const catalog=patch(built.catalog),bytes=new TextEncoder().encode(JSON.stringify(catalog)),sha=hash(bytes),key=`r2-index/objects/${sha}.json`;values.set(key,bytes);values.set(ROOT,new TextEncoder().encode(JSON.stringify({format:1,catalog:{key,sha256:sha,bytes:bytes.length},published_at:new Date().toISOString(),build_version:tag,count:catalog.documents.length})));for(const d of docs)values.set(d.records.document.snapshot_r2_key,new TextEncoder().encode(JSON.stringify({records:d.records,loaded:{...d.loaded,bytes:undefined}})));return catalog;};
 const store=async(_m:'GET',key:string)=>{const v=values.get(key);if(!v)throw Error('R2 GET HTTP 404');return v;};
 const run=async()=>{written=0;batches=0;const r=await mirrorToD1({store,db,log:()=>{}});return {...r,written};};
 const one=async(sql:string,...p:any[])=>(await d1.prepare(sql).bind(...p).first<any>());
 // Old-parser catalog: wait for the re-index instead of loading soon-to-be-stale rows.
 publish(stored,'old-parser',c=>({...c,parser_version:'0.0.0-old'}));
 let r:any=await run();assert.equal(r.status,'waiting_for_reindex');assert.equal(r.written,0);report.tests.push('catalog from an older parser is not mirrored (waits for the R2 re-index)');
 // First load.
 publish(stored,'first');r=await run();assert.equal(r.status,'loaded');
 report.rows_written.first_load=r.written;report.first_load={replaced:r.replaced,totals:r.totals};
 const perReg=await Promise.all(stored.map(async s=>({title:s.records.document.title,sections:s.records.sections.length,table_rows:s.records.rows.length,units:(await one('SELECT count(*) n FROM current_units WHERE reg_id=?',s.records.document.regulation_id)).n,approvals:(await one('SELECT count(*) n FROM current_approvals WHERE reg_id=?',s.records.document.regulation_id)).n})));report.per_regulation=perReg;
 assert.equal(r.totals.regulations,3);for(const p of perReg)assert(p.units<=p.sections+p.table_rows&&p.units>=p.sections);
 const delegation=stored.find(s=>s.records.document.title==='위임전결규정')!.records.document.regulation_id;
 assert.equal((await one("SELECT count(*) n FROM current_approvals WHERE reg_id=? AND task='8) 공무국외출장'",delegation)).n,8);
 // 공통(전 부서) / 개별(해당 부서) scope from the [별표] headings; individual rows name their department.
 const scopeCounts=Object.fromEntries((await d1.prepare("SELECT coalesce(scope,'none') s,count(*) n FROM current_approvals WHERE reg_id=? GROUP BY s").bind(delegation).all()).results.map((r:any)=>[r.s,r.n]));
 assert(scopeCounts.common>100&&scopeCounts.individual>600,JSON.stringify(scopeCounts));
 assert.equal((await one("SELECT count(*) n FROM current_approvals WHERE reg_id=? AND scope='individual' AND department IS NOT category",delegation)).n,0);
 assert.equal((await one("SELECT count(*) n FROM current_approvals WHERE reg_id=? AND scope='common' AND department IS NOT NULL",delegation)).n,0);
 const planning=(await one("SELECT department d FROM current_approvals WHERE reg_id=? AND scope='individual' AND task LIKE '%연구소 경영정책%' LIMIT 1",delegation))?.d;assert.match(String(planning),/정책기획부/);
 report.scope_counts=scopeCounts;report.tests.push(`공통/개별 위임전결: ${JSON.stringify(scopeCounts)}; individual rows carry their department (e.g. ${planning})`);
 const director=(await one("SELECT count(*) n FROM current_approvals WHERE reg_id=? AND approver='소장'",delegation)).n,review=(await one('SELECT count(*) n FROM current_approvals WHERE needs_review=1')).n;assert(director>0);
 const byCategory=(await d1.prepare("SELECT category,count(*) n FROM current_approvals WHERE reg_id=? GROUP BY category ORDER BY n DESC LIMIT 3").bind(delegation).all()).results;
 report.stats_examples={director_approvals:director,needs_review:review,top_categories:byCategory};
 const unit=await one("SELECT label,text FROM current_units WHERE reg_id=? AND label LIKE '부칙(2024.2.16.) 제1조%'",stored.find(s=>s.records.document.title==='여비규정')!.records.document.regulation_id);assert(unit?.text.includes('2024년 2월 16일'),JSON.stringify(unit));
 report.tests.push(`first load: 3 regulations, ${r.totals.units} units, ${r.totals.approvals} approval rows in ${r.written} rows written; SQL statistics (소장 전결 ${director}건, 검토 필요 ${review}건) and 부칙 labels`);
 // Same catalog again: nothing written.
 r=await run();assert.equal(r.status,'unchanged');assert.equal(r.written,0);report.tests.push('unchanged catalog writes nothing');
 // One regulation revised: only it is rewritten; its old generation disappears; version history kept.
 const travel=stored.find(s=>s.records.document.title==='여비규정')!,revised=structuredClone(travel);revised.records.document={...revised.records.document,document_id:hash('travel-revision'),file_no:'999001',st_date:'2026.10.15'};
 const before=(await one('SELECT count(*) n FROM units')).n;publish([stored[0],revised,stored[2]].map(s=>s===stored[0]&&stored[0]===travel?revised:s).map(s=>s.records.document.title==='여비규정'?revised:s),'revised');
 r=await run();assert.equal(r.replaced,1);report.rows_written.one_revision=r.written;
 const reg=revised.records.document.regulation_id;assert.equal((await one('SELECT count(*) n FROM units u JOIN regulations g ON g.reg_id=u.reg_id WHERE u.reg_id=? AND u.generation<>g.generation',reg)).n,0);assert.equal((await one('SELECT current_file_no f FROM regulations WHERE reg_id=?',reg)).f,'999001');assert.equal((await one('SELECT count(*) n FROM versions WHERE reg_id=?',reg)).n,2);assert.equal((await one('SELECT count(*) n FROM units')).n,before);
 report.tests.push(`one revised regulation: only it is rewritten (${r.written} rows), superseded rows removed, both versions kept in history`);
 // Lifecycle-only change (rename alias, repeal status): regulation row update only.
 const docs=[stored[0],revised,stored[2]].map(s=>s.records.document.title==='여비규정'?revised:s);
 publish(docs,'lifecycle',c=>({...c,documents:c.documents.map((d:any)=>d.regulation_id===reg?{...d,aliases:['구 여비규정'],missing_count:1}:d)}));r=await run();assert.equal(r.replaced,0);assert.equal(r.touched,1);assert.equal((await one('SELECT aliases_json a FROM regulations WHERE reg_id=?',reg)).a,'["구 여비규정"]');report.rows_written.lifecycle_only=r.written;
 report.tests.push(`lifecycle-only change updates just the regulation row (${r.written} rows)`);
 // Interrupted by the daily budget mid-way, then resumed: consistent, no duplicates.
 const fresh=docs.map(s=>({...s,records:{...s.records,document:{...s.records.document,document_id:hash('again-'+s.records.document.document_id)}}}));publish(fresh,'resume');
 failAfter=2;await assert.rejects(()=>mirrorToD1({store,db,log:()=>{}}),/d1_daily_write_budget_reached/);failAfter=Infinity;
 assert.notEqual((await one('SELECT catalog_sha s FROM sync_state')).s,JSON.parse(new TextDecoder().decode(values.get(ROOT)!)).catalog.sha256);
 r=await run();assert.equal(r.status,'loaded');for(const s of fresh){const id=s.records.document.regulation_id;assert.equal((await one('SELECT count(*) n FROM current_units WHERE reg_id=?',id)).n,(await one('SELECT count(*) n FROM units WHERE reg_id=?',id)).n,'stale generation left for '+id);}
 report.tests.push('interrupted by the daily write budget and resumed: completes with no stale or duplicate rows');
 // A regulation the catalog drops entirely leaves D1.
 publish(fresh.slice(0,2),'dropped');r=await run();assert.equal(r.removed,1);assert.equal((await one('SELECT count(*) n FROM regulations')).n,2);assert.equal((await one('SELECT count(*) n FROM units WHERE reg_id=?',fresh[2].records.document.regulation_id)).n,0);
 report.tests.push('regulation absent from the catalog is removed from D1');
 report.passed=true;
}catch(error){report.error=String(error);process.exitCode=1;}
finally{mkdirSync('reports',{recursive:true});writeFileSync('reports/d1-mirror.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));await mf.dispose();}
