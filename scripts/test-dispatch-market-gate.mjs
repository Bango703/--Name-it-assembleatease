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
// prefix-equality gate would break the one market that works.
//
// CHANGED 2026-11-21. The gate used to fail OPEN on an unknown ZIP. Tyler (757)
// and Killeen (765) had no market, so the Whitehouse and Harker Heights Easers
// were offered every job in Texas, including a Houston job 166 miles away. Every
// Texas ZIP now has a market, eligibility is distance (serviceAreaCheck: home
// ZIP within the Easer's travel distance), and anything that cannot be placed
// on the map fails CLOSED: the job waits for the owner, never goes statewide.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  SERVICE_MARKETS,
  marketForZip,
  isSameServiceMarket,
  isAutomaticDispatchZip,
  serviceAreaCheck,
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
  assert.equal(serviceAreaCheck('78759', { zip: '78660' }).ok, true);
});
check('Liberty Hill 78642 still reaches the 786 Easer', () => {
  assert.equal(isSameServiceMarket('78642', '78660'), true);
  assert.equal(serviceAreaCheck('78642', { zip: '78660' }).ok, true);
});
check('Central Texas spans 786 and 787 (and the Austin IRS ZIPs, 733)', () => {
  assert.deepEqual([...SERVICE_MARKETS.central_texas].sort(), ['733', '786', '787']);
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

// ── Fail closed, never statewide ───────────────────────────────────────────
check('an unknown booking ZIP matches no Easer', () => {
  assert.equal(isSameServiceMarket('99999', '78660'), false);
  assert.equal(serviceAreaCheck('99999', { zip: '78660' }).reason, 'job_location_unknown');
});
check('a missing Easer ZIP matches no job', () => {
  assert.equal(isSameServiceMarket('78759', null), false);
  assert.equal(isSameServiceMarket('78759', ''), false);
  assert.equal(serviceAreaCheck('78759', { zip: null }).reason, 'easer_location_unknown');
  assert.equal(serviceAreaCheck('78759', { zip: '' }).ok, false);
});
check('the two Easers who had no market are no longer offered far jobs', () => {
  assert.equal(serviceAreaCheck('77018', { zip: '75791' }).ok, false, 'Whitehouse is 166 miles from Houston');
  assert.equal(serviceAreaCheck('75701', { zip: '75791' }).ok, true, 'Whitehouse to Tyler is 8 miles');
  assert.equal(serviceAreaCheck('78701', { zip: '76548' }).ok, false, 'Harker Heights is 55 miles from Austin');
  assert.equal(serviceAreaCheck('76502', { zip: '76548' }).ok, true, 'Harker Heights to Temple is 14 miles');
});
check('every Texas ZIP prefix is in a market', () => {
  const missing = [];
  for (let p = 750; p <= 799; p += 1) if (!marketForZip(`${p}01`)) missing.push(p);
  for (const zip of ['73301', '88510']) if (!marketForZip(zip)) missing.push(zip);
  assert.deepEqual(missing, []);
});
check('a malformed ZIP maps to no market', () => {
  assert.equal(marketForZip('787'), null);
  assert.equal(marketForZip('not-a-zip'), null);
  assert.equal(marketForZip(null), null);
});

// ── The gate is actually wired in, not just exported ───────────────────────
const dispatchSrc = await readFile(new URL('../api/booking/_dispatch-internal.js', import.meta.url), 'utf8');
check('dispatch imports serviceAreaCheck from the source of truth', () => {
  assert.ok(
    /import\s*\{[^}]*serviceAreaCheck[^}]*\}\s*from\s*'\.\.\/_source-of-truth\.js'/.test(dispatchSrc),
    'serviceAreaCheck is not imported from the source of truth',
  );
  assert.ok(!/isSameServiceMarket/.test(dispatchSrc), 'dispatch must not decide offers by market');
});
check('dispatch REJECTS an out-of-range Easer (not merely scores them lower)', () => {
  assert.ok(
    dispatchSrc.includes('area: serviceAreaCheck(bookingZip, { zip: easer.zip, travel_radius_miles: radii.get(easer.id) }),'),
    'the eligibility filter does not check the travel distance',
  );
  assert.ok(
    dispatchSrc.includes('let eligible = areaChecks.filter(({ area }) => area.ok)'),
    'the eligibility filter does not reject out-of-range Easers',
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

// SERVICE_MARKETS.san_antonio contains '780', so Laredo still REPORTS in the
// San Antonio market. It no longer matters for offers: since 2026-11-21 an
// offer needs the Easer within their travel distance, and Laredo is 150 miles
// from San Antonio, so even an owner pressing Dispatch Now cannot send it there.
check('Laredo reports in the San Antonio market but is never offered to a San Antonio Easer', () => {
  assert.equal(isSameServiceMarket('78040', '78209'), true);
  assert.equal(serviceAreaCheck('78040', { zip: '78209' }).ok, false);
  assert.equal(serviceAreaCheck('78040', { zip: '78209', travel_radius_miles: 75 }).ok, false);
});

// Found in the live test of AAE-DMA4UGNPV2 (2026-11-13): customer-app bookings
// keep the street address without city or ZIP. Dispatch read only the address,
// found no ZIP, and the gate failed open: a San Antonio job could go to any
// Easer in Texas. The stored service ZIP now decides.
{
  const { bookingLocation } = await import('../api/booking/_dispatch-internal.js');
  const appBooking = { address: '7906 Headwaters Trail, 4101', service_zip: '78254', service_city: 'San Antonio' };
  const where = bookingLocation(appBooking);
  check('an app booking is placed by its stored ZIP, not its address text', () => {
    assert.equal(where.zip, '78254');
    assert.equal(where.city, 'San Antonio');
    assert.equal(serviceAreaCheck(where.zip, { zip: '78701' }).ok, false, 'an Austin Easer is not offered a San Antonio job');
    assert.equal(serviceAreaCheck(where.zip, { zip: '78209' }).ok, true);
  });
  check('a website booking with the ZIP in the address still works', () => {
    assert.equal(bookingLocation({ address: '100 Congress Ave, Austin, TX 78701' }).zip, '78701');
  });
  const dispatchSrc = (await readFile(new URL('../api/booking/_dispatch-internal.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  check('every dispatch read of the job ZIP goes through bookingLocation', () => {
    assert.doesNotMatch(dispatchSrc, /bookingZip\s*=\s*extractZip\(/);
    assert.match(dispatchSrc, /const \{ city: bookingCity, zip: bookingZip \} = bookingLocation\(booking\);/);
    assert.match(dispatchSrc, /const bookingZip = bookingLocation\(booking\)\.zip;/);
  });
}

{
  const editSrc = (await readFile(new URL('../api/owner/edit-booking.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  check('editing an address moves the stored ZIP and city with it, and needs a ZIP', () => {
    assert.match(editSrc, /nextLocation = parseServiceLocation\(\{ address \}\);/);
    assert.match(editSrc, /if \(!nextLocation\.zip\) \{\n\s+return res\.status\(400\)/);
    assert.match(editSrc, /updates\.service_zip = nextLocation\.zip;/);
    assert.match(editSrc, /updates\.service_city = nextLocation\.city \|\| null;/);
  });
}

console.log('all dispatch market gate checks passed');
