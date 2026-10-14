import {gzipSync,gunzipSync,strToU8,strFromU8} from 'fflate';
import type {Table,StructuredRow} from './table-layout';
import type {PdfLayoutPage} from './pdf-regression-layout';
export const DOCUMENT_INDEX_SCHEMA=1;
export type PreparedDocument={schema:number;encoding:'gzip-base64';uncompressedBytes:number;data:string};
export type DocumentEvidence={meta:Record<string,any>;tables?:Table[];rows?:StructuredRow[];pdfPages?:PdfLayoutPage[];layoutDebug?:unknown[]};
const MAX_BYTES=12_000_000,MAX_COMPRESSED=750_000;
export function packDocument(value:DocumentEvidence):PreparedDocument{
 const raw=strToU8(JSON.stringify(value));if(raw.length>MAX_BYTES)throw Error('document_index_size_limit');
 const zip=gzipSync(raw,{level:6,mtime:0});if(zip.length>MAX_COMPRESSED)throw Error('document_index_compressed_limit');
 let binary='';for(let i=0;i<zip.length;i+=8192)binary+=String.fromCharCode(...zip.subarray(i,i+8192));
 return {schema:DOCUMENT_INDEX_SCHEMA,encoding:'gzip-base64',uncompressedBytes:raw.length,data:btoa(binary)};
}
export function unpackDocument(value:PreparedDocument):DocumentEvidence{
 if(value.schema!==DOCUMENT_INDEX_SCHEMA||value.encoding!=='gzip-base64'||!Number.isInteger(value.uncompressedBytes)||value.uncompressedBytes<1||value.uncompressedBytes>MAX_BYTES||value.data.length>MAX_COMPRESSED*4/3+4)throw Error('document_index_incompatible');
 const binary=atob(value.data),bytes=Uint8Array.from(binary,c=>c.charCodeAt(0));
 // Gzip ISIZE bounds allocation before decompression; exact length checked after.
 if(bytes.length<18||new DataView(bytes.buffer).getUint32(bytes.length-4,true)!==value.uncompressedBytes)throw Error('document_index_corrupt');
 const raw=gunzipSync(bytes,{out:new Uint8Array(value.uncompressedBytes)});if(raw.length!==value.uncompressedBytes)throw Error('document_index_corrupt');
 const result=JSON.parse(strFromU8(raw));if(!result.meta||!Array.isArray(result.rows))throw Error('document_index_corrupt');return result;
}
