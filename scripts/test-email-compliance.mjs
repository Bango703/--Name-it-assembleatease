#!/usr/bin/env node
// Marketing email obeys CAN-SPAM, and the opt-out list is honoured everywhere.
//
// WHAT WAS WRONG. email_suppressions — the list of people who unsubscribed —
// was consulted in exactly ONE file, api/owner/broadcast.js. Every other
// re-engagement send went out through sendEmail(), which never looked at it. So
// a customer who clicked Unsubscribe would still receive the rebook invite, the
// review request and the follow-up. The rebook invite also carried no
// unsubscribe link and no postal address at all, because it was a hand-rolled
// full document that skipped the shared footer.
//
// None of that is recoverable after the fact. Mail cannot be unsent, and an
// opt-out that does not work is the complaint that costs a sending domain its
// reputation. So the check lives in the one function every email goes through,
// and this file keeps it there.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ensureEmailShell } from '../api/_email.js';
import { broadcastFooter, unsubscribeUrl, businessPostalAddress } from '../api/_broadcast.js';

const read = name => readFile(new URL('../' + name, import.meta.url), 'utf8');
const emailSrc = await read('api/_email.js');

// ── 1. The opt-out list is checked in the shared sender ─────────────────────
assert.match(emailSrc, /from\('email_suppressions'\)/,
  'sendEmail must consult the opt-out list itself; leaving it to callers is what failed');
assert.match(emailSrc, /suppressed:\s*true/,
  'a suppressed send must report itself as suppressed, not silently succeed');
// A failed lookup must refuse. Guessing "probably not unsubscribed" is the one
// mistake that cannot be walked back.
assert.match(emailSrc, /suppressErr\)\s*return\s*\{\s*ok:\s*false/,
  'if the opt-out list cannot be read, nothing may be sent');
// And it must happen before the provider call is claimed.
assert.ok(emailSrc.indexOf("from('email_suppressions')") < emailSrc.indexOf('await prepareNotification('),
  'check the opt-out list before claiming a send, not after');

// ── 2. Marketing is defined, and transactional mail is not in it ────────────
const marketingBlock = emailSrc.match(/MARKETING_NOTIFICATION_TYPES = new Set\(\[([\s\S]*?)\]\)/);
assert.ok(marketingBlock, 'the marketing type list must exist');
const marketing = [...marketingBlock[1].matchAll(/'([a-z_0-9]+)'/g)].map(m => m[1]);
for (const expected of ['customer_rebook_invite', 'review_request', 'followup', 'waitlist_invite', 'broadcast']) {
  assert.ok(marketing.includes(expected), `${expected} is marketing and must be on the list`);
}
// Someone who opts out of marketing must still get their own booking confirmed,
// their receipt and their refund. Suppressing those would be a worse bug.
for (const transactional of ['booking_confirmed', 'payment_receipt', 'completion', 'refund', 'cancellation', 'assignment_confirmation']) {
  assert.ok(!marketing.includes(transactional),
    `${transactional} is transactional — suppressing it would withhold something the customer is owed`);
}

// ── 3. Marketing carries the two CAN-SPAM must-haves ────────────────────────
const footer = broadcastFooter('someone@example.com');
assert.match(footer, /\/api\/unsubscribe\?e=/, 'a marketing footer needs a working unsubscribe link');
assert.ok(footer.includes(businessPostalAddress()), 'a marketing footer needs a physical postal address');
// Signed per address, so one click opts out one person and cannot be forged.
// The token needs UNSUBSCRIBE_SECRET or CRON_SECRET; set one for the check so
// this passes on a developer machine as well as in CI.
process.env.UNSUBSCRIBE_SECRET = process.env.UNSUBSCRIBE_SECRET || 'test-secret-for-signature-shape';
assert.match(unsubscribeUrl('a@b.com'), /^https:\/\/.+\/api\/unsubscribe\?e=.+&t=[0-9a-f]{32}$/,
  'the unsubscribe link must be per-address and signed');
assert.notEqual(unsubscribeUrl('a@b.com'), unsubscribeUrl('c@d.com'),
  'two people must not share an unsubscribe token');
// And with no secret at all, marketing must refuse to send rather than ship a
// link that silently does nothing when clicked.
assert.match(emailSrc, /marketing send blocked/,
  'an unsignable unsubscribe link must block the send, not travel dead');
assert.match(emailSrc, /'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'/,
  'Gmail and Yahoo require one-click unsubscribe from bulk senders');
assert.match(emailSrc, /alreadyHasOptOut/,
  'callers that already append the footer must not get a second one');

// ── 4. A bespoke full document still carries the house footer ───────────────
// This is how six customer and Easer emails shipped with no phone number, no
// contact address and no opt-out: a full <!DOCTYPE> passed straight through.
const bespoke = '<!DOCTYPE html><html><head></head><body><p>Your code is 123456.</p></body></html>';
for (const who of ['customer', 'easer']) {
  const framed = ensureEmailShell(bespoke, who);
  assert.match(framed, /232-5139/, `a bespoke ${who} email must still carry the contact footer`);
  assert.ok(framed.indexOf('232-5139') < framed.lastIndexOf('</body>'),
    'the footer belongs inside the document');
}
assert.equal(ensureEmailShell(bespoke, 'owner'), bespoke,
  'owner alerts keep byte-for-byte pass-through');
// It must not staple a second footer onto a document that already has one.
const withFooter = '<!DOCTYPE html><html><body><p>Call (979) 232-5139.</p></body></html>';
assert.equal(ensureEmailShell(withFooter, 'customer'), withFooter,
  'a document that already carries contact details is left alone');

// ── 5. The marketing senders still route through sendEmail ──────────────────
// Reaching the provider directly would skip every rule above.
for (const file of ['api/owner/rebook-invite.js', 'api/review-request.js', 'api/cron/followup.js', 'api/owner/broadcast.js']) {
  const src = await read(file);
  assert.doesNotMatch(src, /api\.resend\.com/, `${file} must send through sendEmail, not the provider directly`);
  assert.match(src, /sendEmail\s*\(/, `${file} must use the shared sender`);
}

// The rebook invite specifically: it is the one that had none of this.
const rebook = await read('api/owner/rebook-invite.js');
// Strip comments first: the file explains WHY it must be a fragment, and that
// explanation contains the very word being searched for.
const rebookCode = rebook.replace(new RegExp('//.*$', 'gm'), '');
assert.doesNotMatch(rebookCode, /<!DOCTYPE/i,
  'the rebook invite must be a fragment so it inherits the shared footer');
assert.match(rebook, /notificationType: 'customer_rebook_invite'/,
  'it must declare the type the suppression check keys on');

console.log(`PASS email compliance: opt-out honoured in the shared sender, ${marketing.length} marketing types carry unsubscribe + postal address`);
