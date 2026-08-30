#!/usr/bin/env node

/**
 * A migration that changes the schema must tell PostgREST, or the column exists
 * and the API still cannot see it.
 *
 * WHAT HAPPENED
 * Migration 068 added notification_log.provider_accepted_at and never issued
 * NOTIFY pgrst, 'reload schema'. The column was really there; PostgREST's cached
 * schema did not know it. Every write naming that column was rejected with
 *
 *     Could not find the 'provider_accepted_at' column of 'notification_log'
 *     in the schema cache
 *
 * For roughly twelve hours on 2026-08-27 every email delivered perfectly and
 * every one was recorded as never sent, including an Easer job assignment the
 * owner then believed had failed. Eight of those failures are still sitting in
 * activity_logs.
 *
 * TWO HALVES, TWO GUARDS. test-email-log-schema-tolerance.mjs holds the
 * application side: a missing optional column must not cost us the send status.
 * This holds the other side — the migration should not have created the gap in
 * the first place. The fallback is a seatbelt, not a reason to keep crashing.
 *
 * GRANDFATHERING IS DELIBERATE
 * 54 migrations at or below 077 lack the reload. They have already run, so
 * editing them changes nothing that is live and would be an unrelated rewrite of
 * applied history. The cutoff records the debt honestly and stops it growing:
 * everything from 078 onward already complies, so this passes today and fails
 * the next time someone forgets.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = fileURLToPath(new URL('../api/migrations/', import.meta.url));

// Migrations numbered below this ran before the rule existed. Do not raise it to
// silence a failure — that is the outage asking to happen again.
const ENFORCED_FROM = 78;

const RELOAD = /NOTIFY\s+pgrst\s*,\s*'reload schema'/i;
// Statements that change what PostgREST must know about.
const SCHEMA_CHANGING = /\b(ADD\s+COLUMN|CREATE\s+TABLE|DROP\s+COLUMN|RENAME\s+COLUMN|ALTER\s+COLUMN)\b/i;

const files = (await fs.readdir(MIGRATIONS_DIR))
  .filter(f => f.endsWith('.sql'))
  .sort();

const offenders = [];
const grandfathered = [];
let checked = 0;

for (const file of files) {
  const num = parseInt(file.slice(0, 3), 10);
  if (!Number.isFinite(num)) continue;

  const sql = await fs.readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
  // Comments explain; they do not change a schema. Strip them so a migration is
  // never judged on prose that merely mentions ADD COLUMN.
  const code = sql.replace(/^\s*--.*$/gm, '');
  if (!SCHEMA_CHANGING.test(code)) continue;

  if (RELOAD.test(code)) { checked++; continue; }
  if (num < ENFORCED_FROM) { grandfathered.push(file); continue; }
  offenders.push(file);
}

if (offenders.length) {
  console.error(`\nFAIL — ${offenders.length} migration(s) change the schema without reloading PostgREST's cache:\n`);
  for (const f of offenders) console.error(`  ${f}`);
  console.error(`
Add this as the last statement of each file:

    NOTIFY pgrst, 'reload schema';

Without it the column exists and the API cannot see it, which is not a
deploy-order problem that resolves itself — it persists until something else
reloads the cache. Migration 068 cost twelve hours of email logging exactly
this way.
`);
  process.exit(1);
}

assert.equal(offenders.length, 0);
console.log(`PASS ${checked} schema-changing migration(s) at or above ${String(ENFORCED_FROM).padStart(3, '0')} reload the PostgREST schema cache`);
console.log(`     ${grandfathered.length} older migration(s) predate the rule and are grandfathered, not fixed`);
console.log('\nSchema cache reload check passed.');
