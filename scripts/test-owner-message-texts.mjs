#!/usr/bin/env node
// Owner texts, 2026-10-01. Owner: "I DONT GET SMS MESSAGES?" Messages written
// to the owner arrived by email only. This holds:
//   - a message written TO the owner texts the owner's own number
//   - a burst is one text per booking per 30 minutes; urgent Easer reports always go
//   - a direct customer-Easer message does not text the owner
//   - one text fits one SMS segment, plain characters, no message body

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { textOwnerAboutMessage, ownerTextBody, OWNER_MESSAGE_TEXT_TYPE } from '../api/_owner-text.js';
import { toGsm7 } from '../api/_sms.js';

function fakeSb(recentRows, error = null) {
  const q = { select() { return q; }, eq() { return q; }, gte() { return q; }, limit() { return Promise.resolve({ data: recentRows, error }); } };
  return { from() { return q; } };
}
const booking = { id: 'b1', ref: 'AAE-TYRHONCHIO' };
const env = { OWNER_PERSONAL_PHONE: '+15125550100' };

{
  const sent = [];
  const r = await textOwnerAboutMessage({ sb: fakeSb([]), booking, fromParty: 'customer' }, { env, sendSms: async (x) => { sent.push(x); return { ok: true }; } });
  assert.equal(r.ok, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].recipient.phone, '+15125550100');
  assert.ok(sent[0].recipient.sms_consent_at, 'the owner number is sent with recorded consent so the SMS module accepts it');
  assert.equal(sent[0].meta.notificationType, OWNER_MESSAGE_TEXT_TYPE);
  assert.equal(sent[0].meta.recipientType, 'owner');
  assert.match(sent[0].body, /A customer messaged you about AAE-TYRHONCHIO/);
}
{
  let sent = 0;
  const r = await textOwnerAboutMessage({ sb: fakeSb([{ id: 'n1' }]), booking, fromParty: 'customer' }, { env, sendSms: async () => { sent++; return { ok: true }; } });
  assert.equal(r.skipped, 'recently_texted', 'a burst is one doorbell');
  assert.equal(sent, 0);
}
{
  let sent = 0;
  await textOwnerAboutMessage({ sb: fakeSb([{ id: 'n1' }]), booking, fromParty: 'assembler', urgent: true }, { env, sendSms: async () => { sent++; return { ok: true }; } });
  assert.equal(sent, 1, 'an urgent Easer report always texts');
}
{
  let sent = 0;
  await textOwnerAboutMessage({ sb: fakeSb(null, { message: 'down' }), booking, fromParty: 'customer' }, { env, sendSms: async () => { sent++; return { ok: true }; } });
  assert.equal(sent, 1, 'if the throttle lookup fails, send: a duplicate beats a missed customer');
}
{
  const r = await textOwnerAboutMessage({ sb: fakeSb([]), booking, fromParty: 'customer' }, { env: {}, sendSms: async () => { throw new Error('should not send'); } });
  assert.equal(r.skipped, 'owner_phone_not_set');
}
{
  const r = await textOwnerAboutMessage({ sb: fakeSb([]), booking, fromParty: 'customer' }, { env, sendSms: async () => { throw new Error('provider down'); } });
  assert.equal(r.ok, false, 'a failed text never throws into the message send');
}
for (const urgent of [false, true]) {
  for (const fromParty of ['customer', 'assembler']) {
    const body = ownerTextBody({ fromParty, ref: 'AAE-ABCDEFGHIJKL', urgent }) + ' Reply STOP to opt out.';
    assert.ok(body.length <= 160, `one segment: ${body.length}`);
    assert.equal(toGsm7(body), body, 'plain GSM-7 characters');
  }
}

// Wiring: only messages addressed to the owner text the owner.
const api = readFileSync('api/booking/message.js', 'utf8');
assert.match(api, /textOwnerAboutMessage\(\{ sb, booking, fromParty: 'assembler', urgent: supportDefinition\?\.severity === OPERATION_CASE_SEVERITIES\.CRITICAL \}\)/);
assert.match(api, /if \(resolvedRecipient === 'owner'\) await textOwnerAboutMessage\(\{ sb, booking, fromParty: 'customer' \}\)/, 'a customer message to the Easer does not text the owner');

console.log('PASS owner message texts: messages to the owner text the owner, one per booking per 30 minutes (urgent always), never for direct customer-Easer chat, one plain segment, never breaks a send.');
