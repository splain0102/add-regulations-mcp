import {createHash} from 'node:crypto';
import {prepareSearchSections} from '../../src/regulation-core/search-sections';
import {extractHwpTables,extractHwpxTables,structureTables,extractPdfLayout,versionCheck} from '../../src/regulation-core/table-layout';
import {extractPdfRichContent,buildPdfStructuredMatches,detectKnownPdfHeader} from '../../src/regulation-core/pdf-regression-layout';
import {searchLatestRegulationTable} from '../../src/regulation-core/regulations';
import {searchGeneralTables} from '../../src/regulation-core/general-table-search';
import {normalize,normalizeWithMap,normalizeName,grams,INDEX_SCHEMA_VERSION} from '../../src/d1/normalize';
import {PARSER_VERSION} from '../../src/regulation-core/parser-version';
export const hash=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex');
export type RecordRow={table_key:string;analysis_type:string;coordinate_space:string;headers:unknown;source_row_number:number;page_number:number|null;text_original:string;match:Record<string,any>;result:Record<string,any>};
export async function documentRecords(item:any,loaded:any){
 const bytes=new Uint8Array(loaded.bytes),extension=bytes[0]===0x25?'pdf':bytes[0]===0x50?'hwpx':'hwp';
 const filename=loaded.attachments?.find((a:any)=>a.fileNo===loaded.fileNo)?.name??item.title+'.'+extension;
 const sha256=hash(bytes),metadata_sha256=hash(JSON.stringify(item));
 const document_id=hash(JSON.stringify([item.detailUrl,loaded.fileNo,sha256,metadata_sha256,PARSER_VERSION,INDEX_SCHEMA_VERSION]));
 const regulation_id=new URL(item.detailUrl).searchParams.get('idx');if(!regulation_id)throw Error('missing_alio_rule_id');
 const source_url=item.detailUrl,raw_r2_key=`raw/${loaded.fileNo}/${sha256}/${filename}`,snapshot_r2_key=`parsed/${document_id}.json`;
 const document={document_id,regulation_id,title:item.title,title_normalized:normalizeName(item.title),st_date:item.revisionDate??null,i_date:item.updatedDate??null,file_no:loaded.fileNo,filename,extension,sha256,metadata_sha256,parser_version:PARSER_VERSION,index_schema_version:INDEX_SCHEMA_VERSION,source_url,raw_r2_key,snapshot_r2_key,selection_evidence_json:JSON.stringify({selectedDate:loaded.selectedDate,attachments:loaded.attachments}),validation_json:JSON.stringify(versionCheck(item.revisionDate,loaded.selectedDate,loaded.text))};
 const bounds=prepareSearchSections(loaded.text),sections=bounds.bounds.slice(0,-1).filter((at:number)=>!bounds.excluded?.includes(at)).map((at:number,i:number)=>{
  const text=loaded.text.slice(at,bounds.bounds[bounds.bounds.indexOf(at)+1]),label=text.trim().split('\n')[0]||'전문';
  const kind=/서식/.test(label)?'form':/별[표지]/.test(label)?'annex':/^부\s*칙/.test(label)?'supplement':/^제\s*\d+\s*조/.test(label)?'article':'preamble';
  if(Buffer.byteLength(text)>500000)throw Error('section_record_size_limit');
  return {ordinal:i,kind,section_label:label,article_number:label.match(/^제\s*\d+\s*조(?:의\s*\d+)?/)?.[0].replace(/\s/g,'')??null,part_number:0,text_original:text,text_normalized:normalize(text),grams:grams(label+' '+text).join(' '),evidence_json:JSON.stringify({start:at,end:at+text.length,normalization_map:normalizeWithMap(text)})};
 });
 const rows:RecordRow[]=[];
 if(extension!=='pdf'){
  const tables=extension==='hwp'?extractHwpTables(bytes):extractHwpxTables(bytes),structured=structureTables(tables,loaded.text);
  const all=searchGeneralTables(tables,'',structured,extension,{allRows:true});
  for(const row of all){const evidence:any=row.header_evidence,physical=(row.raw_cells as any[])??[],table=tables.find(t=>t.id===row.table_id)!;
   const headerRows=evidence?.rows?.map((r:any)=>r.row)??[];
   const dataRows=[...new Set(table.cells.map(c=>c.row))].filter(r=>!headerRows.includes(r)).slice(0,20);
   const headerAliases=dataRows.includes(row.row)?table.cells.filter(c=>headerRows.includes(c.row)).map(c=>normalize(c.text)):[];
   const isHeader=headerRows.includes(row.row),suppressHeader=isHeader&&dataRows.length>0;
   const paths=((row.cells as any[])??physical).map((c:any)=>normalize([...(c.header_path??[]).map((h:any)=>h.text),c.text].join(' ')));
   rows.push({table_key:row.table_id,analysis_type:String(row.analysis_type),coordinate_space:row.coordinate_space,headers:evidence,source_row_number:row.row,page_number:row.page,text_original:physical.map((c:any)=>c.text).join(' '),match:{cells:suppressHeader?[]:physical.filter((c:any)=>c.row===row.row).map((c:any)=>normalize(c.text)),row:normalize(physical.map((c:any)=>c.text).join(' ')),aliases:headerAliases,paths:isHeader?paths:[]},result:row});
  }
 }else{
  const [layout,rich]=await Promise.all([extractPdfLayout(bytes),extractPdfRichContent(bytes)]);if(rich.layoutSkippedReason)throw Error(rich.layoutSkippedReason);
  const meta={regulationName:item.title,revisionDate:item.revisionDate,updatedDate:item.updatedDate,sourceUrl:item.detailUrl,filename,extension,fileNo:loaded.fileNo,parser_version:PARSER_VERSION,version_check:JSON.parse(document.validation_json),version_warning:null,selection_reason:[],other_attachments:[],cache:{key:document_id,hit:false,scope:'offline',metadataRevalidated:true}};
  const prepared={document:{file:{bytes,extension,filename},text:loaded.text,rows:layout.rows,pdfPages:rich.pages,layoutDebug:layout.debug},cache:meta.cache} as any;
  const result=await searchLatestRegulationTable(item.title,'',prepared,meta as any,{allRows:true});
  for(const row of result.rows){const text=String(row.raw_text??[row.task,row.condition].filter(Boolean).join(' '));
   rows.push({table_key:row.table_id,analysis_type:String(row.analysis_type),coordinate_space:row.coordinate_space,headers:row.header_evidence,source_row_number:row.row,page_number:row.page,text_original:text,match:{cells:[normalize(text)],row:normalize(text),aliases:[],paths:[]},result:row});
  }
 }
 for(const row of rows){(row as any).grams=grams([row.text_original,...row.match.aliases,...row.match.paths].join(' ')).join(' ');if(Buffer.byteLength(JSON.stringify(row))>500000)throw Error('table_record_size_limit');}
 return {document,sections,rows};
}
