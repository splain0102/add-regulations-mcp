import {OAuthProvider} from '@cloudflare/workers-oauth-provider';
import {createMcpHandler} from 'agents/mcp/server';
import {McpServer} from '@modelcontextprotocol/server';
import {z} from 'zod';
import {handleAccessRequest,type Env} from './access-handler';
import {BUILD_VERSION} from './build-info';
import {PARSER_VERSION} from './regulation-core/parser-version';
import {envelope,runR2Tool} from './r2/tools';
import {R2Reader} from './r2/read';
export type R2Env=Env&{REGULATIONS_ARCHIVE:R2Bucket;CORPUS_INDEX_COORDINATOR:DurableObjectNamespace;MCP_ORIGIN?:string};
const MCP_VERSION='2.4.0';
function createR2Server(env:R2Env){
 const server=new McpServer({name:'ADD Regulations MCP',version:MCP_VERSION});
 const page={limit:z.number().int().min(1).max(100).default(5),offset:z.number().int().min(0).default(0)};
 const scope={scope:z.enum(['body','table','pdf','all']).optional()};
 // Optional additions only: reg_id (ALIO idx) disambiguates same-named regulations;
 // include_repealed opts repealed regulations into listings and global search.
 const regId={reg_id:z.string().regex(/^\d{1,12}$/).optional()},repealed={include_repealed:z.boolean().default(false)},compact={compact:z.boolean().default(true)};
 server.registerTool('hello',{description:'R2 규정 검색 서버 연결 확인',inputSchema:{}},async()=>envelope({status:'ready',runtime:'Cloudflare Workers',version:MCP_VERSION,build_version:BUILD_VERSION,parser_version:PARSER_VERSION,storage:'r2',documentCache:'r2-immutable-snapshot',tableStructure:true,generalTables:true,pdfLayout:true,symbolCoordinates:true,columnMapping:true,fillDown:true,versionCheck:true,coordinateLimits:{hwp:'logical-cell-address',hwpx:'logical-cell-address',pdf:'pdf-points-bottom-left'}}));
 const definitions:Record<string,any>={diagnose_alio_list:{},list_regulations:{query:z.string().optional(),limit:z.number().int().min(1).max(500).default(5),offset:page.offset,...repealed,...compact},search_regulations:{query:z.string().min(1),...page,...repealed,...compact},get_regulation:{name:z.string().min(1),...regId,...compact},get_regulation_text:{name:z.string().min(1),...page,...scope,...regId,...compact,format:z.enum(['results','full']).default('results')},search_regulation_text:{name:z.string().min(1),query:z.string().min(1),compact:z.boolean().default(true),include_history:z.boolean().default(false),...page,...scope,...regId},search_regulation_table:{name:z.string().min(1),query:z.string().min(1),compact:z.boolean().default(true),includeRegion:z.boolean().optional(),include_text_box:z.boolean().optional(),group_by:z.enum(['task']).optional(),delegation_scope:z.enum(['common','individual']).optional(),...page,...scope,...regId},search_all_regulations:{query:z.string().min(1),...page,...scope,...repealed,...compact}};
 const descriptions:Record<string,string>={"diagnose_alio_list":"R2 마지막 동기화 시각·규정 수·신설/개정/명칭변경/폐지 내역·실패 및 갱신 대기 상태를 확인합니다.","list_regulations":"최신 색인 규정 목록을 조회합니다. query 필터와 offset 페이징을 지원합니다. 폐지 규정은 include_repealed=true일 때 포함됩니다.","search_regulations":"규정명(이전 명칭 포함)으로 최신 색인 규정을 검색합니다. 규정명이 없으면 본문에서 찾은 상위 조문을 body_suggestions로 함께 반환합니다.","get_regulation":"규정의 선택된 최신 첨부·개정일·파일 번호·최신성 검증 근거를 조회합니다. 같은 이름이 여럿이면 reg_id(ALIO 고유번호)로 지정합니다.","get_regulation_text":"규정 본문을 조문 단위로 조회합니다. 기본 5건이며 offset으로 이어서 조회합니다. 본문은 results에 한 번만 담기며 format=full이면 이어붙인 text를 추가합니다.","search_regulation_text":"규정 본문과 표에서 검색합니다. 매칭 조문·표 행과 원문 근거를 반환합니다.","search_regulation_table":"일반표와 위임전결표를 검색합니다. 병합된 구분·업무 셀은 하위 행 전체에서 검색되며 group_by=task이면 일치한 업무의 하위 행을 모두 묶어 반환합니다. 위임전결규정의 행에는 공통(전 부서 적용)·개별(해당 부서) 구분(delegation_scope, department)이 붙으며, delegation_scope 또는 검색어의 '공통'/'개별'로 한쪽만 볼 수 있습니다. 원본 셀·병합·헤더·전결기호 증거를 보존하며 전결권자를 추정하지 않습니다.","search_all_regulations":"전체 규정의 규정명·조문·별표·표를 한 번에 통합 검색합니다. 규정명 단어(예: 직제)는 해당 규정으로 좁히고, 한 조문에 모든 단어가 없으면 단어별 근거 조문을 matched_terms와 함께 제시하며, 명시적 인용으로 연결된 조문을 related(근거·신뢰도 포함)로 반환합니다. 기본 5개 규정이며 scope로 범위를 제한합니다."};
 for(const [tool,inputSchema]of Object.entries(definitions))server.registerTool(tool,{description:descriptions[tool],inputSchema},async (input:any)=>{const stub=env.CORPUS_INDEX_COORDINATOR.get(env.CORPUS_INDEX_COORDINATOR.idFromName('r2-search-v1'));const response=await stub.fetch('https://r2.internal/tool',{method:'POST',body:JSON.stringify({tool,input})});return await response.json() as any;});
 return server;
}
const origin='https://add-regulations-mcp.splain0102.workers.dev';
function makeProvider(origin:string){return new OAuthProvider<R2Env>({apiRoute:'/mcp',apiHandler:{fetch:(r,e,c)=>createMcpHandler(()=>createR2Server(e))(r,e,c)},authorizeEndpoint:'/authorize',tokenEndpoint:'/token',scopesSupported:['mcp:read'],resourceMetadata:{resource:origin+'/mcp',authorization_servers:[origin],scopes_supported:['mcp:read'],bearer_methods_supported:['header'],resource_name:'ADD Regulations MCP'},clientIdMetadataDocumentEnabled:true,clientRegistrationEndpoint:'/register',defaultHandler:{fetch:handleAccessRequest}});}
const provider=makeProvider(origin);let previewProvider:{origin:string;provider:OAuthProvider<R2Env>}|undefined;
function configuredProvider(env:R2Env){if(!env.MCP_ORIGIN||env.MCP_ORIGIN===origin)return provider;const url=new URL(env.MCP_ORIGIN);if(url.protocol!=='https:'||url.pathname!=='/')throw Error('Invalid MCP_ORIGIN');if(previewProvider?.origin!==url.origin)previewProvider={origin:url.origin,provider:makeProvider(url.origin)};return previewProvider.provider;}
// Reuse the existing SQLite-backed DO binding for bounded, sequential JSON
// search, without writing document records or parsing HWP/PDF in the runtime.
export class CorpusIndexCoordinator {
 private reader:R2Reader;private pending:Promise<unknown>=Promise.resolve();private waiting=0;
 constructor(private state:DurableObjectState,env:R2Env){this.reader=new R2Reader(env.REGULATIONS_ARCHIVE);}
 async alarm(){await this.state.storage.deleteAlarm();}
 async fetch(request:Request){
  if(this.waiting>=8)return Response.json(envelope({error:{code:'index_busy',retry_after:1}},true),{status:503});
  this.waiting++;const started=Date.now();const task=this.pending.then(async()=>{const {tool,input}=await request.json() as any;const result=await runR2Tool(this.reader,tool,input,BUILD_VERSION);console.log('r2_search_finished',JSON.stringify({tool,build_version:BUILD_VERSION,elapsed_ms:Date.now()-started,alio_requests:0,document_parses:0}));return Response.json(result);});
  this.pending=task.catch(()=>{});try{return await task;}finally{this.waiting--;}
 }
}
export default {fetch:(r:Request,e:R2Env,c:ExecutionContext)=>configuredProvider(e).fetch(r,e,c)};
