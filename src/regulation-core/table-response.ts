import type {SearchTableRow} from './general-table-search';

type Result={rows:SearchTableRow[];[key:string]:unknown};
type Options={compact?:boolean;offset?:number;limit?:number;includeRegion?:boolean};
const compactKeys=['table_id','row','category','task','condition','approver','symbol','suffix','legend','confidence','needs_review','analysis_type'];
function clean(value:unknown):unknown {
 if(Array.isArray(value))return value.filter(v=>!(v&&typeof v==='object'&&'text' in v&&typeof v.text==='string'&&!v.text.trim())).map(clean);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>!['header_evidence','raw_cells','header_path','row_span','col_span'].includes(k)).map(([k,v])=>[k,clean(v)]));
 return value;
}
export function tableToolResponse(result:Result,query:string,options:Options={}) {
 const compact=options.compact??true,offset=options.offset??0,limit=options.limit??30;
 const {rows,layout_debug,...meta}=result;
 const tables:Record<string,unknown>={};
 const selected:unknown[]=[];
 const data:Record<string,unknown>={...meta,query,compact,offset,totalMatches:rows.length,totalStructuredRows:rows.length,tables,rows:selected,truncated:false,next_offset:null};
 if(!compact&&layout_debug)data.layout_debug=clean(layout_debug);
 const envelope=()=>({structuredContent:data,content:[{type:'text' as const,text:JSON.stringify(data)}]});
 const fits=()=>JSON.stringify(envelope()).length<=50000;
 // Page diagnostics can dwarf the actual results. Detailed cell/coordinate evidence
 // stays available even when full-document diagnostics exceed the response budget.
 if(!fits()){delete data.layout_debug;data.layout_debug_omitted=true;}
 for(let index=offset;index<rows.length&&selected.length<limit;index++){
  const row=rows[index],key=row.table_id,hadTable=key in tables;
  if(!hadTable){
   const evidence=row.header_evidence as {columns?:unknown[];rows?:{row:number;cells:{text:string;col:number;colSpan:number}[]}[];ranges?:unknown}|undefined;
   tables[key]={analysis_type:row.analysis_type,coordinate_type:row.coordinate_type,columns:evidence?.columns??evidence?.rows?.flatMap(b=>b.cells.filter(c=>c.text.trim()).map(c=>({name:c.text,row:b.row,col:c.col,colSpan:c.colSpan})))??[],...(!compact?{headers:clean(evidence?.rows??[]),ranges:clean(evidence?.ranges)}:{})};
  }
  const value=compact?Object.fromEntries(compactKeys.map(k=>[k,row[k]??null])):clean(row);
  selected.push(value);data.next_offset=index+1;
  if(!fits()){
   selected.pop();if(!hadTable)delete tables[key];data.next_offset=index;
   // Do not return an empty page with a non-advancing offset forever.
   if(!selected.length)throw new Error('layout_error: one table row exceeds the 50,000 character response budget; use compact=true');
   break;
  }
 }
 const next=offset+selected.length;
 data.truncated=next<rows.length;data.next_offset=data.truncated?next:null;
 if(options.includeRegion&&!compact){
  data.regions=rows.slice(offset,next).map(row=>({page:row.page,bounding_box:row.bounding_box,coordinate_space:row.coordinate_space,table_id:row.table_id,image:null}));
  if(!fits()){delete data.regions;data.regions_omitted=true;}
 }
 if(!fits())throw new Error('layout_error: table metadata exceeds the response budget');
 return envelope();
}
