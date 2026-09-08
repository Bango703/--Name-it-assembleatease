#!/usr/bin/env node
// Internal bookings must not be counted as business results.
//
// On 2026-09-08 the bookings table held 14 rows and 6 were internal: four
// created by the owner and two by a suspended Easer account while testing.
// Nothing distinguished them from a real customer, so 43% of the booking history
// was staff activity, unlabelled. All six are cancelled, so revenue was never
// affected — but the daily and weekly summary emails report a cancellation
// count, and had been reporting fake cancellations since May.
//
// Flagged, not deleted: these rows carry payment intents, financial audit
// entries and notification history. Article 6 keeps financial operations
// auditable and Article 15 keeps changes reversible; deleting them to tidy a
// report would break both.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

const migration = await read('api/migrations/094_mark_test_bookings.sql');

// Additive and defaulted, so every existing and future row is real unless
// someone deliberately says otherwise.
assert.match(migration, /ADD COLUMN IF NOT EXISTS is_test_booking BOOLEAN NOT NULL DEFAULT FALSE/,
  'The flag must default to FALSE — a new booking is real until proven internal');

// Addressed by ref, not by email pattern: an email match would silently widen
// if a real customer ever used one of those addresses.
assert.match(migration, /WHERE ref IN \(/, 'Rows must be addressed by ref');
const refs = [...migration.matchAll(/'(AAE-[A-Z0-9]+)'/g)].map(m => m[1]);
assert.equal(refs.length, 6, `Exactly 6 internal bookings were identified, found ${refs.length}`);
assert.equal(new Set(refs).size, 6, 'Refs must be unique');

// The one thing this migration must never do.
assert.doesNotMatch(migration, /DELETE\s+FROM/i,
  'Internal bookings are flagged, never deleted — they carry financial history');
assert.doesNotMatch(migration, /DROP\s+(TABLE|COLUMN)/i);

// A schema change nothing reloads is invisible to PostgREST.
assert.match(migration, /NOTIFY pgrst/, 'Schema changes must reload the PostgREST cache');
assert.match(migration, /platform_schema_state/, 'The migration must record itself');

// ------------------------------------------------- the numbers the owner reads --
// Both summaries report business results, so every booking query in them must
// exclude internal rows. A query that forgets is a number that lies.
for (const file of ['api/cron/daily-summary.js', 'api/cron/weekly-summary.js']) {
  const src = await read(file);
  const queries = [...src.matchAll(/\.from\('bookings'\)/g)].length;
  const filtered = [...src.matchAll(/\.eq\('is_test_booking', false\)/g)].length;
  assert.equal(filtered, queries,
    `${file}: ${queries} booking quer(ies) but only ${filtered} exclude internal bookings`);

  // Placement matters. In supabase-js a filter belongs AFTER select(); calling
  // .eq() straight off .from() is valid JavaScript and a broken query, which is
  // exactly the mistake this file exists to prevent recurring.
  assert.doesNotMatch(src, /\.from\('bookings'\)\s*\.eq\(/,
    `${file}: filter placed before select() — that is not a valid PostgREST query`);
}

console.log(`PASS internal bookings: flag defaults to real, ${refs.length} rows flagged not deleted, `
  + 'every summary query excludes them, filters correctly placed');
