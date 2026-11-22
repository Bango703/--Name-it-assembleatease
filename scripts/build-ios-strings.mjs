#!/usr/bin/env node
// Builds the Spanish String Catalogs for both iPhone apps from one dictionary,
// mobile/ios/Localization/es.json (owner, 2026-11-21: "yes spanish").
//
//   node scripts/build-ios-strings.mjs           write the four catalogs
//   node scripts/build-ios-strings.mjs --check   fail if a catalog is out of date,
//                                                a phrase has no Spanish, or a
//                                                translation's placeholders differ
//   node scripts/build-ios-strings.mjs --missing print the phrases still to translate
//
// The catalogs are generated; edit es.json, never the .xcstrings files.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { IOS_APPS, TRANSLATIONS_FILE, requiredKeys, placeholders, catalogJSON } from './lib/ios-strings.mjs';

const mode = process.argv.includes('--check') ? 'check' : process.argv.includes('--missing') ? 'missing' : 'write';
const read = (f) => readFileSync(f, 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');
const dictionary = JSON.parse(read(TRANSLATIONS_FILE));
const strings = dictionary.strings || {};
const keepEnglish = dictionary.keepEnglish || {};
const infoPlist = dictionary.infoPlist || {};

const problems = [];
const missing = new Map();
const used = new Set();

function plistUsageStrings(file) {
  const src = read(file);
  const out = [];
  for (const m of src.matchAll(/<key>(NS\w+UsageDescription)<\/key>\s*<string>([^<]*)<\/string>/g)) out.push([m[1], m[2]]);
  return out;
}

function infoPlistCatalog(entries) {
  const strings = {};
  for (const [key, english, spanish] of entries.sort(([a], [b]) => (a < b ? -1 : 1))) {
    strings[key] = {
      extractionState: 'manual',
      localizations: {
        en: { stringUnit: { state: 'translated', value: english } },
        es: { stringUnit: { state: 'translated', value: spanish } },
      },
    };
  }
  return JSON.stringify({ sourceLanguage: 'en', strings, version: '1.0' }, null, 2).replace(/"([^"\\]*(?:\\.[^"\\]*)*)": /g, '"$1" : ') + '\n';
}

const outputs = [];
for (const [app, spec] of Object.entries(IOS_APPS)) {
  const { keys, errors } = requiredKeys(app);
  problems.push(...errors.map((e) => `${spec.name}: ${e}`));
  const entries = [];
  for (const [key, where] of keys) {
    if (Object.hasOwn(keepEnglish, key)) { used.add(key); continue; }
    if (!Object.hasOwn(strings, key)) { missing.set(key, `${spec.name} ${where}`); continue; }
    used.add(key);
    const es = strings[key];
    const a = placeholders(key).join(','); const b = placeholders(es).join(',');
    if (a !== b) problems.push(`${spec.name}: placeholders differ for "${key}" (${a || 'none'}) vs "${es}" (${b || 'none'})`);
    entries.push([key, es]);
  }
  outputs.push([spec.catalog, catalogJSON(entries)]);

  const plistEntries = [];
  for (const [key, english] of plistUsageStrings(spec.infoPlist)) {
    if (!Object.hasOwn(infoPlist, english)) { missing.set(english, `${spec.name} Info.plist ${key}`); continue; }
    plistEntries.push([key, english, infoPlist[english]]);
  }
  outputs.push([spec.infoPlistCatalog, infoPlistCatalog(plistEntries)]);
}

for (const key of [...Object.keys(strings), ...Object.keys(keepEnglish)]) {
  if (!used.has(key)) problems.push(`es.json has a phrase no app shows any more: "${key}"`);
}
for (const [key, value] of Object.entries(strings)) {
  if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(value)) problems.push(`no emojis: "${value}"`);
  if (!value.trim()) problems.push(`empty translation for "${key}"`);
}

if (mode === 'missing') {
  for (const [key, where] of missing) console.log(JSON.stringify(key) + '\t' + where);
  console.error(`${missing.size} phrases without Spanish; ${problems.length} other problems`);
  for (const p of problems) console.error(p);
  process.exit(0);
}

for (const [key, where] of missing) problems.push(`no Spanish for "${key}" (${where})`);
if (mode === 'check') {
  for (const [file, content] of outputs) {
    if (!existsSync(file) || read(file) !== content) problems.push(`${file} is out of date: run node scripts/build-ios-strings.mjs`);
  }
}
if (problems.length) {
  console.error(problems.join('\n'));
  console.error(`FAIL iOS strings: ${problems.length} problem(s)`);
  process.exit(1);
}
if (mode === 'write') for (const [file, content] of outputs) writeFileSync(file, content);
const count = outputs.map(([f, c]) => `${f.split('/').slice(-3).join('/')} ${Object.keys(JSON.parse(c).strings).length}`).join(', ');
console.log(`${mode === 'check' ? 'PASS' : 'Wrote'} iOS strings: ${count}`);
