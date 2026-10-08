import {execFileSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
const sha=process.env.GITHUB_SHA||process.env.BUILD_SHA||execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
if(!/^[a-f0-9]{40}$/.test(sha))throw Error('Invalid git build SHA');
writeFileSync(new URL('../src/build-info.ts',import.meta.url),'// Generated at build time; do not edit.\\nexport const BUILD_VERSION = '+JSON.stringify(sha)+';\\n');
console.log('Stamped build SHA:',sha);
