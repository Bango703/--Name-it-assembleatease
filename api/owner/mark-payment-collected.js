import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';
import { logActivity } from '../booking/_activity.js';
import {
  normalizeOwnerOfflinePaymentMethod,
  offlineMethodFeeCents,
} from './_offline-payment.js';

// Owner confirms that an owner-created booking was paid outside the platform.
// Online bookings continue to use Stripe as their payment source of truth.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const { bookingId, ref, paymentMethod, confirmedAmountCents } = req.body || {};
  if (!bookingId && !ref) return res.status(400).json({ error: 'bookingId or ref is required' });

  const normalizedMethod = normalizeOwnerOfflinePaymentMethod(paymentMethod);
  if (!normalizedMethod) {
    return res.status(400).json({
      error: 'Select the verified offline customer payment method.',
      code: 'OFFLINE_PAYMENT_METHOD_REQUIRED',
    });
  }
  if (['stripe_manual', 'card_on_site'].includes(normalizedMethod)) {
    return res.status(409).json({
      error: 'Stripe card payments must be verified by PaymentIntent through Record Stripe Payment.',
      code: 'STRIPE_PAYMENT_INTENT_VERIFICATION_REQUIRED',
    });
  }

  const sb = getSupabase();
  let query = sb.from('bookings').select('id, ref, source, status, payment_status, payment_method, payment_collected, payment_collected_at, payment_collected_by, amount_charged, total_price, financial_operation_key, financial_operation_type, financial_operation_started_at');
  query = bookingId ? query.eq('id', bookingId) : query.eq('ref', ref);
  const { data: booking, error: fetchErr } = await query.single();
  if (fetchErr || !booking) return res.status(404).json({ error: 'Booking not found' });

  if (booking.source !== 'owner_manual') {
    return res.status(409).json({
      error: 'Payment collection is tracked automatically for online bookings.',
      code: 'NOT_AN_OWNER_BOOKING',
    });
  }
  if (booking.payment_status !== 'offline_recorded') {
    return res.status(409).json({
      error: 'This booking is not in the offline payment workflow.',
      code: 'OFFLINE_PAYMENT_STATE_REQUIRED',
    });
  }
  if (!['confirmed', 'en_route', 'arrived', 'in_progress', 'completed'].includes(booking.status)) {
    return res.status(409).json({
      error: `Offline customer collection cannot be recorded for a ${booking.status} booking. Reconcile the booking first.`,
      code: 'OFFLINE_PAYMENT_BOOKING_STATE_INVALID',
    });
  }
  if (booking.financial_operation_key
      || booking.financial_operation_type
      || booking.financial_operation_started_at) {
    return res.status(409).json({
      error: 'A completion, cancellation, or payout action is in progress. Wait for it to finish before recording customer collection.',
      code: 'FINANCIAL_OPERATION_IN_PROGRESS',
    });
  }

  const canonicalAmountCents = Number(booking.amount_charged ?? booking.total_price ?? 0);
  const confirmedCents = Number(confirmedAmountCents);
  if (!Number.isInteger(canonicalAmountCents) || canonicalAmountCents <= 0) {
    return res.status(409).json({
      error: 'The booking total is missing. Reconcile the booking before recording collection.',
      code: 'OFFLINE_PAYMENT_AMOUNT_MISSING',
    });
  }
  if (!Number.isInteger(confirmedCents) || confirmedCents !== canonicalAmountCents) {
    return res.status(409).json({
      error: `Confirm the exact recorded customer total of $${(canonicalAmountCents / 100).toFixed(2)}.`,
      code: 'OFFLINE_PAYMENT_AMOUNT_MISMATCH',
    });
  }

  const existingMethod = normalizeOwnerOfflinePaymentMethod(booking.payment_method);
  if (booking.payment_collected === true && existingMethod) {
    if (existingMethod !== normalizedMethod) {
      return res.status(409).json({
        error: `Payment is already recorded using ${existingMethod.replace(/_/g, ' ')}. Reconcile the existing record before changing its method.`,
        code: 'OFFLINE_PAYMENT_METHOD_MISMATCH',
      });
    }
    return res.status(200).json({
      ok: true,
      alreadyCollected: true,
      bookingId: booking.id,
      ref: booking.ref,
      paymentMethod: existingMethod,
    });
  }

  const now = new Date().toISOString();
  const updatePayload = {
    payment_collected: true,
    payment_collected_at: booking.payment_collected_at || now,
    payment_collected_by: booking.payment_collected_by || 'owner',
    payment_method: normalizedMethod,
    // This is the final server-side payment-method truth. Recompute the fee here
    // so a booking created as "to be collected" cannot retain a false $0 fee
    // when the customer ultimately pays by card.
    stripe_fee: offlineMethodFeeCents(normalizedMethod, canonicalAmountCents),
  };
  let updateQuery = sb.from('bookings').update(updatePayload)
    .eq('id', booking.id)
    .eq('status', booking.status)
    .eq('source', 'owner_manual')
    .eq('payment_status', 'offline_recorded')
    .is('financial_operation_key', null)
    .is('financial_operation_type', null)
    .is('financial_operation_started_at', null);
  if (booking.amount_charged == null) {
    updateQuery = updateQuery.is('amount_charged', null).eq('total_price', booking.total_price);
  } else {
    updateQuery = updateQuery.eq('amount_charged', booking.amount_charged);
  }
  if (booking.payment_collected !== true) {
    updateQuery = updateQuery.eq('payment_collected', false);
  } else if (booking.payment_method == null) {
    updateQuery = updateQuery.eq('payment_collected', true).is('payment_method', null);
  } else {
    updateQuery = updateQuery.eq('payment_collected', true).eq('payment_method', booking.payment_method);
  }
  const { data: rows, error: updateErr } = await updateQuery.select('id');

  if (updateErr) {
    console.error('Mark payment collected error:', updateErr);
    return res.status(500).json({ error: 'Failed to record payment collection.' });
  }
  if (!rows?.length) {
    return res.status(409).json({
      error: 'Payment collection changed while this confirmation was open. Refresh the booking and verify it before retrying.',
      code: 'OFFLINE_PAYMENT_COLLECTION_CONFLICT',
    });
  }

  logActivity(sb, {
    bookingId: booking.id,
    eventType: 'payment_collected',
    actorType: 'owner',
    actorName: 'Owner',
    description: `Owner recorded offline payment collected - $${(canonicalAmountCents / 100).toFixed(2)} via ${normalizedMethod.replace(/_/g, ' ')}.`,
    metadata: {
      source: 'owner_manual',
      paymentMethod: normalizedMethod,
      amountCents: canonicalAmountCents,
      repairedMissingMethod: booking.payment_collected === true && !existingMethod,
    },
  }).catch(e => console.warn('Payment-collected activity log skipped:', e?.message || e));

  return res.status(200).json({
    ok: true,
    collected: true,
    bookingId: booking.id,
    ref: booking.ref,
    paymentMethod: normalizedMethod,
    amountCents: canonicalAmountCents,
  });
}
