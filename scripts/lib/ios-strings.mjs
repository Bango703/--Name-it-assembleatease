// The words the two iPhone apps show, read from their Swift source, and the keys
// iOS looks them up by in a String Catalog (Localizable.xcstrings).
//
// A phrase is translated when it reaches the screen through SwiftUI's own text
// parameters (Text("..."), Button("..."), ...) or through String(localized: "...").
// Everything else in the source (API fields, codes, server text, messages a person
// sends to someone else) stays as written.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const IOS_APPS = {
  easer: {
    name: 'Easer',
    dirs: ['mobile/ios/App/App', 'mobile/ios/Shared'],
    catalog: 'mobile/ios/App/App/Localizable.xcstrings',
    infoPlistCatalog: 'mobile/ios/App/App/InfoPlist.xcstrings',
    infoPlist: 'mobile/ios/App/App/Info.plist',
  },
  customer: {
    name: 'Customer',
    dirs: ['mobile/ios/Customer/Customer', 'mobile/ios/Shared'],
    catalog: 'mobile/ios/Customer/Customer/Localizable.xcstrings',
    infoPlistCatalog: 'mobile/ios/Customer/Customer/InfoPlist.xcstrings',
    infoPlist: 'mobile/ios/Customer/Support/Info.plist',
  },
};

export const TRANSLATIONS_FILE = 'mobile/ios/Localization/es.json';

// SwiftUI parameters that take a LocalizedStringKey as their first argument.
const LSK_CALLS = new Set(['Text', 'Button', 'Label', 'Section', 'TextField', 'SecureField', 'Toggle', 'Picker',
  'DatePicker', 'LabeledContent', 'ContentUnavailableView', 'NavigationLink', 'Link', 'Menu', 'Stepper',
  'ProgressView', 'Marker', '.navigationTitle', '.confirmationDialog', '.alert', '.accessibilityLabel', '.accessibilityHint']);

// Phrases kept as English data and shown through `.localizedDisplay` (a help topic the
// server receives in English, an enum's raw value). Each must still be translated.
export const DISPLAYED_DATA = {
  easer: ['Offers', 'Upcoming', 'Past', 'Problem with the job', "I can't make this job", "Customer isn't here",
    'Safety concern', 'Something else', 'Emergency', 'Vehicle issue', 'Running too late', 'Schedule conflict', 'Other'],
  customer: [],
};

