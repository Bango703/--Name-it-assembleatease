import Stripe from 'stripe';
import { getSupabase } from '../_supabase.js';
import { verifyReviewToken } from '../_review-token.js';
import { rateLimit } from '../_ratelimit.js';
import { logActivity } from './_activity.js';

/**
 * POST /api/booking/tip — a customer sends a tip straight to their Easer.
 *
 * WHOSE MONEY THIS IS
 * The charge is created ON THE EASER'S connected account, not the platform's.
 * The money is theirs from the moment it settles: it is never platform revenue,
 * never enters the payout ledger, and the platform takes nothing. There is no
 * application_fee_amount here and there is nowhere in the schema to put one.
 *
 * WHAT THE CUSTOMER SEES
 * One number: what they chose to give. Stripe's processing fee is between Stripe
 * and the Easer and is deliberately NOT shown to the customer — telling someone
 * their $20 thank-you is "really" $19.12 makes a generous act look diminished and
 * invites them to wonder whether they should cover it. The Easer sees the full
 * breakdown, because it is their money it comes out of.
 *
 * AUTHORISATION
 * The same signed review token that guards the review. There is no customer
 * account, so possession of the emailed link plus a matching ref and email is the
 * proof — identical to how a review is authorised, no weaker.
 *
 * THE LIFECYCLE, AND WHY IT HAS ONE
 * A tip row used to be written as 'succeeded' the moment the PaymentIntent was
 * CREATED, and the browser never reported the outcome. The row then said money
 * had moved whether the card cleared, was declined, or the tab was closed. Rule
 * 5 is explicit that Stripe is financial truth, so:
 *
 *   send    creates the intent and records it as PENDING. Nothing has moved.
 *   confirm the browser has confirmed with Stripe; the server RE-READS the
 *           intent from Stripe and promotes the row only if Stripe agrees.
 *   fail    the confirmation failed or was abandoned; cancel the intent and
 *           close the row so it cannot masquerade as money owed.
 *
 * The server never takes the browser's word for a payment. It asks Stripe.
 */

const MIN_TIP_CENTS = 100;
const MAX_TIP_CENTS = 50000;   // $500 — a fat-finger ceiling, not a policy on generosity

