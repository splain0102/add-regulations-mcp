import {lease,release} from './lease';
import {remoteDatabase,r2Store} from './remote';
import {collectCatalog} from './collect';
import {loadDocument,publishCatalog} from './load';
import {hash} from './records';
import {BUILD_VERSION} from '../../src/build-info';
const run=crypto.randomUUID(),db=remoteDatabase(run),r2=r2Store(),start=new Date().toISOString();let currentTitle='ALIO list',currentStage='list';
await lease(db,run,true);
let leaseError:unknown,heartbeat:Promise<void>=Promise.resolve();const timer=setInterval(()=>{heartbeat=heartbeat.then(()=>lease(db,run)).catch(error=>{leaseError=error;});},60000);
try{
await db.batch([{sql:"UPDATE sync_runs SET status='failed',failure_count=failure_count+1,finished_at=? WHERE status='running' AND julianday(started_at)<julianday('now','-1 hour')",params:[start]}]);
const [state]=await db.query('SELECT active_snapshot_id,last_full_sha_check_at FROM service_state WHERE singleton=1');
await db.batch([{sql:"INSERT INTO sync_runs(run_id,build_sha,started_at,status) VALUES(?,?,?,'running')",params:[run,BUILD_VERSION,start]}]);
 const prior=await db.query('SELECT * FROM documents WHERE indexed_at IS NOT NULL ORDER BY indexed_at DESC');
 const forceSha=process.env.FORCE_SHA==='true'||!state?.last_full_sha_check_at||Date.now()-Date.parse(state.last_full_sha_check_at)>7*86400000;
 const catalog=await collectCatalog({prior,forceSha,readPrevious:async d=>({...JSON.parse(new TextDecoder().decode(await r2('GET',(d as any).snapshot_r2_key))).loaded,sha256:d.sha256,fileNo:d.file_no,parserVersion:d.parser_version}),save:async(item,loaded,records)=>{
  currentTitle=item.title;await r2('PUT',records.document.raw_r2_key,loaded.bytes);const previous={...loaded,bytes:undefined},snapshotBytes=new TextEncoder().encode(JSON.stringify({records,loaded:previous}));await r2('PUT',records.document.snapshot_r2_key,snapshotBytes);if(hash(await r2('GET',records.document.snapshot_r2_key))!==hash(snapshotBytes))throw Error('r2_snapshot_checksum_mismatch');
  if(hash(await r2('GET',records.document.raw_r2_key))!==records.document.sha256)throw Error('r2_original_checksum_mismatch');
  await loadDocument(db,records);
 },progress:async p=>{currentTitle=p.title;currentStage=p.stage??'document';console.log('D1_SYNC_PROGRESS',JSON.stringify(p));await db.batch([{sql:'UPDATE sync_runs SET expected_count=?,verified_count=?,checkpoint_json=? WHERE run_id=?',params:[p.total,p.processed,JSON.stringify(p),run]}]);}});
 if(leaseError)throw leaseError;
 const snapshot=await publishCatalog(db,run,{...catalog,full_sha_verified:forceSha},state?.active_snapshot_id??null);console.log('D1_SYNC_PUBLISHED',JSON.stringify({run,snapshot,count:catalog.items.length}));
}catch(error){currentTitle=(error as any).title??currentTitle;currentStage=(error as any).stage??currentStage;await db.batch([{sql:"INSERT OR IGNORE INTO sync_runs(run_id,build_sha,started_at,status) VALUES(?,?,?,'failed')",params:[run,BUILD_VERSION,start]},{sql:'INSERT INTO sync_failures(run_id,regulation_id,stage,error_code,observed_metadata_json,checked_at) VALUES(?,?,?,?,?,?)',params:[run,currentTitle,currentStage,/timeout|abort|fetch/i.test(String(error))?'fetch_failed':'sync_failed',JSON.stringify({message:String(error).slice(0,300)}),new Date().toISOString()]},{sql:"UPDATE sync_runs SET status='failed',finished_at=?,failure_count=failure_count+1,checkpoint_json=? WHERE run_id=?",params:[new Date().toISOString(),JSON.stringify({title:currentTitle,error:String(error).slice(0,300)}),run]}]);console.error('D1_SYNC_FAILED',String(error));process.exitCode=1;}

finally{clearInterval(timer);await heartbeat;await release(db,run);}
