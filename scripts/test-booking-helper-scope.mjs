import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// "Can't find variable: renderSummaryDateTime" reached Live Ops as a HIGH alert.
//
// renderSummaryDateTime and renderSummaryContact were declared INSIDE
// goToStep5Payment, while saveDtEdit and saveContactEdit — the handlers that
// run when someone edits the date or the contact details on the summary step —
// are declared outside it. A function declaration is scoped to the function it
// sits in, so those handlers threw a ReferenceError the moment they ran. Two
// latent bugs; the owner happened to hit the date one.
//
// This holds the fix: a helper called from more than one scope must live at the
// top level of the page's script, where every nested caller can see it.

const html = await readFile(new URL('../book.html', import.meta.url), 'utf8');

const blocks = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
assert.ok(blocks.length, 'book.html must have an inline script');
const script = blocks.reduce((a, b) => (b.length > a.length ? b : a), '');

// Brace depth at a point, ignoring comments and string literals. Indentation in
// this file is inconsistent, so it cannot be used to judge scope.
function depthAt(index) {
  let src = script.slice(0, index);
  src = src.replace(/\/\*[\s\S]*?\*\//g, '');
  src = src.replace(/\/\/[^\n]*/g, '');
  const quote = String.fromCharCode(39);
  const dq = String.fromCharCode(34);
  const bt = String.fromCharCode(96);
  for (const q of [quote, dq, bt]) {
    const re = new RegExp(q + '(?:\\\\.|[^' + q + '\\\\])*' + q, 'g');
    src = src.replace(re, q + q);
  }
  let depth = 0;
  for (const ch of src) {
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
  }
  return depth;
}

// Helpers used by more than one scope. Each must be reachable from all of them.
const SHARED_HELPERS = ['renderSummaryContact', 'renderSummaryDateTime'];

for (const name of SHARED_HELPERS) {
  const decl = script.match(new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\('));
  assert.ok(decl, `${name} must exist in book.html's main script`);
  assert.equal(depthAt(decl.index), 0,
    `${name} is declared inside another function, so callers in other scopes throw a ReferenceError. `
    + 'Move it to the top level of the script.');

  // And it is genuinely called from more than one place, or it would not need
  // to be out here.
  const calls = [...script.matchAll(new RegExp('\\b' + name + '\\s*\\(', 'g'))].length;
  assert.ok(calls >= 3, `${name} should have a declaration plus at least two call sites; found ${calls}`);
}

console.log(`booking helper scope: PASS — ${SHARED_HELPERS.length} shared summary helpers are reachable from every caller`);
