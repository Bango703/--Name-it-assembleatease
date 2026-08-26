#!/usr/bin/env node
// Status-value drift guard — catches code writing a value the database rejects.
//
// Migration 069 existed because api/assembler/apply.js started writing
// profiles.application_status = 'payment_pending' in July 2026 while the live
// database still carried a CHECK constraint that predated the value. Nothing
// failed at deploy, nothing failed in CI, and nothing failed until a real person
// tried to apply months later and got "Failed to save application."
//
// Precision is the whole point here, so the check is narrowed twice over:
//
//   - TABLE-AWARE. Matching on column name alone drowns in false positives:
//     `status` exists on bookings, profiles, payout_ledger, operations_cases and
//     easer_announcements, and they permit completely different values. Allowed
//     values are keyed by TABLE + column from `ALTER TABLE <t> ADD CONSTRAINT
//     ... CHECK (<col> IN (...))`, and code literals are attributed to a table
//     by the enclosing `.from('<table>')` chain.
//
//   - WRITE-AWARE. A bare `column: 'value'` sitting anywhere near a query is not
//     evidence of a database write — that flagged Stripe customer metadata and a
//     plain JS return object. Only the object literal actually handed to
//     .insert()/.update()/.upsert(), and .eq()/.neq() filters, are inspected.
//
// A guard that cries wolf gets ignored, which is worse than no guard. A table or
// column with no CHECK constraint in the repo gets no opinion at all.
//
// It cannot see constraints that exist only in the live database — exactly how
// 069 hid for months. It closes the gap going forward: once a constraint is
// represented in migrations, the code can never silently drift away from it.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const MIGRATIONS = join(ROOT, 'api', 'migrations');
const CODE_ROOT = join(ROOT, 'api');

function walk(dir, ext, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const entry of entries) {
    const full = join(dir, entry);
    let s;
    try { s = statSync(full); } catch { continue; }
    if (s.isDirectory()) walk(full, ext, out);
    else if (entry.endsWith(ext)) out.push(full);
  }
  return out;
}

const rel = (f) => relative(ROOT, f).replace(/\\/g, '/');
const key = (table, column) => `${table}.${column}`;

// Module-level string constants, so `application_status: APPLICATION_PAYMENT_PENDING`
// is understood as the value it actually holds. This is not a nicety: the real
// outage wrote its value through exactly such a constant, and a literal-only
// version of this script passed clean while production was broken.
function stringConstants(src) {
  const consts = new Map();
  const re = /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*'([a-z0-9_]+)'\s*;/gm;
  let m;
  while ((m = re.exec(src)) !== null) consts.set(m[1], m[2]);
  return consts;
}

// ── 1. Allowed values, keyed by table.column ─────────────────────────────────
// Later migrations replace earlier ones for the same table.column, mirroring how
// DROP CONSTRAINT / ADD CONSTRAINT actually behaves against the database.
function allowedValues() {
  const allowed = new Map();
  const stmt = /ALTER\s+TABLE\s+(?:public\.)?([a-z_][a-z0-9_]*)[\s\S]*?ADD\s+CONSTRAINT\s+[a-z_][a-z0-9_]*\s+CHECK\s*\(([\s\S]*?)\)\s*;/gi;

  for (const file of walk(MIGRATIONS, '.sql').sort()) {
    const sql = readFileSync(file, 'utf8');
    let m;
    while ((m = stmt.exec(sql)) !== null) {
      const table = m[1].toLowerCase();
      const inClause = /\b([a-z_][a-z0-9_]*)\s+IN\s*\(([^)]*)\)/gi;
      let c;
      while ((c = inClause.exec(m[2])) !== null) {
        const column = c[1].toLowerCase();
        const values = [...c[2].matchAll(/'([^']*)'/g)].map(v => v[1]);
        if (!values.length) continue;
        const k = key(table, column);
        const prior = allowed.get(k);
        if (prior && prior.file === file) values.forEach(v => prior.values.add(v));
        else allowed.set(k, { table, column, values: new Set(values), file });
      }
    }
  }
  return allowed;
}

