#!/usr/bin/env node

/**
 * Customer-facing copy must not read as machine-written.
 *
 * WHY THIS EXISTS
 * An em dash used as a dramatic pause is the single loudest tell that copy was
 * drafted by a model, and it had spread across the marketing surface:
 *
 *   compare-assembly-options    16.3 per 1k words
 *   become-an-easer             11.4
 *   assemblecash                11.2
 *   setup-club                  10.8
 *   smart-home-installation     8.4
 *
 * Professional marketing copy runs 1-3 per 1,000 words. The pattern was always
 * the same shape: a one-word answer, a dash, then the real sentence.
 *
 *   "Yes - our Easers arrive fully equipped."
 *   "Plans change - that's OK."
 *
 * WHAT IT DOES NOT FLAG
 * An em dash is not banned; it is correct in several places and those are
 * excluded rather than counted and forgiven:
 *
 *   - <span class="cmp-na">-</span>   the "not applicable" cell in the
 *                                     comparison table
 *   - <title>, <meta>, og:, JSON-LD   "Brand - Descriptor" is the standard
 *                                     convention in metadata
 *   - HTML comments                   invisible to a reader
 *   - <script> / <style>              not copy
 *
 * The generated city and service pages are covered at their SOURCE
 * (scripts/generate-location-pages.js, scripts/build-flagship-service-pages.mjs),
 * because editing the generated HTML is overwritten by the next build.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const MAX_PER_1K = 5;

// Hand-authored pages a customer actually reads.
const PAGES = [
  'index.html', 'about.html', 'pricing.html', 'book.html', 'bundles.html',
  'contact.html', 'business.html', 'compare-assembly-options.html',
  'assemblecash.html', 'setup-club.html', 'become-an-easer.html',
  'locations.html', 'track.html',
];

// Generators, so a fix cannot be undone by the next build.
const GENERATORS = [
  'scripts/generate-location-pages.js',
  'scripts/build-flagship-service-pages.mjs',
  'scripts/public-footer-sync.mjs',
];

function visibleCopy(html) {
  let s = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    // The comparison table's "not applicable" marker is correct typography.
    .replace(/<span class="cmp-na">(&mdash;|—)<\/span>/g, ' ')
    // Metadata conventions, not body copy.
    .replace(/<title[\s\S]*?<\/title>/gi, ' ')
    .replace(/<meta[^>]*>/gi, ' ');
  s = s.replace(/<[^>]+>/g, ' ').replace(/&mdash;/g, '—');
  return s.replace(/\s+/g, ' ').trim();
}

let worst = null;
const failures = [];

for (const page of PAGES) {
  let html;
  try { html = await fs.readFile(new URL('../' + page, import.meta.url), 'utf8'); }
  catch { continue; }
  const copy = visibleCopy(html);
  const words = copy.split(/\s+/).filter(Boolean).length;
  if (!words) continue;
  const dashes = (copy.match(/—/g) || []).length;
  const per1k = (dashes / words) * 1000;
  if (!worst || per1k > worst.per1k) worst = { page, per1k, dashes, words };
  if (per1k > MAX_PER_1K) failures.push({ page, per1k, dashes, words });
}

// The loudest single pattern, checked directly at the generators.
for (const gen of GENERATORS) {
  let src;
  try { src = await fs.readFile(new URL('../' + gen, import.meta.url), 'utf8'); }
  catch { continue; }
  const tell = src.match(/(["'`])(Yes|No|Nope) (&mdash;|—) /g) || [];
  assert.equal(tell.length, 0,
    `${gen}: ${tell.length} "Yes — ..." style answer(s). A one-word answer, a dash, then the real sentence is the loudest machine-written tell. Use a period.`);
}

if (failures.length) {
  console.error(`\nFAIL — ${failures.length} customer page(s) over ${MAX_PER_1K} em dashes per 1,000 words:\n`);
  for (const f of failures) {
    console.error(`  ${f.page.padEnd(34)} ${f.per1k.toFixed(1)} per 1k  (${f.dashes} in ${f.words} words)`);
  }
  console.error(`
An em dash used as a dramatic pause reads as machine-written. Replace with:
  a period  where it joins two complete thoughts
  a comma   where it fences an aside
  a colon   where a list or expansion follows

Correct uses are already excluded: the cmp-na table marker, metadata, HTML
comments, and script/style.
`);
  process.exit(1);
}

console.log(`PASS all ${PAGES.length} customer pages are at or under ${MAX_PER_1K} em dashes per 1,000 words`);
console.log(`     heaviest: ${worst.page} at ${worst.per1k.toFixed(1)} (${worst.dashes} in ${worst.words} words)`);
console.log(`PASS no "Yes — ..." answer patterns in the ${GENERATORS.length} page generators`);
console.log('\nEm dash density check passed.');
