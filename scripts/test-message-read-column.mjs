#!/usr/bin/env node

/**
 * Marking a message read must not fail on a column a trigger expects.
 *
 * Every mark-as-read on public.messages failed with:
 *
 *   record "new" has no field "updated_at"
 *
 * A BEFORE UPDATE trigger assigned NEW.updated_at; the table had no such
 * column. Postgres raised before the row was written, so the write NEVER
 * succeeded — not once — and the unread badge could never clear.
 *
 * It looked cosmetic because the handler treats the read-state write as
 * non-fatal on purpose: the thread still loads. So the owner saw the same toast
 * for weeks and nothing behind it ever changed.
 *
 * NO MIGRATION CREATED THAT TRIGGER. It was added by hand in Supabase, which is
 * exactly the blind spot Article 7 names: a trigger that lives only in the
 * database is invisible to review, to tests, and to every guard here.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const migration = await fs.readFile(new URL('../api/migrations/087_messages_updated_at.sql', import.meta.url), 'utf8');
const handler = await fs.readFile(new URL('../api/booking/message.js', import.meta.url), 'utf8');

// ── The column the trigger needs is now version-controlled ─────────────────
{
  assert.ok(/ALTER TABLE public\.messages[\s\S]{0,120}ADD COLUMN IF NOT EXISTS updated_at/.test(migration),
    'messages.updated_at must exist in a migration, not only in someone\'s Supabase session');
  assert.ok(migration.includes('SET updated_at = created_at'),
    'existing rows must be backfilled honestly — nothing has ever been updated, because every update failed');
  assert.ok(migration.includes('FROM pg_trigger t'),
    'the migration must surface WHICH trigger did this, since it exists nowhere in this repo');
  console.log('PASS the column a hand-made trigger depends on is now in version control');
}

// ── The owner is not shown raw Postgres ────────────────────────────────────
// `record "new" has no field "updated_at"` is true and unactionable. It reads
// like corrupt data rather than an outstanding migration (Article 16: never
// show a raw parser error to the owner).
{
  assert.ok(handler.includes('has no field "?updated_at"?'),
    'the known cause must be recognised and translated');
  assert.ok(/migration 087 is applied|migration 087 is not|until migration 087/i.test(handler),
    'the translation must name the actual fix');
  assert.ok(/Your messages are safe and nothing was lost/.test(handler),
    'the owner must be told their data is fine — a database error implies otherwise');
  assert.ok(handler.includes('console.error'),
    'the raw text must still reach the log, where it is useful');

  // Anything unrecognised still passes through rather than being swallowed or
  // replaced with a guess.
  assert.ok(/: raw\)/.test(handler) || /: raw;/.test(handler),
    'an unrecognised database error must still surface its real text');
  console.log('PASS the owner gets a cause they can act on, and the log keeps the raw one');
}

console.log('\nMessage read-column tests passed.');
