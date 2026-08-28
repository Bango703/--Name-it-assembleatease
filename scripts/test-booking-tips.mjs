#!/usr/bin/env node

/**
 * Tips go DIRECTLY to the Easer, and a declined card never costs a review.
 *
 * Two properties matter more than anything else here:
 *
 *   1. The platform takes nothing. Not "currently takes nothing" — there is no
 *      application fee in the charge and nowhere in the schema to record one.
 *   2. The review is saved BEFORE the tip is charged and never depends on it.
 *      Losing a five-star review to a card decline is indefensible in both
 *      directions.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const api = await fs.readFile(new URL('../api/booking/tip.js', import.meta.url), 'utf8');
const sql = await fs.readFile(new URL('../api/migrations/081_booking_tips.sql', import.meta.url), 'utf8');
const ui = await fs.readFile(new URL('../review.html', import.meta.url), 'utf8');

// ── 100% reaches the Easer ──────────────────────────────────────────────────
{
  assert.ok(/stripeAccount: accountId/.test(api),
    'the charge must be created ON the Easer\'s connected account — that is what makes the money theirs');
  // Checked as an ASSIGNMENT, not as a word: the comment above the create call
  // explains why there is no fee, and a naive word match would flag its own
  // explanation and push someone to delete it.
  const codeOnly = api.split(/\r?\n/).filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  assert.ok(!/application_fee_amount\s*:/.test(codeOnly),
    'there must be NO application fee assigned: the platform takes nothing from a tip');
  assert.ok(/No application_fee_amount/.test(api),
    'and the reason must stay written down, so nobody adds one back without reading it');
  assert.ok(!/application_fee|platform_fee|platform_cut/i.test(sql),
    'the schema must offer nowhere to record a platform cut of a tip');
  assert.ok(/100% goes to your pro/i.test(ui), 'the page must say so plainly');
  console.log('PASS the platform takes nothing, and there is nowhere to put a cut');
}

// ── The customer sees one number ────────────────────────────────────────────
{
  // Telling someone their $20 thank-you is "really" $19.12 makes a generous act
  // look diminished and invites them to wonder whether they should cover it.
  assert.ok(/goes to/.test(ui), 'the customer is shown the amount they chose');
  const uiCode = ui.split(/\r?\n/).filter(l => !/^\s*(\/\/|\*|<!--)/.test(l)).join('\n');
  assert.ok(!/Stripe fee/i.test(uiCode),
    'the processing fee must never be rendered to the customer — it is between Stripe and the Easer');
  assert.ok(/stripe_fee_cents/.test(sql) && /easer_net_cents/.test(sql),
    'the fee and net are still RECORDED, because the Easer needs them');
  console.log('PASS the customer sees one number; the fee is recorded for the Easer only');
}

// ── The review is never at risk ─────────────────────────────────────────────
{
  const at = ui.indexOf('async function submitReview');
  const body = ui.slice(at);
  const reviewPost = body.indexOf("fetch('/api/review'");
  const tipCall = body.indexOf('sendTipAfterReview');
  assert.ok(reviewPost > -1 && tipCall > reviewPost,
    'the review must be POSTed before the tip is ever attempted');
  assert.ok(/Your review was still posted/.test(ui),
    'a failed tip must tell the customer their review survived — that is what they will worry about');
  assert.ok(/loadTipOffer/.test(ui) && /catch \(e\) \{ \/\* the review must work/.test(ui),
    'the tip offer must fail soft: a broken quote cannot break the review page');
  console.log('PASS the review is saved first and survives any tip failure');
}

// ── Authorisation is exactly as strong as a review's ────────────────────────
{
  assert.ok(/verifyReviewToken\(token/.test(api), 'the same signed token must guard a tip');
  assert.ok(/customer_email\.toLowerCase\(\) !== normalizedEmail/.test(api), 'the email must match the booking');
  assert.ok(/booking\.status !== 'completed'/.test(api), 'only completed jobs may be tipped');
  assert.ok(/!booking\.assembler_id \|\| !booking\.assembler_accepted_at/.test(api),
    'no ACCEPTED Easer means nobody earned a thank-you — assignment is not commitment');
  console.log('PASS a tip is authorised exactly as strongly as the review it sits beside');
}

// ── Money safety ────────────────────────────────────────────────────────────
{
  assert.ok(/MIN_TIP_CENTS = 100/.test(api) && /MAX_TIP_CENTS = 50000/.test(api),
    'a fat-finger ceiling must exist');
  assert.ok(/amount < MIN_TIP_CENTS \|\| amount > MAX_TIP_CENTS/.test(api),
    'the bounds must be enforced server-side, never trusted from the browser');
  assert.ok(/idempotencyKey: `tip-\$\{booking\.id\}/.test(api),
    'a double-tapped button must not charge twice');
  assert.ok(/idx_booking_tips_one_per_booking/.test(sql),
    'the database must also refuse a second tip on one booking');

  // If recording fails, the intent must not be left chargeable.
  assert.ok(/paymentIntents\.cancel\(intent\.id/.test(api),
    'a failed record must cancel the intent rather than leave money collectable with no row');
  assert.ok(/nothing was charged/i.test(api),
    'every failure must tell the customer nothing was taken');
  console.log('PASS bounded, idempotent, and a failed record can never leave a chargeable intent');
}

// ── Declining is an answer, and it is remembered ───────────────────────────
{
  // Being asked twice for money you already declined reads as nagging, and makes
  // the "completely optional" promise directly above it look untrue.
  assert.ok(/action === 'decline'/.test(api), 'the customer must be able to say no explicitly');
  assert.ok(/tip_declined_at/.test(api) && /tip_declined_at/.test(sql),
    'the decline must be recorded, not just handled in the browser');
  assert.ok(/declined: Boolean\(booking\.tip_declined_at\)/.test(api),
    'the quote must report a previous decline so the offer never returns');
  assert.ok(/d\.declined\) return;/.test(ui), 'and the page must honour it by showing nothing');

  assert.ok(/id="tip-decline"|id !== 'tip-decline'/.test(ui) || /No thanks/.test(ui),
    '"No thanks" must be a visible control, not merely the absence of a choice');

  // A decline stops us asking. It must never block someone who changes their mind.
  const sendPath = api.slice(api.indexOf("if (action !== 'send')"));
  assert.ok(!/tip_declined_at/.test(sendPath.slice(0, sendPath.indexOf('paymentIntents.create'))),
    'a previous decline must not block a customer who later chooses to tip');

  // A decline is not a payment and must not sit in the payments table.
  assert.ok(/ALTER TABLE public\.bookings[\s\S]{0,120}tip_declined_at/.test(sql),
    'the decline belongs on bookings, not in booking_tips where amount_cents is CHECK > 0');
  console.log('PASS declining is explicit, recorded, honoured, and never blocks a change of mind');
}

console.log('\nBooking tip tests passed.');
