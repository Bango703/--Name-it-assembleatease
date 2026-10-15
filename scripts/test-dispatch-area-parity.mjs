#!/usr/bin/env node
// The website's copy of the auto-dispatch area (assets/js/booking-source-of-truth.js)
// must equal the server's (api/_source-of-truth.js). 2026-10-15: San Antonio was
// added to the server on 2026-09-23 and never to the website copy.
import assert from 'node:assert/strict';
import { AUTOMATIC_DISPATCH_ZIP_PREFIXES, AUTOMATIC_DISPATCH_ZIPS } from '../api/_source-of-truth.js';
import { getBookingCatalog } from '../api/_pricing.js';

const area = getBookingCatalog().serviceArea || {};
const sorted = list => [...(list || [])].sort();
assert.deepEqual(sorted(area.zipPrefixes), sorted(AUTOMATIC_DISPATCH_ZIP_PREFIXES), 'website and server auto-dispatch prefixes match');
assert.deepEqual(sorted(area.zipCodes), sorted(AUTOMATIC_DISPATCH_ZIPS), 'website and server auto-dispatch ZIPs match');
console.log(`PASS dispatch area parity: ${AUTOMATIC_DISPATCH_ZIP_PREFIXES.length} prefixes and ${AUTOMATIC_DISPATCH_ZIPS.length} ZIPs identical on website and server.`);
