import Stripe from 'stripe';
import { getSupabase } from '../_supabase.js';
import { verifyOwner, sendEmail, buildStatusEmail, ownerEmail, esc } from '../_email.js';
import { logActivity } from '../booking/_activity.js';
import { normalizeOwnerOfflinePaymentMethod } from './_offline-payment.js';

export const MAX_PAYMENT_CENTS = 2_500_000;

function cleanCents(value) {
  const cents = Number.parseInt(value, 10);
  return Number.isInteger(cents) ? cents : null;
}

function stripeId(value, prefix) {
  const id = String(value || '').trim();
  return new RegExp(`^${prefix}_[A-Za-z0-9]+$`).test(id) ? id : null;
}

function stripeObjectId(value) {
  return typeof value === 'string' ? value : value?.id || null;
}

export function expectedLiveMode() {
  const secret = String(process.env.STRIPE_SECRET_KEY || '');
  if (secret.startsWith('sk_live_')) return true;
  if (secret.startsWith('sk_test_')) return false;
  return null;
}

function money(cents) {
  return `$${(Number(cents || 0) / 100).toFixed(2)}`;
}

async function loadBooking(sb, { bookingId, ref }) {
  let query = sb.from('bookings')
    .select('id, ref, source, status, payment_status, service, total_price, refund_amount, customer_name, customer_email, financial_operation_key, financial_operation_type, financial_operation_started_at, financial_reconciliation_required_at');
  query = bookingId ? query.eq('id', bookingId) : query.eq('ref', ref);
  return query.single();
}

