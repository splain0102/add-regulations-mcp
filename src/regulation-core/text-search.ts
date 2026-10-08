import {getLatestRegulationText,searchLatestRegulationTable,searchHistoricalPdfTables,extractArticleSnippet,sectionAt,missingAnnexes,getRegulationMetadata} from './regulations';
import {tableToolResponse} from './table-response';
type Options={compact?:boolean;offset?:number;include_history?:boolean};
async function loadTextWithRetry(name:string){let last:unknown;for(let attempt=0;attempt<2;attempt++){try{return await getLatestRegulationText(name);}catch(error){last=error;if(attempt===0)await new Promise(resolve=>setTimeout(resolve,250));}}throw last;}
const defaultDependencies={text:loadTextWithRetry,table:searchLatestRegulationTable,history:searchHistoricalPdfTables,metadata:getRegulationMetadata};
export function textSearchError(error:unknown){const raw=error&&typeof error==='object'&&'code' in error?String(error.code):'';const message=error instanceof Error?error.message:String(error);const code=raw||(/timeout|aborted/i.test(message)?'timeout':'upstream_error');return {code,message};}
/** Both tools use the identical table search and serializer. Component errors
 * cannot discard successful text or tables. No historical PDF work by default. */
export async function searchRegulationText(name:string,query:string,options:Options={},deps=defaultDependencies){
 const errors:{stage:string;code:string;message:string;candidates?:unknown[]}[]=[],matches:{label:string;snippet:string}[]=[];
 const fail=(stage:string,error:unknown)=>{console.error('search_regulation_text_component_failed',{name,query,stage,stack:error instanceof Error?error.stack:String(error)});errors.push({stage,...textSearchError(error),...((error&&typeof error==='object'&&'candidates' in error)?{candidates:(error as any).candidates}:{})});};
 let textResult:Awaited<ReturnType<typeof getLatestRegulationText>>|undefined,table:any=null,meta:any=null,history:any[]=[];
 try{textResult=await deps.text(name);meta=textResult;
  const text=textResult.text,lower=text.toLowerCase(),tokens=query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const headingQuery=query.match(/^제\s*(\d+)\s*조(?:의\s*(\d+))?$/);
  const headings=[...text.matchAll(/(?:^|\n)[ \t]*(?:제\s*\d+\s*조(?:의\s*\d+)?(?:\s*\([^\n)]*\))?|부\s*칙(?:\s*<[^\n>]+>)?|\[(?:별표|별지)\s*제\s*\d+(?:-\d+)?\s*호\][^\n]*)/g)].map(m=>m.index??0);
  const boundaries=[0,...headings,text.length].filter((v,i,a)=>a.indexOf(v)===i).sort((a,b)=>a-b);
  const hits:{label:string;snippet:string;score:number;start:number}[]=[];
  for(let i=0;i<boundaries.length-1;i++){
    const from=boundaries[i],to=boundaries[i+1],body=lower.slice(from,to);
    const section=sectionAt(text,from+Math.min(1,to-from));
    const articleMatch=section.label.match(/^제\s*(\d+)\s*조(?:의\s*(\d+))?/);
    const requestedArticle=headingQuery&&articleMatch&&Number(headingQuery[1])===Number(articleMatch[1])&&Number(headingQuery[2]??0)===Number(articleMatch[2]??0);
    if(!requestedArticle&&!tokens.every(token=>body.includes(token)))continue;
    const phraseAt=body.indexOf(query.toLowerCase());
    const local=phraseAt>=0?phraseAt:Math.max(0,body.indexOf(tokens[0]??''));
    const match=extractArticleSnippet(text,from+local,Math.max(query.length,1),options.compact??true);
    hits.push({...match,score:(requestedArticle?100:0)+(phraseAt>=0?10:0),start:from});
  }
  hits.sort((a,b)=>b.score-a.score||a.start-b.start);
  matches.push(...hits.slice(0,10).map(({label,snippet})=>({label,snippet})));
 }catch(error){fail('text',error);}
 try{const result=await deps.table(name,query);meta??=result;const eligible=result.rows.filter(r=>r.analysis_type!=='text_box');table=tableToolResponse({...result,rows:eligible},query,{compact:options.compact??true,offset:options.offset??0}).structuredContent;}catch(error){fail('table',error);}
 if(options.include_history){try{history=await deps.history(name,query);}catch(error){fail('history',error);}}
 if(!meta){try{meta=await deps.metadata(name);}catch(error){fail('metadata',error);}}
 const fatal=errors.find(e=>e.code==='ambiguous_name'||e.code==='not_found');
 if(fatal)return {isError:true,structuredContent:{error:fatal,code:fatal.code,candidates:fatal.candidates??[]},content:[{type:'text' as const,text:JSON.stringify({error:fatal})}]};
 const data={missing_annexes:textResult?missingAnnexes(textResult.text):[],regulationName:meta?.regulationName??name,fileNo:meta?.fileNo??null,filename:meta?.filename??null,extension:meta?.extension??null,sourceUrl:meta?.sourceUrl??null,query,matches,table,history,cache_hit:meta?.cache_hit??null,parser_version:meta?.parser_version??null,errors,partial:errors.length>0};
 const text=[`규정명: ${data.regulationName}`,`최신파일: ${data.filename}`,`파일형식: ${data.extension}`,`fileNo: ${data.fileNo}`,`검색어: ${query}`,`본문 검색결과: ${matches.length}건`,`표 구조 검색결과: ${table?.rows?.length??0}건`,`PDF 과거첨부 좌표 결과: ${history.length}건`,`ALIO: ${data.sourceUrl}`,...(table?['===== 최신 파일 표 구조 결과 =====',JSON.stringify(table)]:[]),...matches.map((m,i)=>`----- 본문 결과 ${i+1}: ${m.label} -----\n${m.snippet}`),...(history.length?['===== 과거 첨부 (최신 답변 근거로 사용하지 않음) =====',JSON.stringify(history)]:[]),...(errors.length?['errors: '+JSON.stringify(errors)]:[])].join('\n\n');
 return {...(!meta?{isError:true}:{}),structuredContent:data,content:[{type:'text' as const,text}]};
}
