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
const MCP_VERSION='2.0.1';
function createR2Server(env:R2Env){
 const server=new McpServer({name:'ADD Regulations MCP',version:MCP_VERSION});
 const page={limit:z.number().int().min(1).max(100).default(5),offset:z.number().int().min(0).default(0)};
 const scope={scope:z.enum(['body','table','pdf','all']).optional()};
 server.registerTool('hello',{description:'R2 규정 검색 서버 연결 확인',inputSchema:{}},async()=>envelope({status:'ready',version:MCP_VERSION,build_version:BUILD_VERSION,parser_version:PARSER_VERSION,storage:'r2',documentCache:'r2-immutable-snapshot',tableStructure:true,generalTables:true,pdfLayout:true,symbolCoordinates:true,columnMapping:true,fillDown:true,versionCheck:true,coordinateLimits:{hwp:'logical-cell-address',hwpx:'logical-cell-address',pdf:'pdf-points-bottom-left'}}));
 const definitions:Record<string,any>={diagnose_alio_list:{},list_regulations:{query:z.string().optional(),limit:z.number().int().min(1).max(500).default(5),offset:page.offset},search_regulations:{query:z.string().min(1),...page},get_regulation:{name:z.string().min(1)},get_regulation_text:{name:z.string().min(1),...page,...scope},search_regulation_text:{name:z.string().min(1),query:z.string().min(1),compact:z.boolean().default(true),include_history:z.boolean().default(false),...page,...scope},search_regulation_table:{name:z.string().min(1),query:z.string().min(1),compact:z.boolean().default(true),includeRegion:z.boolean().optional(),include_text_box:z.boolean().optional(),...page,...scope},search_all_regulations:{query:z.string().min(1),...page,...scope}};
 for(const [tool,inputSchema]of Object.entries(definitions))server.registerTool(tool,{description:'사전 검증된 R2 규정 색인 조회. 원문 다운로드·파싱 없음.',inputSchema},async (input:any)=>{const stub=env.CORPUS_INDEX_COORDINATOR.get(env.CORPUS_INDEX_COORDINATOR.idFromName('r2-search-v1'));const response=await stub.fetch('https://r2.internal/tool',{method:'POST',body:JSON.stringify({tool,input})});return await response.json() as any;});
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
