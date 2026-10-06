import {getDocumentProxy,getResolvedPDFJS} from 'unpdf';
import {DocumentError,roleName,parseLegends,type Box,type StructuredRow,type SymbolPosition} from './table-layout';

type Page=Awaited<ReturnType<Awaited<ReturnType<typeof getDocumentProxy>>['getPage']>>;
type Viewport=ReturnType<Page['getViewport']>;
type Matrix=[number,number,number,number,number,number];
type Token=Box&{text:string;y:number;height:number};
type Line={a:[number,number];b:[number,number]};
type Geometry={rectangles:Box[];vertical:Line[];horizontal:Line[];symbols:PdfSymbol[];unsupportedSymbols:number};
type Header=Box&{name:string;text:string;x_center:number};
type Column={name:string;header:Header;left:number;right:number;column_detection:'vertical_lines'|'header_midpoints'};
export type PdfSymbol=SymbolPosition&{y:number;coordinate_type:'pdf_point';coordinatePrecision:'glyph-advance'|'text-item'|'estimated-within-text-item'|'explicit-cell'};
type Fields={category:string|null;task:string|null;condition:string|null};
type Context=Fields&{page:number;signature:string;title:string|null};
type Filled={field:keyof Fields;source:'merged_cell'|'previous_row'|'previous_page';source_page:number};
const ID:Matrix=[1,0,0,1,0,0];
const multiply=(a:Matrix,b:Matrix):Matrix=>[a[0]*b[0]+a[2]*b[1],a[1]*b[0]+a[3]*b[1],a[0]*b[2]+a[2]*b[3],a[1]*b[2]+a[3]*b[3],a[0]*b[4]+a[2]*b[5]+a[4],a[1]*b[4]+a[3]*b[5]+a[5]];
const apply=(m:Matrix,x:number,y:number):[number,number]=>[m[0]*x+m[2]*y+m[4],m[1]*x+m[3]*y+m[5]];
const center=(b:Box)=>(b.x0+b.x1)/2;
const inside=(x:number,y:number,b:Box,pad=0)=>x>=b.x0-pad&&x<=b.x1+pad&&y>=b.y0-pad&&y<=b.y1+pad;
const overlaps=(a:Box,b:Box)=>Math.min(a.x1,b.x1)-Math.max(a.x0,b.x0)>0;
const close=(a:number,b:number,t=1.8)=>Math.abs(a-b)<=t;
const extent=(points:[number,number][]):Box=>({x0:Math.min(...points.map(p=>p[0])),x1:Math.max(...points.map(p=>p[0])),y0:Math.min(...points.map(p=>p[1])),y1:Math.max(...points.map(p=>p[1]))});
const unique=(v:number[])=>v.sort((a,b)=>a-b).filter((x,i,a)=>!i||!close(x,a[i-1],0.6));
const axisAligned=(m:Matrix)=>Math.abs(m[1])<1e-5&&Math.abs(m[2])<1e-5;

