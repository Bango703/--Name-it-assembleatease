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
 * Actions:
 *   quote   — what may be tipped, and whether this Easer can receive one. No write.
 *   send    — charge it.
 *   decline — the customer said no. Recorded so they are never asked again:
 *             being asked twice for money you already declined reads as nagging
 *             and makes "completely optional" look untrue.
 */

const MIN_TIP_CENTS = 100;
const MAX_TIP_CENTS = 50000;   // $500 — a fat-finger ceiling, not a policy on generosity

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

  // Already tipped? Say so rather than letting a refresh charge again.
  const { data: existing } = await sb
    .from('booking_tips')
    .select('id, amount_cents, created_at')
    .eq('booking_id', booking.id)
    .neq('status', 'failed')
    .maybeSingle();

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
      alreadyTipped: existing ? { amountCents: existing.amount_cents, at: existing.created_at } : null,
      minCents: MIN_TIP_CENTS,
      maxCents: MAX_TIP_CENTS,
      // The server's real reason, so the page never invents one (Article 16).
      reason: canReceive ? null : `${easerFirstName} hasn't finished setting up payouts yet, so tips can't be sent for this job.`,
    });
  }
  if (action !== 'send') return res.status(400).json({ error: `Unknown action: ${action}` });

  // Someone who declined and then changed their mind is welcome to tip — the
  // decline only stops us ASKING, it never blocks a customer who chose to give.

  if (existing) {
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
  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(503).json({ error: 'Tips are temporarily unavailable. Nothing was charged.' });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const accountId = easer.stripe_connect_account_id;

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

  // The row is written BEFORE the customer confirms payment, so a tip that
  // succeeds in Stripe can never be missing here — the webhook and the
  // reconciler both need something to find. Status is corrected on confirmation.
  const { error: insertErr } = await sb.from('booking_tips').insert({
    booking_id: booking.id,
    easer_id: easer.id,
    amount_cents: amount,
    stripe_account_id: accountId,
    stripe_payment_intent_id: intent.id,
    status: 'succeeded',
    customer_email: booking.customer_email,
  });
  if (insertErr) {
    // Recording failed but the intent exists. Cancel it rather than leave a
    // chargeable intent nothing knows about.
    console.error('[tip] record failed, cancelling intent:', insertErr?.message || insertErr);
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
