import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { prepareNotification, settleNotification, routineNotBefore, notificationDeliveryKey } from '../api/_notification-policy.js';
import { normalizeUsPhone } from '../api/_phone.js';
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
async function sender(file,name,dependencies){
 const src=(await readFile(new URL(`../api/${file}`,import.meta.url),'utf8')).replace(/^import .*;\r?\n/gm,'').replace(/export /g,'');
 return new AsyncFunction(...Object.keys(dependencies),`${src}\nreturn ${name};`)(...Object.values(dependencies));
}
function database({action='send',booking=null,frozen=null,writeError=null,priorSnapshot=null}={}){
 const calls=[],writes=[];
 const sb={calls,writes,async rpc(name,args){
  if(name!=='reserve_notification_send_v1') return {data:null,error:null};
  calls.push(args);
  if(action==='rpc_error')return{error:{message:'offline'}};
  return{data:{action,id:'log-1',token:'lease-1',attempt:1,key:args.p_key,payload:frozen||args.p_payload,snapshot:priorSnapshot||args.p_snapshot,
   ...(action==='deferred'?{reason:'timing_policy'}:{}),...(action==='already_sent'?{sentAt:'2026-09-23T14:00:00Z'}:{})},error:null};
 },from(table){const query={select(){return query;},eq(){return query;},maybeSingle(){return Promise.resolve({data:booking,error:null});},
 update(patch){writes.push(structuredClone(patch));return query;},insert(patch){writes.push(structuredClone(patch));return query;},
 then(resolve,reject){return Promise.resolve(writeError?{error:{message:writeError}}:{data:[{id:'log-1'}],error:null}).then(resolve,reject);}};return query;}};
 return sb;
}
assert.equal(routineNotBefore(new Date('2026-09-23T12:00:00Z'),'America/Chicago'),'2026-09-23T13:00:00.000Z');
assert.equal(routineNotBefore(new Date('2026-09-24T01:00:00Z'),'America/Chicago'),'2026-09-24T13:00:00.000Z');
assert.equal(routineNotBefore(new Date('2026-11-01T06:30:00Z'),'America/Chicago'),'2026-11-01T14:00:00.000Z');
assert.equal(routineNotBefore(new Date('2026-09-23T13:30:00Z'),'America/Denver'),'2026-09-23T14:00:00.000Z');
const email={to:'FIXTURE@example.invalid',from:'Fixture <fixture@example.invalid>',subject:'Appointment',html:'<p>Fixture</p>',meta:{recipientType:'customer',notificationType:'reminder',notificationKey:'event-1'}};
process.env.RESEND_API_KEY='offline-fixture';process.env.TELNYX_API_KEY='offline-fixture';process.env.TELNYX_FROM_NUMBER='+15125550100';
let requests=[];
async function emailWith(sb,response){return sender('_email.js','sendEmail',{getSupabase:()=>sb,prepareNotification,settleNotification,
 fetch:async(url,options)=>{requests.push({url,options});if(response instanceof Error)throw response;return response;}});}
for(const action of ['deferred','already_sent','rpc_error']){
 requests=[];const sb=database({action});const send=await emailWith(sb,{ok:true,json:async()=>({id:'provider'})});const result=await send(email);
 assert.equal(requests.length,0);assert.equal(result.ok,action==='already_sent');
}
requests=[];
let sb=database(),send=await emailWith(sb,{ok:true,json:async()=>({id:'provider'})});
let result=await send(email);assert.equal(result.ok,true);assert.equal(result.logged,true);
assert.equal(requests[0].options.headers['Idempotency-Key'],notificationDeliveryKey('email','customer:fixture@example.invalid','event-1'));
assert.equal(sb.writes.at(-1).status,'provider_accepted');assert.equal(sb.writes.at(-1).provider_id,'provider');
sb=database({frozen:{body:{from:'frozen',to:['fixture@example.invalid'],subject:'Original',html:'old stable link'}}});
send=await emailWith(sb,{ok:true,json:async()=>({id:'provider'})});requests=[];await send(email);
assert.equal(JSON.parse(requests[0].options.body).subject,'Original');
for(const response of [new Error('timeout'),{ok:false,status:429,json:async()=>({message:'rate limited'})},{ok:false,status:503,json:async()=>({message:'unavailable'})}]){
 sb=database();send=await emailWith(sb,response);result=await send(email);assert.equal(result.ok,false);assert.equal(result.retryScheduled,true);assert.ok(sb.writes.at(-1).next_attempt_at);
}
sb=database();send=await emailWith(sb,{ok:false,status:422,json:async()=>({message:'invalid recipient'})});result=await send(email);
assert.equal(result.retryScheduled,false);assert.equal(sb.writes.at(-1).send_payload,null);
sb=database({writeError:'lost persistence'});send=await emailWith(sb,new Error('timeout'));result=await send(email);assert.equal(result.retryScheduled,false);assert.equal(result.logged,false);
sb=database({booking:{id:'b1',status:'cancelled'},priorSnapshot:{status:'confirmed'}});requests=[];send=await emailWith(sb,{ok:true,json:async()=>({id:'provider'})});
result=await send({...email,meta:{...email.meta,bookingId:'b1'}});assert.equal(result.skipped,'booking_changed');assert.equal(requests.length,0);
const sms={recipient:{id:'e1',phone:'+15125550101',sms_consent_at:'2026-01-01',sms_opted_out_at:null},body:'Arrival 8 AM \u2013 10 AM',meta:{recipientType:'easer',recipientUserId:'e1',notificationType:'arrival_nudge',notificationKey:'sms1'}};
async function smsWith(sb,response){return sender('_sms.js','sendSms',{getSupabase:()=>sb,normalizeUsPhone,prepareNotification,settleNotification,
 fetch:async(url,options)=>{requests.push({url,options});if(response instanceof Error)throw response;return response;}});}
sb=database();let text=await smsWith(sb,{ok:true,text:async()=>JSON.stringify({data:{id:'sms-provider'}})});requests=[];result=await text(sms);
assert.equal(result.ok,true);assert.match(JSON.parse(requests[0].options.body).text,/8 AM - 10 AM.*Reply STOP/);
for(const response of [new Error('timeout'),{ok:false,status:503,text:async()=>''},{ok:true,text:async()=>'{"data":{}}'}]){
 sb=database();text=await smsWith(sb,response);result=await text(sms);assert.equal(result.ok,false);assert.equal(result.uncertain,true);assert.equal(result.retryScheduled,false);assert.equal(sb.writes.at(-1).status,'uncertain');
}
sb=database();text=await smsWith(sb,{ok:false,status:429,text:async()=>''});result=await text(sms);assert.equal(result.retryScheduled,true);
sb=database();text=await smsWith(sb,{ok:true,text:async()=>'{"data":{"id":"sms"}}'});requests=[];
result=await text({...sms,recipient:{...sms.recipient,sms_opted_out_at:'2026-09-23'}});assert.equal(result.ok,false);assert.equal(requests.length,0);assert.equal(sb.calls.length,0);
console.log('PASS actual email/SMS senders: reserve before network, quiet hours/DST, frozen idempotent retries, failure truth, stale booking cancellation, consent and uncertain SMS hold');
