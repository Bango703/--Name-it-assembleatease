// Executes the migration and money/state transitions in a local PostgreSQL
// engine. No environment files, network, Stripe or production data are used.
import { PGlite } from '@electric-sql/pglite';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const db = new PGlite();
await db.exec(`
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
  CREATE TABLE profiles (id UUID PRIMARY KEY);
  CREATE TABLE partner_leads (id UUID PRIMARY KEY);
  CREATE TABLE platform_schema_state (migration_number INTEGER PRIMARY KEY, migration_name TEXT);
  CREATE TABLE bookings (
    id UUID PRIMARY KEY, created_at TIMESTAMPTZ DEFAULT now(), status TEXT,
    payment_status TEXT, payment_method_type TEXT, quote_token_hash TEXT,
    quote_approved_at TIMESTAMPTZ, stripe_payment_intent_id TEXT,
    financial_operation_key TEXT, financial_operation_type TEXT,
    financial_operation_started_at TIMESTAMPTZ, financial_reconciliation_required_at TIMESTAMPTZ,
    cancellation_reconciliation_required_at TIMESTAMPTZ,
    quote_amount_cents INTEGER, quote_subtotal_cents INTEGER, quote_tax_cents INTEGER,
    date DATE, time TEXT, quote_sent_at TIMESTAMPTZ, quote_expires_at TIMESTAMPTZ,
    quote_terms_version TEXT, quote_approval_started_at TIMESTAMPTZ
  );
`);
const sql = readFileSync(new URL('../api/migrations/129_hybrid_offers_and_accounts.sql', import.meta.url), 'utf8');
await db.exec(sql);
await db.exec(sql); // Migration replay is safe.
const booking = '11111111-1111-4111-8111-111111111111';
const easer = '22222222-2222-4222-8222-222222222222';
const stranger = '33333333-3333-4333-8333-333333333333';
await db.query('INSERT INTO profiles VALUES ($1), ($2)', [easer, stranger]);
await db.query("INSERT INTO bookings (id,status,payment_status,payment_method_type) VALUES ($1,'pending','not_required','card')", [booking]);
const offer = (await db.query("INSERT INTO quote_price_offers (booking_id,easer_id,respond_by) VALUES ($1,$2,now()+interval '1 day') RETURNING *", [booking, easer])).rows[0];
const respond = (who, action, value = {}) => db.query('SELECT respond_quote_price_offer($1,$2,$3,$4)', [offer.id, who, action, value]);
await assert.rejects(respond(stranger, 'submit', { earningsCents: 10000, hours: 2, crewSize: 1 }), /closed/);
await respond(easer, 'submit', { earningsCents: 10000, hours: 2, crewSize: 1 });
const first = (await db.query('SELECT * FROM quote_price_offers WHERE id=$1', [offer.id])).rows[0];
const patch = {
  quote_amount_cents: 15465, quote_subtotal_cents: 14286, quote_tax_cents: 1179,
  quote_offer_earnings_cents: 10000, quote_offer_fee_pct: 30,
  date: '2026-12-01', time: '10:00 AM', quote_token_hash: 'first-token',
  quote_sent_at: new Date().toISOString(), quote_expires_at: '2099-12-01T00:00:00Z', quote_terms_version: 'test',
};
const select = (expected, token = null, pay = 'not_required', body = patch) => db.query(
  'SELECT prepare_hybrid_quote($1,$2,$3,$4,$5,$6)', [booking, pay, token, offer.id, expected, body]);
await respond(easer, 'submit', { earningsCents: 15000, hours: 3, crewSize: 1 });
await assert.rejects(select(first.updated_at), /price changed/);
assert.equal((await db.query('SELECT quote_token_hash FROM bookings')).rows[0].quote_token_hash, null);
const changed = (await db.query('SELECT * FROM quote_price_offers')).rows[0];
await assert.rejects(select(changed.updated_at, null, 'not_required', { ...patch, quote_offer_earnings_cents: 15000, quote_amount_cents: 2 }), /Invalid quote/);
assert.equal((await db.query('SELECT status FROM quote_price_offers')).rows[0].status, 'submitted', 'failed quote rolls back offer selection');
await respond(easer, 'withdraw');
await assert.rejects(select(changed.updated_at), /price changed/);
// Recreate a fresh invitation, select it, and prove no further edits or
// duplicate owner save can mutate its promised amount.
await db.query('DELETE FROM quote_price_offers WHERE id=$1', [offer.id]);
await db.query("INSERT INTO quote_price_offers(id,booking_id,easer_id,respond_by,status,earnings_cents,hours,crew_size) VALUES ($1,$2,$3,now()+interval '1 day','submitted',10000,2,1)", [offer.id, booking, easer]);
const current = (await db.query('SELECT * FROM quote_price_offers')).rows[0];
await select(current.updated_at);
await assert.rejects(respond(easer, 'submit', { earningsCents: 30000, hours: 4, crewSize: 1 }), /closed/);
await assert.rejects(select(current.updated_at), /Quote changed/);
await assert.rejects(db.query("INSERT INTO quote_price_offers (booking_id,easer_id,respond_by) VALUES ($1,$2,now()+interval '1 day')", [booking, stranger]), /changed/);
let saved = (await db.query('SELECT * FROM bookings')).rows[0];
assert.equal(saved.quote_offer_earnings_cents, 10000);
assert.equal(saved.quote_offer_fee_pct, 30);
assert.equal(saved.selected_quote_offer_id, offer.id);
assert.deepEqual(saved.preferred_easer_ids, [easer]);
assert.equal((await db.query('SELECT status FROM quote_price_offers')).rows[0].status, 'selected');
// A manual reprice atomically clears the selection and old invitations.
await db.query('SELECT prepare_hybrid_quote($1,$2,$3,NULL,NULL,$4)', [booking, 'quote_pending_approval', 'first-token', { ...patch, quote_token_hash: 'manual-token' }]);
saved = (await db.query('SELECT * FROM bookings')).rows[0];
assert.equal(saved.selected_quote_offer_id, null);
assert.equal(saved.quote_offer_earnings_cents, null);
assert.equal((await db.query('SELECT status FROM quote_price_offers')).rows[0].status, 'closed');
for (const role of ['anon', 'authenticated']) {
  await db.exec(`SET ROLE ${role}`);
  await assert.rejects(select(current.updated_at), /permission denied/);
  await assert.rejects(respond(easer, 'withdraw'), /permission denied/);
  await db.exec('RESET ROLE');
}
await db.close();
console.log('PASS hybrid PostgreSQL: migration replay, cross-Easer access, stale offers, withdrawals, transaction rollback, duplicate selection, post-selection edits, manual repricing, and RPC role grants.');
