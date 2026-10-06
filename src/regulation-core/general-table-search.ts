// Search semantics ported from GitHub PR #4 at f8126642daa3aeea7bbe40b42f06440993b04688.
// Keep the Site's explicit HWP/HWPX IR rather than round-tripping through rendered HTML.
import {roleName, type Cell, type Table, type StructuredRow, type Box} from './table-layout';
export type SearchTableRow={page:number|null;row:number;table_id:string;coordinate_space:string;bounding_box:Box;raw_cells:unknown;needs_review:boolean;[key:string]:unknown};

export const normalizeTableSearch=(value:string)=>value.normalize('NFKC').toLowerCase().replace(/[\s,]+/g,'');
export const tableCellsForRow=(table:Table,row:number)=>table.cells.filter(c=>c.row<=row&&row<c.row+c.rowSpan).sort((a,b)=>a.col-b.col);
const normalizedText=(s:string)=>s.replace(/\s+/g,' ').replace(/\s*\n\s*/g,' ').trim();
const cellJson=(c:Cell)=>({row:c.row,col:c.col,rowSpan:c.rowSpan,colSpan:c.colSpan,row_span:c.rowSpan,col_span:c.colSpan,text:normalizedText(c.text),raw_text:c.text});
const headerLabels=new Set(['구분','관리등급','공개대상','사업구분','사업관리부서','예산관리부서','순번','장비명','제작사','모델명','취득연도','취득금액','보유기관명','지역중복여부','공동활용여부','장비등록번호','자체검토의견','기존장비명','용도','구축가격','활용상태','처분계획','상호']);
function headerRowNumbers(table:Table){
 const directRows=[...new Set(table.cells.map(c=>c.row))].sort((a,b)=>a-b);
 const first=directRows[0];
 const anchor=directRows.find(row=>table.cells.filter(c=>c.row===row&&(headerLabels.has(normalizeTableSearch(c.text))||roleName(c.text))).length>=2);
 if(anchor===undefined)return first===undefined?[]:[first];
 const recognized=table.cells.filter(c=>c.row===anchor&&(headerLabels.has(normalizeTableSearch(c.text))||roleName(c.text)));
 const end=Math.max(anchor+1,...recognized.map(c=>c.row+c.rowSpan));
 return directRows.filter(row=>row>=anchor&&row<end);
}

export function searchGeneralTables(tables:Table[],query:string,delegationRows:StructuredRow[],sourceType:string){
 const q=normalizeTableSearch(query),tokens=query.normalize('NFKC').split(/[\s,;/]+/).map(normalizeTableSearch).filter(Boolean);
 if(!q)return [];
 const matches:{table:Table;cell:Cell;row:number;mode:'cell'|'row'|'header_path'}[]=[],seen=new Set<string>();
 for(const table of tables){
  const rowCount=Math.max(0,...table.cells.map(c=>c.row+c.rowSpan));
  const colCount=Math.max(0,...table.cells.map(c=>c.col+c.colSpan));
  if(rowCount===1&&colCount===1) continue; // text_box: excluded from default search
  const headerRows=headerRowNumbers(table);
  for(const cell of table.cells){if(normalizeTableSearch(cell.text).includes(q)){
   const key=`${table.id}:${cell.row}`;if(!seen.has(key)){seen.add(key);matches.push({table,cell,row:cell.row,mode:'cell'});}
  }}
  if(tokens.length>=2){
   for(let row=0;row<rowCount;row++){const cells=tableCellsForRow(table,row),text=normalizeTableSearch(cells.map(c=>c.text).join(' ')),key=`${table.id}:${row}`;
    if(!seen.has(key)&&tokens.every(t=>text.includes(t))){const cell=cells.find(c=>c.text.trim());if(cell){seen.add(key);matches.push({table,cell,row,mode:'row'});}}
   }
  }
  // Multi-level header query: join only overlapping ancestor/leaf columns, never unrelated grades.
  if(tokens.length>=2){
   for(const leaf of table.cells.filter(c=>headerRows.includes(c.row)&&c.text.trim())){
    const ancestors=table.cells.filter(h=>headerRows.includes(h.row)&&h.row<leaf.row&&h.text.trim()&&h.col<leaf.col+leaf.colSpan&&leaf.col<h.col+h.colSpan);
    const path=normalizeTableSearch([...ancestors.map(h=>h.text),leaf.text].join(' ')),key=`${table.id}:${leaf.row}`;
    if(!seen.has(key)&&tokens.every(t=>path.includes(t))){seen.add(key);matches.push({table,cell:leaf,row:leaf.row,mode:'header_path'});}
   }
  }
 }
 return matches.flatMap<SearchTableRow>(({table,cell,row,mode})=>{
  const cells=tableCellsForRow(table,row),headerRows=headerRowNumbers(table);
  const headers=headerRows.map(r=>({row:r,cells:tableCellsForRow(table,r).map(cellJson)}));
  const headerCells=table.cells.filter(c=>headerRows.includes(c.row)&&c.text.trim());
  const leafHeaders=[...Array(Math.max(0,...table.cells.map(c=>c.col+c.colSpan))).keys()].map(col=>{
    const candidates=headerCells.filter(h=>h.col<=col&&col<h.col+h.colSpan).sort((a,b)=>b.row-a.row);
    const h=candidates[0];return h?{name:normalizedText(h.text),source_text:h.text,col,colSpan:1}:null;
  }).filter((x):x is {name:string;source_text:string;col:number;colSpan:number}=>!!x&&!!x.name);
  const roleColumns=headerCells.map(c=>({role:roleName(c.text),cell:c})).filter(x=>x.role).map(x=>({name:x.role,source_text:x.cell.text,col:x.cell.col,colSpan:x.cell.colSpan}));
  const columns=roleColumns.length>=2?roleColumns:leafHeaders;
  const contextualCells=cells.map(c=>({...cellJson(c),header_path:headerCells.filter(h=>h.row<c.row&&h.text.trim()&&h.col<c.col+c.colSpan&&c.col<h.col+h.colSpan).sort((a,b)=>a.row-b.row).map(cellJson)}));
  const values:Record<string,string>={};
  if(!headerRows.includes(row)) for(const c of cells){
    const h=leafHeaders.find(x=>x.col>=c.col&&x.col<c.col+c.colSpan);
    if(h?.name&&normalizedText(c.text)) values[h.name]=normalizedText(c.text);
  }
  const base={source_type:sourceType,analysis_type:'general_table',coordinate_type:'logical_cell',coordinate_space:'logical-cell-address',page:null,table_id:table.id,row,match_mode:mode,matched_cell:cellJson(cell),cells:contextualCells,columns,values,header_evidence:{rows:headers},raw_cells:cells.map(cellJson),needs_review:false,bounding_box:{x0:0,y0:row,x1:Math.max(...cells.map(c=>c.col+c.colSpan)),y1:row+1}};
  const specialized=delegationRows.filter(r=>r.table_id===table.id&&r.bounding_box.y0===row);
  return specialized.length?specialized.map(r=>({...base,...r,analysis_type:'delegation_table',coordinate_type:'logical_cell',row,col:r.bounding_box.x0,coordinate:{coordinate_type:'logical_cell',row,col:r.bounding_box.x0},symbol_coordinates:{...r.symbol_coordinates,coordinate_type:'logical_cell',row,col:r.bounding_box.x0},header_evidence:{...(r.header_evidence as object??{}),rows:headers,columns},confidence_basis:['explicit_cell_span','header_detected','symbol_inside_column']})):[base];
 });
}
