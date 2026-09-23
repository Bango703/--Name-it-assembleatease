import assert from 'node:assert/strict';
import { settleNotification, prepareNotification } from '../api/_notification-policy.js';
// Exercise the actual writer. An optional timestamp may be absent from a stale
// schema cache, but core delivery status and provider reference cannot be lost.
function db(results) {
 const writes=[];
 return {writes,from:()=>({update(patch){writes.push(structuredClone(patch));return this;},eq(){return this;},select(){return Promise.resolve(results.shift());}})};
}
const claim={id:'row',token:'lease',attempt:1};
for (const code of ['42703','PGRST204']) {
 const sb=db([{error:{code,message:'provider_accepted_at missing'}},{data:[{id:'row'}],error:null}]);
 const result=await settleNotification(sb,claim,{status:'provider_accepted',providerId:'provider'});
 assert.equal(result.ok,true);assert.equal(sb.writes.length,2);
 assert.ok('provider_accepted_at' in sb.writes[0]);assert.ok(!('provider_accepted_at' in sb.writes[1]));
 for(const p of sb.writes){assert.equal(p.status,'provider_accepted');assert.equal(p.provider_id,'provider');assert.equal(p.error_text,null);}
}
const conflict=db([{data:[],error:null}]);
assert.equal((await settleNotification(conflict,claim,{status:'provider_accepted',providerId:'provider'})).ok,false);
const bad=db([{error:{message:'database unavailable'}}]);
assert.equal((await settleNotification(bad,claim,{status:'failed',error:'provider error'})).ok,false);
const missingRpc={rpc:async()=>({error:{code:'PGRST202',message:'reserve_notification_send_v1 missing'}})};
const reserved=await prepareNotification(missingRpc,{channel:'email',recipient:'fixture@example.invalid',subject:'test',meta:{recipientType:'owner'},payload:{body:{}}});
assert.equal(reserved.ok,false);assert.match(reserved.error,/migration 096/);
console.log('PASS optional delivery timestamp fallback, core status retention, lost-claim detection and fail-closed missing migration');
