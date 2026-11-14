#!/usr/bin/env node
// Market Demand trend (owner console, 2026-11-13): demand signals and bookings
// per Central-time month, built on the server from the same signals as the
// totals, so the months add up to Demand Signals and Recorded Bookings.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildDemandTrend } from '../api/owner/market-demand.js';

const signals = [
  { recordType: 'booking', createdAt: '2026-11-01T03:00:00Z' }, // Oct 31 evening in Austin
  { recordType: 'request', createdAt: '2026-11-05T15:00:00Z' },
  { recordType: 'booking', createdAt: '2026-11-06T15:00:00Z' },
  { recordType: 'request', createdAt: null },
];
const trend = buildDemandTrend(signals);
assert.deepEqual(trend, [
  { month: '2026-10', demandSignals: 1, bookings: 1 },
  { month: '2026-11', demandSignals: 2, bookings: 1 },
  { month: null, demandSignals: 1, bookings: 0 },
]);
const total = (key) => trend.reduce((sum, m) => sum + m[key], 0);
assert.equal(total('demandSignals'), signals.length);
assert.equal(total('bookings'), signals.filter(s => s.recordType === 'booking').length);

const api = readFileSync(new URL('../api/owner/market-demand.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
assert.match(api, /const trend = buildDemandTrend\(demandSignals\);/, 'built from the same signals as Demand Signals');
assert.match(api, /    trend,\n    summary: \{/);
console.log('PASS demand trend: Central-time months that add up to demand signals and bookings.');