// The object literal handed to .insert()/.update()/.upsert(), brace-balanced so
// a nested object cannot truncate it and it cannot run past the call.
function mutationPayloads(chunk) {
  const out = [];
  const call = /\.(?:insert|update|upsert)\(\s*(?:\[\s*)?\{/g;
  let m;
  while ((m = call.exec(chunk)) !== null) {
    const openAt = chunk.indexOf('{', m.index);
    let depth = 0;
    for (let i = openAt; i < chunk.length; i++) {
      if (chunk[i] === '{') depth++;
      else if (chunk[i] === '}') {
        depth--;
        if (depth === 0) { out.push(chunk.slice(openAt, i + 1)); break; }
      }
    }
  }
  return out;
}

// ── 2. Values the code writes, attributed to the table being queried ─────────
function usedValues(allowed) {
  const used = new Map();
  const wanted = new Map();
  for (const { table, column } of allowed.values()) {
    if (!wanted.has(table)) wanted.set(table, new Set());
    wanted.get(table).add(column);
  }

  for (const file of walk(CODE_ROOT, '.js')) {
    const src = readFileSync(file, 'utf8');
    const lineOf = (idx) => src.slice(0, idx).split('\n').length;
    const consts = stringConstants(src);
    const fromRe = /\.from\(\s*['"]([a-z_][a-z0-9_]*)['"]\s*\)/g;
    const marks = [];
    let f;
    while ((f = fromRe.exec(src)) !== null) marks.push({ table: f[1].toLowerCase(), start: f.index });

    for (let i = 0; i < marks.length; i++) {
      const { table, start } = marks[i];
      const columns = wanted.get(table);
      if (!columns) continue;
      const chunk = src.slice(start, i + 1 < marks.length ? marks[i + 1].start : src.length);
      const filters = (chunk.match(/\.(?:eq|neq)\([^)]*\)/g) || []).join('\n');
      const scopes = [...mutationPayloads(chunk), filters].filter(Boolean);

      for (const column of columns) {
        // Capture a quoted literal OR a bare identifier; identifiers are then
        // resolved through the module's string constants, and skipped if unknown.
        const patterns = [
          new RegExp(`\\b${column}\\s*:\\s*(?:'([a-z0-9_]+)'|([A-Za-z_$][\\w$]*))`, 'g'),
          new RegExp(`\\.(?:eq|neq)\\(\\s*'${column}'\\s*,\\s*(?:'([a-z0-9_]+)'|([A-Za-z_$][\\w$]*))\\s*\\)`, 'g'),
        ];
        for (const scope of scopes) {
          if (!scope.includes(column)) continue;
          for (const re of patterns) {
            re.lastIndex = 0;
            let m;
            while ((m = re.exec(scope)) !== null) {
              const value = m[1] || consts.get(m[2]);
              if (!value) continue; // unresolvable identifier — no opinion
              const k = key(table, column);
              if (!used.has(k)) used.set(k, new Map());
              const byValue = used.get(k);
              if (!byValue.has(value)) byValue.set(value, new Set());
              byValue.get(value).add(`${rel(file)}:${lineOf(start)}`);
            }
          }
        }
      }
    }
  }
  return used;
}

const allowed = allowedValues();
if (!allowed.size) {
  console.log('Status constraint drift: no CHECK ... IN (...) constraints found in migrations — nothing to verify.');
  process.exit(0);
}

const used = usedValues(allowed);
const violations = [];
for (const [k, { table, column, values, file }] of allowed) {
  const byValue = used.get(k);
  if (!byValue) continue;
  for (const [value, locations] of byValue) {
    if (values.has(value)) continue;
    violations.push({
      table, column, value,
      constraintFile: rel(file),
      allowed: [...values].sort(),
      locations: [...locations].sort(),
    });
  }
}

if (violations.length) {
  console.error('\nSTATUS CONSTRAINT DRIFT — code writes values the database will reject.\n');
  for (const v of violations) {
    console.error(`  ${v.table}.${v.column} = '${v.value}'  is NOT permitted`);
    console.error(`    constraint : ${v.constraintFile}`);
    console.error(`    allows     : ${v.allowed.map(x => `'${x}'`).join(', ')}`);
    console.error(`    written at : ${v.locations.join(', ')}`);
    console.error('');
  }
  console.error('Add a migration widening the constraint, or change the code to a permitted value.');
  console.error('Unfixed, this surfaces as a check-constraint violation on live user traffic.\n');
  process.exit(1);
}

const covered = [...allowed.entries()].filter(([k]) => used.has(k));
console.log(`Status constraint drift: PASS — ${covered.length} constrained column(s) verified against the code that writes them:`);
for (const [k, { values }] of covered) {
  console.log(`  ${k} → ${[...values].sort().map(v => `'${v}'`).join(', ')}`);
}
