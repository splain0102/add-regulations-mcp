import {grams} from '../d1/normalize';
const SIZE=32768;
function hashes(term:string){let a=2166136261,b=5381;for(const c of term){a=Math.imul(a^c.charCodeAt(0),16777619);b=Math.imul(b,33)^c.charCodeAt(0);}return [a>>>0,b>>>0,(a+b)>>>0].map(n=>n%SIZE);}
export function bloom(text:string){const bytes=new Uint8Array(SIZE/8);for(const term of grams(text))for(const bit of hashes(term))bytes[bit>>3]|=1<<(bit&7);let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte);return btoa(binary);}
// A negative result is definitive. Positive results are always verified against
// the real normalized row, so probabilistic collisions cannot add false hits.
export function mightMatch(filter:string|undefined,terms:string[]){if(!filter)return true;const bytes=atob(filter);return terms.flatMap(grams).every(term=>hashes(term).every(bit=>(bytes.charCodeAt(bit>>3)&(1<<(bit&7)))!==0));}
