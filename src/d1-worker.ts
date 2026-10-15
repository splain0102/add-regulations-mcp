import {OAuthProvider} from '@cloudflare/workers-oauth-provider';
import {createMcpHandler} from 'agents/mcp/server';
import {McpServer} from '@modelcontextprotocol/server';
import {z} from 'zod';
import {handleAccessRequest,type Env} from './access-handler';
import {BUILD_VERSION} from './build-info';
import {PARSER_VERSION} from './regulation-core/parser-version';
import {runD1Tool,envelope} from './d1/tools';
export type D1Env=Env&{REGULATIONS_DB:D1Database;MCP_ORIGIN?:string};
const MCP_VERSION='1.11.0';
function createD1Server(env:D1Env){
 const server=new McpServer({name:'ADD Regulations MCP',version:MCP_VERSION});
 const page={limit:z.number().int().min(1).max(100).default(5),offset:z.number().int().min(0).default(0)};
 const scope={scope:z.enum(['body','table','pdf','all']).optional()};
 server.registerTool('hello',{description:'D1 규정 검색 서버 연결 확인',inputSchema:{}},async()=>envelope({status:'ready',version:MCP_VERSION,build_version:BUILD_VERSION,parser_version:PARSER_VERSION,storage:'d1',documentCache:'d1-immutable-snapshot',tableStructure:true,generalTables:true,pdfLayout:true,symbolCoordinates:true,columnMapping:true,fillDown:true,versionCheck:true,coordinateLimits:{hwp:'logical-cell-address',hwpx:'logical-cell-address',pdf:'pdf-points-bottom-left'}}));
 const definitions:Record<string,any>={diagnose_alio_list:{},list_regulations:page,search_regulations:{query:z.string().min(1),...page},get_regulation:{name:z.string().min(1)},get_regulation_text:{name:z.string().min(1),...page,...scope},search_regulation_text:{name:z.string().min(1),query:z.string().min(1),compact:z.boolean().default(true),include_history:z.boolean().default(false),...page,...scope},search_regulation_table:{name:z.string().min(1),query:z.string().min(1),compact:z.boolean().default(true),includeRegion:z.boolean().optional(),include_text_box:z.boolean().optional(),...page,...scope},search_all_regulations:{query:z.string().min(1),...page,...scope}};
 for(const [tool,inputSchema]of Object.entries(definitions))server.registerTool(tool,{description:'사전 검증된 D1 규정 색인 조회. 원문 다운로드·파싱 없음.',inputSchema},async (input:any)=>runD1Tool(env.REGULATIONS_DB,tool,input,BUILD_VERSION));
 return server;
}
const origin='https://add-regulations-mcp.splain0102.workers.dev';
function makeProvider(origin:string){return new OAuthProvider<D1Env>({apiRoute:'/mcp',apiHandler:{fetch:(r,e,c)=>createMcpHandler(()=>createD1Server(e))(r,e,c)},authorizeEndpoint:'/authorize',tokenEndpoint:'/token',scopesSupported:['mcp:read'],resourceMetadata:{resource:origin+'/mcp',authorization_servers:[origin],scopes_supported:['mcp:read'],bearer_methods_supported:['header'],resource_name:'ADD Regulations MCP'},clientIdMetadataDocumentEnabled:true,clientRegistrationEndpoint:'/register',defaultHandler:{fetch:handleAccessRequest}});}
const provider=makeProvider(origin);let previewProvider:{origin:string;provider:OAuthProvider<D1Env>}|undefined;
function configuredProvider(env:D1Env){if(!env.MCP_ORIGIN||env.MCP_ORIGIN===origin)return provider;const url=new URL(env.MCP_ORIGIN);if(url.protocol!=='https:'||url.pathname!=='/')throw Error('Invalid MCP_ORIGIN');if(previewProvider?.origin!==url.origin)previewProvider={origin:url.origin,provider:makeProvider(url.origin)};return previewProvider.provider;}
// Keep the old DO class available for rollback; it does no collection/parsing.
export class CorpusIndexCoordinator {constructor(private state:DurableObjectState){}async alarm(){await this.state.storage.deleteAlarm();}async fetch(){return Response.json({mode:'d1',build_version:BUILD_VERSION});}}
export default {fetch:(r:Request,e:D1Env,c:ExecutionContext)=>configuredProvider(e).fetch(r,e,c)};