export default async function handler(req, res) {
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const sb = getSupabase();
  const payload = (req.body && typeof req.body === 'object') ? req.body : {};
  const bookingId = String(payload.bookingId || req.query?.bookingId || '').trim();
  const ref = String(payload.ref || req.query?.ref || '').trim().toUpperCase();
  if (!bookingId && !ref) return res.status(400).json({ error: 'bookingId or ref is required' });

  if (req.method === 'GET') {
    const { data: booking, error: bookingError } = await loadBooking(sb, { bookingId, ref });
    if (bookingError || !booking) return res.status(404).json({ error: 'Booking not found' });

    const { data: events, error: eventsError } = await sb
      .from('owner_manual_payment_events')
      .select('id, amount_cents, refunded_cents, latest_refund_id, refunded_at, refund_reason, currency, payment_method, processing_fee_cents, stripe_payment_intent_id, stripe_charge_id, stripe_created_at, booking_total_before_cents, booking_total_after_cents, discount_cents, adjustment_note, payment_note, recorded_by, created_at')
      .eq('booking_id', booking.id)
      .order('created_at', { ascending: true });
    if (eventsError) {
      console.error('Owner manual payment event lookup failed:', eventsError);
      return res.status(503).json({
        error: 'Payment and refund history is unavailable. Apply migration 045 and retry.',
        code: 'OWNER_MANUAL_REFUND_LEDGER_UNAVAILABLE',
      });
    }

    const grossCollectedCents = (events || []).reduce(
      (sum, event) => sum + Number(event.amount_cents || 0),
      0,
    );
    const refundedCents = (events || []).reduce(
      (sum, event) => sum + Number(event.refunded_cents || 0),
      0,
    );
    const amountCollectedCents = Math.max(0, grossCollectedCents - refundedCents);
    return res.status(200).json({
      bookingId: booking.id,
      ref: booking.ref,
      totalCents: Number(booking.total_price || 0),
      grossCollectedCents,
      refundedCents,
      amountCollectedCents,
      remainingBalanceCents: Math.max(0, Number(booking.total_price || 0) - grossCollectedCents),
      events: events || [],
    });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(503).json({
      error: 'Stripe verification is unavailable. The payment was not recorded.',
      code: 'STRIPE_CONFIGURATION_UNAVAILABLE',
    });
  }

  const hasSubmittedAmount = payload.amountCents != null && payload.amountCents !== '';
  const submittedAmountCents = hasSubmittedAmount ? cleanCents(payload.amountCents) : null;
  const expectedTotalCents = cleanCents(payload.expectedTotalCents);
  const hasSubmittedDiscount = payload.discountCents != null && payload.discountCents !== '';
  const submittedDiscountCents = hasSubmittedDiscount ? cleanCents(payload.discountCents) : null;
  const legacyAdjustedTotalCents = payload.adjustedTotalCents == null || payload.adjustedTotalCents === ''
    ? null
    : cleanCents(payload.adjustedTotalCents);
  const adjustedTotalCents = hasSubmittedDiscount
    ? expectedTotalCents - submittedDiscountCents
    : (legacyAdjustedTotalCents ?? expectedTotalCents);
  const paymentMethod = normalizeOwnerOfflinePaymentMethod(payload.paymentMethod);
  const paymentIntentId = stripeId(payload.paymentIntentId, 'pi');
  const adjustmentNote = String(payload.adjustmentNote || '').trim().replace(/\s+/g, ' ').slice(0, 500);
  const paymentNote = String(payload.paymentNote || '').trim().replace(/\s+/g, ' ').slice(0, 500);

  if (hasSubmittedAmount
      && (!submittedAmountCents || submittedAmountCents <= 0 || submittedAmountCents > MAX_PAYMENT_CENTS)) {
    return res.status(400).json({ error: 'The submitted payment amount is invalid.' });
  }
  if (!expectedTotalCents || expectedTotalCents <= 0 || !adjustedTotalCents || adjustedTotalCents <= 0) {
    return res.status(400).json({ error: 'The booking total and discount must leave a positive agreed total.' });
  }
  if (hasSubmittedDiscount
      && (!Number.isInteger(submittedDiscountCents) || submittedDiscountCents < 0)) {
    return res.status(400).json({ error: 'The discount amount is invalid.' });
  }
  if (hasSubmittedDiscount
      && legacyAdjustedTotalCents != null
      && legacyAdjustedTotalCents !== adjustedTotalCents) {
    return res.status(400).json({
      error: 'The discount does not match the adjusted booking total. Refresh and retry.',
      code: 'BOOKING_DISCOUNT_MISMATCH',
    });
  }
  if (adjustedTotalCents > expectedTotalCents) {
    return res.status(400).json({
      error: 'This payment action cannot increase the customer total. Use a customer-approved change order.',
      code: 'PRICE_INCREASE_REQUIRES_CHANGE_ORDER',
    });
  }
  if (adjustedTotalCents < expectedTotalCents && !adjustmentNote) {
    return res.status(400).json({ error: 'Document the customer discount before recording this payment.' });
  }
  if (paymentMethod !== 'stripe_manual') {
    return res.status(400).json({
      error: 'This verified partial-payment action currently supports manual Stripe payments only.',
      code: 'STRIPE_MANUAL_PAYMENT_REQUIRED',
    });
  }
  if (!paymentIntentId) {
    return res.status(400).json({ error: 'Enter the exact Stripe PaymentIntent ID beginning with pi_.' });
  }

  const { data: booking, error: bookingError } = await loadBooking(sb, { bookingId, ref });
  if (bookingError || !booking) return res.status(404).json({ error: 'Booking not found' });
  if (booking.source !== 'owner_manual' || booking.payment_status !== 'offline_recorded') {
    return res.status(409).json({
      error: 'Only owner-created offline bookings can record this type of payment.',
      code: 'OWNER_MANUAL_BOOKING_REQUIRED',
    });
  }
  if (booking.financial_operation_key
      || booking.financial_operation_type
      || booking.financial_operation_started_at
      || booking.financial_reconciliation_required_at) {
    return res.status(409).json({
      error: 'Resolve the current financial operation before recording this payment.',
      code: 'FINANCIAL_OPERATION_IN_PROGRESS',
    });
  }

  const { data: existingEvents, error: existingEventsError } = await sb
    .from('owner_manual_payment_events')
    .select('amount_cents, refunded_cents, stripe_payment_intent_id')
    .eq('booking_id', booking.id);
  if (existingEventsError) {
    return res.status(503).json({
      error: 'Existing customer payments could not be verified. Nothing was recorded.',
      code: 'OWNER_MANUAL_PAYMENT_LEDGER_UNAVAILABLE',
    });
  }
  const existingPaymentRetry = (existingEvents || []).some(event =>
    event.stripe_payment_intent_id === paymentIntentId);
  if (Number(booking.total_price) !== expectedTotalCents && !existingPaymentRetry) {
    return res.status(409).json({
      error: `The booking total is now ${money(booking.total_price)}. Refresh before recording customer money.`,
      code: 'BOOKING_TOTAL_CHANGED',
    });
  }
  const existingGrossCents = (existingEvents || []).reduce(
    (sum, event) => sum + Number(event.amount_cents || 0),
    0,
  );
  if (!existingPaymentRetry && existingGrossCents >= Number(booking.total_price || 0)) {
    return res.status(409).json({
      error: Number(booking.refund_amount || 0) > 0
        ? 'The agreed total was already paid before the recorded refund. A refund does not create a new customer balance; do not charge the customer again.'
        : 'The agreed booking total is already fully paid. Do not record another customer payment.',
      code: 'OWNER_MANUAL_INVOICE_ALREADY_PAID',
    });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  let intent;
  try {
    intent = await stripe.paymentIntents.retrieve(paymentIntentId, {
      expand: ['latest_charge.balance_transaction'],
    });
  } catch (stripeError) {
    console.error('Manual Stripe PaymentIntent lookup failed:', stripeError);
    return res.status(409).json({
      error: 'Stripe could not verify that PaymentIntent. Copy the exact pi_ ID from Stripe and retry.',
      code: 'STRIPE_PAYMENT_NOT_VERIFIED',
    });
  }

  const charge = intent?.latest_charge;
  const amountCents = Number(intent?.amount_received);
  const chargeId = stripeId(stripeObjectId(charge), 'ch');
  const balanceTransaction = charge && typeof charge === 'object' ? charge.balance_transaction : null;
  const processingFeeCents = Number(balanceTransaction?.fee);
  const keyLiveMode = expectedLiveMode();
  const metadataBookingId = String(intent?.metadata?.bookingId || '').trim();
  const chargePaymentIntentId = stripeObjectId(charge?.payment_intent);

  if (!intent
      || intent.status !== 'succeeded'
      || intent.currency !== 'usd'
      || !Number.isSafeInteger(amountCents)
      || amountCents <= 0
      || amountCents > MAX_PAYMENT_CENTS
      || (hasSubmittedAmount && submittedAmountCents !== amountCents)
      || (keyLiveMode != null && intent.livemode !== keyLiveMode)
      || !charge
      || typeof charge !== 'object'
      || charge.status !== 'succeeded'
      || charge.paid !== true
      || charge.captured !== true
      || charge.currency !== 'usd'
      || (keyLiveMode != null && charge.livemode !== keyLiveMode)
      || (chargePaymentIntentId && chargePaymentIntentId !== paymentIntentId)
      || Number(charge.amount_captured || charge.amount) !== amountCents
      || Number(charge.amount_refunded || 0) !== 0
      || charge.refunded === true
      || charge.disputed === true
      || !chargeId
      || (metadataBookingId && metadataBookingId !== booking.id)) {
    return res.status(409).json({
      error: 'Stripe payment truth does not match this booking, amount, currency, or successful unrefunded state.',
      code: 'STRIPE_PAYMENT_MISMATCH',
    });
  }
  if (!existingPaymentRetry && existingGrossCents + amountCents > adjustedTotalCents) {
    return res.status(409).json({
      error: `Recording ${money(amountCents)} would exceed the ${money(adjustedTotalCents)} agreed customer total. Nothing was recorded.`,
      code: 'OWNER_MANUAL_PAYMENT_EXCEEDS_BALANCE',
    });
  }
  if (!Number.isInteger(processingFeeCents) || processingFeeCents < 0) {
    return res.status(409).json({
      error: 'Stripe has not exposed the final processing fee yet. Wait and retry; no estimate was recorded.',
      code: 'STRIPE_PROCESSING_FEE_UNAVAILABLE',
    });
  }

  const stripeCreatedAt = new Date(Number(intent.created) * 1000);
  if (!Number.isFinite(stripeCreatedAt.getTime())) {
    return res.status(409).json({
      error: 'Stripe payment time is unavailable. The payment was not recorded.',
      code: 'STRIPE_PAYMENT_TIME_UNAVAILABLE',
    });
  }

  const operationKey = `owner-manual-payment:${booking.id}:${paymentIntentId}`;
  const { data: rpcRows, error: rpcError } = await sb.rpc('record_owner_manual_payment_event_v4', {
    p_booking_id: booking.id,
    p_operation_key: operationKey,
    p_expected_total_cents: expectedTotalCents,
    p_adjusted_total_cents: adjustedTotalCents,
    p_adjustment_note: adjustmentNote || null,
    p_amount_cents: amountCents,
    p_payment_method: paymentMethod,
    p_processing_fee_cents: processingFeeCents,
    p_stripe_payment_intent_id: paymentIntentId,
    p_stripe_charge_id: chargeId,
    p_stripe_created_at: stripeCreatedAt.toISOString(),
    p_payment_note: paymentNote || null,
    p_recorded_by: 'owner',
  });

  if (rpcError) {
    console.error('Record owner-manual payment RPC failed:', rpcError);
    const migrationMissing = /record_owner_manual_payment_event_v4|owner_manual_payment_events|does not exist/i
      .test(String(rpcError.message || ''));
    return res.status(migrationMissing ? 503 : 409).json({
      error: migrationMissing
        ? 'Owner-manual payment protection is unavailable. Apply migration 049 and retry.'
        : 'Payment could not be reconciled safely. Refresh the booking and verify Stripe before retrying.',
      code: migrationMissing ? 'MIGRATION_049_REQUIRED' : 'PAYMENT_RECONCILIATION_CONFLICT',
    });
  }

  const result = Array.isArray(rpcRows) ? rpcRows[0] : rpcRows;
  if (!result) {
    return res.status(503).json({ error: 'Payment reconciliation returned no verified result.' });
  }

  await logActivity(sb, {
    bookingId: booking.id,
    eventType: result.result_action === 'already_recorded'
      ? 'partial_payment_reverified'
      : 'partial_payment_collected',
    actorType: 'owner',
    actorName: 'Owner',
    description: `${money(amountCents)} Stripe payment ${result.result_action === 'already_recorded' ? 'reverified' : 'recorded'}. ${money(result.remaining_balance_cents)} remains on the agreed ${money(result.adjusted_total_cents)} total.`,
    metadata: {
      paymentMethod,
      paymentIntentId,
      chargeId,
      amountCents,
      processingFeeCents,
      adjustedTotalCents: Number(result.adjusted_total_cents),
      amountCollectedCents: Number(result.amount_collected_cents),
      remainingBalanceCents: Number(result.remaining_balance_cents),
      paymentCollected: result.payment_collected === true,
      discountCents: expectedTotalCents - adjustedTotalCents,
      adjustmentNote: adjustmentNote || null,
    },
  }).catch(error => console.warn('Partial-payment activity log skipped:', error?.message || error));

  let notificationDelivered = null;
  let notificationError = null;
  if (result.result_action !== 'already_recorded' && booking.customer_email) {
    const paidCents = Number(result.amount_collected_cents);
    const remainingCents = Number(result.remaining_balance_cents);
    const fullyPaid = result.payment_collected === true;
    const emailResult = await sendEmail({
      to: booking.customer_email,
      from: 'AssembleAtEase <booking@assembleatease.com>',
      subject: `Payment received — ${money(amountCents)} — ${booking.ref}`,
      html: buildStatusEmail({
        customerName: booking.customer_name,
        ref: booking.ref,
        status: fullyPaid ? 'PAID IN FULL' : 'PAYMENT RECEIVED',
        statusColor: '#065f46',
        statusBg: '#d1fae5',
        headline: fullyPaid ? 'Your balance is paid in full.' : 'We recorded your payment.',
        bodyHtml: `<p style="margin:0 0 16px;font-size:15px;color:#52525b;line-height:1.7">We recorded a verified Stripe payment for your <strong>${esc(booking.service || 'AssembleAtEase')}</strong> service.</p>
          <table width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;margin-bottom:18px">
            <tr><td style="padding:8px 0;border-bottom:1px solid #e4e4e7;color:#71717a">Payment received</td><td style="padding:8px 0;border-bottom:1px solid #e4e4e7;text-align:right;font-weight:700">${money(amountCents)}</td></tr>
            <tr><td style="padding:8px 0;border-bottom:1px solid #e4e4e7;color:#71717a">Total payments recorded</td><td style="padding:8px 0;border-bottom:1px solid #e4e4e7;text-align:right;font-weight:700">${money(paidCents)}</td></tr>
            <tr><td style="padding:8px 0;border-bottom:1px solid #e4e4e7;color:#71717a">Agreed customer total</td><td style="padding:8px 0;border-bottom:1px solid #e4e4e7;text-align:right;font-weight:700">${money(result.adjusted_total_cents)}</td></tr>
            <tr><td style="padding:8px 0;color:#71717a">Remaining balance</td><td style="padding:8px 0;text-align:right;font-weight:800;color:#065f46">${money(remainingCents)}</td></tr>
          </table>
          <p style="margin:0;font-size:13px;color:#71717a;line-height:1.6">This receipt confirms payment only. Your booking status and any remaining service work are shown separately in your AssembleAtEase booking updates.</p>`,
      }),
      replyTo: ownerEmail(),
      meta: {
        bookingId: booking.id,
        notificationType: 'payment_receipt',
        recipientType: 'customer',
        disableDedupe: true,
      },
    }).catch(error => ({ ok: false, error: error?.message || String(error) }));
    notificationDelivered = emailResult?.ok === true;
    notificationError = emailResult?.ok ? null : (emailResult?.error || 'Delivery failed');
    if (!notificationDelivered) {
      await logActivity(sb, {
        bookingId: booking.id,
        eventType: 'payment_receipt_failed',
        actorType: 'system',
        actorName: 'Notifications',
        description: 'Customer payment was recorded, but the AAE payment receipt email failed.',
        metadata: { paymentIntentId, amountCents, error: notificationError },
      });
    }
  }

  return res.status(200).json({
    ok: true,
    alreadyRecorded: result.result_action === 'already_recorded',
    bookingId: result.booking_id,
    ref: result.booking_ref,
    adjustedTotalCents: Number(result.adjusted_total_cents),
    amountCollectedCents: Number(result.amount_collected_cents),
    remainingBalanceCents: Number(result.remaining_balance_cents),
    processingFeeTotalCents: Number(result.processing_fee_total_cents),
    paymentCollected: result.payment_collected === true,
    notificationDelivered,
    notificationError,
  });
}
