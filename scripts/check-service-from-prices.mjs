#!/usr/bin/env node
// "From $NN" drift guard — catches the marketing price disagreeing with the catalog.
//
// On 2026-09-07 the homepage advertised "Outdoor Assembly & Playsets — From $89"
// and "Fitness Equipment — From $119". Neither price existed. The cheapest real
// outdoor item was $109 and the cheapest real fitness item was $139, and the
// booking page said exactly that. A customer clicking the homepage card landed on
// a page quoting $20 more than the ad that brought them there.
//
// Nothing failed. No test covered it. The number was simply typed into three
// separate places — index.html, book.html, and a computed helper inside
// book.html — and two of them drifted. That is Article 2 (one source of truth)
// and Rule 9 (the customer is never surprised by price) failing quietly.
//
// The catalog is the only source of truth. Everything else is a mirror, and this
// guard proves the mirrors still match.
//
// WHAT "FROM" MEANS, precisely — the cheapest item a customer can actually book
// as a job on its own:
//
//   - addon: true       excluded. "Floor leveling / placement support" ($59) is
//                       something you add to a treadmill build, not a visit you
//                       can book by itself. Advertising "Fitness from $59" would
//                       be wrong in the opposite direction.
//   - customQuote: true excluded. Priced at 0 pending a real quote; it is not a
//                       number anyone can be held to.
//   - price <= 0        excluded for the same reason.
//
// It does NOT police whether a price is a good business decision. It only proves
// that every place quoting a starting price is quoting the same, real one.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, runInNewContext } from 'node:vm';

const ROOT = process.cwd();

/** Load the front-end catalog without trusting it with a real global scope. */
function loadCatalog() {
  const src = readFileSync(join(ROOT, 'assets', 'js', 'booking-source-of-truth.js'), 'utf8');
  const sandbox = createContext({ window: {} });
  runInNewContext(src, sandbox);
  const source = sandbox.window.AAE_BOOKING_SOURCE;
  if (!source || !source.subcategories) {
    throw new Error('booking-source-of-truth.js did not expose window.AAE_BOOKING_SOURCE.subcategories');
  }
  return source.subcategories;
}

/** Cheapest independently bookable item in a service, or null if quote-only. */
function trueFromPrice(groups) {
  let best = null;
  for (const group of groups || []) {
    for (const item of group.items || []) {
      if (item.addon || item.customQuote) continue;
      if (!(item.price > 0)) continue;
      if (best === null || item.price < best) best = item.price;
    }
  }
  return best;
}

/**
 * Pull displayed prices out of a page.
 *
 * Both pages tag each card with the catalog's own service key, so the mapping is
 * read from the markup rather than guessed from a label. The homepage links to
 * /book?service=<key> and the booking page carries data-service="<key>".
 */
function scrapeDisplayed(file, label, blockRe, keyRe, priceRe) {
  const html = readFileSync(join(ROOT, file), 'utf8');
  const found = [];
  for (const block of html.match(blockRe) || []) {
    const key = block.match(keyRe)?.[1];
    if (!key) continue;
    const service = decodeURIComponent(key.replace(/\+/g, ' ')).replace(/&amp;/g, '&').trim();
    const price = block.match(priceRe)?.[1];
    // A card that has lost its price is reported, never skipped. Silently
    // ignoring it is how the mobile grid went price-less in the first place.
    found.push({ file, label, service, shown: price ? Number(price) : null });
  }
  return found;
}

const catalog = loadCatalog();

const displayed = [
  // Homepage service cards: <a class="svc5-card" href="/book?service=..."> ... From $NN
  ...scrapeDisplayed(
    'index.html', 'desktop card',
    /<a class="svc5-card"[\s\S]*?<\/a>/g,
    /href="\/book\?service=([^"]+)"/,
    /svc5-price">From \$(\d+)</
  ),
  // Homepage mobile cards: <a href="/book?service=..." class="svc-item"> ... From $NN
  ...scrapeDisplayed(
    'index.html', 'mobile card',
    /<a href="\/book\?service=[^"]+" class="svc-item[^"]*">[\s\S]*?<\/a>/g,
    /href="\/book\?service=([^"]+)"/,
    /svc-price-badge">From \$(\d+)</
  ),
  // Booking step 1 rows: <button class="svc-row" data-service="..."> ... From $NN
  ...scrapeDisplayed(
    'book.html', 'booking row',
    /<button class="svc-row"[\s\S]*?<\/button>/g,
    /data-service="([^"]+)"/,
    /svc-row-meta">From \$(\d+)</
  ),
];

if (!displayed.length) {
  console.error('FAIL  found no "From $" service cards to check — the markup changed shape.');
  console.error('      Update the selectors in scripts/check-service-from-prices.mjs.');
  process.exit(1);
}

const problems = [];
for (const entry of displayed) {
  const where = `${entry.file} (${entry.label})`;
  if (entry.shown === null) {
    problems.push(`${where}: "${entry.service}" shows no starting price at all`);
    continue;
  }
  const groups = catalog[entry.service];
  if (!groups) {
    problems.push(`${where}: card "${entry.service}" is not a service in the catalog`);
    continue;
  }
  const truth = trueFromPrice(groups);
  if (truth === null) {
    problems.push(`${where}: "${entry.service}" shows From $${entry.shown} but has no fixed-price item (quote-only)`);
    continue;
  }
  if (entry.shown !== truth) {
    problems.push(
      `${where}: "${entry.service}" shows From $${entry.shown}, cheapest bookable item is $${truth}`
    );
  }
}

if (problems.length) {
  console.error('FAIL  advertised "From $" prices disagree with the booking catalog:\n');
  for (const p of problems) console.error('  - ' + p);
  console.error('\n  The catalog in assets/js/booking-source-of-truth.js is the source of truth.');
  console.error('  Correct the page, not the catalog, unless the price itself is meant to change.');
  process.exit(1);
}

console.log(`PASS  ${displayed.length} advertised "From $" prices match the booking catalog.`);
