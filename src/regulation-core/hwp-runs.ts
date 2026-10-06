import * as CFB from 'cfb';
import {inflateSync} from 'fflate';
export type TextRun={text:string;size:number|null;superscript:boolean|null;nativeControl?:boolean};
export type Footnote={mark:string;text:string;detected_by:'superscript'|'font_size'|'unicode'|'position'};
type RecordItem={tag:number;level:number;data:Uint8Array};
const view=(data:Uint8Array)=>new DataView(data.buffer,data.byteOffset,data.byteLength);
const ctrl=(data:Uint8Array)=>String.fromCharCode(...data.slice(0,4).reverse());
function records(data:Uint8Array):RecordItem[]{
 const out:RecordItem[]=[],v=view(data);for(let p=0;p+4<=data.length;){const h=v.getUint32(p,true);p+=4;let n=h>>>20;if(n===4095){if(p+4>data.length)throw new Error('HWP record header');n=v.getUint32(p,true);p+=4;}if(p+n>data.length)throw new Error('HWP record length');out.push({tag:h&1023,level:(h>>>10)&1023,data:data.slice(p,p+n)});p+=n;}return out;
}
function plain(data:Uint8Array){let text='';const v=view(data);for(let p=0;p+1<data.length;){const ch=v.getUint16(p,true);if(ch===13)break;if(ch===9){text+='\t';p+=16;}else if((ch>=1&&ch<=8)||ch===11||ch===12||(ch>=14&&ch<=23))p+=16;else{if(ch>=32||ch===10)text+=String.fromCharCode(ch);else if([24,25,31].includes(ch))text+=' ';else if(ch===30)text+='-';p+=2;}}return text;}
/** Raw UTF-16 character positions include eight-word controls. Do not apply
 * PARA_CHAR_SHAPE offsets to the already stripped paragraph text. */
