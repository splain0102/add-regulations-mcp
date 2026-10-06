import * as CFB from 'cfb';
import {inflateSync, unzipSync, strFromU8} from 'fflate';
import {getDocumentProxy} from 'unpdf';
import {DocumentError} from './table-layout';

// Selection reads paragraph text records only: no DocInfo, table IR, images,
// footnotes, drawing operators, Markdown, or positioned PDF layout.
export async function extractRevisionSection(bytes:Uint8Array, extension:string):Promise<string> {
 let section='', collecting=false;
 const accept=(text:string)=>{
  if(/^[ \t]*부[ \t]*칙/.test(text)){collecting=true;section+=text+'\n';}
  else if(collecting){if(/^\s*\[?별\s*(표|지)/.test(text))collecting=false;else section+=text+'\n';}
  if(section.length>64000)throw new DocumentError('parse_error','부칙 텍스트 처리 한도 초과');
 };
 if(extension==='hwp'){
  const cfb=CFB.read(bytes,{type:'buffer'});
  const headerContent=CFB.find(cfb,'/FileHeader')?.content;
  const header=headerContent?Uint8Array.from(headerContent):null;
  if(!header||header.length<40)throw new DocumentError('parse_error','HWP FileHeader 누락');
  const flags=new DataView(header.buffer,header.byteOffset,header.byteLength).getUint32(36,true);
  if(flags&6)throw new DocumentError('parse_error','암호화 또는 배포용 HWP 부칙 미지원');
  const paths=cfb.FullPaths.filter(p=>/\/BodyText\/Section\d+$/.test(p)).sort((a,b)=>Number(a.match(/\d+$/)![0])-Number(b.match(/\d+$/)![0]));
  if(!paths.length)throw new DocumentError('parse_error','HWP BodyText 누락');
  for(const path of paths){
   const content=CFB.find(cfb,path)?.content;if(!content)continue;
   const raw=Uint8Array.from(content);
   const data=flags&1?inflateSync(raw):raw;
   if(data.length>32000000)throw new DocumentError('parse_error','HWP 섹션 처리 한도 초과');
   const view=new DataView(data.buffer,data.byteOffset,data.byteLength);
   for(let offset=0;offset+4<=data.length;){
    const record=view.getUint32(offset,true);offset+=4;let size=record>>>20;
    if(size===4095){if(offset+4>data.length)throw new DocumentError('parse_error','HWP 레코드 헤더 손상');size=view.getUint32(offset,true);offset+=4;}
    if(offset+size>data.length)throw new DocumentError('parse_error','HWP 레코드 길이 손상');
    if((record&1023)===67&&((record>>>10)&1023)===1){
     let text='';for(let p=offset;p+1<offset+size;){const ch=view.getUint16(p,true);if(ch===13)break;if(ch===9){text+='\t';p+=16;}else if((ch>=1&&ch<=8)||(ch>=11&&ch<=23)){p+=16;}else{if(ch>=32)text+=String.fromCharCode(ch);else if(ch===10)text+='\n';p+=2;}}
     accept(text);
    }
    offset+=size;
   }
  }
 }else if(extension==='hwpx'){
  let size=0;const zip=unzipSync(bytes,{filter(entry){if(!/^Contents\/section\d+\.xml$/i.test(entry.name))return false;size+=entry.originalSize;if(size>32000000)throw new DocumentError('parse_error','HWPX 섹션 처리 한도 초과');return true;}});
  for(const path of Object.keys(zip).sort((a,b)=>Number(a.match(/section(\d+)/i)![1])-Number(b.match(/section(\d+)/i)![1]))){
   // Strip tables before scanning paragraphs; the selector never builds cell IR.
   const xml=strFromU8(zip[path]).replace(/<hp:tbl\b[\s\S]*?<\/hp:tbl>/g,'');
   for(const m of xml.matchAll(/<hp:p\b[\s\S]*?<\/hp:p>/g))accept(m[0].replace(/<[^>]*>/g,'').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&'));
  }
 }else if(extension==='pdf'){
  const pdf=await getDocumentProxy(bytes.slice());
  try{for(let number=1;number<=pdf.numPages;number++){const page=await pdf.getPage(number);try{const content=await page.getTextContent();let line='';for(const item of content.items){if(!('str' in item))continue;line+=item.str+' ';if(item.hasEOL){accept(line.trim());line='';}}if(line.trim())accept(line.trim());}finally{page.cleanup();}}}finally{await pdf.loadingTask.destroy();}
 }else throw new DocumentError('parse_error','부칙 확인을 지원하지 않는 첨부 형식');
 return section;
}
