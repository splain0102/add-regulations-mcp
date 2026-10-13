import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
export function exportSnapshot(entries,report){
 if(!report.passed||report.indexed!==report.total||report.result?.partial!==false||report.result?.errors?.count!==0||!report.audit?.fileNo||!report.security?.matches.some(m=>m.label.includes('제8조')))throw Error('Complete ALIO acceptance required before bootstrap export.');
 const values=new Map(entries),state=JSON.parse(values.get('add:corpus:v2:state'));
 if(state.items.length!==report.total)throw Error('Checkpoint/list count mismatch.');
 const shards=Array.from({length:16},(_,id)=>{const documents=state.refs[id]?JSON.parse(values.get(state.refs[id])).documents:{};for(const [title,doc] of Object.entries(documents))doc.verifiedAt=state.checked[title]??doc.verifiedAt;return {id,documents,sha256:createHash('sha256').update(JSON.stringify({documents})).digest('hex')};});
 return {items:state.items,source_verified_at:report.finishedAt,source_build_version:report.result.index_build_version,parser_version:shards.flatMap(s=>Object.values(s.documents))[0]?.parserVersion,shards};
}
export async function uploadSnapshot(snapshot,send){
 const begin=await send('begin',{items:snapshot.items,source_verified_at:snapshot.source_verified_at,source_build_version:snapshot.source_build_version,parser_version:snapshot.parser_version,reuse_shards:snapshot.shards.map(({id,sha256})=>({id,sha256}))});
 for(const shard of snapshot.shards)if(!begin.reused_shards?.includes(shard.id))await send('shard',{session_id:begin.session_id,...shard});
 return send('activate',{session_id:begin.session_id});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const mode=process.argv[2],file=process.argv[3]||'reports/corpus-index-bootstrap.json';
 if(mode==='export'){
  const snapshot=exportSnapshot(JSON.parse(readFileSync('reports/corpus-index-live-checkpoint.json','utf8')),JSON.parse(readFileSync('reports/corpus-index-acceptance.json','utf8')));
  writeFileSync(file,JSON.stringify(snapshot));console.log(JSON.stringify({exported:file,total:snapshot.items.length,source_verified_at:snapshot.source_verified_at}));
 }else if(mode==='upload'){
  const token=process.env.INDEX_ADMIN_TOKEN;if(!token)throw Error('Set INDEX_ADMIN_TOKEN in the environment.');
  const origin=process.env.INDEX_ORIGIN||'https://add-regulations-mcp.splain0102.workers.dev';
  const send=async(path,body)=>{
   for(let attempt=0;attempt<4;attempt++){
    // Begin is not retried after ambiguous transport failure: it creates a session.
    try{const response=await fetch(new URL('/admin/bootstrap-index/'+path,origin),{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(60000)});const result=await response.json();if(response.ok)return result;if((response.status===429||response.status>=500)&&attempt<3&&path!=='begin'){await new Promise(resolve=>setTimeout(resolve,2000*(attempt+1)));continue;}throw Error('Bootstrap '+path+' HTTP '+response.status+': '+JSON.stringify(result));}
    catch(error){if(path==='begin'||attempt===3||String(error).includes(' HTTP '))throw error;await new Promise(resolve=>setTimeout(resolve,2000*(attempt+1)));}
   }
  };
  console.log(JSON.stringify(await uploadSnapshot(JSON.parse(readFileSync(file,'utf8')),send)));
 }else throw Error('Usage: bootstrap-index.mjs export|upload [snapshot.json]');
}
