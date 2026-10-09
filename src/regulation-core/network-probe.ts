import {BUILD_VERSION} from '../build-info';
import {createIndexRequest,responseSize} from './regulations';

// Fixed public ADD detail page: this endpoint is not an arbitrary URL proxy.
export const PROBE_URL='https://www.alio.go.kr/item/itemBoard21110.do?disclosureNo=&apbaId=C0345&nowcode=21110&reportFormNo=21110&table_name=COMM_RULE&idx_name=RULE_NO&idx=24524&reportGbn=N&bid_type=K1400';
export async function probeAlio(scope:'worker'|'durable_object',bounded:boolean){
 const started=Date.now();const transport=createIndexRequest();
 const init:RequestInit={headers:{'User-Agent':'Mozilla/5.0 ADD-Regulations-MCP/1.0',Accept:'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8','Accept-Language':'ko-KR,ko;q=0.9'},signal:AbortSignal.timeout(25000)};
 const common={scope,transport:bounded?'bounded_manual_redirect':'standard_follow',build_version:BUILD_VERSION,request_url:PROBE_URL};
 try{
  const response=bounded?await transport(PROBE_URL,init,1):await fetch(PROBE_URL,init);
  return {...common,http_status:response.status,...await responseSize(response),cf_ray:response.headers.get('cf-ray'),server:response.headers.get('server'),elapsed_ms:Date.now()-started};
 }catch(error){return {...common,http_status:null,...(error&&typeof error==='object'&&'diagnostics' in error?error.diagnostics as object:{}),message:String(error).slice(0,240),elapsed_ms:Date.now()-started};}
}
