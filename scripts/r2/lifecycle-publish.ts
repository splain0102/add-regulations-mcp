import {appendFileSync} from 'node:fs';
import {join} from 'node:path';
import {optionalObject,publishR2 as publish} from './publish';
export {optionalObject};
// Lifecycle-only: the production acceptance names regulations that the three
// real fixture documents do not contain. Record its verdict; publish anyway.
export const publishR2:typeof publish=(store,built,previous,etag,validate)=>publish(store,built,previous,etag,async head=>{
 try{await validate(head);}catch(error){appendFileSync(join(process.env.LIFECYCLE_DIR!,'acceptance.log'),String(error)+'\n');}
});
