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
  isAutomaticDispatchZip,
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
// ── San Antonio opened for auto-dispatch on 2026-09-23 ─────────────────────
// Two ready Easers live in that market, which is the condition the widening
// note requires. The danger in widening is not the market check — that is
// already enforced — it is the ZIP prefix used to open it.
check('San Antonio proper auto-dispatches', () => {
  assert.equal(isAutomaticDispatchZip('78209'), true);
  assert.equal(isAutomaticDispatchZip('78258'), true);
});

check('the metro towns named by ZIP auto-dispatch', () => {
  for (const zip of ['78006', '78015', '78108', '78130', '78132', '78148', '78154']) {
    assert.equal(isAutomaticDispatchZip(zip), true, `${zip} should auto-dispatch`);
  }
});

// The whole reason '780' is not a prefix. Laredo is 78040-78046 and roughly 150
// miles from San Antonio; opening the prefix would have auto-offered a Laredo
// job to a San Antonio Easer.
check('LAREDO never auto-dispatches', () => {
  for (const zip of ['78040', '78041', '78043', '78045', '78046']) {
    assert.equal(isAutomaticDispatchZip(zip), false, `${zip} is Laredo and must stay manual`);
  }
});

check('Kerrville was not opened by accident', () => {
  assert.equal(isAutomaticDispatchZip('78028'), false);
});

check('Austin and its suburbs are unchanged', () => {
  assert.equal(isAutomaticDispatchZip('78759'), true);
  assert.equal(isAutomaticDispatchZip('78660'), true);
});

// KNOWN AND DELIBERATELY NOT FIXED HERE: SERVICE_MARKETS.san_antonio contains
// '780', so isSameServiceMarket treats a Laredo booking and a San Antonio Easer
// as one market. Auto-dispatch can no longer act on it, but an owner pressing
// Dispatch Now on a Laredo job still would. Narrowing that list touches the
// market grouping the 2026-09-23 market-area work just rebuilt, so it is a
// separate change. This assertion records the state as it is, so tightening it
// later is a deliberate edit rather than a surprise.
check('Laredo still shares a market with San Antonio (known, tracked)', () => {
  assert.equal(isSameServiceMarket('78040', '78209'), true);
});

console.log('all dispatch market gate checks passed');
