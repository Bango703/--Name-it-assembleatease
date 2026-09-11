#!/usr/bin/env node
// An Easer must never be offered a job in another market.
//
// WHAT WAS TRUE BEFORE. Dispatch rewarded a ZIP match in scoring (+75) but never
// required one, and the comment in _dispatch-internal.js justified that with
// "every launch Easer serves the one Central Texas market". That was accurate
// when it was written. It is not any more: there are active, available,
// identity-verified Easers in Lubbock (79413), Houston (77002) and San Antonio
// (78006). The only thing standing between a Lubbock booking and an Austin Pro
// was isAutomaticDispatchZip being Austin-only — a second, unrelated control.
//
// WHY THAT MATTERED. Lubbock is the largest single source of real demand in the
// platform's history: four bookings, $1,635.66, including the biggest completed
// job ever ($648.42, done by the Lubbock Easer). Three of those four were lost
// because far-market bookings have no dispatch path. Opening that market means
// widening auto-dispatch, and widening auto-dispatch without a hard market gate
// would blast a Lubbock job to Austin.
//
// WHAT THIS LOCKS. Central Texas keeps spanning 786 AND 787 — Travis is 78660
// (786) and real bookings came from 78759 (787) and 78642 (786), so a naive
// prefix-equality gate would break the one market that works. And an unknown ZIP
// must fail OPEN, so a mistyped or unrecognised ZIP degrades to the old
// behaviour instead of silently dispatching to nobody.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  SERVICE_MARKETS,
  marketForZip,
  isSameServiceMarket,
} from '../api/_source-of-truth.js';

let failures = 0;
const check = (label, fn) => {
  try {
    fn();
    console.log('  PASS  ' + label);
  } catch (err) {
    failures += 1;
    console.log('  FAIL  ' + label + '\n        ' + (err && err.message));
  }
};

console.log('dispatch market gate');

// ── The market that already works must keep working ────────────────────────
check('Austin 787 booking still reaches the 786 Easer (Travis, 78660)', () => {
  assert.equal(isSameServiceMarket('78759', '78660'), true);
});
check('Liberty Hill 78642 still reaches the 786 Easer', () => {
  assert.equal(isSameServiceMarket('78642', '78660'), true);
});
check('Central Texas spans both 786 and 787', () => {
  assert.deepEqual([...SERVICE_MARKETS.central_texas].sort(), ['786', '787']);
});

// ── The incident this exists to prevent ────────────────────────────────────
check('a Lubbock booking is NOT offered to the Austin Easer', () => {
  assert.equal(isSameServiceMarket('79424', '78660'), false);
});
check('a Lubbock booking IS offered to the Lubbock Easer (79413)', () => {
  assert.equal(isSameServiceMarket('79424', '79413'), true);
});
check('a Houston booking is NOT offered to the Austin Easer', () => {
  assert.equal(isSameServiceMarket('77002', '78660'), false);
});
check('a San Antonio booking is NOT offered to the Austin Easer', () => {
  assert.equal(isSameServiceMarket('78006', '78660'), false);
});
check('a Houston booking IS offered to the Houston Easer (77002)', () => {
  assert.equal(isSameServiceMarket('77099', '77002'), true);
});

// ── Fail open, never closed ────────────────────────────────────────────────
check('an unknown booking ZIP fails OPEN', () => {
  assert.equal(isSameServiceMarket('99999', '78660'), true);
});
check('a missing Easer ZIP fails OPEN', () => {
  assert.equal(isSameServiceMarket('78759', null), true);
  assert.equal(isSameServiceMarket('78759', ''), true);
});
check('a malformed ZIP maps to no market', () => {
  assert.equal(marketForZip('787'), null);
  assert.equal(marketForZip('not-a-zip'), null);
  assert.equal(marketForZip(null), null);
});

// ── The gate is actually wired in, not just exported ───────────────────────
const dispatchSrc = await readFile(new URL('../api/booking/_dispatch-internal.js', import.meta.url), 'utf8');
check('dispatch imports isSameServiceMarket', () => {
  assert.ok(
    /import\s*\{[^}]*isSameServiceMarket[^}]*\}\s*from\s*'\.\.\/_source-of-truth\.js'/.test(dispatchSrc),
    'isSameServiceMarket is not imported from the source of truth',
  );
});
check('dispatch REJECTS an out-of-market Easer (not merely scores them lower)', () => {
  assert.ok(
    dispatchSrc.includes('if (!isSameServiceMarket(bookingZip, easer.zip)) return false;'),
    'the eligibility filter does not reject out-of-market Easers',
  );
});
check('the market gate is not re-derived from city names anywhere in dispatch', () => {
  assert.ok(
    !/easer\.city\s*===\s*booking/i.test(dispatchSrc),
    'dispatch compares city names, which drift',
  );
});

// ── Markets must not overlap, or a ZIP would belong to two ─────────────────
check('no ZIP prefix belongs to two markets', () => {
  const seen = new Map();
  for (const [market, prefixes] of Object.entries(SERVICE_MARKETS)) {
    for (const p of prefixes) {
      if (seen.has(p)) {
        throw new Error(`prefix ${p} is in both ${seen.get(p)} and ${market}`);
      }
      seen.set(p, market);
    }
  }
});

console.log('');
if (failures) {
  console.log(failures + ' FAILED');
  process.exit(1);
}
console.log('all dispatch market gate checks passed');
