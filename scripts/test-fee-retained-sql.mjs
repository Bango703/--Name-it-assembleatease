#!/usr/bin/env node
// Runs migration 130 in a local PostgreSQL engine (no network, no production
// data) and walks the rejection paths of finalize_easer_application_decision:
// a non-refundable fee is kept, a retry is recognised, a legacy paid rejection
// still requires a full refund, and a fee can only be kept when it was paid.
import { PGlite } from '@electric-sql/pglite';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const db = new PGlite();
await db.exec(`
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
  CREATE TABLE platform_schema_state (migration_number INTEGER PRIMARY KEY, migration_name TEXT);
  CREATE TABLE profiles (
    id UUID PRIMARY KEY, role TEXT DEFAULT 'assembler', status TEXT DEFAULT 'pending',
    application_status TEXT DEFAULT 'applied', tier TEXT, previous_tier TEXT, is_available BOOLEAN DEFAULT FALSE,
    approved_at TIMESTAMPTZ, rejected_at TIMESTAMPTZ, rejection_reason TEXT,
    application_decision_key TEXT, application_decision_type TEXT, application_decision_started_at TIMESTAMPTZ,
    application_fee_paid BOOLEAN, payment_confirmed BOOLEAN, application_fee_waived BOOLEAN, fee_waived_by_owner BOOLEAN,
    application_fee_refunded BOOLEAN, application_fee_refunded_cents INTEGER DEFAULT 0,
    application_fee_refund_pending_cents INTEGER DEFAULT 0, application_fee_refund_review_required_at TIMESTAMPTZ,
    application_fee_refund_id TEXT, application_fee_refunded_at TIMESTAMPTZ,
    stripe_payment_intent_id TEXT, stripe_customer_id TEXT, identity_verified BOOLEAN,
    contractor_agreement_signed_at TIMESTAMPTZ, contractor_agreement_version TEXT, code_of_conduct_agreed_at TIMESTAMPTZ,
    phone TEXT, account_closure_status TEXT
  );
  CREATE FUNCTION easer_application_decision_snapshot(p public.profiles) RETURNS JSONB LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
`);
await db.exec(readFileSync(new URL('../api/migrations/130_easer_application_fee_retained.sql', import.meta.url), 'utf8'));

const paid = { application_fee_paid: true, payment_confirmed: true, stripe_payment_intent_id: 'pi_1', stripe_customer_id: 'cus_1' };
async function easer(id, fields) {
  const cols = ['id', 'application_decision_type', 'application_decision_key', ...Object.keys(fields)];
  const vals = [id, 'reject', 'k-' + id, ...Object.values(fields)];
  await db.query(`INSERT INTO profiles (${cols.join(',')}) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(',')})`, vals);
}
const finalize = (id, retained, decision = 'reject') => db.query(
  `SELECT * FROM finalize_easer_application_decision($1, $2, $3, '{}'::jsonb, 'v1', NULL, NULL, 'Not a fit', NULL, $4)`,
  [id, decision, 'k-' + id, retained]);
const fails = async (promise, pattern) => { await assert.rejects(promise, err => pattern.test(err.message)); };

const A = '11111111-1111-4111-8111-111111111111';
await easer(A, paid);
const applied = (await finalize(A, true)).rows[0];
assert.equal(applied.result_action, 'applied');
const row = (await db.query('SELECT status, application_status, application_fee_retained_at, application_fee_refund_id FROM profiles WHERE id = $1', [A])).rows[0];
assert.equal(row.status, 'rejected');
assert.ok(row.application_fee_retained_at, 'the kept fee is recorded');
assert.equal(row.application_fee_refund_id, null);
assert.equal((await finalize(A, true)).rows[0].result_action, 'already_finalized', 'a retry is recognised');

const B = '22222222-2222-4222-8222-222222222222';
await easer(B, paid);
await fails(finalize(B, false), /requires a completed aggregate Stripe refund/);

const C = '33333333-3333-4333-8333-333333333333';
await easer(C, { application_fee_waived: true });
await fails(finalize(C, true), /Only a paid application fee can be retained/);

const D = '44444444-4444-4444-8444-444444444444';
await easer(D, { ...paid, application_fee_refund_pending_cents: 3000 });
await fails(finalize(D, true), /cannot carry refund activity/);

await fails(finalize(B, true, 'approve'), /Invalid Easer application decision finalization/);

const grants = (await db.query(`SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'finalize_easer_application_decision'`)).rows[0].n;
assert.equal(grants, 1, 'exactly one version of the function exists');

console.log('PASS fee retained SQL: non-refundable fee kept and recorded, retry recognised, legacy paid rejection still needs a full refund, waived fee cannot be kept, refund activity blocks keeping, one function version.');
