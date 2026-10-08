#!/usr/bin/env node
// Search Console audit, 2026-09-29. Each check below is a finding that cost
// the site search visibility, held shut so it cannot come back quietly.
//
// - Every Easer job posting carried validThrough 2026-11-06, baked into a
//   static page, so all 55 would have expired from Google on one day. They
//   also shared one title (Google recognized 1 of 55) and used a
//   jobLocationType value Google does not accept.
// - Google indexed "/book?bundle='+encodeURIComponent(b.slug)+'" because a
//   link template sat in inline JavaScript as a literal href.
// - City service pages were 92-94% word-identical; Google crawled several and
//   declined to index them. Non-Austin pages now carry Census housing facts.
// - Service pages shifted 0.27-0.31 CLS when DM Serif Display / DM Sans
//   swapped in. Stylesheets now define metric-matched fallback faces.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';

const read = (f) => readFileSync(f, 'utf8');
const html = readdirSync('.').filter((f) => f.endsWith('.html'));
let checks = 0;

function jsonLd(text) {
  return [...text.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
}

// 1. Job postings: no expiry date, valid location fields, one title per page.
const jobPages = html.filter((f) => f.startsWith('easer-jobs-')).concat('become-an-easer.html');
const titles = new Map();
for (const f of jobPages) {
  const postings = jsonLd(read(f)).filter((j) => j['@type'] === 'JobPosting');
  assert.equal(postings.length, 1, `${f}: expected one JobPosting`);
  const j = postings[0];
  assert.ok(!('validThrough' in j), `${f}: validThrough on a static page expires the posting`);
  assert.ok(!('jobLocationType' in j) || j.jobLocationType === 'TELECOMMUTE', `${f}: jobLocationType only accepts TELECOMMUTE`);
  assert.ok(!('applicantLocationRequirements' in j) || j.jobLocationType === 'TELECOMMUTE', `${f}: applicantLocationRequirements is for remote roles`);
  assert.ok(!titles.has(j.title), `${f}: duplicate JobPosting title "${j.title}" (also ${titles.get(j.title)})`);
  titles.set(j.title, f);
  checks++;
}
const gen = read('scripts/generate-easer-recruit-pages.js');
assert.ok(!/^\s*validThrough\s*:/m.test(gen) && !/^\s*jobLocationType\s*:/m.test(gen), 'Easer page generator reintroduces expiry or invalid location type');

// 2. No link template literal inside inline scripts.
for (const f of html) {
  assert.ok(!/href="\/book\?bundle='\s*\+/.test(read(f)), `${f}: href template in inline JS is crawled as a URL`);
}
checks++;

// 3. Every non-Austin city service page carries its Census housing facts.
const housing = JSON.parse(read('scripts/lib/city-housing.json'));
const servicePrefixes = ['furniture-assembly', 'tv-mounting', 'smart-home-installation', 'fitness-equipment-assembly', 'office-furniture-assembly', 'playset-assembly'];
let cityPages = 0;
for (const slug of Object.keys(housing.cities)) {
  if (slug === 'austin') continue;
  for (const prefix of servicePrefixes) {
    const f = `${prefix}-${slug}-tx.html`;
    if (!existsSync(f)) continue;
    const t = read(f);
    assert.ok(t.includes('Local homes:</strong>'), `${f}: missing local housing facts`);
    assert.ok(t.includes(`${housing.cities[slug].medianYearBuilt}`), `${f}: housing facts do not match city-housing.json`);
    cityPages++;
  }
}
assert.ok(cityPages >= 300, `expected 300+ city service pages with housing facts, found ${cityPages}`);
checks++;

// 4. Metric-matched fallback faces exist and every stack that names a web font names its fallback.
for (const css of ['assets/css/marketing.css', 'assets/css/style.css']) {
  const t = read(css);
  assert.ok(t.includes("font-family:'DM Serif Display Fallback'") && t.includes("font-family:'DM Sans Fallback'"), `${css}: fallback @font-face missing`);
}
for (const f of [...html, 'assets/css/marketing.css', 'assets/css/style.css']) {
  const t = read(f);
  for (const m of t.matchAll(/(['"])(DM Serif Display|DM Sans)\1\s*,(?!\s*\1?\2 Fallback)/g)) {
    // Stripe Elements renders inside its own iframe; the fallback face cannot apply there.
    const around = t.slice(Math.max(0, m.index - 40), m.index);
    if (/fontFamily\s*:\s*'?$/.test(around)) continue;
    assert.fail(`${f}: "${m[2]}" stack without its metric-matched fallback`);
  }
}
// The fallback only belongs where the web font is actually loaded. The Easer
// app never loads DM Sans, so a sized-up Arial there replaced the system font
// and grew every line of the dashboard (2026-09-29).
for (const [css, pages] of [['assets/css/easer.css', ['assembler/index.html', 'assembler/my-assignments.html', 'assembler/payouts.html', 'assembler/profile.html']]]) {
  const loadsWebFont = pages.some((p) => /fonts\.googleapis\.com\/css2/.test(read(p)));
  if (!loadsWebFont) assert.ok(!read(css).includes('DM Sans Fallback'), `${css}: fallback face on pages that never load DM Sans changes their font`);
}
// An @import after any other rule is ignored by the browser. Inserting the
// faces above style.css's font @import silently dropped the web fonts from
// the booking page (2026-09-29).
for (const css of readdirSync('assets/css').filter((f) => f.endsWith('.css')).map((f) => `assets/css/${f}`)) {
  const body = read(css).replace(/^﻿/, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const firstImport = body.indexOf('@import');
  if (firstImport === -1) continue;
  const before = body.slice(0, firstImport).replace(/@charset[^;]*;/, '').trim();
  assert.equal(before, '', `${css}: @import must come before every other rule or the browser ignores it`);
}
checks++;

// 5. Service photos ship responsive WebP with reserved dimensions.
const variants = JSON.parse(read('scripts/lib/service-image-variants.json'));
for (const [src, v] of Object.entries(variants)) {
  for (const w of v.variants) {
    const webp = `images/${src.replace(/\.(jpe?g|png)$/i, '')}-${w}.webp`;
    assert.ok(existsSync(webp), `missing ${webp}`);
  }
}
const tv = read('tv-mounting-austin-tx.html');
assert.match(tv, /<picture><source type="image\/webp" srcset="\/images\/real-tv-mount-console-640\.webp 640w/, 'hero photo is not served as responsive WebP');
assert.match(tv, /<img src="\/images\/real-tv-mount-console\.jpg"[^>]* width="\d+" height="\d+"/, 'hero photo has no reserved dimensions');
checks++;

console.log(`PASS Search Console findings: ${checks} guards (job postings ${jobPages.length}, city pages ${cityPages}).`);
