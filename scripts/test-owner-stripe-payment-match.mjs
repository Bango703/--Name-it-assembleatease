import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  buildPaymentMatchCandidates,
  chooseBestMatchId,
} from '../api/owner/stripe-match-payment.js';

function intent({
  id,
  amount,
  created,
  brand = 'visa',
  last4 = '4242',
  status = 'succeeded',
  currency = 'usd',
  livemode = true,
  refunded = 0,
  disputed = false,
  bookingId = '',
}) {
  return {
    id,
    status,
    currency,
    amount_received: amount,
    created,
    livemode,
    metadata: bookingId ? { bookingId } : {},
    latest_charge: {
      id: `ch_${id.slice(3)}`,
      payment_intent: id,
      status: 'succeeded',
      paid: true,
      captured: true,
      amount_captured: amount,
      amount_refunded: refunded,
      refunded: refunded === amount,
      disputed,
      livemode,
      payment_method_details: {
        card_present: { brand, last4 },
      },
    },
  };
}

const bookingId = '00000000-0000-4000-8000-000000000001';
const base = 2_000_000_000;
const input = [
  intent({ id: 'pi_other', amount: 5000, created: base + 30 }),
  intent({ id: 'pi_total', amount: 37465, created: base + 20 }),
  intent({ id: 'pi_remaining', amount: 11000, created: base + 10 }),
  intent({ id: 'pi_linked', amount: 11000, created: base + 40 }),
  intent({ id: 'pi_refunded', amount: 11000, created: base + 50, refunded: 100 }),
  intent({ id: 'pi_disputed', amount: 11000, created: base + 60, disputed: true }),
  intent({ id: 'pi_wrong_mode', amount: 11000, created: base + 70, livemode: false }),
  intent({ id: 'pi_wrong_booking', amount: 11000, created: base + 80, bookingId: 'different-booking' }),
  intent({ id: 'pi_above_record_limit', amount: 2_500_001, created: base + 90 }),
];

const candidates = buildPaymentMatchCandidates({
  intents: input,
  linkedPaymentIntentIds: new Set(['pi_linked']),
  bookingId,
  remainingBalanceCents: 11000,
  totalCents: 37465,
  liveMode: true,
});

assert.deepEqual(
  candidates.map(candidate => candidate.paymentIntentId),
  ['pi_remaining', 'pi_total', 'pi_other'],
  'remaining balance must rank before full total and other recent amounts',
);
assert.equal(candidates[0].cardBrand, 'visa');
assert.equal(candidates[0].last4, '4242');
assert.equal(chooseBestMatchId(candidates, {
  remainingBalanceCents: 11000,
  totalCents: 37465,
}), 'pi_remaining');

const ambiguous = buildPaymentMatchCandidates({
  intents: [
    intent({ id: 'pi_same_new', amount: 11000, created: base + 2 }),
    intent({ id: 'pi_same_old', amount: 11000, created: base + 1 }),
  ],
  linkedPaymentIntentIds: new Set(),
  bookingId,
  remainingBalanceCents: 11000,
  totalCents: 37465,
  liveMode: true,
});
assert.equal(chooseBestMatchId(ambiguous, {
  remainingBalanceCents: 11000,
  totalCents: 37465,
}), null, 'two exact-amount payments must require an owner selection');

const totalOnly = candidates.filter(candidate => candidate.paymentIntentId !== 'pi_remaining');
assert.equal(chooseBestMatchId(totalOnly, {
  remainingBalanceCents: 11000,
  totalCents: 37465,
}), null, 'a full-total payment must not auto-fill after a partial payment already exists');
assert.equal(chooseBestMatchId(totalOnly, {
  remainingBalanceCents: 37465,
  totalCents: 37465,
}), 'pi_total', 'a unique full-total match may be suggested when the full total remains due');
assert.equal(chooseBestMatchId(candidates, {
  remainingBalanceCents: 11000,
  totalCents: 37465,
  searchTruncated: true,
}), null, 'a truncated Stripe search must never auto-select');

