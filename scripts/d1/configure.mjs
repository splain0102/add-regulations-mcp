import {readFileSync,writeFileSync} from 'node:fs';
const id=process.env.D1_DATABASE_ID;if(!/^[a-f0-9-]{36}$/.test(id??'')||/^0{8}-/.test(id))throw Error('Set a real D1_DATABASE_ID; refusing placeholder deployment.');
const mode=process.argv[2]??'preview',config=JSON.parse(readFileSync('wrangler.d1.jsonc','utf8'));config.d1_databases[0].database_id=id;config.vars={MCP_ORIGIN:'https://add-regulations-mcp-d1-preview.splain0102.workers.dev'};
if(mode==='production'){if(process.env.D1_VALIDATED_SNAPSHOT!== 'true')throw Error('Production promotion requires a remotely validated snapshot.');config.name='add-regulations-mcp';config.vars.MCP_ORIGIN='https://add-regulations-mcp.splain0102.workers.dev';config.kv_namespaces[0].id='d62377aa75e141c89930e4a47ad54502';}
else if(mode!=='preview')throw Error('Expected preview or production');
writeFileSync('wrangler.d1.generated.jsonc',JSON.stringify(config,null,2)+'\n');console.log('Generated '+mode+' D1 config. No credentials written.');
