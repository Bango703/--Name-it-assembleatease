#!/usr/bin/env node
// The Google Ads booking conversion reports what the platform keeps, never the
// customer's total (owner, 2026-11-18: "send accurate platform revenue
// excluding sales tax"; "preserve correct consent handling and conversion
// deduplication"). Before this, book.html sent BOOK._grandTotalCents, the
// tax-inclusive customer total; in May it sent nothing and Google recorded $1.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { estimatedPlatformRevenueCents, sameDaySplitParts, computeBookingSplitFromSnapshot } from '../api/_source-of-truth.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
let passed = 0;
function check(name, fn) { fn(); passed++; console.log(`PASS  ${name}`); }

// Real completed bookings (production, read 2026-11-18): total charged incl.
// tax, tax, and the platform fee the books recorded at completion.
const realBookings = [
  { place: 'Spring playset', totalCents: 42651, taxCents: 3251, platformFeeCents: 11820 },
  { place: 'San Antonio furniture', totalCents: 13423, taxCents: 1023, platformFeeCents: 3720 },
  { place: 'Lubbock fitness quote', totalCents: 64842, taxCents: 4942, platformFeeCents: 17970 },
  { place: 'Fischer playset after a 10% promo', totalCents: 75266, taxCents: 5736, platformFeeCents: 20859 },
  { place: 'Bullard mounting', totalCents: 146462, taxCents: 11162, platformFeeCents: 40590 },
];

check('the value equals the platform fee recorded on real completed bookings, never the customer total', () => {
  for (const b of realBookings) {
    const value = estimatedPlatformRevenueCents({ totalCents: b.totalCents, taxCents: b.taxCents });
    assert.equal(value, b.platformFeeCents, b.place);
    assert.ok(value < b.totalCents - b.taxCents, `${b.place}: below the pre-tax total`);
  }
});

check('sales tax never enters the value', () => {
  const noTax = estimatedPlatformRevenueCents({ totalCents: 12400, taxCents: 0 });
  const withTax = estimatedPlatformRevenueCents({ totalCents: 13423, taxCents: 1023 });
  assert.equal(noTax, 3720);
  assert.equal(withTax, 3720);
});

check('a gift card does not lower the value (the customer paid it earlier)', () => {
  const full = estimatedPlatformRevenueCents({ totalCents: 13423, taxCents: 1023 });
  const giftCard = estimatedPlatformRevenueCents({ totalCents: 13423 - 5000, taxCents: 1023, giftCardAppliedCents: 5000 });
  assert.equal(giftCard, full);
});

check('AssembleCash and review rewards come out of the platform share, as in the payout split', () => {
  const split = computeBookingSplitFromSnapshot({ amountChargedCents: 13423 - 2000, taxCents: 1023, assemblecashRedeemedCents: 2000 });
  assert.equal(estimatedPlatformRevenueCents({ totalCents: 13423 - 2000, taxCents: 1023, assemblecashRedeemedCents: 2000 }), split.platformFeeCents);
  assert.ok(split.platformFeeCents < 3720);
});

check('a same-day fee adds only the platform part, outside the 30/70 base', () => {
  const base = estimatedPlatformRevenueCents({ totalCents: 13423, taxCents: 1023 });
  const sameDayFee = 6900;
  const sameDayTax = sameDaySplitParts({ same_day_fee_cents: sameDayFee }).taxCents;
  const withSameDay = estimatedPlatformRevenueCents({
    totalCents: 13423 + sameDayFee + sameDayTax, taxCents: 1023 + sameDayTax,
    sameDayFeeCents: sameDayFee, sameDayEaserBonusCents: 3000,
  });
  assert.equal(withSameDay, base + (sameDayFee - 3000));
});

const book = read('book.html');
const conversionBlock = book.slice(book.indexOf('function trackBookingConfirmation'), book.indexOf('function showConfirmation'));

check('book.html reports the server value, never the customer total', () => {
  assert.match(conversionBlock, /bookingConversion\.value = BOOK\._conversionValueCents \/ 100/);
  assert.doesNotMatch(conversionBlock, /_grandTotalCents/, 'the tax-inclusive total must not reach the conversion');
  assert.match(book, /BOOK\._conversionValueCents = Number\.isFinite\(Number\(data\.conversionValueCents\)\)/, 'the value comes from the booking API response');
  assert.match(conversionBlock, /if \(BOOK\._conversionValueCents != null\)/, 'an unknown value is left out, not guessed');
});

check('consent and deduplication are unchanged', () => {
  assert.match(conversionBlock, /window\.AAEAnalytics\.canMeasure\(\)/, 'conversions respect the consent decision');
  assert.match(conversionBlock, /transaction_id: ref/, 'Google drops repeats of the same booking');
  assert.match(conversionBlock, /aaeAdsConfirmation:' \+ ref/, 'one conversion per booking per tab');
  assert.match(conversionBlock, /send_to: ADS_QUOTE_CONVERSION,\s*transaction_id: ref\s*\}/, 'a quote request still carries no value');
});

const bookingApi = read('api/booking.js');
check('the booking API computes the value on the server', () => {
  assert.match(bookingApi, /estimatedPlatformRevenueCents\(\{/);
  assert.match(bookingApi, /const conversionValueCentsFor = \(extra = \{\}\) => \(pricedBooking \?/, 'a quote request has no value');
  assert.equal((bookingApi.match(/conversionValueCents: conversionValueCentsFor\(/g) || []).length, 2, 'both success responses carry the value');
});

check('one same-day split rule: completion and the conversion value read the same function', () => {
  const complete = read('api/booking/assembler-complete.js');
  assert.doesNotMatch(complete, /function sameDaySplitParts/);
  assert.match(complete, /sameDaySplitParts, PAYOUT_HOLD_HOURS \} from '\.\.\/_source-of-truth\.js'/);
});

console.log(`\nAds conversion value: ${passed} checks passed.`);
