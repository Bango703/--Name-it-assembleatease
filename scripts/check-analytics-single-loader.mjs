#!/usr/bin/env node
// One loader owns Google measurement. Nothing else may load the tag.
//
// Shared consent owns both the banner and all optional tag loading. Templates
// must not introduce independent loaders or bypass the published opt-in promise.
// No choice, decline and GPC remain unmeasured; behavioral coverage lives in
// test-organic-measurement.mjs.
//
// Article 2 (one source of truth) and Article 3 (no duplicate domain logic).

import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const OWNER = 'assets/js/cookie-consent.js';
const SKIP = new Set(['node_modules', '.git', '_prev_', '__pycache__', 'shots']);

let failures = 0;
const fail = (msg) => { failures += 1; console.log('  FAIL  ' + msg); };

async function walk(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if (/\.(html|js|mjs)$/i.test(entry.name)) out.push(full);
  }
  return out;
}

console.log('analytics single loader');

const files = await walk(ROOT);
const offenders = [];
for (const file of files) {
  const rel = relative(ROOT, file).split('\\').join('/');
  if (rel === OWNER) continue;
  if (rel.startsWith('scripts/')) continue;   // guards may name it to check for it
  const text = await readFile(file, 'utf8');
  if (text.includes('googletagmanager.com/gtag')) offenders.push(rel);
}

if (offenders.length) {
  fail('these load the Google tag directly instead of through ' + OWNER + ':');
  for (const o of offenders) console.log('          ' + o);
} else {
  console.log('  PASS  only ' + OWNER + ' loads the Google tag');
}

// Defense-in-depth defaults remain denied even after explicit tag opt-in.
const owner = await readFile(join(ROOT, OWNER), 'utf8');

const required = [
  ["gtag('consent', 'default'", 'declares Consent Mode defaults'],
  ["url_passthrough", 'passes the Google click id through navigation'],
  ["ads_data_redaction", 'redacts identifiers while consent is denied'],
];
for (const [needle, why] of required) {
  if (owner.includes(needle)) console.log('  PASS  ' + why);
  else fail(OWNER + ' no longer ' + why + ' (missing ' + needle + ')');
}

// Defaults must all start denied — the banner is meaningless otherwise.
const defaults = owner.match(/consent',\s*'default',\s*\{([\s\S]*?)\}/);
if (!defaults) fail('could not read the consent default block');
else {
  const block = defaults[1];
  for (const signal of ['analytics_storage', 'ad_storage', 'ad_user_data', 'ad_personalization']) {
    const m = block.match(new RegExp(signal + "\\s*:\\s*'(\\w+)'"));
    if (!m) fail('consent default block does not set ' + signal);
    else if (m[1] !== 'denied') fail(signal + " defaults to '" + m[1] + "', not 'denied'");
  }
  if (!failures) console.log('  PASS  all four consent signals default to denied');
}

// The shared loader must never load optional tags before an accepted choice.
if (/function loadMeasurement\(\) \{\s*if \(!analyticsAllowed\(\)\) return;/.test(owner)
    && !/loadMeasurement\(\);\s*\n\s*if \(storedConsent === 'accepted'\)/.test(owner)) {
  console.log('  PASS  optional tag loading requires accepted consent');
} else {
  fail('the tag loader must require accepted consent and honor decline/GPC');
}

console.log('');
if (failures) { console.log(failures + ' FAILED'); process.exit(1); }
console.log('all analytics loader checks passed');
