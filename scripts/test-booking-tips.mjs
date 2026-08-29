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

// ── The library the page calls must actually be on the page ────────────────
// review.html called Stripe(...) and never loaded js.stripe.com. The call threw
// ReferenceError, the catch reported "the tip could not be sent", and no tip
// could ever succeed — while the server had already created a PaymentIntent.
//
// The rule that generalises: a page may call Stripe(...) only if it loads the
// library, OR guards with typeof so it degrades on purpose instead of by
// accident. index.html and contact.html deliberately do the latter.
{
  const pages = ['book.html', 'contact.html', 'index.html', 'review.html',
    'assembler/apply.html', 'assembler/verify-identity.html'];
  for (const page of pages) {
    const html = await fs.readFile(new URL('../' + page, import.meta.url), 'utf8');
    // A real constructor call, not a function named continueToStripe().
    if (!/[^A-Za-z]Stripe\(/.test(html)) continue;
    const loadsLibrary = html.includes('js.stripe.com');
    const guardsForAbsence = /typeof Stripe === ['"]undefined['"]/.test(html);
    assert.ok(loadsLibrary || guardsForAbsence,
      `${page} calls Stripe(...) but neither loads js.stripe.com nor guards for its absence`);
  }

  // The tip is not optional on this page: a guard that degrades silently would
  // still mean no customer can ever tip. review.html must load it outright.
  assert.ok(ui.includes('https://js.stripe.com/v3/'),
    'review.html must load Stripe.js — the tip cannot work without it');
  console.log('PASS every page that calls Stripe either loads it or guards for its absence');
}

// ── A tip claims money only after Stripe says money moved ──────────────────
// The row used to be written 'succeeded' at intent-CREATION time, and the
// browser never reported the outcome. Rule 5: Stripe is financial truth.
{
  assert.ok(api.includes("status: 'pending',"),
    'a new tip row must be recorded as pending — nothing has been paid at that point');
  assert.ok(!/status: 'succeeded',\s*\n\s*customer_email/.test(api),
    'the insert path must not write succeeded before the customer has confirmed');

  // Promotion re-reads Stripe rather than trusting the browser.
  assert.ok(api.includes("if (action === 'confirm')"), 'there must be a confirm step');
  assert.ok(api.includes('stripe.paymentIntents.retrieve('),
    'confirm must re-read the intent from Stripe, not take the browser\'s word');
  assert.ok(api.includes("if (intent.status !== 'succeeded')"),
    'a tip may be promoted only when Stripe itself reports succeeded');
  assert.ok(api.includes(".eq('status', 'pending')"),
    'promotion must be a compare-and-set so two confirmations cannot double-write');

  // And the browser must actually call it, or every real tip stays pending.
  assert.ok(ui.includes("reportTip('confirm')"), 'the page must report a successful charge to the server');
  assert.ok(ui.includes("reportTip('fail')"), 'the page must report a failed charge so the row is closed');
  console.log('PASS a tip is recorded only after Stripe confirms it');
}

// ── A pending tip is not a tip ─────────────────────────────────────────────
{
  assert.ok(api.includes("const SETTLED_STATUSES = ['succeeded', 'refunded', 'disputed'];"),
    'the statuses that represent real money must be named in one place');
  assert.ok(api.includes('alreadyTipped: settled ?'),
    'a pending row must not tell the customer they already tipped — no money moved');
  assert.ok(api.includes("if (action === 'fail')"),
    'a failed confirmation must close the row, or it blocks the customer from retrying');
  assert.ok(api.includes('stripe.paymentIntents.cancel('),
    'an abandoned tip intent must be cancelled, not left chargeable on the Easer account');

  const migration = await fs.readFile(new URL('../api/migrations/083_booking_tips_pending_state.sql', import.meta.url), 'utf8');
  assert.ok(migration.includes("CHECK (status IN ('pending', 'succeeded', 'refunded', 'disputed', 'failed'))"),
    'the database must allow the pending state');
  assert.ok(migration.includes("ALTER COLUMN status SET DEFAULT 'pending'"),
    'the default must understate rather than overstate whether money moved');

  // A customer who closes the tab leaves a pending row. If Stripe took the
  // money anyway, an Easer is owed a tip nobody knows about.
  const recon = await fs.readFile(new URL('../api/cron/stripe-reconciliation.js', import.meta.url), 'utf8');
  assert.ok(recon.includes('tip_paid_but_unrecorded'),
    'reconciliation must surface a tip Stripe took that the books still call pending');
  console.log('PASS a stuck tip is visible and never blocks a retry');
}

// ── Writing a review is optional; rating is not ────────────────────────────
// Requiring a paragraph cost the rating AND the tip from every customer who did
// not feel like writing, because the tip only runs once the review saves.
{
  const reviewApi = await fs.readFile(new URL('../api/review.js', import.meta.url), 'utf8');
  assert.ok(reviewApi.includes('if (!ref || !email || !rating) {'),
    'the written review must not be a required field');
  assert.ok(!reviewApi.includes('!rating || !body'), 'body must no longer be required');
  assert.ok(reviewApi.includes('reviewBody.length > 0 && reviewBody.length < 10'),
    'empty must be allowed, but a half-word should still be refused');
  assert.ok(reviewApi.includes('body: reviewBody,'), 'the stored body must be the normalised value');

  assert.ok(ui.includes('body.length > 0 && body.length < 10'),
    'the page must not block a rating-only review either');
  assert.ok(/\(optional\)/.test(ui), 'the label must tell the customer writing is optional');
  console.log('PASS a customer can rate and tip without writing anything');
}

console.log('\nBooking tip tests passed.');
