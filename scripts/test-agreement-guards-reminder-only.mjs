#!/usr/bin/env node
// Owner decision: a newer contractor agreement is a reminder to sign, never a
// gate on jobs. Migration 115 removed the version comparison from the three Easer
// job guards; migration 120 then recreated the assignment guard from an older
// body and the owner could not assign Thomas (signed 2026-08-28) a job
// (2026-10-28, fixed by 123). Replays the migrations in order and fails if any
// guard ends up comparing agreement versions again.
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

const GUARDS = [
  'guard_easer_current_agreement_online',
  'guard_booking_easer_closure_assignment',
  'guard_dispatch_offer_easer_readiness',
];
const COMPARES_VERSION = /contractor_agreement_version\s+IS\s+DISTINCT\s+FROM/i;
const SIGNED_CHECK = /contractor_agreement_signed_at\s+IS\s+NULL/i;
const PATCH_LOOP = /regexp_replace\(\s*v_definition\s*,\s*v_pattern\s*,\s*'FALSE'/;

const dir = new URL('../api/migrations/', import.meta.url);
const files = (await readdir(dir)).filter(f => /^\d+_.*\.sql$/.test(f) && !/DIAGNOSE/i.test(f))
  .sort((a, b) => parseInt(a, 10) - parseInt(b, 10) || a.localeCompare(b));

// Each CREATE OR REPLACE body, from its opening dollar tag to the matching close.
function definitions(sql, name) {
  const out = [];
  const start = new RegExp(String.raw`CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.${name}\s*\(\s*\)`, 'gi');
  let m;
  while ((m = start.exec(sql))) {
    const rest = sql.slice(m.index);
    const tag = rest.match(/\bAS\s+(\$[A-Za-z_]*\$)/i);
    assert.ok(tag, `${name}: no dollar-quoted body after ${m.index}`);
    const open = tag.index + tag[0].length;
    const close = rest.indexOf(tag[1], open);
    assert.ok(close > open, `${name}: unterminated body`);
    out.push(rest.slice(open, close));
  }
  return out;
}

const state = Object.fromEntries(GUARDS.map(g => [g, null]));
for (const file of files) {
  const sql = (await readFile(new URL(file, dir), 'utf8')).replace(/\r\n/g, '\n');
  for (const guard of GUARDS) {
    for (const body of definitions(sql, guard)) {
      state[guard] = { file, compares: COMPARES_VERSION.test(body), signed: SIGNED_CHECK.test(body) };
    }
    if (PATCH_LOOP.test(sql) && sql.includes(`'${guard}'`) && state[guard]) {
      state[guard] = { ...state[guard], file, compares: false };
    }
  }
}

for (const guard of GUARDS) {
  const s = state[guard];
  assert.ok(s, `${guard} is defined by a migration`);
  assert.equal(s.compares, false,
    `${guard} compares the agreement version after ${s.file}; add a patch like migration 123 so an older signed agreement only prompts the Easer`);
  assert.equal(s.signed, true, `${guard} still requires a signed agreement (last set by ${s.file})`);
  console.log(`PASS ${guard}: signed agreement required, version is a reminder (last set by ${s.file})`);
}

// The reminder itself stays: the Easer is still asked to sign the update.
const assignments = await readFile(new URL('../api/booking/my-assignments.js', import.meta.url), 'utf8');
assert.match(assignments, /'agreement_update_available'/, 'Easers are still prompted to sign the updated agreement');
console.log('PASS Easers on an older agreement are prompted to sign, not blocked');

console.log('\nAgreement guard tests passed.');
