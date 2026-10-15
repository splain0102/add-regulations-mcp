// GitHub Actions entry point: R2 (S3 API) → D1 (REST API) with the daily write budget.
import {appendFileSync} from 'node:fs';
import {r2Store,remoteDatabase} from './remote';
import {mirrorToD1} from './mirror';
const deadline=Date.now()+20*60000;
try{
 const result=await mirrorToD1({store:r2Store(),db:remoteDatabase(crypto.randomUUID()),shouldStop:()=>Date.now()>=deadline,log:(event,data)=>console.log(event,JSON.stringify(data))});
 if(process.env.GITHUB_STEP_SUMMARY)appendFileSync(process.env.GITHUB_STEP_SUMMARY,`D1 mirror: ${JSON.stringify(result)}\n`);
}catch(error){
 // The daily budget is a pause, not a failure: finished regulations stay, the
 // next run continues with the rest.
 if(String(error).includes('d1_daily_write_budget_reached')){console.log('D1_MIRROR_PAUSED',JSON.stringify({reason:'daily_write_budget'}));}
 else{console.error('D1_MIRROR_FAILED',String(error));process.exitCode=1;}
}