/** Decode PDF.js drawing paths and text advances. Never use text-run length as glyph width. */
async function positionedGraphics(page:Page,viewport:Viewport):Promise<Geometry>{
 const {OPS}=await getResolvedPDFJS(),operators=await page.getOperatorList();
 const geometry:Geometry={rectangles:[],vertical:[],horizontal:[],symbols:[],unsupportedSymbols:0};
 type State={ctm:Matrix;fontSize:number;fontMatrix:number;fontName:string;textMatrix:Matrix;lineMatrix:Matrix;pen:number;charSpace:number;wordSpace:number;hScale:number;rise:number;leading:number};
 let state:State={ctm:[...ID],fontSize:12,fontMatrix:0.001,fontName:'',textMatrix:[...ID],lineMatrix:[...ID],pen:0,charSpace:0,wordSpace:0,hScale:1,rise:0,leading:0};const stack:State[]=[];
 const point=(x:number,y:number)=>{const p=apply(state.ctm,x,y);return viewport.convertToViewportPoint(p[0],p[1]) as [number,number];};
 function addPath(points:[number,number][],closed:boolean){
 if(points.length<2)return;
 const converted=points.map(p=>point(...p));if(closed)converted.push(converted[0]);
 for(let j=1;j<converted.length;j++){const a=converted[j-1],b=converted[j];if(close(a[0],b[0],0.5)&&Math.abs(a[1]-b[1])>=8)geometry.vertical.push({a,b});if(close(a[1],b[1],0.5)&&Math.abs(a[0]-b[0])>=8)geometry.horizontal.push({a,b});}
 const xs=unique(converted.map(p=>p[0])),ys=unique(converted.map(p=>p[1]));
 if(closed&&xs.length===2&&ys.length===2&&converted.every(p=>xs.some(x=>close(x,p[0],0.6))&&ys.some(y=>close(y,p[1],0.6)))){
 const b=extent(converted);if(b.x1-b.x0>8&&b.y1-b.y0>8&&(b.x1-b.x0)*(b.y1-b.y0)<viewport.width*viewport.height*0.9&&!geometry.rectangles.some(r=>Object.keys(b).every(k=>close(r[k as keyof Box],b[k as keyof Box],0.6))))geometry.rectangles.push(b);
 }
 }
 function decodePacked(data:ArrayLike<number>){let p=0,points:[number,number][]=[];while(p<data.length){const op=data[p++];if(op===0){if(points.length)addPath(points,false);points=[[data[p++],data[p++]]];}else if(op===1)points.push([data[p++],data[p++]]);else if(op===2){p+=6;points=[];}else if(op===3){p+=4;points=[];}else if(op===4){addPath(points,true);points=[];}else break;}if(points.length)addPath(points,false);}
 function moveText(x:number,y:number){state.lineMatrix=multiply(state.lineMatrix,[1,0,0,1,x,y]);state.textMatrix=[...state.lineMatrix];state.pen=0;}
 for(let i=0;i<operators.fnArray.length;i++){
 const op=operators.fnArray[i],args=operators.argsArray[i];
 if(op===OPS.save)stack.push({...state,ctm:[...state.ctm],textMatrix:[...state.textMatrix],lineMatrix:[...state.lineMatrix]});
 else if(op===OPS.restore)state=stack.pop()??state;
 else if(op===OPS.transform)state.ctm=multiply(state.ctm,Array.from(args) as Matrix);
 else if(op===OPS.constructPath){
 if(typeof args[0]==='number'){for(const data of args[1]??[])if(data)decodePacked(data);}
 else {const ops=args[0],coords=args[1];let at=0,points:[number,number][]=[];for(const draw of ops){if(draw===OPS.moveTo){if(points.length)addPath(points,false);points=[[coords[at++],coords[at++]]];}else if(draw===OPS.lineTo)points.push([coords[at++],coords[at++]]);else if(draw===OPS.rectangle){const x=coords[at++],y=coords[at++],w=coords[at++],h=coords[at++];addPath([[x,y],[x+w,y],[x+w,y+h],[x,y+h]],true);}else if(draw===OPS.closePath){addPath(points,true);points=[];}else if(draw===OPS.curveTo){at+=6;points=[];}else if(draw===OPS.curveTo2||draw===OPS.curveTo3){at+=4;points=[];}}if(points.length)addPath(points,false);}
 }
 else if(op===OPS.beginText){state.textMatrix=[...ID];state.lineMatrix=[...ID];state.pen=0;}
 else if(op===OPS.setFont){state.fontName=args[0];state.fontSize=args[1];try{const font=page.commonObjs.get(state.fontName);state.fontMatrix=font?.fontMatrix?.[0]??0.001;}catch{state.fontMatrix=0.001;}}
 else if(op===OPS.setTextMatrix){const matrix=Array.from(args.length===1?args[0]:args) as Matrix;state.textMatrix=matrix;state.lineMatrix=[...matrix];state.pen=0;}
 else if(op===OPS.moveText)moveText(args[0],args[1]);
 else if(op===OPS.setLeadingMoveText){state.leading=-args[1];moveText(args[0],args[1]);}
 else if(op===OPS.setLeading)state.leading=args[0];
 else if(op===OPS.nextLine)moveText(0,-state.leading);
 else if(op===OPS.setCharSpacing)state.charSpace=args[0];
 else if(op===OPS.setWordSpacing)state.wordSpace=args[0];
 else if(op===OPS.setHScale)state.hScale=args[0]/100;
 else if(op===OPS.setTextRise)state.rise=args[0];
 else if(op===OPS.showText||op===OPS.showSpacedText||op===OPS.nextLineShowText||op===OPS.nextLineSetSpacingShowText){
 if(op===OPS.nextLineShowText||op===OPS.nextLineSetSpacingShowText)moveText(0,-state.leading);
 if(op===OPS.nextLineSetSpacingShowText){state.wordSpace=args[0];state.charSpace=args[1];}
 const glyphs=args[op===OPS.nextLineSetSpacingShowText?2:0] as (number|{unicode:string;width:number;isSpace:boolean})[];
 if(!Array.isArray(glyphs))continue;
 for(let g=0;g<glyphs.length;g++){const glyph=glyphs[g];if(typeof glyph==='number'){state.pen-=glyph*state.fontSize*state.fontMatrix;continue;}
 const glyphWidth=glyph.width*state.fontSize*state.fontMatrix;
 if(/[◎★☆]/.test(glyph.unicode)){
 const matrix=multiply(state.ctm,state.textMatrix);
 if(!axisAligned(matrix)||glyph.unicode.length!==1||!Number.isFinite(glyphWidth)||glyphWidth<=0){geometry.unsupportedSymbols++;}
 else {
 const a=apply(matrix,state.pen*state.hScale,state.rise),b=apply(matrix,(state.pen+glyphWidth)*state.hScale,state.rise),va=viewport.convertToViewportPoint(...a),vb=viewport.convertToViewportPoint(...b);
 const following=glyphs.slice(g+1).map(v=>typeof v==='number'?'':v.unicode).join(''),suffix=following.match(/^\s*[（(]([^）)]*)[）)]/)?.[1]?.trim()??null;
 const x0=Math.min(va[0],vb[0]),x1=Math.max(va[0],vb[0]);geometry.symbols.push({symbol:glyph.unicode,x0,x1,x_center:(x0+x1)/2,y:va[1],suffix,coordinate_type:'pdf_point',coordinatePrecision:'glyph-advance'});
 }
 }
 state.pen+=glyphWidth+state.charSpace+(glyph.isSpace?state.wordSpace:0);
 }
 }
 }
 return geometry;
}
function baselineLines(tokens:Token[]):Token[][]{
 const lines:Token[][]=[];for(const token of [...tokens].sort((a,b)=>a.y-b.y||a.x0-b.x0)){const line=lines.find(l=>Math.abs(l[0].y-token.y)<=Math.max(2,Math.min(l[0].height,token.height)*0.3));if(line)line.push(token);else lines.push([token]);}return lines.sort((a,b)=>a[0].y-b[0].y).map(l=>l.sort((a,b)=>a.x0-b.x0));
}
function textOf(tokens:Token[]):string{return baselineLines(tokens).map(line=>line.map(t=>t.text).join(' ')).join('\n').trim();}
function role(text:string):string|null{
 const normalized=text.replace(/\s+/g,'');return roleName(text)??(/^원장\/기술(?:지원)?센터장$/.test(normalized)?normalized:null);
}
function mergedHorizontal(line:Token[]):Token[]{const out:Token[]=[];for(const t of line){const p=out.at(-1);if(p&&t.x0-p.x1<=Math.max(p.height,t.height)*1.35){p.text+=' '+t.text;p.x1=Math.max(p.x1,t.x1);}else out.push({...t});}return out;}
function headersFrom(tokens:Token[],rectangles:Box[]):Header[][]{
 const candidates:Header[]=[];
 // A physical header cell joins fragments by common x/y containment first.
 for(const rect of rectangles){const insideTokens=tokens.filter(t=>inside(center(t),t.y-t.height*0.3,rect,0.5));const text=textOf(insideTokens),name=role(text);if(name)candidates.push({...rect,text,name,x_center:center(rect)});}
 // Fallback for ruled or unruled two-line headers: require overlapping x extents.
 const merged=baselineLines(tokens).flatMap(mergedHorizontal);
 for(const t of merged){let name=role(t.text),joined=[t];for(const other of merged){if(other===t||!overlaps(t,other)||Math.abs(t.y-other.y)>Math.max(t.height,other.height)*2.7)continue;const value=role(textOf([t,other]));if(value&&(!name||value.length>name.length)){name=value;joined=[t,other];}}
 if(name){const box=extent(joined.flatMap(t=>[[t.x0,t.y0],[t.x1,t.y1]] as [number,number][]));if(!candidates.some(c=>c.name===name&&inside(center(box),(box.y0+box.y1)/2,c,2)))candidates.push({...box,name,text:textOf(joined),x_center:center(box)});}}
 const bands:Header[][]=[];for(const candidate of candidates.sort((a,b)=>a.y0-b.y0||a.x0-b.x0)){const band=bands.find(b=>b.some(h=>Math.min(h.y1,candidate.y1)-Math.max(h.y0,candidate.y0)>0));if(band){if(!band.some(h=>close(h.x_center,candidate.x_center,8))){band.push(candidate);}else{const at=band.findIndex(h=>close(h.x_center,candidate.x_center,8));if(candidate.text.length>band[at].text.length)band[at]=candidate;}}else bands.push([candidate]);}
 return bands.filter(b=>b.length>=2).map(b=>b.sort((a,b)=>a.x_center-b.x_center)).sort((a,b)=>a[0].y0-b[0].y0);
}
function columnsFor(headers:Header[],geometry:Geometry):Column[]{
 return headers.map((header,i)=>{
 const headerCells=geometry.rectangles.filter(r=>inside(header.x_center,(header.y0+header.y1)/2,r,1)&&r.x1-r.x0<150).sort((a,b)=>(a.x1-a.x0)*(a.y1-a.y0)-(b.x1-b.x0)*(b.y1-b.y0));
 const cell=headerCells.find(c=>!headers.some(h=>h!==header&&h.x_center>c.x0+1&&h.x_center<c.x1-1));
 if(cell)return {header,name:header.name,left:cell.x0,right:cell.x1,column_detection:'vertical_lines'};
 const y=(header.y0+header.y1)/2,lines=geometry.vertical.filter(l=>y>=Math.min(l.a[1],l.b[1])-2&&y<=Math.max(l.a[1],l.b[1])+2).map(l=>(l.a[0]+l.b[0])/2);
 const left=lines.filter(x=>x<header.x_center-1).sort((a,b)=>b-a)[0],right=lines.filter(x=>x>header.x_center+1).sort((a,b)=>a-b)[0];
 if(left!==undefined&&right!==undefined&&!headers.some(h=>h!==header&&h.x_center>left&&h.x_center<right))return {header,name:header.name,left,right,column_detection:'vertical_lines'};
 const previous=headers[i-1],next=headers[i+1],distance=next?next.x_center-header.x_center:header.x_center-previous.x_center;
 return {header,name:header.name,left:previous?(previous.x_center+header.x_center)/2:header.x_center-distance/2,right:next?(next.x_center+header.x_center)/2:header.x_center+distance/2,column_detection:'header_midpoints'};
 });
}
function cellForToken(token:Token,rectangles:Box[]):Box|null{
 const boxes=rectangles.filter(r=>inside(center(token),token.y-token.height*0.3,r,0.6));return boxes.sort((a,b)=>(a.x1-a.x0)*(a.y1-a.y0)-(b.x1-b.x0)*(b.y1-b.y0))[0]??null;
}
function reconstructCells(tokens:Token[],rectangles:Box[]):(Box&{tokens:Token[];text:string})[]{
 const cells:(Box&{tokens:Token[];text:string})[]=[];
 for(const token of tokens){const rect=cellForToken(token,rectangles);if(!rect)continue;let cell=cells.find(c=>Object.keys(rect).every(k=>close(c[k as keyof Box],rect[k as keyof Box],0.6)));if(!cell){cell={...rect,tokens:[],text:''};cells.push(cell);}cell.tokens.push(token);}
 for(const cell of cells)cell.text=textOf(cell.tokens);return cells;
}
function sectionTitle(tokens:Token[],y:number):string|null{
 const before=baselineLines(tokens.filter(t=>t.y<y&&y-t.y<70));return before.map(textOf).find(s=>/^(?:[가-힣]\.|\d+[.)])\s*(?:공통|개별).*위임전결/.test(s))??null;
}
function roleField(text:string):keyof Fields|null{const s=text.replace(/\s+/g,'');if(/^(구분|부서|담당부서)$/.test(s))return 'category';if(/^(업무|업무내용|전결사항)$/.test(s))return 'task';if(/^(조건|세부조건|세부사항|금액|기준)$/.test(s))return 'condition';return null;}

