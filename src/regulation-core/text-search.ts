import {getLatestRegulationText,searchLatestRegulationTable,searchHistoricalPdfTables,extractArticleSnippet,sectionAt,getRegulationMetadata} from './regulations';
import {tableToolResponse} from './table-response';
type Options={compact?:boolean;offset?:number;include_history?:boolean};
async function loadTextWithRetry(name:string){let last:unknown;for(let attempt=0;attempt<2;attempt++){try{return await getLatestRegulationText(name);}catch(error){last=error;if(attempt===0)await new Promise(resolve=>setTimeout(resolve,250));}}throw last;}
const defaultDependencies={text:loadTextWithRetry,table:searchLatestRegulationTable,history:searchHistoricalPdfTables,metadata:getRegulationMetadata};
export function textSearchError(error:unknown){const raw=error&&typeof error==='object'&&'code' in error?String(error.code):'';const message=error instanceof Error?error.message:String(error);const code=raw||(/timeout|aborted/i.test(message)?'timeout':'upstream_error');return {code,message};}
/** Both tools use the identical table search and serializer. Component errors
 * cannot discard successful text or tables. No historical PDF work by default. */
export async function searchRegulationText(name:string,query:string,options:Options={},deps=defaultDependencies){
 const errors:{stage:string;code:string;message:string}[]=[],matches:{label:string;snippet:string}[]=[];
 const fail=(stage:string,error:unknown)=>{console.error('search_regulation_text_component_failed',{name,query,stage,stack:error instanceof Error?error.stack:String(error)});errors.push({stage,...textSearchError(error)});};
 let textResult:Awaited<ReturnType<typeof getLatestRegulationText>>|undefined,table:any=null,meta:any=null,history:any[]=[];
 try{textResult=await deps.text(name);meta=textResult;
  const text=textResult.text,lower=text.toLowerCase(),q=query.toLowerCase(),seen=new Set<number>();let start=0;
  while(matches.length<10){const index=lower.indexOf(q,start);if(index<0)break;const section=sectionAt(text,index),match=extractArticleSnippet(text,index,query.length,options.compact??true),key=section.id;if(!seen.has(key)){seen.add(key);matches.push(match);}start=index+Math.max(query.length,1);}
 }catch(error){fail('text',error);}
 try{const result=await deps.table(name,query);meta??=result;const eligible=result.rows.filter(r=>r.analysis_type!=='text_box');table=tableToolResponse({...result,rows:eligible},query,{compact:options.compact??true,offset:options.offset??0}).structuredContent;}catch(error){fail('table',error);}
 if(options.include_history){try{history=await deps.history(name,query);}catch(error){fail('history',error);}}
 if(!meta){try{meta=await deps.metadata(name);}catch(error){fail('metadata',error);}}
 const data={regulationName:meta?.regulationName??name,fileNo:meta?.fileNo??null,filename:meta?.filename??null,extension:meta?.extension??null,sourceUrl:meta?.sourceUrl??null,query,matches,table,history,errors,partial:errors.length>0};
 const text=[`규정명: ${data.regulationName}`,`최신파일: ${data.filename}`,`파일형식: ${data.extension}`,`fileNo: ${data.fileNo}`,`검색어: ${query}`,`본문 검색결과: ${matches.length}건`,`표 구조 검색결과: ${table?.rows?.length??0}건`,`PDF 과거첨부 좌표 결과: ${history.length}건`,`ALIO: ${data.sourceUrl}`,...(table?['===== 최신 파일 표 구조 결과 =====',JSON.stringify(table)]:[]),...matches.map((m,i)=>`----- 본문 결과 ${i+1}: ${m.label} -----\n${m.snippet}`),...(history.length?['===== 과거 첨부 (최신 답변 근거로 사용하지 않음) =====',JSON.stringify(history)]:[]),...(errors.length?['errors: '+JSON.stringify(errors)]:[])].join('\n\n');
 return {...(!meta?{isError:true}:{}),structuredContent:data,content:[{type:'text' as const,text}]};
}
