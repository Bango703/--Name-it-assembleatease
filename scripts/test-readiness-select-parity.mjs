import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

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

const files = await walk('api/');
const failures = [];

for (const rel of files) {
  if (rel === 'api/_easer-readiness.js') continue;
  const src = await read(rel);
  if (!src.includes('getEaserReadiness')) continue;

  // Each profiles SELECT in this file. A caller may also hand readiness a row
  // fetched elsewhere; those selects live in the file that fetched it.
  const selects = [...src.matchAll(/from\(\s*['"]profiles['"]\s*\)\s*(?:\r?\n\s*)*\.select\(\s*(['"`])([\s\S]*?)\1/g)]
    .map(m => m[2]);
  if (!selects.length) continue;

  // The widest select in the file is the one that feeds readiness; narrow ones
  // (an id-only existence check, a candidate prefilter) are not readiness rows.
  const widest = selects.reduce((a, b) => (b.length > a.length ? b : a), '');
  if (widest.includes('*')) continue;
  if (widest.split(',').length < 8) continue;

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