export function hwpParagraphEvidence(bytes:Uint8Array,shapes:any[]){
 const f=CFB.read(bytes,{type:'buffer'}),header=Uint8Array.from(CFB.find(f,'/FileHeader')!.content!);
 const compressed=(view(header).getUint32(36,true)&1)!==0;
 const byText=new Map<string,{runs:TextRun[];notes:{mark:string;text:string}[]}[]>();
 for(const path of f.FullPaths.filter(p=>/\/BodyText\/Section\d+$/.test(p))){
  const section=Number(path.match(/\d+$/)![0]),raw=Uint8Array.from(CFB.find(f,path)!.content!),rs=records(compressed?inflateSync(raw):raw);
  const ancestors:number[]=[];
  for(let i=0;i<rs.length;i++){
   while(ancestors.length&&rs[ancestors.at(-1)!].level>=rs[i].level)ancestors.pop();
   const inNote=ancestors.some(a=>rs[a].tag===71&&ctrl(rs[a].data)==='fn  ');
   ancestors.push(i);
   const head=rs[i];if(head.tag!==66||head.level===0||inNote)continue;let end=i+1;while(end<rs.length&&rs[end].level>head.level)end++;
   const direct=rs.slice(i+1,end).filter(r=>r.level===head.level+1),textRec=direct.find(r=>r.tag===67);if(!textRec)continue;
   const changes=direct.find(r=>r.tag===68)?.data,points:{pos:number;id:number}[]=[];
   if(changes){const v=view(changes);for(let p=0;p+8<=changes.length;p+=8)points.push({pos:v.getUint32(p,true),id:v.getUint32(p+4,true)});}
   const notes:{mark:string;text:string}[]=[],anchors:{mark:string}[]=[];
   for(let j=i+1;j<end;j++)if(rs[j].level===head.level+1&&rs[j].tag===71&&ctrl(rs[j].data)==='fn  '){
    const mark=view(rs[j].data).getUint32(4,true)+')';let stop=j+1;while(stop<end&&rs[stop].level>rs[j].level)stop++;
    const paragraphs=rs.slice(j+1,stop).filter(r=>r.tag===67).map(r=>plain(r.data).trim()).filter(Boolean);
    const body:string[]=[];for(const line of paragraphs){const m=line.match(/^※\s*(.+)/);if(m)notes.push({mark:'※',text:m[1]});else body.push(line);}
    if(body.length)notes.push({mark,text:body.join('\n')});anchors.push({mark});
   }
   const runs:TextRun[]=[],data=textRec.data,v=view(data);let anchor=0;
   const add=(text:string,pos:number,native=false)=>{if(!text)return;const id=points.filter(x=>x.pos<=pos).at(-1)?.id??0,shape=shapes[id];const run:TextRun={text,size:shape?.baseSize!=null?shape.baseSize/100:null,superscript:native?true:shape?!!(shape.property&0x8000):null,...(native?{nativeControl:true}:{})};const prev=runs.at(-1);if(!native&&prev&&!prev.nativeControl&&prev.size===run.size&&prev.superscript===run.superscript)prev.text+=text;else runs.push(run);};
   for(let p=0;p+1<data.length;){const ch=v.getUint16(p,true),pos=p/2;if(ch===13)break;
    if(ch===17&&ctrl(data.slice(p+2,p+6))==='fn  '){const mark=anchors[anchor++]?.mark;if(mark)add(mark,pos,true);p+=16;}
    else if(ch===9){add('\t',pos);p+=16;}
    else if((ch>=1&&ch<=8)||ch===11||ch===12||(ch>=14&&ch<=23))p+=16;
    else{add(ch>=32||ch===10?String.fromCharCode(ch):[24,25,31].includes(ch)?' ':ch===30?'-':'',pos);p+=2;}
   }
   const key=section+'\0'+plain(data),items=byText.get(key)??[];items.push({runs,notes});byText.set(key,items);
  }
 }
 return (section:number,text:string)=>byText.get(section+'\0'+text)?.shift();
}
export function canonicalMark(mark:string){
 const circled='①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';if(circled.includes(mark)&&mark.length===1)return (circled.indexOf(mark)+1)+')';
 const digits='⁰¹²³⁴⁵⁶⁷⁸⁹';return mark.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/g,c=>String(digits.indexOf(c))).replace(/[⁾）]/g,')').replace(/^([0-9]+)$/,'$1)');
}
export function resolveCellFootnotes(cell:{text:string;runs?:TextRun[];nativeNotes?:{mark:string;text:string}[]},block:{mark:string;text:string}[]){
 const joined=cell.runs?.map(r=>r.text).join('')??cell.text,runs=cell.runs??[];
 const weights=new Map<number,number>();for(const r of runs)if(r.size&&!r.superscript)weights.set(r.size,(weights.get(r.size)??0)+r.text.replace(/\s/g,'').length);
 const base=[...weights].sort((a,b)=>b[1]-a[1])[0]?.[0]??null,linked:Footnote[]=[],remove:{start:number;end:number}[]=[];
 const pattern=/(?:\d+(?:-\d+)?[)⁾）]|[①-⑳]|[⁰¹²³⁴⁵⁶⁷⁸⁹]+[)⁾）]?|※)/g;
 for(const m of joined.matchAll(pattern)){
  const start=m.index!,end=start+m[0].length;let position=0;
  const touched=runs.filter(r=>{const from=position;position+=r.text.length;return from<end&&position>start;});
  let method:Footnote['detected_by']|null=null;
  if(touched.length&&touched.every(r=>r.superscript===true))method='superscript';
  else if(base&&touched.length&&touched.every(r=>r.size!=null&&r.size<=base*0.85))method='font_size';
  else if(/[①-⑳⁰¹²³⁴⁵⁶⁷⁸⁹⁾]/.test(m[0]))method='unicode';
  else if(!touched.length||touched.some(r=>r.size===null||r.superscript===null)){
   if(joined.slice(0,start).trim()&&(start===0||!/[\d-]/.test(joined[start-1])))method='position';
  }
  if(!method)continue;
  const mark=canonicalMark(m[0]),note=(cell.nativeNotes??[]).find(n=>canonicalMark(n.mark)===mark)??block.find(n=>canonicalMark(n.mark)===mark);
  // A confirmed marker can be removed even when its definition is unavailable;
  // only explicit definitions outside table data may enter footnotes.
  remove.push({start,end});if(note&&!linked.some(n=>n.mark===mark))linked.push({mark,text:note.text,detected_by:method});
 }
 let text=joined;for(const span of remove.reverse())text=text.slice(0,span.start)+text.slice(span.end);
 return {text,footnotes:linked};
}
