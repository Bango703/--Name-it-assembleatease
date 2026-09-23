import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { EASER_READINESS_FIELDS } from '../api/_easer-readiness-select.js';
import { EASER_SUPPLY_SELECT } from '../api/owner/market-demand.js';

// getEaserReadiness reads its fields off the profile row it is HANDED. It never
// refetches. So a caller that forgets a column does not get an error — it gets a
// requirement silently computed as UNMET.
//
// That is what happened: api/owner/live-ops.js did not select sms_consent_at, so
// Live Ops reported every Easer as blocked on "Job texts enabled" regardless of
// their actual consent, while _dispatch-internal.js and assign.js (which do
// select it) saw the truth. Four alerts, none of them verified.
//
// This test keeps the readiness module and every caller's SELECT in step.

const ROOT = new URL('../', import.meta.url);
const read = rel => readFile(new URL(rel, ROOT), 'utf8');

// ── What readiness actually reads ──────────────────────────────────────────
const readinessSrc = await read('api/_easer-readiness.js');
const readColumns = new Set(
  [...readinessSrc.matchAll(/\bprofile\.([a-z_]+)/g)].map(m => m[1]),
);
// Read through helpers rather than `profile.` directly.
readColumns.add('account_closure_status');
for (const rel of ['api/_easer-application-fee.js', 'api/_easer-closure.js']) {
  const helper = await read(rel);
  for (const match of helper.matchAll(/\bprofile\.([a-z_]+)/g)) readColumns.add(match[1]);
}
assert.deepEqual([...readColumns].filter(column => !EASER_READINESS_FIELDS.includes(column)), [],
  'The canonical narrow readiness projection must cover every dependency, including delegated fee/closure fields');
assert.deepEqual(EASER_READINESS_FIELDS.filter(column => !EASER_SUPPLY_SELECT.split(',').map(v => v.trim()).includes(column)), [],
  'Constant-based market supply SELECT must include the complete readiness projection');

assert.ok(readColumns.has('sms_consent_at'), 'sanity: readiness reads sms_consent_at');
assert.ok(readColumns.size > 15, `sanity: expected a real column list, got ${readColumns.size}`);

// Columns a caller may legitimately omit, with the reason it is safe.
const OPTIONAL = new Map([
  // Connect columns drive the payout-setup nudge, not job readiness.
  ['stripe_connect_account_id', 'payout nudge only, never blocks job offers'],
  // Legacy alias still read alongside application_fee_paid.
  ['payment_confirmed', 'legacy alias; application_fee_paid is the current column'],
]);

// ── Every caller that loads profiles for readiness ─────────────────────────
async function walk(dir, acc = []) {
  for (const entry of await readdir(new URL(dir, ROOT), { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const rel = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) await walk(rel + '/', acc);
    else if (entry.name.endsWith('.js')) acc.push(rel);
  }
  return acc;
}

// ── The shared projection must carry everything readiness reads ────────────
// api/_easer-readiness-select.js is the canonical column list for callers that
// cannot load a whole profile. It is the right answer to this class of bug —
// one list, imported — and it only works while it stays in parity with the
// module that consumes it.
const { EASER_READINESS_FIELDS: READINESS_FIELDS } = await import('../api/_easer-readiness-select.js');
{
  const shared = new Set(READINESS_FIELDS);
  const absent = [...readColumns].filter(col => !shared.has(col) && !OPTIONAL.has(col));
  assert.deepEqual(absent, [],
    `EASER_READINESS_FIELDS is missing ${absent.join(', ')} — every caller using it computes that requirement as UNMET.`);
}

const files = await walk('api/');
const failures = [];

for (const rel of files) {
  if (rel === 'api/_easer-readiness.js') continue;
  const src = await read(rel);
  if (!src.includes('getEaserReadiness')) continue;

  // Every candidate column list in the file, however it is written.
  //
  // The first version of this test only matched a string literal sitting
  // directly after .from('profiles'). api/owner/market-demand.js builds its
  // projection as a named constant and passes the table as a variable, so it
  // was invisible here — and it was missing sms_consent_at, which is exactly
  // the bug this test exists to catch. Found by a reviewer, not by the test.
  const selects = [
    // .select('a, b, c') anywhere in the file
    ...[...src.matchAll(/\.select\(\s*(['"`])([\s\S]*?)\1/g)].map(m => m[2]),
    // const NAME = 'a, b, c'  /  const NAME = ['a','b'].join(', ')
    ...[...src.matchAll(/const\s+\w*SELECT\w*\s*=\s*\[([\s\S]*?)\]\s*\.join/g)].map(m => m[1]),
    ...[...src.matchAll(/const\s+\w*SELECT\w*\s*=\s*(['"`])([\s\S]*?)\1/g)].map(m => m[2]),
  ].map(chunk => chunk
    // A spread of the shared projection contributes every field it holds.
    .replace(/\.\.\.EASER_READINESS_FIELDS/g, READINESS_FIELDS.join(', '))
    .replace(/['"`\n]/g, ' '));
  if (!selects.length) continue;

  // Only projections that are plainly of a PROFILE. Matching every .select( in
  // the file flagged api/booking/_crew.js, which selects from booking_crew and
  // is handed a readiness result as an argument — it never loads a profile at
  // all. A profile projection names several readiness columns; a booking or
  // crew projection names none.
  const profileSelects = selects.filter((chunk) => {
    const cols = new Set(chunk.split(',').map(s => s.trim()));
    return [...readColumns].filter(col => cols.has(col)).length >= 3;
  });
  if (!profileSelects.length) continue;

  // The widest is the one that feeds readiness; narrow ones (an id-only
  // existence check, a candidate prefilter) are not readiness rows.
  const widest = profileSelects.reduce((a, b) => (b.length > a.length ? b : a), '');
  if (widest.includes('*')) continue;

  const selected = new Set(widest.split(',').map(s => s.trim()));
  const missing = [...readColumns]
    .filter(col => !selected.has(col) && !OPTIONAL.has(col));

  if (missing.length) {
    failures.push(`${rel}: readiness reads ${missing.join(', ')}, but the profiles SELECT omits ${missing.length === 1 ? 'it' : 'them'} — that requirement computes as UNMET, silently.`);
  }
}

assert.deepEqual(failures, [], `\n${failures.join('\n')}\n`);

// ── The specific regression ────────────────────────────────────────────────
const liveOps = await read('api/owner/live-ops.js');
for (const col of ['sms_consent_at', 'sms_opted_out_at']) {
  assert.ok(
    new RegExp(`from\\(\\s*['"]profiles['"][\\s\\S]{0,2000}${col}`).test(liveOps),
    `Live Ops must select ${col} or it reports every Easer as blocked on job texts`,
  );
}

console.log(`readiness SELECT parity: PASS — ${readColumns.size} readiness columns checked against every caller`);
