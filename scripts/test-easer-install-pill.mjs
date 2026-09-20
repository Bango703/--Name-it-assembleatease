import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

// The "Install app" pill (assets/js/app.js) is fixed above every layer on
// Easer routes. Nothing told it to step aside, so on a phone it sat on top of
// Accept and Decline in the job sheet. easer.css now hides it while a sheet or
// the job modal is open. This test keeps every Easer dialog inside that rule,
// so a new dialog cannot quietly bring the overlap back.

const root = new URL('../', import.meta.url);
const read = rel => readFile(new URL(rel, root), 'utf8');

const appJs = await read('assets/js/app.js');
assert.match(appJs, /pill\.id = 'aae-install-pill'/, 'the pill keeps the id the stylesheet targets');
assert.match(appJs, /location\.pathname\.indexOf\('\/assembler'\) !== 0\) return;/,
  'the pill only runs on Easer routes, which all style dialogs from easer.css');

const css = await read('assets/css/easer.css');
const rule = css.match(/body:has\(([^)]*)\)\s*#aae-install-pill\s*\{([^}]*)\}/);
assert.ok(rule, 'easer.css must hide the install pill while a dialog is open');
assert.match(rule[2], /display:\s*none\s*!important/, "the rule must beat the pill's inline display:flex");
const coveredClasses = rule[1].split(',').map(selector => {
  const match = selector.trim().match(/^\.([\w-]+)\.open$/);
  assert.ok(match, `unexpected selector in the install-pill rule: ${selector}`);
  return match[1];
});

// Both covered overlays must really use .open as their visible state.
assert.match(css, /\.sheet-overlay\.open\s*\{/, 'sheet overlays open with .open');
const assignments = await read('assembler/my-assignments.html');
assert.match(assignments, /\.modal-overlay\.open\s*\{/, 'the job modal opens with .open');
assert.match(assignments, /modal\.classList\.add\('open'\)/, 'the job modal is opened by adding .open');

let dialogs = 0;
const pages = (await readdir(new URL('assembler/', root))).filter(file => file.endsWith('.html'));
for (const file of pages) {
  const html = await read(`assembler/${file}`);
  if (!/assets\/js\/app\.js/.test(html)) continue; // no pill on this page
  for (const tag of html.match(/<[a-z]+\b[^>]*\brole="dialog"[^>]*>/g) || []) {
    dialogs += 1;
    const classes = ((tag.match(/\bclass="([^"]*)"/) || [])[1] || '').split(/\s+/);
    assert.ok(classes.some(name => coveredClasses.includes(name)),
      `assembler/${file}: ${tag} is a dialog the install pill would cover; give it a covered overlay class`);
    assert.match(html, /<link rel="stylesheet" href="\.\.\/assets\/css\/easer\.css"/,
      `assembler/${file} must load easer.css so the rule applies`);
  }
}
assert.ok(dialogs >= 7, `expected to find the Easer dialogs (found ${dialogs})`);

console.log(`Easer install pill tests: PASS (${dialogs} dialogs covered)`);
