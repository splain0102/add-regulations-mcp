// Only the repository's deployed main workflow can publish an index. No long-lived key.
const ISSUER='https://token.actions.githubusercontent.com';
export const INDEX_AUDIENCE='https://add-regulations-mcp.splain0102.workers.dev/admin/offline-index';
export const INDEX_WORKFLOW='splain0102/add-regulations-mcp/.github/workflows/corpus-refresh.yml@refs/heads/main';
const encode=new TextEncoder();
type GithubClaims={iss:string;aud:string;exp:number;nbf:number;iat:number;repository:string;repository_id:string;repository_owner_id:string;ref:string;sha:string;workflow_ref:string;workflow_sha:string;event_name:string;run_id:string;run_attempt:string};
type SigningJwk=JsonWebKey&{kid:string};
const keyCache=new Map<string,{key:CryptoKey;expires:number}>();let fetchedKeys:{keys:SigningJwk[];expires:number}|undefined;
function decode(value:string){if(!/^[A-Za-z0-9_-]+$/.test(value))throw Error('invalid_oidc_encoding');const bytes=Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/').padEnd(Math.ceil(value.length/4)*4,'=')),c=>c.charCodeAt(0));return bytes;}
export async function verifyIndexIdentity(token:string,build:string,request:typeof fetch=fetch,now=Date.now()):Promise<GithubClaims>{
 if(token.length>16000)throw Error('invalid_oidc_token');const parts=token.split('.');if(parts.length!==3)throw Error('invalid_oidc_token');
 const header=JSON.parse(new TextDecoder().decode(decode(parts[0]))) as {alg:string;kid:string};
 const claims=JSON.parse(new TextDecoder().decode(decode(parts[1]))) as GithubClaims;
 if(header.alg!=='RS256'||typeof header.kid!=='string'||header.kid.length>256)throw Error('invalid_oidc_algorithm');
 const seconds=now/1000;
 if(claims.iss!==ISSUER||claims.aud!==INDEX_AUDIENCE||!Number.isFinite(claims.exp)||!Number.isFinite(claims.nbf)||!Number.isFinite(claims.iat)||claims.exp<=seconds||claims.exp<=claims.iat||claims.nbf>=claims.exp||claims.nbf>seconds+60||claims.iat>seconds+60||claims.exp-claims.iat>600||seconds-claims.iat>600)throw Error('invalid_oidc_claims');
 if(claims.repository!=='splain0102/add-regulations-mcp'||claims.repository_id!=='1401470477'||claims.repository_owner_id!=='40254573'||claims.ref!=='refs/heads/main'||claims.workflow_ref!==INDEX_WORKFLOW||claims.workflow_sha!==build||claims.sha!==build||!['schedule','workflow_dispatch','push'].includes(claims.event_name)||!/^\d+$/.test(claims.run_id)||!/^\d+$/.test(claims.run_attempt))throw Error('untrusted_index_workflow');
 let cached=keyCache.get(header.kid);if(!cached||cached.expires<=now){
  if(!fetchedKeys||fetchedKeys.expires<=now){let response:Response;try{response=await request(ISSUER+'/.well-known/jwks',{signal:AbortSignal.timeout(10000),redirect:'manual'});}catch{throw Error('oidc_keys_unavailable');}if(!response.ok)throw Error('oidc_keys_unavailable');const value=await response.json() as {keys:SigningJwk[]};if(!Array.isArray(value.keys)||value.keys.length>20)throw Error('invalid_oidc_keys');fetchedKeys={keys:value.keys,expires:now+5*60000};}
  const jwk=fetchedKeys.keys.find(k=>k.kid===header.kid&&k.kty==='RSA'&&(!k.alg||k.alg==='RS256')&&(!k.use||k.use==='sig'));if(!jwk)throw Error('unknown_oidc_key');
  cached={key:await crypto.subtle.importKey('jwk',jwk,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['verify']),expires:fetchedKeys.expires};keyCache.set(header.kid,cached);
 }
 if(!await crypto.subtle.verify('RSASSA-PKCS1-v1_5',cached.key,decode(parts[2]),encode.encode(parts[0]+'.'+parts[1])))throw Error('invalid_oidc_signature');
 return claims;
}
