import assert from 'node:assert/strict';
import { computeBookingSplitFromSnapshot, sameDaySplitParts } from '../api/_source-of-truth.js';

const booking = {
  total_price: 42651,
  tax_amount: 3251,
  same_day_fee_cents: 6900,
  same_day_easer_bonus_cents: 3000,
  assemblecash_redeemed_cents: 0,
};
const feePct = 30;
const sameDay = sameDaySplitParts(booking);
const split = computeBookingSplitFromSnapshot({
  amountChargedCents: booking.total_price - sameDay.grossCents,
  taxCents: booking.tax_amount - sameDay.taxCents,
  feePct,
  assemblecashRedeemedCents: booking.assemblecash_redeemed_cents,
});
split.platformFeeCents += sameDay.platformExtra;
split.assemblerDueCents += sameDay.bonusCents;

assert.deepEqual({
  platformFeeCents: split.platformFeeCents,
  assemblerDueCents: split.assemblerDueCents,
}, {
  platformFeeCents: 13650,
  assemblerDueCents: 25750,
});

console.log('same-day owner/Easer split parity: PASS');
