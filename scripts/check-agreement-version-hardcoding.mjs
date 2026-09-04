#!/usr/bin/env node

/**
 * The required agreement version has ONE owner. No migration may hold a copy.
 *
 * WHAT THIS PREVENTS
 * Three trigger functions each hardcoded the required version:
 *
 *   guard_easer_current_agreement_online     going Online
 *   guard_dispatch_offer_easer_readiness     receiving an offer
 *   guard_booking_easer_closure_assignment   booking assignment
 *
 * Migration 066 string-replaced all three from '2026-07-13' to '2026-08-16'.
 * When the agreement moved to '2026-08-28' in application code, nothing updated
 * the database copies. The effect was exactly backwards: accepting the CURRENT
 * agreement is what locked an Easer out of every one of those three gates.
 *
 * Phillip Hawkins hit it on 2026-09-03 and emailed asking what he was missing.
 * He was missing nothing. Trapper and Travis were unaffected only because they
 * went Online before the bump and the trigger fires on the transition, so no new
 * Easer had been able to start for weeks and nobody could see why.
 *
 * Constitution Article 1 and 2: one rule, one owner. Migration 091 repointed all
 * three at public.current_required_agreement_version(), which reads the
 * published row in agreement_versions. This stops a fourth copy being written.
 *
 * Migrations at or below 091 are the history that created the problem; they have
 * already run and rewriting them changes nothing live.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = fileURLToPath(new URL('../api/migrations/', import.meta.url));
const ENFORCED_FROM = 92;

// A version literal compared against an agreement column.
const HARDCODED = /contractor_agreement_version[^;\n]{0,80}?['"]\d{4}-\d{2}-\d{2}['"]/gi;
const SINGLE_SOURCE = /current_required_agreement_version\s*\(/i;

const files = (await fs.readdir(DIR)).filter(f => f.endsWith('.sql')).sort();
const offenders = [];
let scanned = 0;
let grandfathered = 0;

for (const file of files) {
  const num = parseInt(file.slice(0, 3), 10);
  if (!Number.isFinite(num)) continue;

  const sql = await fs.readFile(path.join(DIR, file), 'utf8');
  // Comments explain the rule; they are not the rule.
  const code = sql.replace(/^\s*--.*$/gm, '');

  const hits = [...code.matchAll(HARDCODED)];
  if (!hits.length) { scanned++; continue; }

  if (num < ENFORCED_FROM) { grandfathered++; continue; }

  // A COALESCE fallback beside the real lookup is allowed: it is what keeps an
  // empty agreement_versions from locking the network out.
  if (SINGLE_SOURCE.test(code)) { scanned++; continue; }

  offenders.push({ file, sample: hits[0][0].replace(/\s+/g, ' ').slice(0, 90) });
}

if (offenders.length) {
  console.error(`\nFAIL — ${offenders.length} migration(s) hardcode the required agreement version:\n`);
  for (const o of offenders) console.error(`  ${o.file}\n      ${o.sample}`);
  console.error(`
Compare against public.current_required_agreement_version() instead:

    OR contractor_agreement_version IS DISTINCT FROM
         COALESCE(public.current_required_agreement_version(), '<today's version>')

A version pinned in a trigger is invisible to code review, drifts the moment the
agreement is bumped, and locks out every Easer holding the CURRENT agreement.
That is exactly what migration 091 had to undo.
`);
  process.exit(1);
}

console.log(`PASS no migration at or above ${ENFORCED_FROM} hardcodes the agreement version`);
console.log(`     ${scanned} migration(s) scanned, ${grandfathered} predate the rule and are grandfathered`);
console.log('\nAgreement version single-source check passed.');
