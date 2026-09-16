import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { getEaserReadiness } from '../api/_easer-readiness.js';
// Read the live constant rather than pinning a version — a pinned one rots the
// moment the agreement is bumped, which is the exact trap migration 091 undid.
import { CONTRACTOR_AGREEMENT_VERSION } from '../api/_assembler-onboarding.js';

const read = rel => readFile(new URL(`../${rel}`, import.meta.url), 'utf8');

const ready = extra => ({
  status: 'active', application_status: 'approved', identity_verified: true,
  contractor_agreement_signed_at: '2026-08-16T00:00:00Z',
  contractor_agreement_version: CONTRACTOR_AGREEMENT_VERSION,
  code_of_conduct_agreed_at: '2026-08-16T00:00:00Z',
  phone: '512-555-0100', sms_consent_at: '2026-08-16T00:00:00Z', is_available: true, tier: 'starter',
  application_fee_paid: true, ...extra,
});

const base = await getEaserReadiness(ready(), { connectRequired: false });
assert.equal(base.isReady, true, 'the fixture must otherwise be ready');

// ── The five fields the database enforced and the API ignored ──────────────
// Each of these made the trigger raise 23514, which the owner saw as an opaque
// refusal on an Easer the API had just called ready.
const blockers = [
  ['application_decision_key', 'abc-123', /Application decision finished/],
  ['application_fee_refunded', true, /Application fee refund resolved/],
  ['application_fee_refunded_cents', 500, /Application fee refund resolved/],
  ['application_fee_refund_pending_cents', 500, /Application fee refund resolved/],
  ['application_fee_refund_review_required_at', '2026-09-01', /Application fee refund resolved/],
];
for (const [field, value, pattern] of blockers) {
  const r = await getEaserReadiness(ready({ [field]: value }), { connectRequired: false });
  assert.equal(r.isReady, false, `${field} must block readiness, as the database already does`);
  assert.ok(r.missingItems.some(i => pattern.test(i)),
    `${field} must produce a NAMED missing item, not a silent database rejection. Got: ${JSON.stringify(r.missingItems)}`);
}

// Zero/absent values must not block a healthy Easer.
for (const [field, value] of [
  ['application_fee_refunded', false],
  ['application_fee_refunded_cents', 0],
  ['application_fee_refund_pending_cents', 0],
  ['application_fee_refund_review_required_at', null],
  ['application_decision_key', null],
]) {
  const r = await getEaserReadiness(ready({ [field]: value }), { connectRequired: false });
  assert.equal(r.isReady, true, `${field}=${JSON.stringify(value)} must not block a ready Easer`);
}

// ── Parity is structural, not a one-off ────────────────────────────────────
// Every profile column the assignment trigger reads must also be read by the
// readiness function, or the database can reject someone the API called ready.
const files = (await readdir(new URL('../api/migrations/', import.meta.url))).sort();
let latest = null;
for (const f of files) {
  const sql = await read(`api/migrations/${f}`);
  if (sql.includes('FUNCTION public.guard_booking_easer_closure_assignment')) latest = { f, sql };
}
assert.ok(latest, 'the assignment trigger must live in a migration');

const guardBlock = latest.sql.slice(
  latest.sql.indexOf('IF v_readiness_guard_required THEN'),
  latest.sql.indexOf('RAISE EXCEPTION \'Assigned Easer is not ready and eligible for jobs\''),
);
const dbFields = [...new Set([...guardBlock.matchAll(/v_profile\.([a-z_]+)/g)].map(m => m[1]))];
assert.ok(dbFields.length >= 15, `expected the full readiness field set, found ${dbFields.length}`);

const readinessSrc = await read('api/_easer-readiness.js');
const closureSrc = await read('api/_easer-closure.js');
const feeSrc = await read('api/_easer-application-fee.js');
const apiSurface = readinessSrc + closureSrc + feeSrc;
const unread = dbFields.filter(f => !apiSurface.includes(f));
assert.deepEqual(unread, [],
  `${latest.f} rejects on these columns but the readiness API never reads them, so the database would refuse an Easer the API called ready: ${unread.join(', ')}`);

console.log(`readiness/database parity tests: PASS (${dbFields.length} trigger columns all read by the API)`);
