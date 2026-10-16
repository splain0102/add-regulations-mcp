// Korean money amounts ("10억", "300만원", "1억5천만 원") and the ranges that
// delegation-table conditions state ("2억 원 이상 5억 원 미만", "용역비 5억 초과").
const UNIT:Record<string,number>={조:1e12,억:1e8,천만:1e7,백만:1e6,만:1e4,천:1e3};
const PART=/(\d+(?:\.\d+)?)\s*(조|억|천만|백만|만|천)?/g;
// Value of a query term that is purely an amount, else null ("10억" → 1e9).
export function amountOf(term:string):number|null{
 const t=term.replace(/[,\s]/g,'').replace(/원$/,'');
 if(!/^(?:\d+(?:\.\d+)?(?:조|억|천만|백만|만|천)?)+$/.test(t)||!/[조억만천]/.test(t))return null;
 let total=0;for(const m of t.matchAll(PART))total+=Number(m[1])*(m[2]?UNIT[m[2]]:1);return total||null;
}
export type Range={min:number;minInclusive:boolean;max:number;maxInclusive:boolean};
// Bounds stated in a condition. Each amount must carry a unit and be followed by
// 이상/초과/미만/이하; conditions without one have no range (null).
export function rangeOf(text:string):Range|null{
 const re=/((?:\d+(?:\.\d+)?\s*(?:조|억|천만|백만|만|천)\s*)+)원?\s*(이상|초과|미만|이하)/g;let range:Range|null=null;
 for(const m of text.replace(/,/g,'').matchAll(re)){const v=amountOf(m[1]);if(v===null)continue;range??={min:-Infinity,minInclusive:true,max:Infinity,maxInclusive:true};
  if(m[2]==='이상'||m[2]==='초과'){range.min=v;range.minInclusive=m[2]==='이상';}else{range.max=v;range.maxInclusive=m[2]==='이하';}}
 return range;
}
export function inRange(v:number,r:Range){return (r.minInclusive?v>=r.min:v>r.min)&&(r.maxInclusive?v<=r.max:v<r.max);}
