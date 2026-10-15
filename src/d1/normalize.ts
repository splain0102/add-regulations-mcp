export const INDEX_SCHEMA_VERSION=1;
export const normalize=(s:string)=>s.normalize('NFKC').toLowerCase().replace(/[\s,]+/g,'');
export const normalizeName=(s:string)=>normalize(s).replace(/[·･‧ㆍ・「」｢｣()（）]/g,'');
// Hex tokens avoid FTS syntax, punctuation and tokenizer-specific Hangul boundaries.
export function grams(s:string){const chars=Array.from(normalize(s)),out=new Set<string>();for(let i=0;i+1<chars.length;i++)out.add('g'+chars[i].codePointAt(0)!.toString(16)+'z'+chars[i+1].codePointAt(0)!.toString(16));return [...out];}
export function queryTerms(query:string){
 const terms=query.normalize('NFKC').trim().split(/[\s,;/]+/).map(normalize).filter(Boolean);
 const joined=normalize(query);
 if(Array.from(joined).length<2)return {warning:'query_too_short',terms,joined,fts:''};
 if(!/[\p{L}\p{N}]{2}/u.test(joined))return {warning:'symbol_query',terms,joined,fts:''};
 // A one-character component is verified after the indexed longer components.
 const indexed=terms.flatMap(grams);if(!indexed.length)indexed.push(...grams(joined));
 return {warning:null,terms,joined,fts:[...new Set(indexed)].map(g=>'"'+g+'"').join(' AND ')};
}

export function normalizeWithMap(text:string){
 const map:number[]=[],parts:string[]=[];let originalPosition=0;
 for(const char of text){originalPosition++;const value=normalize(char);parts.push(value);for(const _ of value)map.push(originalPosition);}
 if(parts.join('')!==normalize(text))throw Error('normalization_mapping_unsupported');return map;
}
