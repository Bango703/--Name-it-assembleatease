#!/usr/bin/env node
// Every price a customer is quoted comes from one list.
//
// assets/js/booking-source-of-truth.js is that list, and api/_pricing.js reads
// the same file, so the browser and the server cannot disagree. The exception
// is scripts/generate-location-pages.js, which writes two add-on prices into
// FAQ prose by hand. Those went stale the moment the menu changed and nothing
// noticed, because prose is not arithmetic.
//
// This file keeps the prose honest and pins the two add-ons that were raised
// off the floor they were under: masonry work needs a hammer drill, bits and
// anchors, and an above-fireplace mount is the hardest job on the menu —
// height, heat, stone, ladder work and cable routing.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = name => readFile(new URL('../' + name, import.meta.url), 'utf8');
const catalog = await read('assets/js/booking-source-of-truth.js');

function addonPrice(name) {
  const row = catalog.match(new RegExp(`\\{ name: '${name}', price: (\\d+)`));
  assert.ok(row, `${name} must still exist in the catalog`);
  return Number(row[1]);
}

const masonry = addonPrice('Brick or concrete wall');
const fireplace = addonPrice('Above fireplace mount');
const tile = addonPrice('Tile wall');
const steelStud = addonPrice('Steel stud / metal framing');

// ── The raise holds ─────────────────────────────────────────────────────────
assert.equal(masonry, 110, 'brick or concrete is a $110 add-on');
assert.equal(fireplace, 175, 'above fireplace is a $175 add-on');

// ── And the menu still ranks by difficulty ──────────────────────────────────
// A customer reading the list has to see the harder job cost more. If tile
// ever outprices masonry, or masonry outprices a fireplace mount, the menu is
// telling them something untrue about the work.
assert.ok(fireplace > masonry, 'a fireplace mount is harder than plain masonry and must cost more');
assert.ok(masonry > tile, 'masonry is harder than tile');
assert.ok(tile > steelStud, 'tile is harder than steel stud');

// ── The prose agrees with the list ──────────────────────────────────────────
// Two prices are written by hand into generated-page FAQs. A customer who
// reads "$85" on a city page and is charged $175 at checkout has been quoted
// a price that was not real.
const generator = await read('scripts/generate-location-pages.js');
assert.ok(generator.includes(`a $${fireplace} add-on for the extra height`),
  `the fireplace FAQ must quote $${fireplace}, not a stale figure`);
assert.ok(generator.includes(`Brick/concrete is a $${masonry} add-on, tile is $${tile}, and steel stud framing is $${steelStud}`),
  'the wall-type FAQ must quote the live prices for all three surfaces');

// The old numbers must not survive anywhere in that file.
for (const stale of ['$85 add-on', '$75 add-on']) {
  assert.ok(!generator.includes(stale), `the generator still quotes ${stale}`);
}

// ── The server reads the same file, not a copy ──────────────────────────────
// A second hardcoded price list is how the checkout total and the menu drift
// apart, and the customer is charged something the page never showed.
const pricing = await read('api/_pricing.js');
assert.match(pricing, /booking-source-of-truth\.js/,
  'the server must read the catalog rather than keep its own prices');
assert.ok(!/Above fireplace mount'\s*,\s*price:/.test(pricing),
  'the server must not declare its own copy of an add-on price');

console.log(`PASS mounting add-on pricing: masonry $${masonry}, fireplace $${fireplace}, menu ranks by difficulty, and the FAQ prose matches`);
