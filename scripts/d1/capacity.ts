import {readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {documentRecords} from './records';
const directory=process.env.D1_FIXTURE_DIRECTORY;if(!directory)throw Error('Set D1_FIXTURE_DIRECTORY to previously downloaded actual ALIO raw fixtures');
const report:any={scope:'Stored raw documents; format/materialization capacity only, not current ALIO validation',documents:[],failures:[]};
for(const file of readdirSync(directory)){
 if(!file.endsWith('.json'))continue;const source=JSON.parse(readFileSync(directory+'/'+file,'utf8'));if(!source.item||!source.document?.bytes)continue;
 const start=Date.now();try{const records=await documentRecords(source.item,{...source.document,bytes:new Uint8Array(Buffer.from(source.document.bytes,'base64'))});report.documents.push({title:source.item.title,format:records.document.extension,sections:records.sections.length,rows:records.rows.length,record_json_bytes:Buffer.byteLength(JSON.stringify(records)),elapsed_ms:Date.now()-start});console.log('D1_CAPACITY',JSON.stringify(report.documents.at(-1)));}
 catch(error){report.failures.push({title:source.item.title,error:String(error)});console.log('D1_CAPACITY_FAILED',JSON.stringify(report.failures.at(-1)));}
 writeFileSync('reports/d1-capacity.json',JSON.stringify(report,null,2));
}
report.total_record_json_bytes=report.documents.reduce((sum:number,d:any)=>sum+d.record_json_bytes,0);report.passed=report.failures.length===0;writeFileSync('reports/d1-capacity.json',JSON.stringify(report,null,2));console.log('D1_CAPACITY_FINISHED',JSON.stringify({documents:report.documents.length,failures:report.failures.length,totalRecordBytes:report.total_record_json_bytes}));
