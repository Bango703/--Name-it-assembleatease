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

// Trust & Safety (owner, 2026-11-06): email about an Easer's account standing
// is sent from, answered at, and footed with trust@. The type decides it in
// api/_email.js; no caller passes service@ or a reply address for these.
const { TRUST_EMAIL, TRUST_NOTIFICATION_TYPES, contactEmailFor, ensureEmailShell } = await import('../api/_email.js');
assert.equal(TRUST_EMAIL, 'trust@assembleatease.com');
assert.equal(EMAIL_SENDERS.trust, 'AssembleAtEase Trust & Safety <trust@assembleatease.com>');
const trustTypes = ['easer_suspended', 'easer_strike_recorded', 'easer_no_show_recorded', 'easer_inactivity_notice', 'easer_deactivated', 'easer_reactivated', 'easer_reinstated'];
assert.deepEqual([...TRUST_NOTIFICATION_TYPES].sort(), [...trustTypes].sort(), 'the Trust & Safety list changed; update this test with the owner');
for (const type of trustTypes) {
  assert.equal(senderFor({ recipientType: 'easer', notificationType: type }), EMAIL_SENDERS.trust, type);
  assert.equal(contactEmailFor({ recipientType: 'easer', notificationType: type }), TRUST_EMAIL, type);
}
assert.equal(senderFor({ recipientType: 'easer', notificationType: 'easer_welcome' }), EMAIL_SENDERS.easer, 'everyday Easer email stays with Easer Support');
assert.equal(contactEmailFor({ recipientType: 'owner', notificationType: 'easer_suspended' }), 'service@assembleatease.com', 'owner alerts are not Trust & Safety mail');
const trustFramed = ensureEmailShell('<p>A no-show was recorded.</p>', 'easer', '', TRUST_EMAIL);
assert.match(trustFramed, /mailto:trust@assembleatease\.com/, 'the footer names trust@');
assert.doesNotMatch(trustFramed, /service@assembleatease\.com/, 'the footer does not also name service@');
assert.match(email, /const replyAddress = trust \? TRUST_EMAIL : replyTo;/, 'sendEmail sets the reply address for Trust & Safety mail');

const misrouted = [];
const sites = new Set();
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) { if (name !== 'node_modules' && name !== 'migrations') walk(path); continue; }
    if (!name.endsWith('.js') || path.endsWith(join('api', '_email.js'))) continue;
    const text = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
    for (const type of trustTypes) {
      const needle = `notificationType: '${type}'`;
      for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) {
        const start = text.lastIndexOf('sendEmail({', at);
        if (start === -1) continue;
        sites.add(`${type}`);
        if (/replyTo:|service@assembleatease\.com/.test(text.slice(start, at))) misrouted.push(`${path} (${type})`);
      }
    }
  }
})(new URL('../api', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
assert.deepEqual(misrouted, [], `these Trust & Safety emails pass a reply address or name service@: ${misrouted.join(', ')}`);
for (const type of ['easer_suspended', 'easer_inactivity_notice', 'easer_deactivated', 'easer_reactivated', 'easer_reinstated', 'easer_no_show_recorded']) {
  assert.ok(sites.has(type), `no sendEmail call found for ${type}`);
}
console.log('PASS trust: account-standing email is sent from, answered at and footed with trust@');

console.log('\nEmail sender tests passed.');
