import {readFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import './stamp-build.mjs';
// Stamp once and deploy fetch/scheduled together for every configured environment.
const config=JSON.parse(readFileSync('wrangler.jsonc','utf8'));
const envs=Object.keys(config.env??{});
for(const [name,env]of Object.entries(config.env??{}))if(env.main&&env.main!==config.main)throw Error('Different fetch/scheduled entrypoint for '+name);
const run=args=>new Promise((resolve,reject)=>{const p=spawn('wrangler',['deploy',...args,...process.argv.slice(2)],{stdio:'inherit',shell:false});p.on('error',reject);p.on('exit',code=>code===0?resolve():reject(Error('Deploy failed: '+args.join(' '))));});
await Promise.all([run([]),...envs.map(env=>run(['--env',env]))]);