// A row in one of these states represents a real, settled tip. 'pending' does
// not: it is an intent nobody has paid yet.
const SETTLED_STATUSES = ['succeeded', 'refunded', 'disputed'];

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
  const { ref, email, token, action = 'quote', amountCents } = req.body || {};
  if (!ref || !email || !token) {
    return res.status(400).json({ error: 'This tip link is incomplete. Open the link from your review email again.' });
  }

  const sb = getSupabase();
  const normalizedEmail = String(email).trim().toLowerCase();

  const { data: booking, error: bookingErr } = await sb
    .from('bookings')
    .select('id, ref, status, customer_email, customer_name, service, assembler_id, assembler_name, assembler_accepted_at, tip_declined_at')
    .eq('ref', String(ref).trim())
    .maybeSingle();
  if (bookingErr || !booking) return res.status(404).json({ error: 'Booking not found.' });

  // Identical authorisation to a review: matching email, completed job, valid token.
  if (!booking.customer_email || booking.customer_email.toLowerCase() !== normalizedEmail) {
    return res.status(403).json({ error: 'Email does not match this booking.' });
  }
  if (booking.status !== 'completed') {
    return res.status(400).json({ error: 'Tips can only be sent for completed jobs.' });
  }
  if (!verifyReviewToken(token, { bookingId: booking.id, ref: booking.ref, email: booking.customer_email })) {
    return res.status(403).json({
      error: 'This secure link is invalid or expired. Ask AssembleAtEase to send a new one.',
    });
  }

  // No accepted Easer means nobody earned a thank-you. Same principle as the
  // cancellation-fee invariant: assignment is not commitment.
  if (!booking.assembler_id || !booking.assembler_accepted_at) {
    return res.status(409).json({ error: 'This job has no Easer to tip.', code: 'NO_EASER' });
  }

  const { data: easer } = await sb
    .from('profiles')
    .select('id, full_name, stripe_connect_account_id, stripe_connect_charges_enabled')
    .eq('id', booking.assembler_id)
    .maybeSingle();

  const canReceive = Boolean(easer?.stripe_connect_account_id && easer.stripe_connect_charges_enabled === true);
  const easerFirstName = String(easer?.full_name || booking.assembler_name || 'your pro').trim().split(/\s+/)[0];

  // Any row that is not closed out. Its STATUS decides what it means.
  const { data: existing } = await sb
    .from('booking_tips')
    .select('id, amount_cents, status, stripe_payment_intent_id, stripe_account_id, created_at')
    .eq('booking_id', booking.id)
    .neq('status', 'failed')
    .maybeSingle();
  const settled = existing && SETTLED_STATUSES.includes(existing.status) ? existing : null;

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  const stripe = stripeKey ? new Stripe(stripeKey) : null;

  // A recorded "no thanks" ends it. Nothing further is offered, ever.
  if (action === 'decline') {
    await sb.from('bookings')
      .update({ tip_declined_at: new Date().toISOString() })
      .eq('id', booking.id)
      .is('tip_declined_at', null);
    return res.status(200).json({ ok: true, declined: true });
  }

  if (action === 'quote') {
    return res.status(200).json({
      ok: true,
      easerFirstName,
      canReceive,
      declined: Boolean(booking.tip_declined_at),
      // Only a SETTLED tip counts as already given. A pending row is an intent
      // nobody paid — telling someone they already tipped when no money moved
      // would be the same false claim this lifecycle exists to prevent.
      alreadyTipped: settled ? { amountCents: settled.amount_cents, at: settled.created_at } : null,
      minCents: MIN_TIP_CENTS,
      maxCents: MAX_TIP_CENTS,
      // The server's real reason, so the page never invents one (Article 16).
      reason: canReceive ? null : `${easerFirstName} hasn't finished setting up payouts yet, so tips can't be sent for this job.`,
    });
  }

  // ── confirm: the browser says Stripe took the payment. Verify that. ───────
  if (action === 'confirm') {
    if (!existing) return res.status(404).json({ error: 'There is no tip to confirm.', code: 'NO_TIP' });
    if (settled) {
      return res.status(200).json({ ok: true, alreadyRecorded: true, amountCents: settled.amount_cents });
    }
    if (!stripe) return res.status(503).json({ error: 'Tips are temporarily unavailable.' });

    // Stripe is asked directly. The browser reporting success is a hint, not proof.
    let intent;
    try {
      intent = await stripe.paymentIntents.retrieve(
        existing.stripe_payment_intent_id,
        { expand: ['latest_charge.balance_transaction'] },
        { stripeAccount: existing.stripe_account_id },
      );
    } catch (err) {
      console.error('[tip] confirm retrieve failed:', err?.message || err);
      return res.status(502).json({ error: 'The tip could not be verified with Stripe. It has not been recorded.' });
    }

    if (intent.status !== 'succeeded') {
      // Say what Stripe said. Never promote on hope.
      return res.status(409).json({
        error: `Stripe reports this payment is ${intent.status}, so the tip has not been recorded.`,
        code: 'NOT_SUCCEEDED',
        stripeStatus: intent.status,
      });
    }

    const balanceTx = intent.latest_charge?.balance_transaction;
    const patch = {
      status: 'succeeded',
      amount_cents: intent.amount_received || intent.amount || existing.amount_cents,
    };
    if (balanceTx && typeof balanceTx === 'object') {
      patch.stripe_fee_cents = balanceTx.fee ?? null;
      patch.easer_net_cents = balanceTx.net ?? null;
    }

    // Only promote a row that is still pending, so two confirmations cannot
    // double-write and a refund that landed first is never overwritten.
    const { data: promoted } = await sb.from('booking_tips')
      .update(patch)
      .eq('id', existing.id)
      .eq('status', 'pending')
      .select('id, amount_cents');
    if (!promoted?.length) {
      return res.status(200).json({ ok: true, alreadyRecorded: true, amountCents: existing.amount_cents });
    }

    await logActivity(sb, {
      bookingId: booking.id,
      eventType: 'tip_succeeded',
      actorType: 'customer',
      actorName: booking.customer_name || 'Customer',
      description: `Customer tipped ${easerFirstName} $${(patch.amount_cents / 100).toFixed(2)}`,
      metadata: { easerId: easer.id, amountCents: patch.amount_cents, paymentIntentId: intent.id },
    }).catch(() => {});

    return res.status(200).json({ ok: true, amountCents: patch.amount_cents, easerFirstName });
  }

  // ── fail: the confirmation did not happen. Close the row. ─────────────────
  // Without this a declined card leaves a pending row forever, and a pending row
  // blocks the customer from trying again.
  if (action === 'fail') {
    if (!existing || settled) return res.status(200).json({ ok: true });
    if (stripe && existing.stripe_payment_intent_id) {
      await stripe.paymentIntents.cancel(
        existing.stripe_payment_intent_id, {}, { stripeAccount: existing.stripe_account_id },
      ).catch(() => {});   // already cancelled or uncancellable is fine
    }
    await sb.from('booking_tips').update({ status: 'failed' }).eq('id', existing.id).eq('status', 'pending');
    return res.status(200).json({ ok: true, closed: true });
  }

  if (action !== 'send') return res.status(400).json({ error: `Unknown action: ${action}` });

  // Someone who declined and then changed their mind is welcome to tip — the
  // decline only stops us ASKING, it never blocks a customer who chose to give.

  if (settled) {
    return res.status(409).json({
      error: `You already sent ${easerFirstName} a tip for this job. Thank you.`,
      code: 'ALREADY_TIPPED',
    });
  }
  if (!canReceive) {
    return res.status(409).json({ error: `${easerFirstName} cannot receive tips yet.`, code: 'EASER_CANNOT_RECEIVE' });
  }

  const amount = Math.round(Number(amountCents));
  if (!Number.isFinite(amount) || amount < MIN_TIP_CENTS || amount > MAX_TIP_CENTS) {
    return res.status(400).json({
      error: `Choose an amount between $${(MIN_TIP_CENTS / 100).toFixed(2)} and $${(MAX_TIP_CENTS / 100).toFixed(0)}.`,
      code: 'AMOUNT_OUT_OF_RANGE',
    });
  }

  // Only meter the charge itself. Quoting is free — a customer deciding whether
  // to tip must never be told "too many requests".
  if (!await rateLimit(ip, 'default')) {
    return res.status(429).json({ error: 'Too many attempts. Please wait a moment and try again.' });
  }
  if (!stripe) {
    return res.status(503).json({ error: 'Tips are temporarily unavailable. Nothing was charged.' });
  }

  const accountId = easer.stripe_connect_account_id;

  // A pending row for the SAME amount is the same attempt — a refresh or a
  // second tap. Reuse its intent rather than creating another one the customer
  // could be charged for.
  if (existing && existing.status === 'pending' && existing.amount_cents === amount) {
    try {
      const prior = await stripe.paymentIntents.retrieve(
        existing.stripe_payment_intent_id, {}, { stripeAccount: existing.stripe_account_id },
      );
      if (prior.status !== 'canceled' && prior.client_secret) {
        return res.status(200).json({
          ok: true,
          clientSecret: prior.client_secret,
          stripeAccount: existing.stripe_account_id,
          amountCents: amount,
          easerFirstName,
          resumed: true,
        });
      }
    } catch { /* fall through and create a fresh one */ }
  }

  let intent;
  try {
    intent = await stripe.paymentIntents.create({
      amount,
      currency: 'usd',
      // No application_fee_amount. The platform takes nothing, and this is the
      // line that makes that true rather than merely stated.
      description: `Tip for ${easerFirstName} — ${booking.service || 'AssembleAtEase job'} (${booking.ref})`,
      receipt_email: booking.customer_email,
      metadata: {
        bookingId: booking.id,
        bookingRef: booking.ref,
        easerId: easer.id,
        type: 'customer_tip',
      },
      automatic_payment_methods: { enabled: true },
    }, {
      // Created ON the Easer's account. This is what makes the money theirs.
      stripeAccount: accountId,
      // One tip per booking, even if the button is double-tapped on a slow phone.
      idempotencyKey: `tip-${booking.id}-${amount}`,
    });
  } catch (err) {
    console.error('[tip] intent create failed:', err?.message || err);
    return res.status(402).json({
      error: err?.message || 'The tip could not be started. Nothing was charged.',
      code: 'TIP_INTENT_FAILED',
    });
  }

  // Recorded as PENDING, before the customer confirms — so a tip that succeeds
  // in Stripe can never be missing here, while a row never claims money that has
  // not moved. Promotion to 'succeeded' happens in the confirm action above,
  // only after Stripe itself is re-read.
  const row = {
    booking_id: booking.id,
    easer_id: easer.id,
    amount_cents: amount,
    stripe_account_id: accountId,
    stripe_payment_intent_id: intent.id,
    status: 'pending',
    customer_email: booking.customer_email,
  };

  let recordErr = null;
  if (existing && existing.status === 'pending') {
    // Same customer, new amount. Cancel the intent they are no longer paying so
    // it cannot sit authorisable on the Easer's account, then reuse the row —
    // the one-tip-per-booking index would refuse a second insert.
    if (existing.stripe_payment_intent_id !== intent.id) {
      await stripe.paymentIntents.cancel(
        existing.stripe_payment_intent_id, {}, { stripeAccount: existing.stripe_account_id },
      ).catch(() => {});
    }
    ({ error: recordErr } = await sb.from('booking_tips').update(row).eq('id', existing.id).eq('status', 'pending'));
  } else {
    ({ error: recordErr } = await sb.from('booking_tips').insert(row));
  }

  if (recordErr) {
    // Recording failed but the intent exists. Cancel it rather than leave a
    // chargeable intent nothing knows about.
    console.error('[tip] record failed, cancelling intent:', recordErr?.message || recordErr);
    await stripe.paymentIntents.cancel(intent.id, {}, { stripeAccount: accountId }).catch(() => {});
    return res.status(500).json({
      error: 'The tip could not be recorded, so nothing was charged. Please try again.',
      code: 'TIP_RECORD_FAILED',
    });
  }

  await logActivity(sb, {
    bookingId: booking.id,
    eventType: 'tip_started',
    actorType: 'customer',
    actorName: booking.customer_name || 'Customer',
    description: `Customer is sending ${easerFirstName} a $${(amount / 100).toFixed(2)} tip`,
    metadata: { easerId: easer.id, amountCents: amount, paymentIntentId: intent.id },
  }).catch(() => {});

  return res.status(200).json({
    ok: true,
    // The browser confirms on the CONNECTED account, so it needs both.
    clientSecret: intent.client_secret,
    stripeAccount: accountId,
    amountCents: amount,
    easerFirstName,
  });
}
