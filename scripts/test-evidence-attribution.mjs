#!/usr/bin/env node
// A completion photo says who did the work, not just who pressed upload.
//
// The owner can upload a photo on an Easer's behalf when the Easer could not
// — a dead phone, a failed upload. booking_evidence records both: uploaded_by
// is whoever pressed the button, uploaded_on_behalf_of is whose work it
// documents. The dashboard only ever showed the first, so an owner-assisted
// upload read as though the owner did the job.
//
// The UI half of this shipped first and rendered nothing, because the field it
// reads was never produced and the query never fetched the column. That is the
// same projection bug twice in one file, so both ends are pinned here.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = name => readFile(new URL('../' + name, import.meta.url), 'utf8');
const api = await read('api/booking/evidence.js');
const ui = await read('owner/index.html');

// ── The column has to be fetched ────────────────────────────────────────────
// Resolving a field the SELECT never asked for yields undefined, and the row
// renders as if nothing was on behalf of anyone.
const evidenceSelect = api.match(/\.select\('(id, uploaded_by[^']*)'\)/);
assert.ok(evidenceSelect, 'the evidence query must still exist');
assert.ok(evidenceSelect[1].includes('uploaded_on_behalf_of'),
  'the SELECT must fetch uploaded_on_behalf_of or the name is always undefined');

// ── The name has to be resolvable ───────────────────────────────────────────
// Profiles are looked up by id. If only uploaded_by ids are collected, the
// on-behalf-of profile is missing from the map and the name reads "Unknown"
// for every assisted upload.
assert.match(api, /flatMap\(r => \[r\.uploaded_by, r\.uploaded_on_behalf_of\]\)/,
  'both ids must be collected before profiles are fetched');
assert.match(api, /\.filter\(Boolean\)/, 'a null on-behalf-of must not become a lookup for null');

// ── And returned ────────────────────────────────────────────────────────────
assert.match(api, /uploaded_on_behalf_of_name: row\.uploaded_on_behalf_of/,
  'the response must carry the resolved name');
assert.match(api, /uploaded_on_behalf_of_id:\s+row\.uploaded_on_behalf_of \|\| null/,
  'and the id, so a caller can match it without re-deriving');
// A direct upload must stay null rather than say "Unknown", which would put
// "(for Unknown)" beside every ordinary photo.
assert.match(api, /\? \(profileMap\[row\.uploaded_on_behalf_of\]\?\.full_name \|\| 'Unknown'\)[\s\S]{0,20}: null/,
  'a photo with no on-behalf-of must return null, not "Unknown"');

// ── The dashboard shows it, and only when there is something to show ───────
assert.match(ui, /ev\.uploaded_on_behalf_of_name \? ' <span[^']*\(for ' \+ esc\(ev\.uploaded_on_behalf_of_name\)/,
  'the drawer must name who the work belongs to when the upload was assisted');
assert.match(ui, /esc\(ev\.uploaded_on_behalf_of_name\)/, 'and escape it like every other name');

// ── The active-job payment notice must match the server ────────────────────
// The dashboard offers "Email Secure Payment Link" on a live job. The browser
// cannot import isActivePaymentRecoveryBooking, so the rule is duplicated —
// and a duplicate that drifts offers a button the server then refuses.
assert.match(ui, /\['en_route', 'arrived', 'in_progress'\]\.includes\(b\.status\)[\s\S]{0,400}\['pending', 'failed'\]\.includes\(b\.payment_status\)[\s\S]{0,300}b\.stripe_payment_intent_id/,
  'the dashboard rule must be the three live statuses, unpaid, with a payment on record');
// isActivePaymentRecoveryBooking, the server-side twin, arrives with the
// payment-links change. Once it is on main this should tighten to assert the
// two are identical rather than merely the same shape.
const gate = await read('api/booking/_pending-payment-recovery.js');
if (gate.includes('isActivePaymentRecoveryBooking')) {
  assert.match(gate, /\['en_route', 'arrived', 'in_progress'\]/,
    'the server predicate must cover the same three statuses as the dashboard');
}
// 'authorized' must not appear in the browser copy of the rule either: a
// booking with a healthy hold owes nothing and must not be offered a link.
const notice = ui.slice(ui.indexOf("['en_route', 'arrived', 'in_progress'].includes(b.status)"),
  ui.indexOf('data-action="send-payment"'));
assert.doesNotMatch(notice, /'authorized'/,
  'a job whose money is already held must not be shown a payment prompt');

// And it must describe what it tests. The condition detects an unpaid job,
// not an expired hold; labelling it "expired" sends the owner into Stripe
// looking for a problem that is not there.
assert.match(ui, /<strong>Payment not completed:<\/strong>/,
  'the notice must say the payment is outstanding, not that it expired');
assert.doesNotMatch(ui, /Payment authorization expired/,
  'the old label claimed something the condition never checked');

console.log('PASS evidence attribution: the column is fetched, the name resolved, an assisted upload says whose work it documents, and the payment notice matches the server rule');
