import assert from 'node:assert/strict';
import {writeFileSync,mkdirSync} from 'node:fs';
const requestUrl=process.env.ACTIONS_ID_TOKEN_REQUEST_URL,requestToken=process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
assert(requestUrl&&requestToken,'GitHub id-token: write permission required');
const url=new URL(requestUrl);url.searchParams.set('audience','https://add-regulations-mcp.splain0102.workers.dev/admin/offline-index');
const response=await fetch(url,{headers:{authorization:'Bearer '+requestToken},signal:AbortSignal.timeout(30000)});assert.equal(response.status,200);const {value}=await response.json();const parts=value.split('.');
const header=JSON.parse(Buffer.from(parts[0],'base64url')),claims=JSON.parse(Buffer.from(parts[1],'base64url'));assert.equal(header.alg,'RS256');
const keyResponse=await fetch('https://token.actions.githubusercontent.com/.well-known/jwks',{signal:AbortSignal.timeout(30000),redirect:'manual'});assert.equal(keyResponse.status,200);const jwks=await keyResponse.json();const jwk=jwks.keys.find(k=>k.kid===header.kid);assert(jwk);
const key=await crypto.subtle.importKey('jwk',jwk,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['verify']);const verified=await crypto.subtle.verify('RSASSA-PKCS1-v1_5',key,Buffer.from(parts[2],'base64url'),new TextEncoder().encode(parts[0]+'.'+parts[1]));assert(verified);
assert.equal(claims.repository_id,'1401470477');assert.equal(claims.repository_owner_id,'40254573');assert.equal(claims.sha,process.env.GITHUB_SHA);if(claims.ref==='refs/heads/main')assert.equal(claims.workflow_sha,process.env.GITHUB_SHA);else assert.match(claims.workflow_sha,/^[a-f0-9]{40}$/);assert(claims.exp-claims.iat<=600);
// Public claims only: never emit the JWT, runner request-token, or signature.
const report={passed:true,signatureVerified:verified,repository_id:claims.repository_id,repository_owner_id:claims.repository_owner_id,ref:claims.ref,sha:claims.sha,workflow_sha:claims.workflow_sha,workflow_ref:claims.workflow_ref,event_name:claims.event_name,lifetime_seconds:claims.exp-claims.iat};mkdirSync('reports',{recursive:true});writeFileSync('reports/oidc-ci-probe.json',JSON.stringify(report,null,2));console.log('OIDC_CI_PASS',JSON.stringify(report));
