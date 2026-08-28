#!/usr/bin/env node

/**
 * A booking projection must carry every field the code it feeds actually reads.
 *
 * WHAT HAPPENED
 * The charge.refunded handler selected 18 columns and passed the row to
 * validateBookingPaymentIntentTopology(), which reads total_price. It was not in
 * the projection, so Number(undefined) became NaN and the validator threw
 * "The linked Stripe payment has no valid server-priced booking total."
 *
 * Every refund webhook failed. A refund issued from the Stripe dashboard never
 * reached the database, so the books disagreed with Stripe permanently and
 * silently — the platform kept counting revenue it had already given back. A
 * $32.94 refund had to be reconciled by hand to discover it.
 *
 * Nothing failed loudly. financial_event_audit recorded status 'failed' with the
 * exact cause, and nothing surfaced it.
 *
 * This is the same shape as the sendSms dead import and the provider_accepted_at
 * outage: the code was right, the projection was short.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const webhook = await fs.readFile(new URL('../api/assembler/stripe-webhook.js', import.meta.url), 'utf8');
const truth = await fs.readFile(new URL('../api/booking/_cancellation-stripe-truth.js', import.meta.url), 'utf8');

// Everything validateBookingPaymentIntentTopology reads off a booking.
const required = [...new Set([...truth.matchAll(/booking\?\.([a-z_]+)/g)].map(m => m[1]))].sort();

// ── The refund projection carries them all ──────────────────────────────────
{
  const at = webhook.indexOf("case 'charge.refunded'");
  assert.ok(at > -1, 'the charge.refunded handler must exist');
  const projection = /\.select\('([^']+)'\)/.exec(webhook.slice(at, at + 3000))[1];
  const have = new Set(projection.split(',').map(c => c.trim()));

  const missing = required.filter(f => !have.has(f));
  assert.deepEqual(missing, [],
    `the refund projection omits ${missing.join(', ')} — the validator reads them and throws on undefined`);

  // The one that actually broke, named explicitly so a future trim is obvious.
  assert.ok(have.has('total_price'),
    'total_price MUST be selected: without it the validator sees NaN and every refund fails');
  console.log(`PASS the refund projection carries all ${required.length} fields the validator reads`);
}

// ── The validator still fails closed on a genuinely missing total ───────────
{
  const { validateBookingPaymentIntentTopology } = await import('../api/booking/_cancellation-stripe-truth.js');
  assert.throws(
    () => validateBookingPaymentIntentTopology({ stripe_payment_intent_id: 'pi_x' }),
    /no valid server-priced booking total/,
    'a booking with no total must still be refused — the fix is the projection, not the guard',
  );
  // And a well-formed booking passes.
  const ok = validateBookingPaymentIntentTopology({
    stripe_payment_intent_id: 'pi_x', total_price: 24313, deposit_amount: 0, is_deposit: false,
  });
  assert.equal(ok.flow, 'full');
  assert.equal(ok.totalCents, 24313);
  console.log('PASS the validator still refuses a genuinely priceless booking, and accepts a real one');
}

console.log('\nRefund webhook projection tests passed.');
