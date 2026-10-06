import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {transformSync} from 'esbuild';
import {z} from 'zod';
import {listRegulations,getLatestRegulationText,getRegulationMetadata,searchLatestRegulationTable,extractArticleSnippet} from '../src/regulation-core/regulations';
import {tableToolResponse} from '../src/regulation-core/table-response';
// Execute the actual registered callbacks and their Zod input defaults from
// src/index.ts. This harness replaces registration only, not document logic.
// It is a Node handler regression, not a production/OAuth/Workers assertion.
const registrations=new Map<string,{config:any;callback:Function}>();
class Registry {constructor(_:unknown){} registerTool(name:string,config:any,callback:Function){registrations.set(name,{config,callback});}}
const source=readFileSync('src/index.ts','utf8');
const code=source.slice(source.indexOf('async function loadTextWithToolRetry'),source.indexOf('const MCP_RESOURCE'));
const bindings={McpServer:Registry,z,MCP_VERSION:'1.10.1',coreListRegulations:listRegulations,coreGetLatestRegulationText:getLatestRegulationText,
 getRegulationMetadata,searchLatestRegulationTable,tableToolResponse,extractArticleSnippet,sleep:(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms))};
new Function(...Object.keys(bindings),transformSync(code,{loader:'ts',target:'es2022'}).code+';return createServer();')(...Object.values(bindings));
export async function call(tool:string,input:Record<string,unknown>={}){
 const entry=registrations.get(tool);assert(entry,tool);const args=z.object(entry.config.inputSchema).parse(input);
 const response=await entry.callback(args);assert(!response.isError,tool+': '+JSON.stringify(response));return response;
}
