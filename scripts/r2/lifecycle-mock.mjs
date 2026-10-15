// Preload for scripts/r2/lifecycle.ts: runs the unmodified scripts/r2/sync.ts
// against a scripted ALIO and a file-backed S3-compatible R2. No network.
import {registerHooks} from 'node:module';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,existsSync,mkdirSync,readdirSync,appendFileSync} from 'node:fs';
import {join} from 'node:path';
const dir=process.env.LIFECYCLE_DIR,scenario=JSON.parse(readFileSync(join(dir,'scenario.json'),'utf8')),objects=join(dir,'r2');mkdirSync(objects,{recursive:true});
const files=new Map(Object.entries(JSON.parse(readFileSync(join(dir,'files.json'),'utf8'))).map(([k,v])=>[k,Buffer.from(v,'base64')]));
const file=key=>join(objects,encodeURIComponent(key)),etag=bytes=>'"'+createHash('md5').update(bytes).digest('hex')+'"';
const log=entry=>appendFileSync(join(dir,'requests.log'),JSON.stringify(entry)+'\n');
// Production acceptance queries regulations absent from the three-sample corpus.
// The publish wrapper records that gate instead of letting it block every step.
registerHooks({resolve(specifier,context,next){if(specifier==='./publish'&&context.parentURL?.endsWith('/scripts/r2/sync.ts'))return next('./lifecycle-publish.ts',context);return next(specifier,context);}});
const detail=row=>`<table><tr><th>구분</th><td>내부규정</td></tr><tr><th>제목</th><td>${row.title}</td></tr><tr><th>제·개정일</th><td>${row.stDate}</td></tr><tr><th>최종수정일</th><td>${row.idate}</td></tr><tr><th>파일</th><td>${row.attachments.map(a=>`<a href="/download/rulefiledown.json?fileNo=${a.fileNo}">${a.name}</a>`).join('<br>')}</td></tr></table>`;
globalThis.fetch=async(input,init={})=>{
 const url=new URL(String(input instanceof Request?input.url:input)),method=(init.method??'GET').toUpperCase();
 if(url.host.endsWith('.r2.cloudflarestorage.com')){
  const key=decodeURIComponent(url.pathname.split('/').slice(2).join('/')),headers=new Headers(init.headers);
  if(method==='GET'&&url.searchParams.get('list-type')==='2'){const keys=readdirSync(objects).map(decodeURIComponent).sort();return new Response(`<ListBucketResult>${keys.map(k=>`<Contents><Key>${k.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</Key><Size>${readFileSync(file(k)).length}</Size></Contents>`).join('')}</ListBucketResult>`);}
  if(method==='GET'){if(!existsSync(file(key)))return new Response('',{status:404});const bytes=readFileSync(file(key));return new Response(bytes,{headers:{etag:etag(bytes)}});}
  const current=existsSync(file(key))?readFileSync(file(key)):undefined,ifMatch=headers.get('if-match'),ifNone=headers.get('if-none-match');
  if(ifMatch&&(!current||etag(current)!==ifMatch)||ifNone==='*'&&current)return new Response('',{status:412});
  const bytes=Buffer.from(await new Response(init.body).arrayBuffer());writeFileSync(file(key),bytes);return new Response('',{headers:{etag:etag(bytes)}});
 }
 if(url.host!=='www.alio.go.kr')throw Error('lifecycle: unexpected network '+url.host);
 if(url.pathname==='/item/itemReportListSusi.json'){log({alio:'list'});if(scenario.listStatus)return new Response('',{status:scenario.listStatus});const rows=scenario.rows.map(r=>({title:r.title,apbaId:'C0345',idx:r.idx,reportFormNo:'21110',tableName:'COMM_RULE',idxName:'RULE_NO',reportGbn:'N',bidType:'K1400',stDate:r.stDate,idate:r.idate}));return Response.json({data:{result:rows.slice(0,scenario.returnedRows??rows.length),page:{totalPage:1,totalCount:scenario.totalCount??rows.length}}});}
 if(url.pathname==='/item/itemBoard21110.do'){const row=scenario.rows.find(r=>r.idx===url.searchParams.get('idx'));log({alio:'detail',idx:url.searchParams.get('idx')});return row?new Response(detail(row),{headers:{'content-type':'text/html'}}):new Response('',{status:404});}
 if(url.pathname==='/download/rulefiledown.json'){const fileNo=url.searchParams.get('fileNo'),bytes=files.get(fileNo);log({alio:'download',fileNo});if(!bytes)return new Response('',{status:404});const name=scenario.rows.flatMap(r=>r.attachments).find(a=>a.fileNo===fileNo)?.name??fileNo+'.hwp';return new Response(bytes,{headers:{'content-type':'application/octet-stream','content-disposition':`attachment; filename*=UTF-8''${encodeURIComponent(name)}`}});}
 return new Response('',{status:404});
};
