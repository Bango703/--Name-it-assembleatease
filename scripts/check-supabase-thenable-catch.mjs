#!/usr/bin/env node
// Supabase query builders are THENABLES, not Promises.
//
// `sb.from('t').insert({...})` returns a builder. `.catch()` does not exist on
// it until it is awaited, so this:
//
//     await sb.from('operational_events').insert({ ... }).catch(() => {});
//
// throws `TypeError: sb.from(...).insert(...).catch is not a function` the
// moment it runs. It looks like ordinary defensive code and passes lint,
// node --check, and every test that never exercises that line.
//
// On 2026-09-09 four of these shipped in one day. The owner click-to-call
// endpoint returned HTTP 500 instead of a useful message, and the stranded-
// booking cron would have sent its alert email and then crashed before
// recording that it had — re-alerting the owner every thirty minutes forever.
//
// The correct shape is a real try/catch around an awaited call:
//
//     try { await sb.from('t').insert({ ... }); } catch { /* non-fatal */ }
//
// This finds the broken shape by walking parentheses, because these calls span
// many lines and a line-based grep cannot see them.

import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const API = join(ROOT, 'api');
const METHODS = ['insert', 'update', 'upsert', 'delete', 'select'];

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walk(full, out);
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

/** Index just past the ')' that closes the '(' at `open`. */
function closeParen(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '(') depth += 1;
    else if (src[i] === ')') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

const problems = [];

for (const file of walk(API)) {
  const src = readFileSync(file, 'utf8');
  // Only builders that actually start from a Supabase table.
  for (const m of src.matchAll(/\.from\(\s*['"`][^'"`]+['"`]\s*\)/g)) {
    let cursor = m.index + m[0].length;
    // Follow the chain of .method(...) calls after .from(...).
    for (;;) {
      const rest = src.slice(cursor);
      const next = rest.match(/^\s*\.(\w+)\s*\(/);
      if (!next) break;
      const method = next[1];
      const open = cursor + rest.indexOf('(', next.index);
      const end = closeParen(src, open);
      if (end < 0) break;

      if (method === 'catch' && METHODS.some(k => src.slice(m.index, open).includes('.' + k + '('))) {
        const line = src.slice(0, open).split('\n').length;
        problems.push(`${relative(ROOT, file).replace(/\\/g, '/')}:${line} — .catch() on a query builder`);
      }
      cursor = end;
      if (method === 'catch' || method === 'then') break;
    }
  }
}

if (problems.length) {
  console.error('FAIL  .catch() attached to a Supabase query builder:\n');
  for (const p of problems) console.error('  - ' + p);
  console.error('\n  A builder is a thenable, not a Promise — .catch() does not exist on it.');
  console.error('  Use:  try { await sb.from(...).insert({ ... }); } catch { /* non-fatal */ }');
  process.exit(1);
}

console.log('PASS  no .catch() attached directly to a Supabase query builder.');
