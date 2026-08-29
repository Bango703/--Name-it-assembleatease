#!/usr/bin/env node

/**
 * Instant Payout must match what Stripe actually does, not what we assume.
 *
 * Two defects made it impossible for an Easer to ever use this:
 *
 *   1. balance.retrieve({ stripeAccount }) put an OPTIONS argument in the
 *      PARAMS position. Stripe rejected every call with "Received unknown
 *      parameter: stripeAccount", so the endpoint returned "Could not read your
 *      Stripe balance" 100% of the time. Instant payout has never worked once.
 *
 *   2. Eligibility was read from `available`. Stripe is explicit that the
 *      eligible amount is `instant_available`, and that card funds qualify
 *      "including pending funds within your payout schedule window" — so an
 *      Easer whose money was still settling saw zero, which is exactly when
 *      instant is worth paying for.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const src = await fs.readFile(new URL('../api/assembler/instant-payout.js', import.meta.url), 'utf8');
const { instantPayoutFeeCents } = await import('../api/assembler/instant-payout.js');

// ── The call shape Stripe requires ─────────────────────────────────────────
{
  assert.ok(src.includes('stripe.balance.retrieve({}, { stripeAccount: accountId })'),
    'stripeAccount is an options argument; in the params position Stripe rejects the call outright');
  assert.ok(!/balance\.retrieve\(\{ stripeAccount/.test(src),
    'the params-position form must never come back — it fails 100% of the time');
  console.log('PASS the balance call is shaped the way Stripe accepts');
}

// ── Eligibility comes from instant_available ───────────────────────────────
{
  assert.ok(src.includes('instantAvailable = usdTotal(balance.instant_available)'),
    'Stripe says instant_available is the eligible amount, not available');
  assert.ok(src.includes('quoteInstantPayout(Math.min(instantAvailable, INSTANT_MAX_CENTS))'),
    'the instant quote must price what is instantly payable, capped at Stripe\'s ceiling');
  assert.ok(src.includes('instantAvailable <= 0'),
    'nothing instantly payable must read as not eligible, not as a $0 offer');
  console.log('PASS eligibility reads the field Stripe defines it by');
}

// ── The published US figures ───────────────────────────────────────────────
{
  assert.equal(instantPayoutFeeCents(41930), 629, '1.5% of $419.30 is $6.29');
  assert.equal(instantPayoutFeeCents(50), 50, 'the $0.50 minimum applies at the floor');
  assert.equal(instantPayoutFeeCents(3334), 50, 'below $33.34 the minimum bites, not the percentage');
  assert.ok(src.includes('const INSTANT_MAX_CENTS = 999900;'),
    "Stripe's US ceiling is $9,999 per instant payout and must not be exceeded");
  assert.ok(src.includes('INSTANT_FEE_PCT = 1.5'), 'the US rate is 1.5%');
  console.log('PASS fee, floor and ceiling match Stripe\'s published US figures');
}

console.log('\nInstant payout Stripe-alignment tests passed.');
