// 위임전결규정 [별표] are split under headings "가. 공통 위임전결사항(전 부서 적용)"
// and "나. 개별 위임전결사항": common rows apply to every department, individual
// rows only to the department named in their 구분 cell. The heading is plain text
// before each table, so each delegation table takes the last heading preceding it
// in the document text (a table continued across pages keeps its heading).
export type DelegationScope={delegation_scope:'common'|'individual';scope_label:string};
const compact=(s:string)=>s.replace(/\s+/g,'');
// Headings only: the article that introduces both kinds ("공통 위임전결사항, 개별
// 위임전결사항으로 구분하며") is prose, recognised by the particle or comma after it.
const HEADING=/(공통|개별)위임전결사항(?![,，、·]|으로|과|와|및|은|는|을|를|에|의|이|가)(\([^)]{0,20}\))?/g;
export function delegationScopes(text:string,rows:any[]):Map<string,DelegationScope>{
 const scopes=new Map<string,DelegationScope>(),c=compact(String(text??'')),headings=[...c.matchAll(HEADING)].map(m=>({at:m.index!,scope:m[1]==='공통'?'common' as const:'individual' as const,label:m[1]==='공통'?'공통 위임전결사항(전 부서 적용)':'개별 위임전결사항(해당 부서)'}));
 if(!headings.length)return scopes;
 // A table is located by the first of its task names found in the text after the
 // previous table (legend rows such as "★: 부설기구의 경우…" are skipped).
 const byTable=new Map<string,any[]>();for(const r of rows)if(r?.result?.analysis_type==='delegation_table'){const list=byTable.get(r.table_key)??[];list.push(r);byTable.set(r.table_key,list);}
 let cursor=0;
 for(const [table,list] of byTable){let at=-1;
  for(const r of list.slice(0,40)){const a=compact(String(r.result.task??''));if(a.length<4||/^[★☆◎○●※]/.test(a))continue;at=c.indexOf(a,cursor);if(at>=0)break;}
  if(at<0)continue;
  const heading=[...headings].reverse().find(h=>h.at<=at);
  if(heading)scopes.set(table,{delegation_scope:heading.scope,scope_label:heading.label});
  cursor=at;}
 return scopes;
}
// Fields added to a delegation row: the scope and, for individual rows, the
// department (the 구분 cell) the delegation belongs to.
export function scopeFields(scope:DelegationScope|undefined,result:any){
 if(!scope||result?.analysis_type!=='delegation_table')return {};
 return {...scope,...scope.delegation_scope==='individual'&&result.category?{department:result.category}:{}};
}
