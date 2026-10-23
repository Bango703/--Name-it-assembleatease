#!/usr/bin/env node
// Review thank-you reward (owner, 2026-10-19): $10 off one future booking of
// $100 or more after an honest review on our own site, any rating. One code per
// booking reviewed, tied to the customer's email, single use, platform-funded.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  isReviewRewardCode, createReviewRewardCode, REVIEW_REWARD_DISCOUNT_CENTS, REVIEW_REWARD_MINIMUM_CENTS,
} from '../api/_review-rewards.js';
import { computeBookingSplitFromSnapshot } from '../api/_source-of-truth.js';

const read = rel => readFile(new URL(`../${rel}`, import.meta.url), 'utf8').then(s => s.replace(/\r\n/g, '\n'));

// ── The offer ───────────────────────────────────────────────────────────────
assert.equal(REVIEW_REWARD_DISCOUNT_CENTS, 1000);
assert.equal(REVIEW_REWARD_MINIMUM_CENTS, 10000);
const code = createReviewRewardCode();
assert.ok(isReviewRewardCode(code), 'generated codes are valid');
assert.ok(!isReviewRewardCode('AAE10-123'), 'short codes are refused');
assert.notEqual(code, createReviewRewardCode(), 'codes are random');
console.log('PASS the offer: $10 off a $100+ booking, random single-use codes');

// ── Any rating qualifies; only the website review is rewarded ───────────────
// The offer and its terms are shown on /review before submitting. The request
// email is a plain personal note (owner, 2026-10-23: it was landing in Promotions)
// and does not pitch the reward.
const reviewPage = await read('review.html');
assert.match(reviewPage, /Any rating qualifies\./, 'the reward never depends on the rating');
assert.match(reviewPage, /Google reviews are optional and not rewarded/, 'Google reviews are never incentivized');
const email = await read('api/_review-email.js');
assert.doesNotMatch(email, /\$10|thank-you offer|<img/, 'the request email carries no offer or images');
assert.doesNotMatch(email, /&#9733;|starRow/, 'no star grid');
// Owner, 2026-10-23: customer email speaks as the business, never as one person.
assert.doesNotMatch(email, /Travis|I will|I would/, 'the review email speaks as the business');
assert.match(email, /The AssembleAtEase Team/);
assert.doesNotMatch(await read('api/_email.js'), /Travis at AssembleAtEase/, 'no founder-name sender');
const reviewApi = await read('api/review.js');
assert.doesNotMatch(reviewApi, /rating\s*>=\s*4[\s\S]{0,200}issueReviewReward/, 'issuing the reward is not gated on a high rating');
console.log('PASS the reward is for an honest website review, any rating; Google is not rewarded');

// ── The platform pays for it, not the Easer ─────────────────────────────────
{
  const base = computeBookingSplitFromSnapshot({ totalPriceCents: 21650, taxCents: 1650, feePct: 30 });
  const rewarded = computeBookingSplitFromSnapshot({ totalPriceCents: 20650, taxCents: 1650, feePct: 30, reviewRewardDiscountCents: 1000 });
  assert.equal(rewarded.assemblerDueCents, base.assemblerDueCents, 'the Easer earns the same with or without the reward');
}
console.log('PASS the $10 comes from the platform share; Easer earnings are unchanged');

// ── One code, one booking ───────────────────────────────────────────────────
const sql = await read('api/migrations/117_review_reward_codes.sql');
assert.match(sql, /booking_id UUID NOT NULL UNIQUE/, 'one code per booking reviewed');
assert.match(sql, /code TEXT NOT NULL UNIQUE/);
assert.match(sql, /status = 'reserved' AND reserved_until < now\(\)\s*AND NOT EXISTS \(\s*SELECT 1 FROM public\.bookings b\s*WHERE b\.id = review_reward_codes\.reserved_booking_id\s*AND b\.status IN \('confirmed', 'en_route', 'arrived', 'in_progress', 'completed'\)/,
  'an expired hold is never taken from a booking that went ahead (a saved-card booking redeems weeks later)');
const booking = await read('api/booking.js');
assert.ok((booking.match(/if \(reviewRewardReserved\) await releaseReviewReward\(sb, bookingId\)/g) || []).length >= 3,
  'every path that deletes a failed booking releases its code first');
for (const rel of ['api/booking-confirmed.js', 'api/cron/authorize-scheduled-payments.js']) {
  assert.match(await read(rel), /completeReviewReward\(sb,/, `${rel} redeems the code once payment is secured`);
}
console.log('PASS one code per booking; holds cannot be taken from active bookings; failures release, payment redeems');
