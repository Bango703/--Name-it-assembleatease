#!/usr/bin/env node
// Migration 131 in a local PostgreSQL engine (no network, no production data).
// Holds: every fee rule accepts a whole percent from 10 to 30 and rejects
// anything outside it; replaying the migration is safe; a 25/30-only rule left
// under another name stops the whole migration with nothing changed; and the
// two functions it re-creates are exact copies of their only definitions
// (036, 078) apart from the one widened check.
import { PGlite } from '@electric-sql/pglite';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = p => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const migration = read('api/migrations/131_quote_fee_pct_range.sql');

async function freshDb(extraSql = '') {
  const db = new PGlite();
  await db.exec(`
    SET check_function_bodies = off;
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE platform_schema_state (migration_number INTEGER PRIMARY KEY, migration_name TEXT);
    CREATE TABLE bookings (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      easer_fee_pct_snapshot INTEGER,
      selected_quote_offer_id UUID, quote_offer_fee_pct SMALLINT,
      quote_offer_earnings_cents INTEGER, quote_offer_crew_size SMALLINT
    );
    ALTER TABLE bookings ADD CONSTRAINT bookings_easer_fee_pct_snapshot_check
      CHECK (easer_fee_pct_snapshot IS NULL OR easer_fee_pct_snapshot IN (25, 30));
    ALTER TABLE bookings ADD CONSTRAINT bookings_quote_offer_snapshot_check CHECK (
      selected_quote_offer_id IS NULL OR (
        quote_offer_fee_pct IS NOT NULL AND quote_offer_earnings_cents IS NOT NULL
        AND quote_offer_crew_size IS NOT NULL
        AND quote_offer_fee_pct IN (25, 30) AND quote_offer_earnings_cents > 0
        AND quote_offer_crew_size BETWEEN 1 AND 4));
    CREATE TABLE booking_crew (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      booking_id UUID,
      fee_pct_snapshot INTEGER CHECK (fee_pct_snapshot IN (25, 30))
    );
    ${extraSql}
  `);
  return db;
}

const ok = async (sql, params = []) => (await db.query(sql, params)).rows;
const refused = (sql, params = []) => assert.rejects(db.query(sql, params), /violates check constraint/);

// 1. Before: 17 is refused everywhere (the old rules are real in this engine).
let db = await freshDb();
await refused('INSERT INTO bookings (easer_fee_pct_snapshot) VALUES (17)');

// 2. After, and after a replay: 10 to 30 accepted, outside refused.
await db.exec(migration);
await db.exec(migration);
for (const pct of [10, 17, 25, 30]) {
  await ok('INSERT INTO bookings (easer_fee_pct_snapshot) VALUES ($1)', [pct]);
  await ok('INSERT INTO bookings (selected_quote_offer_id, quote_offer_fee_pct, quote_offer_earnings_cents, quote_offer_crew_size) VALUES (gen_random_uuid(), $1, 120000, 1)', [pct]);
  await ok('INSERT INTO booking_crew (fee_pct_snapshot) VALUES ($1)', [pct]);
}
for (const pct of [9, 31, 0]) {
  await refused('INSERT INTO bookings (easer_fee_pct_snapshot) VALUES ($1)', [pct]);
  await refused('INSERT INTO bookings (selected_quote_offer_id, quote_offer_fee_pct, quote_offer_earnings_cents, quote_offer_crew_size) VALUES (gen_random_uuid(), $1, 120000, 1)', [pct]);
  await refused('INSERT INTO booking_crew (fee_pct_snapshot) VALUES ($1)', [pct]);
}
// The rest of the quote snapshot rule is unchanged.
await refused('INSERT INTO bookings (selected_quote_offer_id, quote_offer_fee_pct, quote_offer_earnings_cents, quote_offer_crew_size) VALUES (gen_random_uuid(), 20, 120000, 5)');
await refused('INSERT INTO bookings (selected_quote_offer_id, quote_offer_fee_pct, quote_offer_earnings_cents, quote_offer_crew_size) VALUES (gen_random_uuid(), 20, 0, 1)');
const fns = await ok(`SELECT proname, pg_get_functiondef(oid) AS def FROM pg_proc WHERE proname IN ('accept_dispatch_offer', 'add_booking_crew_member')`);
assert.equal(fns.length, 2);
assert.match(fns.find(f => f.proname === 'accept_dispatch_offer').def, /p_easer_fee_pct_snapshot NOT BETWEEN 10 AND 30/);
assert.match(fns.find(f => f.proname === 'add_booking_crew_member').def, /WHEN p_fee_pct BETWEEN 10 AND 30 THEN p_fee_pct/);
assert.deepEqual(await ok('SELECT migration_number FROM platform_schema_state'), [{ migration_number: 131 }]);

// 3. A 25/30 rule under another name stops the migration; nothing changes.
db = await freshDb('ALTER TABLE bookings ADD CONSTRAINT legacy_fee_rule CHECK (easer_fee_pct_snapshot IN (25, 30));');
await assert.rejects(db.exec(migration), /still in place; nothing was changed/);
await db.exec('ROLLBACK');
assert.equal((await ok("SELECT count(*)::int AS n FROM pg_constraint WHERE conname = 'bookings_easer_fee_pct_snapshot_check' AND pg_get_constraintdef(oid) ~ 'ARRAY\\[25, 30\\]'"))[0].n, 1, 'the old rule is untouched');
assert.deepEqual(await ok('SELECT migration_number FROM platform_schema_state'), []);
assert.equal((await ok("SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'accept_dispatch_offer'"))[0].n, 0);

// 4. The re-created functions are exact copies apart from the widened check.
function between(text, start, end) {
  const i = text.indexOf(start);
  assert.ok(i >= 0, start);
  return text.slice(i, text.indexOf(end, text.indexOf(start === 'CREATE OR REPLACE FUNCTION public.add_booking_crew_member(' ? 'AS $fn$' : start, i) + 1) + end.length);
}
const accept036 = between(read('api/migrations/036_dispatch_state_safety.sql'), 'CREATE OR REPLACE FUNCTION public.accept_dispatch_offer(', '$$;\n');
const accept131 = between(migration, 'CREATE OR REPLACE FUNCTION public.accept_dispatch_offer(', '$$;\n');
assert.equal(accept131.replace('NOT BETWEEN 10 AND 30', 'NOT IN (25, 30)'), accept036);
const crew078 = between(read('api/migrations/078_add_crew_member_rpc.sql'), 'CREATE OR REPLACE FUNCTION public.add_booking_crew_member(', '$fn$;\n');
const crew131 = between(migration, 'CREATE OR REPLACE FUNCTION public.add_booking_crew_member(', '$fn$;\n');
assert.equal(crew131.replace('p_fee_pct BETWEEN 10 AND 30 THEN', 'p_fee_pct IN (25, 30) THEN'), crew078);

console.log('PASS migration 131: fee rules accept 10 to 30 and refuse the rest; replay safe; a leftover 25/30 rule stops it with nothing changed; the two functions are exact copies apart from the widened check.');
