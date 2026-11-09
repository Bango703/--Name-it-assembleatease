#!/usr/bin/env node
// Moving a held-card booking more than two days out (owner, 2026-11-08): an
// Easer could not move a reassigned job, and the customer would have been sent
// to support, because of our card-hold mechanics. The booking now returns to a
// saved card; the scheduled authorization places a fresh hold later.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { heldCardCanWait, SAVED_CARD_FIELDS, releaseSupersededHold } from '../api/booking/_held-card-reschedule.js';
import { reschedulePaymentConflict } from '../api/booking/reschedule.js';
import { chicagoTodayIso } from '../api/booking/_appt-date.js';
import { addIsoDays } from '../api/booking/_booking-window.js';

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');

const held = (changes = {}) => ({
  status: 'confirmed', payment_status: 'authorized', payment_method_type: 'card',
  stripe_payment_intent_id: 'pi_old', stripe_customer_id: 'cus_1', stripe_payment_method_id: 'pm_1',
  stripe_deposit_intent_id: null, total_price: 18900, ...changes,
});
const today = chicagoTodayIso();
const far = addIsoDays(today, 10);
const near = addIsoDays(today, 1);

// Which holds can wait.
{
  assert.equal(heldCardCanWait(held()), true, 'a confirmed card hold with its saved card can wait');
  assert.equal(heldCardCanWait(held({ payment_method_type: null })), true, 'an unrecorded method is a card, as everywhere else');
  for (const [change, why] of [
    [{ payment_method_type: 'klarna' }, 'Klarna cannot be authorized off-session'],
    [{ stripe_payment_method_id: null }, 'no saved card'],
    [{ stripe_customer_id: null }, 'no Stripe customer'],
    [{ stripe_payment_intent_id: null }, 'no hold to release'],
    [{ stripe_deposit_intent_id: 'pi_dep' }, 'a deposit is left alone'],
    [{ total_price: 0 }, 'no amount to authorize later'],
    [{ total_price: null }, 'no amount to authorize later'],
    [{ payment_status: 'card_saved' }, 'not a hold'],
    [{ status: 'pending' }, 'the scheduled authorization only runs on confirmed bookings'],
  ]) assert.equal(heldCardCanWait(held(change)), false, why);
  assert.deepEqual({ ...SAVED_CARD_FIELDS }, { payment_status: 'card_saved', stripe_payment_intent_id: null, payment_authorized_at: null, authorization_capture_before: null });
}
console.log('PASS held card: only a confirmed card hold with its saved card and amount goes back to a saved card');

// The refusal is gone only where the hold can wait.
{
  assert.equal(reschedulePaymentConflict(held(), far), null, 'a held card moves past the window');
  assert.equal(reschedulePaymentConflict(held(), near), null, 'inside the window it keeps its hold, as before');
  assert.equal(reschedulePaymentConflict(held({ payment_method_type: 'klarna' }), far)?.code, 'PAYMENT_RESCHEDULE_ASSISTANCE_REQUIRED', 'Klarna still needs help');
  assert.equal(reschedulePaymentConflict(held({ stripe_payment_method_id: null }), far)?.code, 'PAYMENT_RESCHEDULE_ASSISTANCE_REQUIRED', 'no saved card still needs help');
  assert.equal(reschedulePaymentConflict({ ...held(), payment_status: 'card_saved', stripe_payment_intent_id: null }, near)?.code, 'PAYMENT_RESCHEDULE_ASSISTANCE_REQUIRED', 'saved card moving inside the window is unchanged');
}
console.log('PASS conflict: a held card is no longer refused past two days; Klarna and missing cards still are');

