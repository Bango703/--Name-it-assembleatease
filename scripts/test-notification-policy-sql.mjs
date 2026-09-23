import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
// Run with a locally installed @electric-sql/pglite module path; no live DB.
const modulePath = process.argv[2];
if (!modulePath) throw new Error('Pass the local @electric-sql/pglite/dist/index.js path. See notification release receipt.');
const { PGlite } = await import(pathToFileURL(modulePath).href);
const db = new PGlite();
await db.exec(`
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE TABLE notification_log (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),booking_id uuid,
 channel text NOT NULL, notification_type text NOT NULL,recipient_type text,recipient_email text,
 recipient_user_id uuid,subject text,status text NOT NULL DEFAULT 'sent',provider_id text,error_text text,
 sent_at timestamptz NOT NULL DEFAULT now(),provider_accepted_at timestamptz,operation_case_id uuid);
CREATE TABLE easer_announcement_deliveries(id uuid PRIMARY KEY DEFAULT gen_random_uuid());
CREATE TABLE email_broadcasts(id uuid PRIMARY KEY DEFAULT gen_random_uuid());
CREATE TABLE platform_schema_state(migration_number integer PRIMARY KEY,migration_name text);
`);
const migration = await fs.readFile(new URL('../api/migrations/096_notification_delivery_policy.sql', import.meta.url), 'utf8');
await db.exec(migration);
await db.exec(migration); // replay must be safe
const uid = '10000000-0000-4000-8000-000000000001';
async function reserve(key, overrides = {}) {
 const defaults = { key, recipient: `user:${uid}`, fingerprint: key,
  log: { channel:'email', notification_type:'reminder', recipient_type:'easer',recipient_email:'fixture@example.invalid',recipient_user_id:uid },
  payload:{body:{text:'fixture'}},snapshot:{status:'confirmed'},notBefore:new Date(0),expires:new Date(Date.now()+3600000),routine:true,minutes:0,legacy:null };
 const o={...defaults,...overrides};
 const r=await db.query('SELECT reserve_notification_send_v1($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,$8,$9,$10,$11) AS result',
 [o.key,o.recipient,o.fingerprint,JSON.stringify(o.log),JSON.stringify(o.payload),JSON.stringify(o.snapshot),o.notBefore,o.expires,o.routine,o.minutes,o.legacy]);
 return r.rows[0].result;
}
const clear = () => db.exec('TRUNCATE notification_log');
let a=await reserve('a');assert.equal(a.action,'send');
let b=await reserve('a');assert.equal(b.action,'deferred');
await db.query("UPDATE notification_log SET status='provider_accepted',provider_id='provider-a',claim_token=NULL,claim_expires_at=NULL,send_payload=NULL WHERE id=$1",[a.id]);
b=await reserve('a');assert.equal(b.action,'already_sent');assert.ok(b.sentAt);
b=await reserve('b',{log:{channel:'sms',notification_type:'appointment_day_of',recipient_type:'easer',recipient_email:'+15125550100',recipient_user_id:uid}});
assert.equal(b.action,'deferred');assert.ok(new Date(b.nextAttemptAt)-Date.now()>3.9*3600000);
await clear();
a=await reserve('quiet',{notBefore:new Date(Date.now()+3600000)});assert.equal(a.action,'deferred');
await clear();
await db.exec(`INSERT INTO notification_log(recipient_key,routine,channel,notification_type,status,sent_at) VALUES
 ('user:${uid}',true,'email','reminder','delivered',now()-interval '10 hours'),
 ('user:${uid}',true,'sms','appointment_day_of','delivered',now()-interval '5 hours')`);
a=await reserve('cap');assert.equal(a.action,'deferred');assert.ok(new Date(a.nextAttemptAt)-Date.now()>13.9*3600000);
a=await reserve('urgent',{routine:false});assert.equal(a.action,'send');
await clear();
a=await reserve('frozen',{routine:false});
await db.query("UPDATE notification_log SET status='failed',claim_token=NULL,claim_expires_at=NULL,next_attempt_at=now()-interval '1 second' WHERE id=$1",[a.id]);
b=await reserve('frozen',{routine:false,payload:{body:{text:'changed'}}});assert.equal(b.action,'send');assert.equal(b.payload.body.text,'fixture');assert.equal(b.attempt,2);
await db.query("UPDATE notification_log SET status='failed',claim_token=NULL,claim_expires_at=NULL,send_payload=NULL WHERE id=$1",[a.id]);
assert.equal((await reserve('frozen',{routine:false})).action,'blocked');
await clear();
a=await reserve('sms',{routine:false,log:{channel:'sms',notification_type:'job_accepted',recipient_email:'+15125550100'}});
await db.query("UPDATE notification_log SET claim_expires_at=now()-interval '1 second' WHERE id=$1",[a.id]);
assert.equal((await reserve('sms',{routine:false})).reason,'sms_delivery_unknown');
assert.equal((await db.query('SELECT status FROM notification_log WHERE id=$1',[a.id])).rows[0].status,'uncertain');
await clear();
await db.query("INSERT INTO notification_log(channel,notification_type,recipient_type,recipient_email,status,recipient_user_id) VALUES ('sms','reminder','easer','+15125550100','delivered',$1)",[uid]);
a=await reserve('legacy-email',{legacy:new Date(Date.now()-86400000)});assert.equal(a.action,'deferred'); // SMS does not falsely prove email already sent
await db.query("INSERT INTO notification_log(channel,notification_type,recipient_email,status) VALUES ('email','reminder','fixture@example.invalid','delivered')");
assert.equal((await reserve('legacy-email-other',{legacy:new Date(Date.now()-86400000)})).action,'already_sent');
await clear();
await db.exec(`INSERT INTO notification_log(recipient_user_id,recipient_type,channel,notification_type,status,sent_at) VALUES
 ('${uid}','easer','email','easer_reminder','delivered',now()-interval '10 hours'),
 ('${uid}','easer','sms','easer_reminder','delivered',now()-interval '5 hours')`);
assert.equal((await reserve('legacy-cap')).action,'deferred');
await clear();
a=await reserve('bucket1',{routine:false,fingerprint:'same',minutes:2});
assert.equal((await reserve('bucket2',{routine:false,fingerprint:'same',minutes:2})).reason,'prior_attempt_pending');
await clear();
assert.equal((await reserve('expired',{expires:new Date(0)})).action,'blocked');
const permissions=await db.query("SELECT has_function_privilege('anon','reserve_notification_send_v1(text,text,text,jsonb,jsonb,jsonb,timestamptz,timestamptz,boolean,integer,timestamptz)','EXECUTE') AS allowed");
assert.equal(permissions.rows[0].allowed,false);
const token='20000000-0000-4000-8000-000000000001';
assert.equal((await db.query('SELECT acquire_notification_lease_v1($1,$2) AS ok',['workflow',token])).rows[0].ok,true);
assert.equal((await db.query('SELECT acquire_notification_lease_v1($1,$2) AS ok',['workflow',token])).rows[0].ok,false);
await db.query('SELECT release_notification_lease_v1($1,$2)',['workflow',token]);
assert.equal((await db.query('SELECT acquire_notification_lease_v1($1,$2) AS ok',['workflow',token])).rows[0].ok,true);
await db.close();
console.log('PASS PostgreSQL migration replay, leases, privileges, durable dedupe, channel separation, cadence, cap, frozen retries, expiry and uncertain SMS');
