import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

// Two mistakes were each made in several places on 2026-09-22, found one at a
// time, and fixed one at a time. Nothing stopped the next one. This is the
// nothing.
//
//   1. Telling the owner a job "needs manual assignment" while reading only the
//      flag. needs_manual_dispatch can be true on a booking that already has an
//      Easer — expire-offers sets it after max attempts and a live offer stays
//      acceptable afterwards — so the flag alone is not the question. Wrong in
//      the booking card, the dispatch-log label, and the Market Demand count.
//
//   2. Painting a count badge as empty when its fetch FAILED. A hidden badge
//      reads as "nothing needs you", which is a claim the failure could not
//      support. Wrong in Cases, Easer applications, waitlist and market demand.
//      Live Ops had it right and printed "!".

const ROOT = new URL('../', import.meta.url);
const read = rel => readFile(new URL(rel, ROOT), 'utf8');

async function walk(dir, exts, acc = []) {
  for (const entry of await readdir(new URL(dir, ROOT), { withFileTypes: true })) {
    if (['node_modules', '.git', '_local_artifacts', 'output'].includes(entry.name)) continue;
    const rel = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) await walk(rel + '/', exts, acc);
    else if (exts.some(x => entry.name.endsWith(x))) acc.push(rel);
  }
  return acc;
}

const failures = [];

// ── 1. "Needs manual assignment" must never be said from the flag alone ────
// The claim is what is guarded, not the column. A gate that refuses to dispatch
// a flagged booking is correct without assembler_id; a sentence telling a human
// the job is unassigned is not.
const WINDOW = 420;
const CLAIM = /needs?\s+manual\s+assignment/i;

for (const rel of await walk('api/', ['.js'])) {
  const src = await read(rel);
  for (const match of src.matchAll(/needs?\s+manual\s+assignment/gi)) {
    const from = Math.max(0, match.index - WINDOW);
    const context = src.slice(from, match.index + WINDOW);
    // A comment describing the rule is not a claim made to anyone.
    const line = src.slice(src.lastIndexOf('\n', match.index) + 1, src.indexOf('\n', match.index));
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
    if (!/needs_manual_dispatch|needsManualDispatch/.test(context)) continue;
    if (/assembler_id|assemblerId/.test(context)) continue;
    failures.push(`${rel}: says "${match[0]}" from the flag without checking assembler_id. A job with an Easer on it is not waiting to be assigned.`);
  }
}

for (const rel of await walk('owner/', ['.html', '.js'])) {
  const src = await read(rel);
  for (const match of src.matchAll(/Needs?\s+[Mm]anual\s+[Aa]ssignment/g)) {
    const from = Math.max(0, match.index - WINDOW);
    const context = src.slice(from, match.index + WINDOW);
    if (!/needs_manual_dispatch/.test(context)) continue;
    if (/assembler_id/.test(context)) continue;
    failures.push(`${rel}: renders "${match[0]}" without checking assembler_id in the same expression.`);
  }
}

// The Market Demand count pairs them upstream, when the signal is built, rather
// than at the point of counting. Assert the pairing exists where it lives.
{
  const demand = await read('api/owner/market-demand.js');
  assert.match(demand, /needsManualDispatch: booking\.needs_manual_dispatch === true && !booking\.assembler_id/,
    'the demand signal must bake the assignment check in, since the count reads the signal');
}

// ── 2. A count that could not load must not render as zero ─────────────────
{
  const ownerUi = await read('owner/index.html');
  assert.match(ownerUi, /function navBadgeUnknown/,
    'the owner board needs one place that renders "count unknown"');
  assert.match(ownerUi, /el\.textContent = '!'/,
    'an unknown count shows a mark, not an empty space');
  assert.match(ownerUi, /this is not a count of zero/i,
    'and says so on hover, because a bare "!" is not an explanation');

  // Each badge fetch must treat a non-2xx as a failure rather than parsing it
  // as data, and must land in the unknown state.
  for (const badge of ['nav-pending-apps', 'nav-waitlist', 'nav-market-demand']) {
    const at = ownerUi.indexOf(`navBadgeUnknown('${badge}'`);
    assert.ok(at > 0, `${badge} must have an unknown state on failure`);
  }
  assert.equal((ownerUi.match(/if \(!r\.ok\) throw new Error\('unavailable'\)/g) || []).length, 3,
    'all three badge fetches must reject a non-2xx instead of reading it as a count');

  const cases = await read('owner/assets/cases.js');
  assert.match(cases, /badge\.textContent = '!'/,
    'the Cases badge must show unknown on failure, not hide');
  assert.doesNotMatch(cases, /catch \(error\) \{\s*badge\.style\.display = 'none';\s*\}/,
    'hiding the Cases badge on failure is the bug this guards');
}

assert.deepEqual(failures, [], `\n${failures.join('\n')}\n`);

console.log('owner truth guards: PASS — no unassigned claim from the flag alone, no failed count shown as zero');
