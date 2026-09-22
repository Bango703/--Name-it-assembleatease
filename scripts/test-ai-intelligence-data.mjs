#!/usr/bin/env node
// The AI Intelligence panel must advise on real customers, not on staff tests.
//
// Run on 2026-09-22, the briefing opened with "completion rate critically low
// at 27%... this is revenue death" and named the single most important action
// as investigating ten cancellations. Six of those ten were the owner's own
// test bookings, every one of them cancelled. It also called Furniture Assembly
// "your strongest service" at 7 bookings — one was real and six were tests. The
// true picture was 9 bookings, 4 cancellations, 50% of finished jobs completed.
//
// The same run announced "Net revenue sits at $315.62 — that's 24.5% going to
// payment processing, which is high." Stripe took 2.9%. The model had been
// handed `grossRevenueDollars`, `stripeFeeDollars` and `netRevenueDollars` and
// filled in the relationship itself, because nothing told it that the gap is
// the Easers' pay.
//
// migration 094 made is_test_booking the one definition of test data; the
// finance ledger, financial dashboard and Easer earnings already honour it.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const monitor = await readFile(new URL('../api/owner/monitor.js', import.meta.url), 'utf8');

// ── 1. Test bookings never reach the model ──────────────────────────────────
assert.match(monitor, /const bookings = allBookingRows\.filter\(booking => booking\.is_test_booking !== true\)/,
  'the analysed set excludes the owner test bookings');
assert.match(monitor, /excludedOwnerTestBookings: testBookingCount/,
  'and says how many it left out, rather than dropping them silently');
// Everything downstream must read the filtered list, not the raw rows.
const rawUses = [...monitor.matchAll(/allBookingRows/g)].length;
assert.equal(rawUses, 3, `allBookingRows is used only to filter and count (found ${rawUses} uses)`);

// ── 2. The money figures say what they are ──────────────────────────────────
for (const field of ['customerMoneyCollectedDollars', 'stripeProcessingFeesDollars', 'platformNetDollars']) {
  assert.ok(monitor.includes(field), `${field} is named for what it holds`);
}
// As field names, not as the comment explaining why they were renamed.
assert.doesNotMatch(monitor, /(grossRevenueDollars|netRevenueDollars|stripeFeeDollars)\s*[:.]/,
  'the names that invited "net = gross minus fees" are gone');
assert.match(monitor, /platformNetDollars: what AssembleAtEase keeps after paying the Easers/,
  'the prompt defines the figures so the model never has to guess a relationship');
assert.match(monitor, /Do not derive a ratio, percentage or trend that is\s*\n\s*not in the data/,
  'and is told not to invent one');

// ── 3. Completion rate counts finished jobs, not future ones ────────────────
assert.match(monitor, /completionRateOfFinishedJobs/,
  'the rate is named for what it measures');
assert.match(monitor, /completed\.length \/ \(completed\.length \+ cancelled\.length\)/,
  'a job scheduled for next week is not counted as a failure today');
assert.doesNotMatch(monitor, /completed\.length \/ bookings\.length/);

// ── 4. The fallback still prints real values when the model is down ─────────
// This briefing is the owner's only output if Anthropic is unreachable, so a
// renamed field must not leave it printing "$undefined".
const fallback = monitor.slice(monitor.indexOf("'REVENUE:',"), monitor.indexOf("'ACTION:',"));
for (const reference of fallback.match(/platformData\.financials\.([a-zA-Z]+)/g) || []) {
  const field = reference.split('.').pop();
  assert.ok(monitor.includes(`${field}:`), `fallback prints ${field}, which must exist in platformData`);
}

// ── 5. One AI surface for the owner, not two ────────────────────────────────
// api/owner/ai.js was a second owner-facing assistant with a weaker prompt and
// no platform data. Nothing called it; it is gone (Article 3).
let deadEndpointExists = true;
try {
  await readFile(new URL('../api/owner/ai.js', import.meta.url), 'utf8');
} catch {
  deadEndpointExists = false;
}
assert.equal(deadEndpointExists, false, 'the unreferenced duplicate AI endpoint stays deleted');

const dashboard = await readFile(new URL('../owner/index.html', import.meta.url), 'utf8');
assert.match(dashboard, /fetch\('\/api\/owner\/monitor'/, 'Ask the AI posts to the one surface that has the data');
assert.doesNotMatch(dashboard, /\/api\/owner\/ai\b/, 'and nothing points at the removed one');

console.log('AI intelligence data tests: PASS');