const endpoint = await readFile(new URL('../api/owner/stripe-match-payment.js', import.meta.url), 'utf8');
const recorder = await readFile(new URL('../api/owner/record-manual-payment.js', import.meta.url), 'utf8');
const ownerUi = await readFile(new URL('../owner/index.html', import.meta.url), 'utf8');

assert.match(endpoint, /req\.method !== 'GET'/, 'matcher must be read-only GET');
assert.match(endpoint, /if \(!verifyOwner\(req\)\)/, 'matcher must require owner authentication');
assert.match(endpoint, /booking\.source !== 'owner_manual'/, 'matcher must require the owner-manual booking lane');
assert.match(endpoint, /booking\.payment_status !== 'offline_recorded'/, 'matcher must require offline-recorded payment truth');
assert.match(endpoint, /const LOOKBACK_SECONDS = 7 \* 24 \* 60 \* 60/, 'matcher must cover next-day owner reconciliation');
assert.match(endpoint, /Math\.floor\(Date\.now\(\) \/ 1000\) - LOOKBACK_SECONDS/, 'matcher must use the bounded Stripe window');
assert.match(endpoint, /limit: STRIPE_LIST_LIMIT/, 'matcher must cap Stripe results at 100');
assert.match(endpoint, /expand: \['data\.latest_charge'\]/, 'matcher must expand charge truth in the Stripe list request');
assert.match(endpoint, /\.in\('stripe_payment_intent_id', listedIds\)/, 'matcher must exclude PaymentIntents already linked to any manual booking');
assert.match(endpoint, /metadataBookingId === bookingId/, 'matcher must reject Stripe metadata linked to another booking');
assert.match(endpoint, /searchTruncated/, 'matcher must surface incomplete Stripe search truth');
assert.doesNotMatch(endpoint, /\.insert\(|\.update\(|\.delete\(|\.rpc\(/, 'matcher must never mutate database state');
assert.doesNotMatch(endpoint, /paymentIntents\.create|refunds\.create|charges\.capture/, 'matcher must never mutate Stripe state');

assert.match(recorder, /export function expectedLiveMode/, 'matcher and recorder must share the same live-mode rule');
assert.match(recorder, /export const MAX_PAYMENT_CENTS/, 'matcher and recorder must share the same payment limit');
assert.match(recorder, /paymentIntents\.retrieve/, 'recording must still retrieve fresh Stripe truth');
assert.match(recorder, /const amountCents = Number\(intent\?\.amount_received\)/, 'Stripe must supply the recorded amount');
assert.match(recorder, /expectedTotalCents - submittedDiscountCents/, 'the server must calculate the adjusted customer total');
assert.match(recorder, /existingGrossCents \+ amountCents > adjustedTotalCents/, 'gross payments must never exceed the agreed customer total');
assert.match(recorder, /Number\(charge\.amount_refunded \|\| 0\) !== 0/, 'recording must still reject refunded charges');
assert.match(recorder, /charge\.disputed === true/, 'recording must still reject disputed charges');

assert.match(ownerUi, /\/api\/owner\/stripe-match-payment\?bookingId=/, 'record-payment modal must call the matcher');
assert.match(ownerUi, /Matched:<\/strong>/, 'one strong match must be clearly identified');
assert.match(ownerUi, /manual-payment-match-choice/, 'ambiguous matches must require radio selection');
assert.match(ownerUi, /No unused Stripe payment from the last 7 days was found/, 'manual PaymentIntent fallback must remain visible');
assert.match(ownerUi, /manual-payment-discount/, 'discount entry must remain available as an optional audited adjustment');
assert.doesNotMatch(ownerUi, /id="manual-payment-amount"/, 'the owner must not type an amount Stripe already knows');
assert.doesNotMatch(ownerUi, /id="manual-payment-total"/, 'the owner must not recalculate the adjusted booking total');
assert.match(ownerUi, /\/api\/owner\/record-manual-payment/, 'Record must still use the verified mutation endpoint');
assert.match(ownerUi, /manual-payment-confirm-cb/, 'owner confirmation must remain required');

console.log('Owner Stripe payment auto-match safety checks passed.');
