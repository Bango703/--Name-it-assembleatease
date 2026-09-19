import Stripe from 'stripe';
import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';
import { finishUnconfirmedHold } from '../cron/authorize-scheduled-payments.js';

// ─── Finish a card hold that was created but never confirmed ─────────────────
//
// reconcile-payment-authorization repairs a booking when Stripe ALREADY holds
// the money; it refuses a PaymentIntent sitting at `requires_confirmation`
// ("Stripe does not show a valid uncaptured authorization"). That is exactly
// what a dropped confirm call leaves behind, so on 2026-09-19 the owner's only
// remaining button was "Email Secure Payment Link" — asking a customer to
// re-confirm a card that was never the problem.
//
// This runs the same confirmation the nightly job runs, for one booking, now.
// It is the identical code path, not a second opinion: the cron's own
// finishUnconfirmedHold decides, and Stripe decides what that means.

export function describeRetryBlock(booking) {
  if (!booking) return { status: 404, code: 'BOOKING_NOT_FOUND', message: 'Booking not found.' };
  const bookingStatus = String(booking.status || '');
  const paymentStatus = String(booking.payment_status || '');
  if (bookingStatus !== 'confirmed') {
    return {
      status: 409,
      code: 'BOOKING_NOT_CONFIRMED',
      message: `This booking is ${bookingStatus || 'in an unknown state'}, so there is no scheduled hold to finish.`,
    };
  }
  if (paymentStatus === 'authorized') {
    return { status: 409, code: 'ALREADY_AUTHORIZED', message: 'The hold is already authorized. Nothing to retry.' };
  }
  if (paymentStatus !== 'pending') {
    return {
      status: 409,
      code: 'PAYMENT_STATE_NOT_RETRYABLE',
      message: `This booking's payment is "${paymentStatus || 'missing'}". Only a hold that was created and left unconfirmed can be retried here.`,
    };
  }
  if (!booking.stripe_payment_intent_id) {
    return {
      status: 409,
      code: 'NO_HOLD_TO_FINISH',
      message: 'No hold has been created for this booking yet, so there is nothing to confirm.',
    };
  }
  if (!booking.stripe_payment_method_id) {
    return {
      status: 409,
      code: 'NO_SAVED_CARD',
      message: 'This booking carries no saved card, so a hold cannot be placed without the customer.',
    };
  }
  if (booking.financial_operation_key) {
    return {
      status: 409,
      code: 'OPERATION_IN_FLIGHT',
      message: 'Another payment operation is running on this booking. Wait for it to finish before retrying.',
    };
  }
  return null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });
  if (!process.env.STRIPE_SECRET_KEY) return res.status(503).json({ error: 'Stripe is not configured.' });

  const bookingId = String(req.body?.bookingId || '').trim();
  if (!bookingId) return res.status(400).json({ error: 'bookingId is required' });

  const sb = getSupabase();
  const { data: booking, error: lookupError } = await sb.from('bookings')
    .select('*')
    .eq('id', bookingId)
    .maybeSingle();
  if (lookupError) return res.status(503).json({ error: 'Booking payment state could not be loaded.' });

  const block = describeRetryBlock(booking);
  if (block) return res.status(block.status).json({ error: block.message, code: block.code });

  const secret = String(process.env.STRIPE_SECRET_KEY);
  const expectedLivemode = secret.startsWith('sk_live_') ? true : (secret.startsWith('sk_test_') ? false : null);
  const stripe = new Stripe(secret);
  const outcome = await finishUnconfirmedHold({ sb, stripe, booking, expectedLivemode });

  if (outcome.authorized) {
    return res.status(200).json({
      ok: true,
      bookingRef: booking.ref,
      authorized: true,
      message: `The hold is authorized for ${booking.ref}. Dispatch is open again${booking.assembler_id ? ' and the assigned Easer has been told it cleared' : ''}.`,
    });
  }

  // finishUnconfirmedHold reports a null reason when Stripe is genuinely waiting
  // on the cardholder: that is the one case where the customer has to act, and
  // the secure link has already gone out.
  if (outcome.reason == null) {
    return res.status(409).json({
      ok: false,
      code: 'CUSTOMER_ACTION_REQUIRED',
      error: "Stripe is waiting on the customer's bank this time, so the hold cannot be finished from here. The secure link has already been sent to them.",
    });
  }

  // Article 16: the server's reason, not a guess.
  return res.status(502).json({
    ok: false,
    code: 'RETRY_FAILED',
    error: `The hold could not be finished (${outcome.reason}). Nothing was charged and the booking is unchanged.`,
  });
}
