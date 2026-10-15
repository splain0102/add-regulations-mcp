import type {Database} from './load';
export async function lease(db:Database,owner:string,claim=false){
 await db.batch([{sql:`INSERT INTO publication_guard(value) SELECT CASE WHEN ${claim?"owner IS NULL OR julianday(expires_at)<julianday('now')":"owner=? AND julianday(expires_at)>=julianday('now')"} THEN 1 ELSE 0 END FROM sync_lease WHERE singleton=1`,params:claim?[]:[owner]},{sql:'UPDATE sync_lease SET owner=?,expires_at=? WHERE singleton=1',params:[owner,new Date(Date.now()+15*60000).toISOString()]},{sql:'DELETE FROM publication_guard',params:[]}]);
}
export async function release(db:Database,owner:string){await db.batch([{sql:'UPDATE sync_lease SET owner=NULL,expires_at=NULL WHERE singleton=1 AND owner=?',params:[owner]}]);}
