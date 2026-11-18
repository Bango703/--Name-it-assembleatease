#!/usr/bin/env node
// The website's copy of the auto-dispatch area (assets/js/booking-source-of-truth.js)
// must equal the server's (api/_source-of-truth.js). 2026-10-15: San Antonio was
// added to the server on 2026-09-23 and never to the website copy.
// 2026-11-18: Greater Houston (770-775) joined automatic dispatch; the website's
// Houston zone list must equal HOUSTON_MARKET_ZIP_PREFIXES and SERVICE_MARKETS.houston.
import assert from 'node:assert/strict';
import {
  AUTOMATIC_DISPATCH_ZIP_PREFIXES, AUTOMATIC_DISPATCH_ZIPS, HOUSTON_MARKET_ZIP_PREFIXES, SERVICE_MARKETS,
  SERVICE_CALL_ZONES, getServiceCallZone, isAutomaticDispatchZip, isSameServiceMarket,
} from '../api/_source-of-truth.js';
import { getBookingCatalog } from '../api/_pricing.js';

const area = getBookingCatalog().serviceArea || {};
const sorted = list => [...(list || [])].sort();
assert.deepEqual(sorted(area.zipPrefixes), sorted(AUTOMATIC_DISPATCH_ZIP_PREFIXES), 'website and server auto-dispatch prefixes match');
assert.deepEqual(sorted(area.zipCodes), sorted(AUTOMATIC_DISPATCH_ZIPS), 'website and server auto-dispatch ZIPs match');
assert.deepEqual(sorted(area.houstonZipPrefixes), sorted(HOUSTON_MARKET_ZIP_PREFIXES), 'website and server Houston zone prefixes match');
assert.deepEqual(sorted(SERVICE_MARKETS.houston), sorted(HOUSTON_MARKET_ZIP_PREFIXES), 'the Houston market and the Houston dispatch list are one list');
for (const prefix of HOUSTON_MARKET_ZIP_PREFIXES) {
  assert.ok(AUTOMATIC_DISPATCH_ZIP_PREFIXES.includes(prefix), `Houston prefix ${prefix} dispatches automatically`);
}

// Greater Houston communities: automatic, Houston zone, Houston market only.
const greaterHouston = {
  Houston: '77002', Katy: '77494', Spring: '77389', Cypress: '77433', 'The Woodlands': '77380',
  Conroe: '77301', 'Sugar Land': '77479', Pearland: '77584', 'League City': '77573',
  Pasadena: '77506', Baytown: '77520', Galveston: '77550',
};
for (const [name, zip] of Object.entries(greaterHouston)) {
  assert.equal(isAutomaticDispatchZip(zip), true, `${name} ${zip} dispatches automatically`);
  assert.equal(getServiceCallZone(zip), 'houston_metro', `${name} ${zip} is in the Greater Houston zone`);
  assert.equal(isSameServiceMarket(zip, '77002'), true, `${name} ${zip} is offered to Houston-market Easers`);
  assert.equal(isSameServiceMarket(zip, '78701'), false, `${name} ${zip} is never offered to an Austin Easer`);
}
assert.equal(SERVICE_CALL_ZONES.houston_metro.label, 'Greater Houston', 'Houston is never labelled as Central Texas');
assert.equal(SERVICE_CALL_ZONES.houston_metro.fee, SERVICE_CALL_ZONES.texas_statewide.fee, 'Houston keeps the same service-call fee');

// Austin and San Antonio are unchanged; places outside every open market still wait for the owner.
assert.equal(getServiceCallZone('78701'), 'austin_core');
assert.equal(getServiceCallZone('78660'), 'near_suburb');
assert.equal(getServiceCallZone('78205'), 'near_suburb');
for (const zip of ['78040', '75201', '76102', '79401', '77801', '77833']) {
  assert.equal(isAutomaticDispatchZip(zip), false, `${zip} is outside automatic dispatch`);
  assert.equal(getServiceCallZone(zip), 'texas_statewide', `${zip} stays statewide`);
}

console.log(`PASS dispatch area parity: ${AUTOMATIC_DISPATCH_ZIP_PREFIXES.length} prefixes and ${AUTOMATIC_DISPATCH_ZIPS.length} ZIPs identical on website and server; Greater Houston automatic and Houston-only; Austin, San Antonio and statewide unchanged.`);
