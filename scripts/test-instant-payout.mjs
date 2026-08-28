#!/usr/bin/env node

/**
 * Instant payout: the Easer's own money, their own choice, and a fee they see
 * before they agree to it.
 *
 * The failure mode this guards against is not a crash. It is a pro in a hurry
 * being quietly charged more than they expected, or offered a "convenience" that
 * takes half their pay. Those look fine in production and are only caught here.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { quoteInstantPayout, instantPayoutFeeCents } from '../api/assembler/instant-payout.js';

// ── The fee is Stripe's 1.5%, with Stripe's floor ───────────────────────────
{
  assert.equal(instantPayoutFeeCents(9894), 148, '1.5% of $98.94');
  assert.equal(instantPayoutFeeCents(24550), 368, '1.5% of $245.50');
  assert.equal(instantPayoutFeeCents(3334), 50, 'the $0.50 floor applies below ~$33.34');
  assert.equal(instantPayoutFeeCents(0), 0, 'no balance, no fee');

  // The platform adds NOTHING on top. If this ever drifts above Stripe's rate,
  // the Easer is being marked up on their own earnings.
  const q = quoteInstantPayout(10000);
  assert.equal(q.feeCents, 150, 'exactly Stripe 1.5% — the platform takes no margin on a payout');
  assert.equal(q.grossCents - q.feeCents, q.netCents, 'net must reconcile exactly');
  console.log('PASS the fee is exactly Stripe\'s 1.5%, with no platform markup');
}

// ── A fee that eats the payout is not offered ───────────────────────────────
{
  // At $1.00 the $0.50 floor is FIFTY PERCENT. A pro in a hurry is the least
  // likely person to do that arithmetic, so the offer is withdrawn rather than
  // dressed up as convenience.
  const tiny = quoteInstantPayout(100);
  assert.equal(tiny.feeCents, 50);
  assert.equal(tiny.eligible, false, 'a 50% fee must never be offered');

  assert.equal(quoteInstantPayout(500).eligible, true, '$5.00 at 10% is the boundary');
  assert.equal(quoteInstantPayout(9894).eligible, true);
  assert.equal(quoteInstantPayout(0).eligible, false, 'nothing settled, nothing to offer');

  // No eligible quote may ever exceed a tenth of the money.
  for (const cents of [500, 1000, 3333, 5000, 9894, 24550]) {
    const q = quoteInstantPayout(cents);
    if (q.eligible) {
      assert.ok((q.feeCents * 100) / cents <= 10, `${cents} would charge over 10%`);
    }
  }
  console.log('PASS a fee worth more than a tenth of the payout is never offered');
}

// ── The handler ─────────────────────────────────────────────────────────────
{
  const src = await fs.readFile(new URL('../api/assembler/instant-payout.js', import.meta.url), 'utf8');

  assert.ok(/authenticateBearerUser\(req\)/.test(src), 'the Easer must be authenticated');
  assert.ok(/stripeAccount: accountId/.test(src), 'the payout must target the EASER\'s connected account');

  // The Easer pays themselves. The platform must never be able to move their money.
  assert.ok(/initiatedBy: 'easer_self_service'/.test(src));
  assert.ok(!/verifyOwner/.test(src), 'the owner must not be able to trigger an Easer payout');

  // Balance comes from Stripe, never a local mirror — offering money that is not
  // actually there is how a payout fails in a pro's hands.
  assert.ok(/stripe\.balance\.retrieve/.test(src), 'the balance must be read live from Stripe');
  assert.ok(!/from\('bookings'\)[\s\S]{0,200}assembler_due/.test(src),
    'the withdrawable amount must not be derived from our own tables');

  // The quoted fee must be confirmed, and re-derived server-side.
  assert.ok(/acknowledgedFeeCents/.test(src), 'the Easer must confirm the fee they were shown');
  assert.ok(/QUOTE_STALE/.test(src), 'a changed balance must re-quote rather than charge a stale fee');
  assert.ok(/acknowledgedFee !== quote\.feeCents/.test(src),
    'the posted fee must be compared against a server-derived one, never trusted (Rule 4)');

  // Free alternative shown beside the paid one.
  assert.ok(/Free on the standard schedule/.test(src),
    'the free option must be shown alongside — never sell speed without it');

  // A double tap must not withdraw twice.
  assert.ok(/idempotencyKey: `instant-/.test(src), 'the payout must be idempotent');

  // Errors must reassure, not alarm: the money is never lost, only delayed.
  assert.ok(/Your earnings are safe/.test(src),
    'a failure must tell the pro their money is safe — that is the only thing they care about');
  console.log('PASS the Easer pays themselves, confirms the fee, and cannot double-withdraw');
}

// ── The transfer no longer waits on OUR settlement ──────────────────────────
{
  const src = await fs.readFile(new URL('../api/cron/release-payouts.js', import.meta.url), 'utf8');
  assert.ok(/source_transaction/.test(src),
    'the transfer must name its originating charge, or it waits for the platform balance to settle');
  assert.ok(/latest_charge/.test(src), 'the charge id must be resolved from the PaymentIntent');

  // A lookup failure must degrade, not lose the payout.
  assert.ok(/sourceCharge \? \{ source_transaction: sourceCharge \} : \{\}/.test(src),
    'an unresolved charge must fall back to a plain transfer, never skip the payout');
  console.log('PASS payout transfers are tied to their charge, so the Easer does not wait on settlement');
}

console.log('\nInstant payout tests passed.');
