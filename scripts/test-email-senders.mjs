#!/usr/bin/env node
// One sender per audience (owner, 2026-10-22). An Easer's rejection arrived
// from "AssembleAtEase <booking@assembleatease.com>", and email went out under
// ten sender names picked call by call. api/_email.js decides the sender from
// who the email is for; no caller passes one.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

process.env.RESEND_API_KEY = '';
const { EMAIL_SENDERS, senderFor } = await import('../api/_email.js');

assert.equal(senderFor({ recipientType: 'easer', notificationType: 'easer_application_rejected' }), 'AssembleAtEase Easer Support <service@assembleatease.com>');
assert.equal(senderFor({ recipientType: 'owner', notificationType: 'daily_summary' }), 'AssembleAtEase Alerts <booking@assembleatease.com>');
assert.equal(senderFor({ recipientType: 'customer', notificationType: 'booking_confirmed' }), 'AssembleAtEase <booking@assembleatease.com>');
for (const care of ['support_case_confirmation', 'business_inquiry_received', 'owner_message', 'stripe_dispute_customer', 'case_update_customer']) {
  assert.equal(senderFor({ recipientType: 'customer', notificationType: care }), EMAIL_SENDERS.customerCare, care);
}
assert.equal(senderFor({ recipientType: 'unknown', notificationType: 'transactional' }), EMAIL_SENDERS.customer, 'an unknown recipient gets the plain sender');
for (const review of ['review_request', 'review_request_1', 'review_request_2']) {
  assert.equal(senderFor({ recipientType: 'customer', notificationType: review }), EMAIL_SENDERS.customer, `${review} is sent by the business`);
}
console.log('PASS senders: customers, Customer Care, Easer Support and owner alerts each have one sender');

const email = readFileSync(new URL('../api/_email.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
assert.match(email, /export async function sendEmail\(\{ to, subject, html, replyTo, meta = \{\} \}\)/, 'sendEmail takes no sender');
assert.match(email, /const from = senderFor\(\{ recipientType, notificationType \}\);\n  const body = \{ from,/);

const offenders = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) { if (name !== 'node_modules') walk(path); continue; }
    if (!name.endsWith('.js') || path.endsWith(join('api', '_email.js'))) continue;
    const text = readFileSync(path, 'utf8');
    if (/from:\s*['"`][^'"`\n]*@assembleatease\.com/.test(text)) offenders.push(path);
  }
})(new URL('../api', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
assert.deepEqual(offenders, [], `these pass their own sender: ${offenders.join(', ')}`);
console.log('PASS callers: no email in api/ names its own sender');

console.log('\nEmail sender tests passed.');