// Releasing the old hold never throws and is idempotent.
{
  const calls = [];
  const ok = await releaseSupersededHold({ bookingId: 'b1', paymentIntentId: 'pi_old', stripe: { paymentIntents: { cancel: async (...a) => { calls.push(a); return { status: 'canceled' }; } } } });
  assert.equal(ok.ok, true);
  assert.deepEqual(calls[0], ['pi_old', { cancellation_reason: 'requested_by_customer' }, { idempotencyKey: 'reschedule-release-b1-pi_old' }]);
  const already = await releaseSupersededHold({ bookingId: 'b1', paymentIntentId: 'pi_old', stripe: { paymentIntents: { cancel: async () => { throw new Error('unexpected state'); }, retrieve: async () => ({ status: 'canceled' }) } } });
  assert.equal(already.ok, true, 'already released counts as released');
  const failed = await releaseSupersededHold({ bookingId: 'b1', paymentIntentId: 'pi_old', stripe: { paymentIntents: { cancel: async () => { throw new Error('network'); }, retrieve: async () => ({ status: 'requires_capture' }) } } });
  assert.deepEqual(failed, { ok: false, error: 'network' });
  const down = await releaseSupersededHold({ bookingId: 'b1', paymentIntentId: 'pi_old', stripe: { paymentIntents: { cancel: async () => { throw new Error('down'); }, retrieve: async () => { throw new Error('down too'); } } } });
  assert.deepEqual(down, { ok: false, error: 'down' });
  assert.equal((await releaseSupersededHold({ bookingId: 'b1', paymentIntentId: 'pi_old', stripe: null })).ok, false);
}
console.log('PASS release: idempotent, already-released counts, failure is reported and never thrown');

// The booking changes first, under the reschedule's own check; the hold is released after.
{
  const src = read('api/booking/reschedule.js');
  assert.match(src, /const releaseHold = booking\.payment_status === 'authorized' && needsScheduledAuthorization\(date\) && heldCardCanWait\(booking\)\s*\? booking\.stripe_payment_intent_id : null;/);
  assert.match(src, /const update = \{\s*\.\.\.\(releaseHold \? SAVED_CARD_FIELDS : \{\}\),/);
  for (const column of ['payment_status', 'stripe_payment_intent_id', 'stripe_deposit_intent_id']) {
    assert.match(src, new RegExp(`\\['${column}', booking\\.${column}\\]`), `the move still checks ${column} has not changed`);
  }
  const saved = src.indexOf("if (updateErr || !updatedRows?.length)");
  const release = src.indexOf('await releaseSupersededHold(');
  assert.ok(saved > 0 && release > saved, 'the hold is released only after the booking row is saved');
  assert.match(src, /eventType: released\.ok \? 'payment_hold_released_for_reschedule' : 'payment_hold_release_failed'/, 'both outcomes reach the owner timeline');

  // A released hold that later reports canceled must not mark the booking failed.
  const webhook = read('api/assembler/stripe-webhook.js');
  const canceled = webhook.slice(webhook.indexOf("case 'payment_intent.canceled'"), webhook.indexOf("case 'payment_intent.canceled'") + 3000);
  assert.match(canceled, /if \(booking\.stripe_payment_intent_id !== pi\.id\) \{[\s\S]*?reason: 'stale-canceled-payment-intent'/, 'the webhook ignores a hold the booking no longer points at');

  // Every reader of the rule has the fields it needs (Easer proposals call it too).
  const proposal = read('api/booking/time-proposal.js');
  const select = proposal.match(/\.select\('(id, ref, service, status, date, time, payment_status[^']*)'\)/)[1];
  for (const column of ['payment_method_type', 'total_price', 'stripe_payment_intent_id', 'stripe_customer_id', 'stripe_payment_method_id', 'stripe_deposit_intent_id']) {
    assert.ok(select.split(/,\s*/).includes(column), `time-proposal selects ${column} for the held-card rule`);
  }
  assert.match(read('api/booking/reschedule.js'), /\.from\('bookings'\)\s*\.select\('\*'\)/, 'the reschedule reads the whole row');

  // The scheduled authorization picks a saved-card booking up again.
  const scheduled = read('api/cron/authorize-scheduled-payments.js');
  assert.match(scheduled, /payment_status\.eq\.card_saved,date\.gte\.\$\{today\},date\.lte\.\$\{authorizationCutoff\}/);
}
console.log('PASS order: booking saved first under its compare-and-set, hold released after, webhook ignores it, every reader selects the fields');
console.log('\nHeld-card reschedule tests passed.');