// What each interpolated expression is, which decides its placeholder in the key:
// Int is %lld, Double %lf, everything else (String) %@. An expression not listed
// fails the build of the catalog until it is added here.
const INT_EXPRESSIONS = new Set([
  'radius', 'miles', 'wait', 'minutes', 'minutes / 60', 'minutes % 60', 'remaining', 'index + 1', 'strikesAdded',
  'strikesBefore', 'windowDays', 'pauseAtStrikes', 'itemCount', 'remainingPhotoCount', 'standing.strikes',
  'standing.windowDays', 'standing.pauseAtStrikes', 'job.crewSize', 'info.qualifyingJobs', 'info.windowDays',
  'rows.count', 'all.count', 'bundle.included.count', 'store.unreadCount', 'progress.step + 1',
  'progress.steps.count', 'left / 60', 'star', 'rating', 'work.count - 1', 'flow.itemCount',
  'job.completedJobs ?? 0', 'store.profile?.completedJobs ?? 0', 'photos.count', 'limit', 'jobs', 'index', 'review.rating',
]);
const STRING_EXPRESSION = [
  /^Format\./, /^wholeDollars\(/, /^String\(/, /\.joined\(/, /\?\? (String\(localized: )?"/, /^Site\./,
  /\? "[^"]*" : "[^"]*"$/, /\.trimmingCharacters\(/, /^\[.*\]\.compactMap/,
];
const STRING_NAMES = new Set([
  'email', 'sentTo', 'legalName', 'missing', 'clean', 'name', 'plural', 'before', 'opens', 'pay', 'who', 'recipient',
  'trimmed', 'through', 'short', 'build', 'card.brandName', 'card.last4', 'card.expiry', 'quote.easerFirstName',
  'detail.ref', 'done.ref', 'flow.email', 'cleanEmail', 'offer.code', 'customerFirstName', 'job.when', 'title',
  'bundle.name', 'progress.steps[progress.step]', 'area.homeZip ?? ""', 'project', 'access', 'ratingText',
  'Self.dayNames[day.key] ?? day.key',
]);

export function placeholderFor(expr) {
  const e = expr.trim();
  if (INT_EXPRESSIONS.has(e)) return '%lld';
  if (STRING_NAMES.has(e) || STRING_EXPRESSION.some((r) => r.test(e))) return '%@';
  return null;
}

function readString(src, i) {
  i++;
  const parts = [];
  let text = '';
  while (i < src.length) {
    const c = src[i];
    if (c === '\\' && src[i + 1] === '(') {
      let depth = 1; let j = i + 2; let expr = '';
      while (j < src.length && depth > 0) {
        const d = src[j];
        if (d === '"') { const r = readString(src, j); expr += src.slice(j, r.end); j = r.end; continue; }
        if (d === '(') depth++;
        if (d === ')') { depth--; if (depth === 0) break; }
        expr += d; j++;
      }
      parts.push({ text }); text = '';
      parts.push({ expr });
      i = j + 1;
      continue;
    }
    if (c === '\\') {
      const n = src[i + 1];
      if (n === 'u' && src[i + 2] === '{') {
        const close = src.indexOf('}', i);
        text += String.fromCodePoint(parseInt(src.slice(i + 3, close), 16));
        i = close + 1;
        continue;
      }
      text += ({ n: '\n', t: '\t', '"': '"', '\\': '\\', "'": "'", '0': '\0' })[n] ?? n;
      i += 2;
      continue;
    }
    if (c === '"') { i++; break; }
    text += c; i++;
  }
  parts.push({ text });
  return { end: i, parts };
}

function literals(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2) + 2; continue; }
    if (src.startsWith('"""', i)) { i = src.indexOf('"""', i + 3) + 3; continue; }
    if (c === '"') { const r = readString(src, i); out.push({ start: i, end: r.end, parts: r.parts }); i = r.end; continue; }
    i++;
  }
  return out;
}

// Nested literals inside an interpolation, e.g. the fallback in "\(name ?? String(localized: "you"))".
function nestedLiterals(parts) {
  const found = [];
  for (const p of parts) {
    if (p.expr === undefined) continue;
    for (const lit of literals(p.expr)) {
      const before = p.expr.slice(0, lit.start);
      if (/String\(localized:\s*$/.test(before)) found.push(lit.parts);
      found.push(...nestedLiterals(lit.parts));
    }
  }
  return found;
}

/** The key iOS looks a literal up by, or { error } when an interpolation's type is unknown. */
export function keyFor(parts) {
  const hasArgs = parts.some((p) => p.expr !== undefined);
  let key = '';
  for (const p of parts) {
    if (p.expr !== undefined) {
      const ph = placeholderFor(p.expr);
      if (!ph) return { error: `unknown interpolation type: \\(${p.expr})` };
      key += ph;
    } else {
      key += hasArgs ? p.text.replace(/%/g, '%%') : p.text;
    }
  }
  return { key };
}

const read = (f) => readFileSync(f, 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');

/** Every key an app needs translated, with where each one is used. */
export function requiredKeys(app, root = '.') {
  const keys = new Map();
  const errors = [];
  const add = (parts, where) => {
    const plain = parts.filter((p) => p.expr === undefined).map((p) => p.text).join('');
    if (!/[A-Za-z]{2,}/.test(plain)) return;
    const r = keyFor(parts);
    if (r.error) { errors.push(`${where}: ${r.error}`); return; }
    if (!keys.has(r.key)) keys.set(r.key, where);
  };
  for (const dir of IOS_APPS[app].dirs) {
    for (const file of readdirSync(join(root, dir)).filter((f) => f.endsWith('.swift')).sort()) {
      const src = read(join(root, dir, file));
      for (const lit of literals(src)) {
        const before = src.slice(Math.max(0, lit.start - 80), lit.start);
        const where = `${dir.split('/').pop()}/${file}:${src.slice(0, lit.start).split('\n').length}`;
        for (const nested of nestedLiterals(lit.parts)) add(nested, where);
        if (/String\(localized:\s*$/.test(before)) { add(lit.parts, where); continue; }
        const call = before.match(/([A-Za-z_.]+)\(\s*(?:[a-zA-Z]+:\s*)?$/);
        if ((call && LSK_CALLS.has(call[1])) || /prompt:\s*$/.test(before)) add(lit.parts, where);
      }
    }
  }
  for (const phrase of DISPLAYED_DATA[app]) if (!keys.has(phrase)) keys.set(phrase, 'displayed data');
  return { keys, errors };
}

/** Placeholders in a format string, in argument order (positional ones sorted by position). */
export function placeholders(format) {
  const found = [];
  const re = /%(?:(\d+)\$)?(lld|lf|@|d|f)|%%/g;
  let m; let next = 1;
  while ((m = re.exec(format))) {
    if (m[0] === '%%') continue;
    const pos = m[1] ? Number(m[1]) : next++;
    found.push({ pos, type: m[2] });
  }
  return found.sort((a, b) => a.pos - b.pos).map((p) => `${p.pos}:${p.type}`);
}

/** Apple's String Catalog JSON, keys sorted, in Xcode's own formatting. */
export function catalogJSON(entries) {
  const strings = {};
  for (const [key, value] of [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    strings[key] = {
      extractionState: 'manual',
      localizations: { es: { stringUnit: { state: 'translated', value } } },
    };
  }
  const json = JSON.stringify({ sourceLanguage: 'en', strings, version: '1.0' }, null, 2);
  return json.replace(/"([^"\\]*(?:\\.[^"\\]*)*)": /g, '"$1" : ') + '\n';
}

/** Swift source with String(localized: "x") read as "x", for tests that check wiring by text. */
export const unwrapLocalized = (source) => source.replace(/String\(localized: ("(?:[^"\\\n]|\\.)*")\)/g, '$1');
