import {hash} from './records';
export type Database={query:(sql:string,params?:any[])=>Promise<any[]>;batch:(rows:{sql:string;params:any[]}[])=>Promise<void>};
const statement=(table:string,row:Record<string,any>)=>({sql:`INSERT OR IGNORE INTO ${table} (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(()=>'?').join(',')})`,params:Object.values(row)});
export async function loadDocument(db:Database,records:any){
 const d=records.document,exists=await db.query('SELECT indexed_at FROM documents WHERE document_id=?',[d.document_id]);if(exists[0]?.indexed_at)return;
 // Partial immutable documents are not publishable until every declared record exists.
 const statements=[{sql:'INSERT OR IGNORE INTO regulations(regulation_id,alio_rule_no,detail_url) VALUES(?,?,?)',params:[d.regulation_id,d.regulation_id,d.source_url]},statement('documents',d)];
 // A document is loaded in a bounded batch sequence. On retry remove only this
 // unpublished document's partial rows; never touch active/previous snapshots.
 await db.batch(statements);
 try{
  for(let i=0;i<records.sections.length;i+=20)await db.batch(records.sections.slice(i,i+20).map((s:any)=>statement('sections',{document_id:d.document_id,...s})));
  const keys=[...new Set(records.rows.map((r:any)=>r.table_key))];
  for(const key of keys){const rows=records.rows.filter((r:any)=>r.table_key===key),r=rows[0];
   await db.batch([statement('table_definitions',{document_id:d.document_id,table_key:key,analysis_type:r.analysis_type,coordinate_space:r.coordinate_space,header_evidence_json:JSON.stringify(r.headers??{})})]);
   const [table]=await db.query('SELECT table_pk FROM table_definitions WHERE document_id=? AND table_key=?',[d.document_id,key]);
   for(let i=0;i<rows.length;i+=10)await db.batch(rows.slice(i,i+10).map((r:any,j:number)=>statement('table_rows',{table_pk:table.table_pk,record_number:i+j,source_row_number:r.source_row_number,page_number:r.page_number,text_original:r.text_original,text_normalized:r.match.row,match_json:JSON.stringify(r.match),grams:r.grams,task:r.result.task??null,condition_text:r.result.condition??null,amount_evidence_json:JSON.stringify({condition:r.result.condition??null}),approval_evidence_json:JSON.stringify(r.result.approvers??[]),raw_cells_json:JSON.stringify(r.result.raw_cells??[]),footnotes_json:JSON.stringify(r.result.footnotes??[]),parser_result_json:JSON.stringify(r.result),needs_review:r.result.needs_review?1:0})));
  }
  const [counts]=await db.query('SELECT (SELECT count(*) FROM sections WHERE document_id=?) AS sections,(SELECT count(*) FROM table_rows r JOIN table_definitions t ON t.table_pk=r.table_pk WHERE t.document_id=?) AS rows',[d.document_id,d.document_id]);
  if(counts.sections!==records.sections.length||counts.rows!==records.rows.length)throw Error('document_count_mismatch');
  await db.batch([{sql:'UPDATE documents SET indexed_at=?,expected_sections=?,expected_rows=? WHERE document_id=?',params:[new Date().toISOString(),records.sections.length,records.rows.length,d.document_id]}]);
 }catch(error){/* Keep deterministic partial rows for quota/network retry. They remain unpublished. */throw error;}
}
export async function discardUnpublished(db:Database,id:string){
 const [used]=await db.query('SELECT count(*) AS n FROM catalog_entries WHERE document_id=?',[id]);if(used.n)throw Error('refuse_to_delete_referenced_document');
 await db.batch([{sql:'DELETE FROM table_rows WHERE table_pk IN(SELECT table_pk FROM table_definitions WHERE document_id=?)',params:[id]},{sql:'DELETE FROM table_definitions WHERE document_id=?',params:[id]},{sql:'DELETE FROM sections WHERE document_id=?',params:[id]},{sql:'DELETE FROM documents WHERE document_id=?',params:[id]}]);
}
export async function publishCatalog(db:Database,runId:string,catalog:any,previous:string|null){
 if(new Set(catalog.documents.map((d:any)=>d.document_id)).size!==catalog.items.length)throw Error('duplicate_catalog_document');
 for(let i=0;i<catalog.documents.length;i+=40){const ids=catalog.documents.slice(i,i+40).map((d:any)=>d.document_id);const ready=await db.query(`SELECT document_id FROM documents d WHERE document_id IN (${ids.map(()=>'?').join(',')}) AND indexed_at IS NOT NULL AND expected_sections=(SELECT count(*) FROM sections WHERE document_id=d.document_id) AND expected_rows=(SELECT count(*) FROM table_rows r JOIN table_definitions t ON r.table_pk=t.table_pk WHERE t.document_id=d.document_id)`,ids);if(ready.length!==ids.length)throw Error('catalog_document_not_ready');}
 const snapshot=hash(JSON.stringify([runId,catalog.documents.map((d:any)=>d.document_id)]));
 await db.batch([{sql:'INSERT INTO catalog_snapshots(snapshot_id,run_id,created_at) VALUES(?,?,?)',params:[snapshot,runId,catalog.verified_at]}]);
 for(let i=0;i<catalog.documents.length;i+=40)await db.batch(catalog.documents.slice(i,i+40).map((d:any)=>statement('catalog_entries',{snapshot_id:snapshot,regulation_id:new URL(d.item.detailUrl).searchParams.get('idx'),document_id:d.document_id,is_current:1,verified_at:d.verified_at})));
 const [counts]=await db.query('SELECT count(*) AS n FROM catalog_entries c JOIN documents d ON d.document_id=c.document_id WHERE c.snapshot_id=? AND d.indexed_at IS NOT NULL AND d.expected_sections=(SELECT count(*) FROM sections WHERE document_id=d.document_id) AND d.expected_rows=(SELECT count(*) FROM table_rows r JOIN table_definitions t ON r.table_pk=t.table_pk WHERE t.document_id=d.document_id)',[snapshot]);if(counts.n!==catalog.items.length)throw Error('catalog_count_mismatch');
 // The guarded update uses a CHECK-constrained assertion table to roll back the
 // complete publication batch if another publisher moved the active pointer.
 await db.batch([{sql:"INSERT INTO publication_guard(value) SELECT CASE WHEN owner=? AND julianday(expires_at)>=julianday('now') THEN 1 ELSE 0 END FROM sync_lease WHERE singleton=1",params:[runId]},{sql:'UPDATE catalog_snapshots SET validated_at=? WHERE snapshot_id=?',params:[catalog.verified_at,snapshot]},{sql:'INSERT INTO publication_guard(value) SELECT CASE WHEN active_snapshot_id IS ? THEN 1 ELSE 0 END FROM service_state WHERE singleton=1',params:[previous]},{sql:'UPDATE service_state SET previous_snapshot_id=active_snapshot_id,active_snapshot_id=?,last_success_at=?,last_full_sha_check_at=CASE WHEN ? THEN ? ELSE last_full_sha_check_at END WHERE singleton=1',params:[snapshot,catalog.verified_at,catalog.full_sha_verified?1:0,catalog.verified_at]},{sql:"UPDATE sync_runs SET status='published',finished_at=?,verified_count=? WHERE run_id=?",params:[catalog.verified_at,catalog.items.length,runId]},{sql:'DELETE FROM publication_guard',params:[]}]);
 return snapshot;
}