export async function extractPdfLayout(bytes:Uint8Array):Promise<{rows:StructuredRow[];pages:number;text:string;debug:unknown[]}>{
 const pdf=await getDocumentProxy(bytes.slice()),rows:StructuredRow[]=[],debug:unknown[]=[];let allText='',prior:Context|null=null;
 try{for(let pageNo=1;pageNo<=pdf.numPages;pageNo++){
 const page=await pdf.getPage(pageNo),viewport=page.getViewport({scale:1}),content=await page.getTextContent();
 const tokens:Token[]=content.items.flatMap(item=>{if(!('str' in item)||!item.str.trim())return [];const position=viewport.convertToViewportPoint(item.transform[4],item.transform[5]),height=Math.max(1,item.height);return [{text:item.str,x0:position[0],x1:position[0]+item.width,y:position[1],y0:position[1]-height,y1:position[1]+height*0.2,height}];});
 allText+=textOf(tokens)+'\n';const geometry=await positionedGraphics(page,viewport),bands=headersFrom(tokens,geometry.rectangles);
 if(!bands.length){if(tokens.some(t=>/[◎★☆]/.test(t.text)))debug.push({page:pageNo,stage:'header_detection',error:'layout_error',message:'No coherent authority header band; no approver inferred.'});prior=null;page.cleanup();continue;}
 const cells=reconstructCells(tokens,geometry.rectangles);
 for(let bandIndex=0;bandIndex<bands.length;bandIndex++){
 const headers=bands[bandIndex],headerBottom=Math.max(...headers.map(h=>h.y1)),nextTop=bandIndex+1<bands.length?Math.min(...bands[bandIndex+1].map(h=>h.y0)):viewport.height-25;
 const columns=columnsFor(headers,geometry),firstRole=Math.min(...columns.map(c=>c.left)),signature=columns.map(c=>`${c.name}:${Math.round(c.left/3)}:${Math.round(c.right/3)}`).join('|'),title=sectionTitle(tokens,Math.min(...headers.map(h=>h.y0)));
 const currentSymbols=geometry.symbols.filter(s=>s.y>headerBottom+1&&s.y<nextTop-1&&!tokens.some(t=>/[◎★☆]\s*[:：]/.test(t.text)&&inside(s.x_center,s.y-t.height*0.3,t,1)));
 const headerFields=cells.filter(c=>c.x1<=firstRole+2&&c.y0<=headerBottom&&c.y1>=Math.min(...headers.map(h=>h.y0))).map(c=>({cell:c,field:roleField(c.text)})).filter(c=>c.field);
 const categoryHeader=headerFields.find(c=>c.field==='category'),taskHeader=headerFields.find(c=>c.field==='task'),conditionHeader=headerFields.find(c=>c.field==='condition');
 const before:Context|null=prior as Context|null;
 const continuable:boolean=!!before&&(before.page===pageNo-1||before.page===pageNo)&&before.signature===signature&&(!title||title===before.title);
 const state:Fields=continuable?{category:before!.category,task:before!.task,condition:before!.condition}:{category:null,task:null,condition:null};
 const dataCells=cells.filter(c=>c.x1<=firstRole+2&&c.y0>=headerBottom-1&&c.y1<nextTop+1&&!roleField(c.text)&&!/[◎★☆]\s*[:：]/.test(c.text));
 for(const businessCell of dataCells.filter(c=>/^\d+[.)]/.test(c.text.trim()))){if(!currentSymbols.some(s=>s.y>=businessCell.y0&&s.y<=businessCell.y1))debug.push({page:pageNo,stage:'symbol_detection',code:'no_symbol_in_source',task:businessCell.text,bounding_box:{x0:businessCell.x0,x1:businessCell.x1,y0:businessCell.y0,y1:businessCell.y1},message:'No authority symbol within this source task cell span; no approver inferred.'});}
 const symbolsByBaseline:{y:number;symbols:PdfSymbol[]}[]=[];for(const symbol of currentSymbols.sort((a,b)=>a.y-b.y||a.x_center-b.x_center)){let group=symbolsByBaseline.find(g=>Math.abs(g.y-symbol.y)<=3);if(!group){group={y:symbol.y,symbols:[]};symbolsByBaseline.push(group);}group.symbols.push(symbol);}
 for(const group of symbolsByBaseline){
 const active=dataCells.filter(c=>group.y>=c.y0-1&&group.y<=c.y1+2).sort((a,b)=>a.x0-b.x0),values:Fields={category:null,task:null,condition:null},filled:Filled[]=[];
 if(categoryHeader){const category=active.find(c=>overlaps(c,categoryHeader.cell)&&center(c)<categoryHeader.cell.x1);if(category){values.category=category.text;if(category.y0<group.y-15)filled.push({field:'category',source:'merged_cell',source_page:pageNo});}}
 const business=active.filter(c=>!categoryHeader||c.x0>=categoryHeader.cell.x1-1);
 if(taskHeader){const tasks=business.filter(c=>overlaps(c,taskHeader.cell));const task=tasks.find(c=>/^\d+[.)]/.test(c.text.trim()))??tasks[0];if(task){values.task=task.text;if(task.y0<group.y-15)filled.push({field:'task',source:'merged_cell',source_page:pageNo});}
 const remainder=tasks.filter(c=>c!==task);if(remainder.length)values.condition=remainder.map(c=>c.text).join(' / ');
 }
 if(conditionHeader){const conditions=business.filter(c=>overlaps(c,conditionHeader.cell));if(conditions.length)values.condition=conditions.map(c=>c.text).join(' / ');}
 // Unruled fallback: explicit field headers define the x-center intervals, never a whole-line string.
 const fallbackLines=baselineLines(tokens.filter(t=>Math.abs(t.y-group.y)<4&&t.x1<firstRole));
 if(!active.length&&fallbackLines.length){const fieldTokens=baselineLines(tokens.filter(t=>t.y>=Math.min(...headers.map(h=>h.y0))-3&&t.y<=headerBottom+1&&t.x1<=firstRole)).flatMap(mergedHorizontal).map(t=>({token:t,field:roleField(t.text)})).filter(f=>f.field);
 for(const f of fieldTokens){const ordered=fieldTokens.sort((a,b)=>center(a.token)-center(b.token)),at=ordered.indexOf(f),left=at?(center(ordered[at-1].token)+center(f.token))/2:0,right=at<ordered.length-1?(center(f.token)+center(ordered[at+1].token))/2:firstRole;const value=textOf(fallbackLines.flat().filter(t=>center(t)>=left&&center(t)<right));if(value)values[f.field!]=value;}}
 if(values.category&&values.category!==state.category){state.task=null;state.condition=null;}if(values.task&&values.task!==state.task)state.condition=null;
 for(const field of ['category','task','condition'] as const){if(values[field])state[field]=values[field];else if(state[field])filled.push({field,source:continuable&&before!.page<pageNo&&state[field]===before?.[field]?'previous_page':'previous_row',source_page:continuable&&state[field]===before?.[field]?before!.page:pageNo});}
 for(const symbol of group.symbols){
 const owningCell=cells.find(c=>inside(symbol.x_center,symbol.y-2,c,1)&&c.text.includes(symbol.symbol));const owningToken=tokens.find(t=>inside(symbol.x_center,symbol.y-t.height*0.2,t,2)&&t.text.includes(symbol.symbol));const suffixText=owningCell?.text??owningToken?.text;if(!symbol.suffix&&suffixText)symbol.suffix=suffixText.slice(suffixText.indexOf(symbol.symbol)+1).match(/^\s*[（(]([^）)]*)[）)]/)?.[1]?.trim()??null;
 const candidates=columns.filter(c=>symbol.x_center>=c.left&&symbol.x_center<c.right),column=candidates.length===1?candidates[0]:null;
 const margin=column?Math.min(symbol.x0-column.left,column.right-symbol.x1):-1,boundaryClear=margin>1;
 const basis=['header_detected','glyph_width_measured',...(column?['symbol_inside_column']:[]),...(column?.column_detection==='vertical_lines'?['vertical_boundary_detected']:['header_midpoints_used']),...(active.length?['data_cells_reconstructed']:[]),...filled.map(f=>`${f.field}_fill_down`),...(!boundaryClear?['symbol_near_boundary']:[])];
 const valid=!!column&&!!state.task&&!!state.condition&&boundaryClear;const confidence=valid?(column.column_detection==='vertical_lines'?(state.category?0.96:0.92):0.8):0.4;
 const symbolCell=geometry.rectangles.filter(r=>inside(symbol.x_center,symbol.y-2,r,0.5)).sort((a,b)=>(a.x1-a.x0)*(a.y1-a.y0)-(b.x1-b.x0)*(b.y1-b.y0))[0];const bbox=symbolCell?{x0:categoryHeader?.cell.x0??Math.min(...active.map(c=>c.x0),symbolCell.x0),x1:Math.max(...columns.map(c=>c.right)),y0:symbolCell.y0,y1:symbolCell.y1}:{x0:Math.min(...active.map(c=>c.x0),symbol.x0),x1:Math.max(...columns.map(c=>c.right)),y0:group.y-12,y1:group.y+3};
 const row:StructuredRow={page:pageNo,table_id:`pdf-${pageNo}-${bandIndex}`,...state,approver:column?.name??null,symbol:symbol.symbol,symbol_x_center:symbol.x_center,suffix:symbol.suffix,legend:null,confidence,version_warning:null,symbol_coordinates:symbol,bounding_box:bbox,coordinate_space:'pdf-points-top-left',header_evidence:column,raw_cells:active.map(c=>({bbox:{x0:c.x0,x1:c.x1,y0:c.y0,y1:c.y1},text:c.text})),needs_review:!valid,
 coordinate_type:'pdf_point',x_center:symbol.x_center,y:symbol.y,column_detection:column?.column_detection??null,confidence_basis:basis,fill_down:filled,debug:{headers:columns,task:state.task,condition:state.condition,symbol,column:column?.name??null,fill_down:filled,failure_stage:!column?'column_mapping':!state.task||!state.condition?'cell_relationships':!boundaryClear?'boundary_check':null}};
 rows.push(row);
 }
 }
 prior={...state,page:pageNo,signature,title:title??(continuable?before?.title??null:null)};
 if(geometry.unsupportedSymbols)debug.push({page:pageNo,stage:'symbol_coordinates',error:'unsupported_rotated_or_compound_glyph',count:geometry.unsupportedSymbols});
 debug.push({page:pageNo,header_band:bandIndex,headers:columns,column_detection:columns.every(c=>c.column_detection==='vertical_lines')?'vertical_lines':'header_midpoints',cell_count:dataCells.length,continuation_confirmed:continuable,title});
 }
 page.cleanup();
 }
 if(!allText.trim())throw new DocumentError('no_text_layer','PDF에 추출 가능한 텍스트 레이어가 없습니다.');const legends=parseLegends(allText);for(const row of rows){row.legend=legends[row.symbol];if(row.suffix){const declaredAlias=row.suffix==='책임원'&&/(?:^|\n)\s*책임원\s+재무책임원(?=\s|$)/.test(allText);row.effective_approver=declaredAlias?'재무책임원':row.suffix;row.approver_basis={type:declaredAlias?'document_glossary_and_symbol_suffix':'symbol_suffix',header_column:row.approver,suffix:row.suffix,glossary:declaredAlias?'책임원 → 재무책임원':null};}else{row.effective_approver=row.approver;row.approver_basis={type:'header_column'};}}return {rows,pages:pdf.numPages,text:allText,debug};
 }catch(error){if(error instanceof DocumentError)throw error;throw new DocumentError('layout_error',error instanceof Error?error.message:String(error));}finally{await pdf.loadingTask.destroy();}
}
