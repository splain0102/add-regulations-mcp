import {unzipSync,strFromU8} from 'fflate';
import {hwpParagraphEvidence,resolveCellFootnotes,type TextRun,type Footnote} from './hwp-runs';
import {parseHwp} from '@ssabrojs/hwpxjs/browser';
export {extractPdfLayout} from './pdf-table-layout';

export class DocumentError extends Error {
 code:'timeout'|'download_error'|'parse_error'|'no_text_layer'|'layout_error'|'selection_error'|'upstream_error';
 constructor(code:DocumentError['code'],message:string){super(message);this.code=code;this.name='DocumentError';}
}
export type Box={x0:number;y0:number;x1:number;y1:number};
export type Cell={row:number;col:number;rowSpan:number;colSpan:number;text:string;x0:number;x1:number;runs?:TextRun[];nativeNotes?:{mark:string;text:string}[]};
export type Table={id:string;page:number|null;cells:Cell[];coordinateSpace:'table-column'|'table-local-hwpunit';context:string;footnoteBlock?:{mark:string;text:string}[]};
export type SymbolPosition={symbol:string;x0:number;x1:number;x_center:number;suffix:string|null;coordinatePrecision:'text-item'|'estimated-within-text-item'|'explicit-cell'|'glyph-advance'};
export type StructuredRow={page:number|null;table_id:string;category:string|null;task:string|null;condition:string|null;approver:string|null;approver_type?:'symbol'|'text';approvers?:Array<{name:string|null;symbol:string|null;legend:string|null;suffix?:string|null}>;multi_approver?:boolean;footnotes?:Footnote[];related_regulations?:string[];symbol:string|null;symbol_x_center:number;suffix:string|null;legend:string|null;confidence:number;version_warning:unknown;symbol_coordinates:SymbolPosition|null;bounding_box:Box;coordinate_space:string;header_evidence:unknown;raw_cells:unknown;needs_review:boolean;coordinate_type?:'logical_cell'|'pdf_point';row?:number;col?:number;x_center?:number;y?:number;column_detection?:'vertical_lines'|'header_midpoints'|null;confidence_basis?:string[];fill_down?:unknown;debug?:unknown;effective_approver?:string|null;approver_basis?:unknown};
const compact=(s:string)=>s.replace(/\s+/g,'');
const roles=['사책/과책','운영','실장','부장(센터장)','사업기구장','부소장','소장'];
const textApproverName=(text:string)=>{const v=compact(text).replace(/[（]/g,'(').replace(/[）]/g,')');for(const r of ['직상위자','책임원','부서장','사업기구장','부소장','실장','운영','소장'])if(v===r||v===r+'전결')return r;return null;};
export function roleName(text:string):string|null {
 const v=compact(text).replace(/[（]/g,'(').replace(/[）]/g,')');
 if(/사책.*과책|과책.*사책/.test(v))return roles[0];
 if(/부장.*센터장|센터장.*부장/.test(v))return roles[3];
 // Longest names first: 부소장 must never become 소장.
 for(const r of ['사업기구장','부소장','실장','운영','소장','부장','센터장','사책','과책'])if(v===r||v===r+'전결')return r;
 return null;
}
export function parseLegends(text:string):Record<string,string|null> {
 const result:Record<string,string|null>={'◎':null,'★':null,'☆':null};
 const candidates:Record<string,Set<string>>={'◎':new Set(),'★':new Set(),'☆':new Set()};
 // Require explicit explanatory syntax. A symbol merely appearing in a data cell is not a legend.
 for(const m of text.matchAll(/([◎★☆])\s*(?:[:：=]|는|은|[―–-])\s*([^\n◎★☆]{1,100})/g))candidates[m[1]].add(m[2].trim());
 for(const m of text.matchAll(/(전결|결재|협조|보고|합의)\s*[:：=]\s*([◎★☆])/g))candidates[m[2]].add(m[1]);
 for(const s of Object.keys(result))if(candidates[s].size===1)result[s]=[...candidates[s]][0];
 return result;
}
export function splitSymbols(text:string,x0:number,x1:number,precision:SymbolPosition['coordinatePrecision']='text-item'):SymbolPosition[] {
 const chars=Array.from(text),out:SymbolPosition[]=[];
 for(let i=0;i<chars.length;i++)if(/[◎★☆]/.test(chars[i])){
 const after=chars.slice(i+1).join(''), suffix=after.match(/^\s*[（(]([^）)]*)[）)]/)?.[1]?.trim()??null;
 // PDF.js reports text runs, not universally individual glyphs. Mark interpolation explicitly.
 const standalone=chars.length===1, left=standalone?x0:x0+(x1-x0)*i/chars.length,right=standalone?x1:x0+(x1-x0)*(i+1)/chars.length;
 out.push({symbol:chars[i],x0:left,x1:right,x_center:(left+right)/2,suffix,coordinatePrecision:precision==='explicit-cell'?'explicit-cell':standalone?'text-item':'estimated-within-text-item'});
 }
 return out;
}
function decode(s:string){return s.replace(/<[^>]+>/g,'').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&#(x[\da-f]+|\d+);/gi,(_,v)=>String.fromCodePoint(v[0]==='x'?parseInt(v.slice(1),16):Number(v))).replace(/&amp;/g,'&');}
type Xml={tag:string;attrs:Record<string,string>;children:Xml[];text:string};
function xmlTree(xml:string):Xml {
 const root:Xml={tag:'root',attrs:{},children:[],text:''},stack=[root];
 for(const m of xml.matchAll(/<[^>]*>|[^<]+/g)){
 const s=m[0];if(s.startsWith('<?')||s.startsWith('<!'))continue;
 if(s.startsWith('</')){const tag=s.slice(2,-1).trim().split(':').pop();if(stack.length<2||stack.at(-1)!.tag!==tag)throw new DocumentError('parse_error','HWPX XML 태그 불일치');stack.pop();continue;}
 if(s.startsWith('<')){const name=s.match(/^<([^\s/>]+)/)?.[1];if(!name)continue;const attrs:Record<string,string>={};for(const a of s.matchAll(/([^\s=]+)\s*=\s*["']([^"']*)["']/g))attrs[a[1].split(':').pop()!]=a[2];const node:Xml={tag:name.split(':').pop()!,attrs,children:[],text:''};stack.at(-1)!.children.push(node);if(!s.endsWith('/>'))stack.push(node);}
 else stack.at(-1)!.text+=s;
 }if(stack.length!==1)throw new DocumentError('parse_error','HWPX XML 종료 태그 누락');return root;
}
const descendants=(node:Xml,tag:string):Xml[]=>node.children.flatMap(c=>[...(c.tag===tag?[c]:[]),...descendants(c,tag)]);
function nodeText(n:Xml):string {return decode(n.text)+n.children.map(c=>nodeText(c)+(c.tag==='p'?'\n':'')).join('');}

function outsideBlock(tree:Xml,target:Xml):{mark:string;text:string}[]{
 const flow:Xml[]=[];function visit(n:Xml){if(n.tag==='tbl'){flow.push(n);return;}if(n.tag==='p'&&!descendants(n,'tbl').length){flow.push(n);return;}n.children.forEach(visit);}visit(tree);
 const index=flow.indexOf(target);if(index<0)return [];
 const result:{mark:string;text:string}[]=[];for(const n of flow.slice(index+1)){if(n.tag==='tbl')break;const text=nodeText(n).trim();if(!text)continue;const match=text.match(/^(\d+(?:-\d+)?[)⁾）]|[①-⑳]|※)\s+(.+)/);if(!match)break;result.push({mark:match[1],text:match[2]});}return result;
}
function xmlCellEvidence(cell:Xml,shapes:Map<string,{size:number;superscript:boolean}>){
 const runs:TextRun[]=[],nativeNotes:{mark:string;text:string}[]=[];
 const visit=(node:Xml,style:{size:number|null;superscript:boolean|null}={size:null,superscript:null})=>{
  if(node.tag==='footNote'||node.tag==='endNote'){
   const number=node.attrs.number??node.attrs.num??descendants(node,'autoNum')[0]?.attrs.num;
   const mark=number?number+')':null;
   const body=descendants(node,'p').map(p=>descendants(p,'t').map(nodeText).join('')).filter(Boolean).join('\n').trim();
   if(mark&&body){runs.push({text:mark,...style,superscript:true,nativeControl:true});nativeNotes.push({mark,text:body});}return;
  }
  if(node.tag==='run'){const shape=shapes.get(node.attrs.charPrIDRef);style={size:shape?.size??null,superscript:shape?.superscript??null};}
  if(node.tag==='t'){runs.push({text:nodeText(node),...style});return;}
  node.children.forEach(child=>visit(child,style));if(node.tag==='p')runs.push({text:'\n',...style});
 };
 visit(cell);return {text:runs.map(r=>r.text).join('').trim(),runs,nativeNotes};
}
export function extractHwpxTables(bytes:Uint8Array):Table[] {
 let size=0;const zip=unzipSync(bytes,{filter(e){if(!/^Contents\/(?:section\d+|header)\.xml$/i.test(e.name))return false;size+=e.originalSize;if(size>32_000_000)throw new DocumentError('parse_error','HWPX XML 처리 한도 초과');return true;}}),tables:Table[]=[];
 const header=zip['Contents/header.xml']?xmlTree(strFromU8(zip['Contents/header.xml'])):null;
 const shapes=new Map(header?descendants(header,'charPr').map(n=>[n.attrs.id,{size:Number(n.attrs.height)/100,superscript:descendants(n,'supscript').length>0||descendants(n,'superscript').length>0}] as const):[]);
 for(const name of Object.keys(zip).filter(n=>/section\d+\.xml$/i.test(n)).sort((a,b)=>Number(a.match(/\d+/)?.[0])-Number(b.match(/\d+/)?.[0]))){const tree=xmlTree(strFromU8(zip[name]));let index=0;
 for(const t of descendants(tree,'tbl')){
 const cells:Cell[]=descendants(t,'tc').map(c=>{const a=descendants(c,'cellAddr')[0]?.attrs??{},s=descendants(c,'cellSpan')[0]?.attrs??{};return {row:Number(a.rowAddr??0),col:Number(a.colAddr??0),rowSpan:Number(s.rowSpan??1),colSpan:Number(s.colSpan??1),...xmlCellEvidence(c,shapes),x0:0,x1:0};});
 // Logical columns are exact; page geometry is not present in this parser's IR.
 for(const c of cells){c.x0=c.col;c.x1=c.col+c.colSpan;}
 tables.push({id:`${name}:${index++}`,page:null,cells,coordinateSpace:'table-column',context:'',footnoteBlock:outsideBlock(tree,t)});
 }}return tables;
}
export function extractHwpTables(bytes:Uint8Array):Table[] {
 const doc=parseHwp(bytes),tables:Table[]=[];let context='';
 const evidence=hwpParagraphEvidence(bytes,doc.docInfo.charShapes);
 const paragraphRuns=(p:any,section:number)=>evidence(section,p.text)??{runs:(p.runs??[]).map((r:any)=>({text:r.text,size:doc.docInfo.charShapes[r.charShapeId]?.baseSize/100||null,superscript:doc.docInfo.charShapes[r.charShapeId]?!!(doc.docInfo.charShapes[r.charShapeId].property&0x8000):null})),notes:[]};
 type Paragraph=typeof doc.sections[number]['paragraphs'][number];
 function walk(paragraphs:Paragraph[],section:number){for(const p of paragraphs){if(p.text.trim())context=p.text.trim();for(const control of p.controls){if(control.kind==='table'){
 const cells=control.cells.map(c=>{const parts=c.paragraphs.map((p:any)=>paragraphRuns(p,section));const runs:TextRun[]=parts.flatMap((part,i)=>[...(i?[{text:'\n',size:null,superscript:null}]:[]),...part.runs]);return {row:c.row,col:c.col,rowSpan:c.rowSpan,colSpan:c.colSpan,text:runs.map(r=>r.text).join('').trim(),runs,nativeNotes:parts.flatMap(p=>p.notes),x0:c.col,x1:c.col+c.colSpan};});
 tables.push({id:`section${section}:table${tables.length}`,page:null,cells,coordinateSpace:'table-column',context,footnoteBlock:(()=>{const block:{mark:string;text:string}[]=[];for(const next of paragraphs.slice(paragraphs.indexOf(p)+1)){if(next.controls.some(c=>c.kind==='table'))break;const value=next.text.trim();if(!value)continue;const match=value.match(/^(\d+(?:-\d+)?[)⁾）]|[①-⑳]|※)\s+(.+)/);if(!match)break;block.push({mark:match[1],text:match[2]});}return block;})()});for(const c of control.cells)walk(c.paragraphs,section);
 }else if('paragraphs' in control)walk(control.paragraphs,section);}}}
 doc.sections.forEach((s,i)=>walk(s.paragraphs,i));return tables;
}
function fieldName(text:string):'category'|'task'|'condition'|null {
 const s=compact(text);if(/^(구분|부서|소관|담당부서)$/.test(s))return 'category';if(/^(업무|업무내용|업무명|사항|전결사항|결재사항)$/.test(s))return 'task';if(/^(세부조건|조건|세부내용|세부사항|금액|기준)$/.test(s))return 'condition';return null;
}
export function structureTables(tables:Table[],text:string):StructuredRow[] {
 const out:StructuredRow[]=[],legends=parseLegends(text);
 let priorSignature='',priorValues:{category:string|null;task:string|null;condition:string|null}={category:null,task:null,condition:null};
 for(const table of tables){
 const cellTexts=new Set(table.cells.map(c=>compact(c.text).normalize('NFKC')));
 const resolved=new Map(table.cells.map(c=>[c,resolveCellFootnotes(c,table.footnoteBlock??[])]));
 const cellText=(c:Cell|undefined)=>c?resolved.get(c)!.text.trim():'';
 const rowNums=[...new Set(table.cells.map(c=>c.row))].sort((a,b)=>a-b);let headers:{name:string;col:number;span:number;source:string}[]=[],fields:{name:'category'|'task'|'condition';col:number;span:number}[]=[],last={category:null,task:null,condition:null} as typeof priorValues;
 for(const row of rowNums){const direct=table.cells.filter(c=>c.row===row),active=table.cells.filter(c=>c.row<=row&&c.row+c.rowSpan>row);
 const detected=direct.flatMap(c=>{let role=roleName(c.text),source=c.text;for(const adjacent of table.cells.filter(a=>c.text.trim()&&a.text.trim()&&a.col===c.col&&a.colSpan===c.colSpan&&Math.abs(a.row-c.row)===1)){const merged=roleName(adjacent.row<c.row?adjacent.text+c.text:c.text+adjacent.text);if(merged&&(!role||merged.length>role.length)){role=merged;source=adjacent.row<c.row?adjacent.text+' / '+c.text:c.text+' / '+adjacent.text;}}return role?[{name:role,col:c.col,span:c.colSpan,source}]:[];});
 if(detected.length>=2){headers=detected;fields=active.flatMap(c=>{const f=fieldName(c.text);return f?[{name:f,col:c.col,span:c.colSpan}]:[];});
 const signature=headers.map(h=>`${h.col}:${h.name}`).join('|');if(signature===priorSignature)last={...priorValues};else last={category:null,task:null,condition:null};priorSignature=signature;continue;}
 if(!headers.length)continue;
 // Complete split headers in adjacent rows if the same cell column contains a header fragment.
 if(!direct.some(c=>/[◎★☆]/.test(c.text))&&direct.some(c=>fieldName(c.text))){for(const c of direct){const f=fieldName(c.text);if(f&&!fields.some(x=>x.name===f))fields.push({name:f,col:c.col,span:c.colSpan});}continue;}
 const minRole=Math.min(...headers.map(h=>h.col));
 if(!fields.length){const contentCols=[...new Set(table.cells.filter(c=>c.col<minRole).map(c=>c.col))].sort((a,b)=>a-b);fields=contentCols.slice(0,3).map((col,i)=>({name:(['category','task','condition'] as const)[i],col,span:1}));}

 for(const f of fields){const cell=active.find(c=>c.col<=f.col&&c.col+c.colSpan>f.col);const value=cellText(cell);if(value&&!roleName(value)&&!fieldName(value)&&!/[◎★☆]/.test(value)){
 if(f.name==='category'&&value!==last.category){last.task=null;last.condition=null;}
 if(f.name==='task'&&value!==last.task){last.condition=null;}last[f.name]=value;}}
 // A broad 업무내용 header spans the task and all its subcondition cells.
 const taskField=fields.find(f=>f.name==='task');
 if(taskField&&!fields.some(f=>f.name==='condition')){
 const taskCell=active.find(c=>c.col<=taskField.col&&c.col+c.colSpan>taskField.col);
 const conditions=active.filter(c=>c.col>=(taskCell?taskCell.col+taskCell.colSpan:taskField.col+1)&&c.col<minRole&&!/[◎★☆]/.test(c.text)).sort((a,b)=>a.col-b.col);
 last.condition=conditions.map(cellText).filter(Boolean).join(' / ')||null;
 }
 // Only explicit rowSpan or continuation carry prior values; blank cells may be meaningful.
 const approvals:Array<{name:string|null;symbol:string|null;legend:string|null;suffix:string|null;cell:Cell;position:SymbolPosition|null;type:'symbol'|'text';header:typeof headers[number]|null}>=[];
 for(const c of direct){if(c.col<minRole)continue;
   if(/[◎★☆]/.test(c.text)){
     for(const symbol of splitSymbols(c.text,c.x0,c.x1,'explicit-cell').map(s=>({...s,x0:c.x0,x1:c.x1,x_center:(c.x0+c.x1)/2}))){
       const candidate=headers.filter(h=>c.col>=h.col&&c.col+c.colSpan<=h.col+h.span);const header=candidate.length===1?candidate[0]:null;
       approvals.push({name:header?.name??null,symbol:symbol.symbol,legend:legends[symbol.symbol],suffix:symbol.suffix,cell:c,position:symbol,type:'symbol',header});
     }
   } else {
     const textName=textApproverName(cellText(c));
     if(textName) approvals.push({name:textName,symbol:null,legend:null,suffix:null,cell:c,position:null,type:'text',header:null});
   }
 }
 if(approvals.length){
   const first=approvals[0],multi=approvals.length>1;
   out.push({page:table.page,table_id:table.id,...last,approver:first.name,approver_type:first.type,approvers:approvals.map(a=>({name:a.name,symbol:a.symbol,legend:a.legend,suffix:a.suffix})),multi_approver:multi,footnotes:[...new Map(active.flatMap(c=>resolved.get(c)!.footnotes).map(n=>[n.mark+'\0'+n.text,n])).values()].filter(n=>!cellTexts.has(compact(n.text).normalize('NFKC'))),related_regulations:approvals.some(a=>a.symbol==='★')?['부설 국방신속획득기술연구원 위임전결규정']:[],symbol:first.symbol,symbol_x_center:first.position?.x_center??first.cell.col,suffix:first.suffix,legend:first.legend,confidence:approvals.every(a=>a.name)?0.98:0.5,version_warning:null,symbol_coordinates:first.position,bounding_box:{x0:Math.min(...approvals.map(a=>a.cell.col)),y0:row,x1:Math.max(...approvals.map(a=>a.cell.col+a.cell.colSpan)),y1:row+1},coordinate_space:table.coordinateSpace,header_evidence:first.header,raw_cells:active.map(c=>({col:c.col,row:c.row,rowSpan:c.rowSpan,colSpan:c.colSpan,text:c.text,runs:c.runs})),needs_review:approvals.some(a=>!a.name)});
 }
 priorValues={...last};
 }
 }return out;
}
export function versionCheck(alio:string|undefined,filenameDate:string|undefined,text:string){
 const normalize=(v:string)=>{const m=v.match(/(20\d{2})\D{0,4}(\d{1,2})\D{0,4}(\d{1,2})/);return m?`${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`:null;};
 const dates:{source:string;date:string}[]=[];const a=alio&&normalize(alio);if(a)dates.push({source:'alio_revision_date',date:a});if(filenameDate)dates.push({source:'attachment_filename_date',date:filenameDate});
 const headings=[...text.matchAll(/^[ \t]*부[ \t]*칙[^\n]*/gm)];
 const lastHeading=headings.at(-1),section=lastHeading?text.slice(lastHeading.index!,text.indexOf('[별표',lastHeading.index!)>=0?text.indexOf('[별표',lastHeading.index!):undefined):'';
 const revisions=[...(lastHeading?.[0]??'').matchAll(/20\d{2}\D{0,4}\d{1,2}\D{0,4}\d{1,2}/g)].map(m=>normalize(m[0])).filter(Boolean) as string[];
 const effective=[...section.matchAll(/(20\d{2}\D{0,4}\d{1,2}\D{0,4}\d{1,2})[^\n]{0,25}시행/g)].map(m=>normalize(m[1])).filter(Boolean) as string[];
 const r=revisions.sort().at(-1),e=effective.sort().at(-1);if(r)dates.push({source:'body_last_revision_date',date:r});if(e)dates.push({source:'body_last_effective_date',date:e});
 const dateRange=(value:string):[number,number]=>{
  if(value.length===7){const [year,month]=value.split('-').map(Number);return [Date.UTC(year,month-1,1),Date.UTC(year,month,0)];}
  const day=Date.parse(value+'T00:00:00Z');return [day,day];
 };
 // Month-only filenames describe an interval, never an invented day. Compare
 // nearby effective dates against that interval and exact revision evidence.
 const dayDiff=(a:string,b:string)=>{const x=dateRange(a),y=dateRange(b);return Math.max(0,x[0]-y[1],y[0]-x[1])/86400000;};
 const mismatches=dates.flatMap((d,i)=>dates.slice(i+1).filter(o=>(o.date.length===7||d.date.length===7)?o.date.slice(0,7)!==d.date.slice(0,7):o.date!==d.date).map(o=>({left:d,right:o,kind:d.source.includes('effective')||o.source.includes('effective')?'effective_date_difference':'revision_date_mismatch'})));
 const onlyEffectiveNear=mismatches.length>0&&mismatches.every(m=>m.kind==='effective_date_difference'&&dayDiff(m.left.date,m.right.date)<=7);
 return {dates,checked:dates.length>=2,info:onlyEffectiveNear?{code:'effective_date_near_revision',mismatches}:null,warning:mismatches.length&&!onlyEffectiveNear?{code:'version_date_mismatch',mismatches,note:'시행일과 개정일 차이는 정상일 수 있으므로 원문 확인이 필요합니다.'}:null,missing:['alio_revision_date','attachment_filename_date','body_last_revision_date','body_last_effective_date'].filter(s=>!dates.some(d=>d.source===s))};
}
