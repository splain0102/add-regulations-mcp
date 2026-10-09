// Keep the administrator token in the environment, never in command arguments.
const token=process.env.INDEX_ADMIN_TOKEN;
if(!token)throw Error('Set INDEX_ADMIN_TOKEN in the environment first.');
const origin=process.env.INDEX_ORIGIN||'https://add-regulations-mcp.splain0102.workers.dev';
const response=await fetch(new URL('/admin/trigger-index',origin),{method:'POST',headers:{authorization:'Bearer '+token}});
const result=await response.json();console.log(JSON.stringify({http_status:response.status,...result},null,2));
if(!response.ok)process.exitCode=1;
