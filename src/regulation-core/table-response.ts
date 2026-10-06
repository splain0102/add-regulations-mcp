import type {SearchTableRow} from './general-table-search';

type Result={rows:SearchTableRow[];[key:string]:unknown};
type Options={compact?:boolean;offset?:number;limit?:number;includeRegion?:boolean};
const commonKeys=['table_id','row','analysis_type','needs_review'];
const delegationKeys=['category','task','condition','approver','approvers','symbol','suffix','legend','footnotes','confidence','multi_approver','approver_type'];
function compactRow(row:SearchTableRow){
 const value:Record<string,unknown>=Object.fromEntries(commonKeys.map(k=>[k,row[k]??null]));
 if(row.analysis_type==='delegation_table'){
  for(const key of delegationKeys)value[key]=row[key]??(key==='footnotes'||key==='approvers'?[]:key==='multi_approver'?false:null);
  if(Array.isArray(row.related_regulations)&&row.related_regulations.length)value.related_regulations=row.related_regulations;
 }else value.values=row.values??{};
 if(row.coordinate_type==='pdf_point')Object.assign(value,{coordinate_type:'pdf_point',page:row.page,y:row.y,coordinate:row.coordinate,symbol_coordinates:row.symbol_coordinates});
 return value;
}
function clean(value:unknown):unknown {
 if(Array.isArray(value))return value.filter(v=>!(v&&typeof v==='object'&&'text' in v&&typeof v.text==='string'&&!v.text.trim())).map(clean);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>!['row_span','col_span'].includes(k)).map(([k,v])=>[k,clean(v)]));
 return value;
}
export function tableToolResponse(result:Result,query:string,options:Options={}) {
 const compact=options.compact??true,offset=options.offset??0,limit=options.limit??30;
 const {rows,layout_debug,...fullMeta}=result;
 // Attachment audit and detailed version evidence remain in metadata tools and
 // compact=false; repeating that audit can exceed a small table's entire budget.
 const meta=compact?Object.fromEntries(['regulationName','fileNo','extension','sourceUrl'].filter(k=>fullMeta[k]!==undefined).map(k=>[k,fullMeta[k]])):fullMeta;
 if(compact&&fullMeta.version_warning)meta.version_warning=fullMeta.version_warning;

 const tables:Record<string,unknown>={};
 const selected:unknown[]=[];let sizeTruncated=false;
 const data:Record<string,unknown>={...meta,query,compact,offset,totalMatches:rows.length,totalStructuredRows:rows.length,tables,rows:selected,has_more:false,truncated:false,next_offset:null};
 if(!compact&&layout_debug)data.layout_debug=clean(layout_debug);
 const envelope=()=>({structuredContent:data,content:[{type:'text' as const,text:JSON.stringify(data)}]});
 const fits=()=>JSON.stringify(envelope()).length<=(compact?15000:50000);
 // Page diagnostics can dwarf the actual results. Detailed cell/coordinate evidence
 // stays available even when full-document diagnostics exceed the response budget.
 if(!fits()){delete data.layout_debug;data.layout_debug_omitted=true;}
 for(let index=offset;index<rows.length&&selected.length<limit;index++){
  const row=rows[index],key=row.table_id,hadTable=key in tables;
  if(!hadTable){
   const evidence=row.header_evidence as {columns?:unknown[];rows?:{row:number;cells:{text:string;col:number;colSpan:number}[]}[];ranges?:unknown}|undefined;
   tables[key]={analysis_type:row.analysis_type,coordinate_type:row.coordinate_type,columns:compact?(evidence?.columns??row.columns??evidence?.rows?.flatMap(b=>b.cells.filter(c=>c.text.trim()).map(c=>({name:c.text,row:b.row,col:c.col,colSpan:c.colSpan})))??[]).map((c:any)=>({name:c.name,col:c.col,colSpan:c.colSpan??c.span??1})):clean(evidence?.columns??row.columns??evidence?.rows??[]),...(!compact?{headers:clean(evidence?.rows??[]),ranges:clean(evidence?.ranges)}:{})};
  }
  const value=compact?compactRow(row):clean(row);
  selected.push(value);data.next_offset=index+1;
  if(!fits()){
   sizeTruncated=true;selected.pop();if(!hadTable)delete tables[key];data.next_offset=index;
   // Do not return an empty page with a non-advancing offset forever.
   if(!selected.length)throw new Error('layout_error: one table row exceeds the 50,000 character response budget; use compact=true');
   break;
  }
 }
 const next=offset+selected.length;
 data.has_more=next<rows.length;data.truncated=sizeTruncated;data.next_offset=data.has_more?next:null;
 if(options.includeRegion&&!compact){
  data.regions=rows.slice(offset,next).map(row=>({page:row.page,bounding_box:row.bounding_box,coordinate_space:row.coordinate_space,table_id:row.table_id,image:null}));
  if(!fits()){delete data.regions;data.regions_omitted=true;}
 }
 if(!fits())throw new Error('layout_error: table metadata exceeds the response budget');
 return envelope();
}
