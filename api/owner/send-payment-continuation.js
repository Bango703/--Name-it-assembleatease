import Stripe from 'stripe';
import { getSupabase } from '../_supabase.js';
import { esc, sendEmail, ownerEmail, verifyOwner } from '../_email.js';
import { randomToken, sha256 } from '../_payment-security.js';
import { logActivity } from '../booking/_activity.js';
import {
  isRecoverablePaymentIntentStatus,
  isStandardRecoveryBooking,
  validateBookingPaymentIntent,
} from '../booking/_pending-payment-recovery.js';

const SITE = String(process.env.PUBLIC_SITE_URL || 'https://www.assembleatease.com').replace(/\/$/, '');

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const bookingId = String(req.body?.bookingId || '').trim();
  if (!bookingId) return res.status(400).json({ error: 'bookingId is required' });
  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_PUBLISHABLE_KEY) {
    return res.status(503).json({ error: 'Secure payment recovery is not configured.' });
  }

  const sb = getSupabase();
  const { data: booking, error: bookingError } = await sb.from('bookings')
    .select('id, ref, service, status, payment_status, dispatch_status, customer_name, customer_email, total_price, stripe_payment_intent_id, stripe_customer_id, guest_mutation_token_hash, created_at, financial_operation_key, financial_operation_type, financial_operation_started_at')
    .eq('id', bookingId)
    .maybeSingle();

  if (bookingError) return res.status(503).json({ error: 'Booking payment state could not be verified.' });
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  if (!booking.customer_email) return res.status(409).json({ error: 'This booking has no customer email address.' });
  if (hasActiveFinancialOperation(booking)) {
    return res.status(409).json({
      error: 'Another payment or cancellation operation is in progress. Resolve it before contacting the customer.',
      code: 'FINANCIAL_OPERATION_IN_PROGRESS',
    });
  }
  if (!isStandardRecoveryBooking(booking)) {
    return res.status(409).json({
      error: 'Only an incomplete standard card authorization can receive a payment continuation email.',
      code: 'PAYMENT_RECOVERY_NOT_ALLOWED',
    });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  let intent;
  try {
    intent = await stripe.paymentIntents.retrieve(booking.stripe_payment_intent_id);
  } catch (stripeError) {
    console.error('[send-payment-continuation] Stripe lookup failed:', stripeError?.message || stripeError);
    return res.status(502).json({ error: 'Stripe payment state could not be verified. No email was sent.' });
  }

  let validation = validateBookingPaymentIntent(booking, intent);
  if (!validation.ok) {
    console.error('[send-payment-continuation] PaymentIntent mismatch:', {
      bookingId: booking.id,
      paymentIntentId: intent?.id || null,
      errors: validation.errors,
    });
    return res.status(409).json({
      error: 'Stripe payment details do not match this booking. Reconcile the booking before contacting the customer.',
      code: 'PAYMENT_RECOVERY_STRIPE_MISMATCH',
    });
  }
  if (intent.status === 'canceled') {
    const oldIntentId = intent.id;
    const preCreateState = await ownerRecoveryStillUnlocked({
      sb,
      booking,
      paymentIntentId: oldIntentId,
      paymentStatus: booking.payment_status,
    });
    if (!preCreateState.ok) {
      return res.status(preCreateState.status).json({
        error: preCreateState.status >= 500
          ? 'Booking payment state could not be verified. No new authorization was created.'
          : 'Booking payment state changed or another financial operation started. No new authorization was created.',
        code: preCreateState.status === 409 ? 'PAYMENT_RECOVERY_STATE_CONFLICT' : 'PAYMENT_RECOVERY_STATE_UNAVAILABLE',
      });
    }

    let replacement;
    try {
      replacement = await stripe.paymentIntents.create({
        amount: Number(booking.total_price || 0),
        currency: 'usd',
        ...(booking.stripe_customer_id ? { customer: booking.stripe_customer_id } : {}),
        capture_method: 'manual',
        setup_future_usage: 'off_session',
        payment_method_types: ['card'],
        receipt_email: booking.customer_email,
        statement_descriptor_suffix: 'ASSEMBLEATEASE',
        description: `Payment recovery - ${booking.service} - ${booking.customer_name}`,
        metadata: {
          bookingRef: booking.ref,
          bookingId: booking.id,
          type: 'customer_booking',
          replacesPaymentIntentId: oldIntentId,
          paymentRecovery: 'true',
        },
      }, { idempotencyKey: `booking-payment-recovery-replace-${booking.id}-${oldIntentId}` });
    } catch (replacementError) {
      console.error('[send-payment-continuation] Replacement PaymentIntent failed:', replacementError?.message || replacementError);
      return res.status(502).json({ error: 'A new secure card authorization could not be prepared. No email was sent.' });
    }

    const replacementValidation = validateBookingPaymentIntent({ ...booking, stripe_payment_intent_id: replacement.id }, replacement);
    if (!replacementValidation.ok || !isRecoverablePaymentIntentStatus(replacement.status)) {
      await cancelProvenUnlinkedPaymentIntent({
        stripe,
        sb,
        bookingId: booking.id,
        paymentIntentId: replacement.id,
        context: 'send-payment-continuation-invalid-replacement',
      });
      return res.status(502).json({ error: 'Stripe returned an invalid replacement authorization. No email was sent.' });
    }
    const { data: linkedRows, error: linkError } = await sb.from('bookings').update({
      stripe_payment_intent_id: replacement.id,
      payment_status: 'pending',
    })
      .eq('id', booking.id)
      .eq('status', booking.status)
      .eq('payment_status', booking.payment_status)
      .eq('stripe_payment_intent_id', oldIntentId)
      .is('financial_operation_key', null)
      .is('financial_operation_type', null)
      .is('financial_operation_started_at', null)
      .select('id');
    if (linkError || !linkedRows?.length) {
      const { data: current, error: currentError } = await sb.from('bookings')
        .select('id, status, payment_status, stripe_payment_intent_id, financial_operation_key, financial_operation_type, financial_operation_started_at')
        .eq('id', booking.id)
        .maybeSingle();
      if (currentError) {
        await logPaymentReconciliation(sb, {
          bookingId: booking.id,
          eventType: 'payment_recovery_linkage_ambiguous',
          description: 'A replacement PaymentIntent was created, but its booking linkage could not be verified. It was not cancelled automatically.',
          paymentIntentId: replacement.id,
        });
        return res.status(503).json({
          error: 'The new authorization linkage could not be verified. No email was sent; owner reconciliation is required.',
          code: 'PAYMENT_RECOVERY_LINKAGE_AMBIGUOUS',
        });
      }

      const replacementIsLinked = current?.stripe_payment_intent_id === replacement.id;
      const linkedByConcurrentRequest = replacementIsLinked
        && current?.status === booking.status
        && current?.payment_status === 'pending'
        && !hasActiveFinancialOperation(current);
      let linkedByRecoveryCas = false;
      const originalLinkStateStillPresent = current?.status === booking.status
        && current?.payment_status === booking.payment_status
        && current?.stripe_payment_intent_id === oldIntentId
        && !hasActiveFinancialOperation(current);
      if (!replacementIsLinked && originalLinkStateStillPresent) {
        const { data: recoveryRows, error: recoveryError } = await sb.from('bookings').update({
          stripe_payment_intent_id: replacement.id,
          payment_status: 'pending',
        })
          .eq('id', booking.id)
          .eq('status', booking.status)
          .eq('payment_status', booking.payment_status)
          .eq('stripe_payment_intent_id', oldIntentId)
          .is('financial_operation_key', null)
          .is('financial_operation_type', null)
          .is('financial_operation_started_at', null)
          .select('id');
        linkedByRecoveryCas = !recoveryError && !!recoveryRows?.length;
        if (!linkedByRecoveryCas) {
          await logPaymentReconciliation(sb, {
            bookingId: booking.id,
            eventType: 'payment_recovery_linkage_ambiguous',
            description: 'A concurrent payment-recovery request may still link this PaymentIntent. It was not cancelled automatically.',
            paymentIntentId: replacement.id,
            error: recoveryError?.message || null,
          });
          return res.status(recoveryError ? 503 : 409).json({
            error: 'The new authorization linkage is still being resolved. No email was sent.',
            code: 'PAYMENT_RECOVERY_LINKAGE_AMBIGUOUS',
          });
        }
      }
      if (!linkedByConcurrentRequest && !linkedByRecoveryCas) {
        if (!replacementIsLinked) {
          await cancelProvenUnlinkedPaymentIntent({
            stripe,
            sb,
            bookingId: booking.id,
            paymentIntentId: replacement.id,
            context: 'send-payment-continuation-link-conflict',
          });
        }
        return res.status(linkError ? 503 : 409).json({
          error: 'Booking state changed before the new authorization could be linked. No email was sent.',
          code: 'PAYMENT_RECOVERY_LINK_CONFLICT',
        });
      }
    }
    await logActivity(sb, {
      bookingId: booking.id,
      eventType: 'payment_recovery_intent_replaced',
      actorType: 'owner',
      actorName: 'Owner',
      description: 'Owner prepared a replacement secure card authorization after Stripe released the prior hold.',
      metadata: { oldPaymentIntentId: oldIntentId, newPaymentIntentId: replacement.id },
    }).catch(error => console.error('[send-payment-continuation] Replacement activity log failed:', error?.message || error));
    booking.stripe_payment_intent_id = replacement.id;
    booking.payment_status = 'pending';
    intent = replacement;
    validation = replacementValidation;
  }

  if (intent.status === 'requires_capture') {
    return res.status(409).json({
      error: 'The card is already authorized. Reconcile booking confirmation instead of requesting payment again.',
      code: 'PAYMENT_ALREADY_AUTHORIZED',
    });
  }
  if (!isRecoverablePaymentIntentStatus(intent.status)) {
    return res.status(409).json({
      error: `This Stripe payment cannot be continued from its current state (${intent.status}).`,
      code: 'PAYMENT_INTENT_NOT_RECOVERABLE',
    });
  }

  // booking-confirmed and the Stripe webhook only promote a pending payment.
  // Restore a failed attempt only after Stripe proves the same intent is safely
  // recoverable; never reset an authorized/captured/terminal booking.
  if (booking.payment_status === 'failed') {
    const { data: resetRows, error: resetError } = await sb.from('bookings').update({
      payment_status: 'pending',
    })
      .eq('id', booking.id)
      .eq('status', booking.status)
      .eq('payment_status', 'failed')
      .eq('stripe_payment_intent_id', intent.id)
      .is('financial_operation_key', null)
      .is('financial_operation_type', null)
      .is('financial_operation_started_at', null)
      .select('id');
    if (resetError) return res.status(503).json({ error: 'The recoverable payment state could not be saved. No email was sent.' });
    if (!resetRows?.length) {
      return res.status(409).json({ error: 'Booking payment state changed. Refresh before sending a continuation email.' });
    }
    booking.payment_status = 'pending';
  }

  const previousGuestTokenHash = booking.guest_mutation_token_hash || null;
  const guestToken = randomToken(32);
  const nextGuestTokenHash = sha256(guestToken);
  let tokenRotation = sb.from('bookings').update({
    guest_mutation_token_hash: nextGuestTokenHash,
  })
    .eq('id', booking.id)
    .eq('status', booking.status)
    .eq('payment_status', booking.payment_status)
    .eq('stripe_payment_intent_id', intent.id)
    .is('financial_operation_key', null)
    .is('financial_operation_type', null)
    .is('financial_operation_started_at', null);
  tokenRotation = booking.guest_mutation_token_hash
    ? tokenRotation.eq('guest_mutation_token_hash', booking.guest_mutation_token_hash)
    : tokenRotation.is('guest_mutation_token_hash', null);
  const { data: tokenRows, error: tokenError } = await tokenRotation.select('id');
  if (tokenError || !tokenRows?.length) {
    return res.status(tokenError ? 503 : 409).json({
      error: tokenError
        ? 'A fresh secure payment link could not be saved. No email was sent.'
        : 'Booking state changed or another financial operation started. No email was sent.',
      code: tokenError ? 'PAYMENT_RECOVERY_TOKEN_ROTATION_FAILED' : 'PAYMENT_RECOVERY_STATE_CONFLICT',
    });
  }
  booking.guest_mutation_token_hash = nextGuestTokenHash;

  const continuationUrl = `${SITE}/api/booking/payment-recovery?bookingId=${encodeURIComponent(booking.id)}&token=${encodeURIComponent(guestToken)}`;
  const total = `$${(Number(booking.total_price || 0) / 100).toFixed(2)}`;
  const firstName = String(booking.customer_name || 'there').trim().split(/\s+/)[0] || 'there';
  const emailResult = await sendEmail({
    to: booking.customer_email,
    from: 'AssembleAtEase <booking@assembleatease.com>',
    subject: `Continue your secure booking payment - ${booking.ref}`,
    replyTo: ownerEmail(),
    html: buildContinuationEmail({ booking, continuationUrl, total, firstName }),
    meta: {
      bookingId: booking.id,
      notificationType: 'payment_continuation',
      recipientType: 'customer',
      dedupeWindowMin: 2,
    },
  }).catch(error => ({ ok: false, error: error?.message || String(error) }));

  const emailDelivered = emailResult?.ok === true && emailResult?.suppressed !== true;
  let tokenRollbackFailed = false;
  if (!emailDelivered) {
    const { data: rollbackRows, error: rollbackError } = await sb.from('bookings').update({
      guest_mutation_token_hash: previousGuestTokenHash,
    })
      .eq('id', booking.id)
      .eq('status', booking.status)
      .eq('payment_status', booking.payment_status)
      .eq('stripe_payment_intent_id', intent.id)
      .eq('guest_mutation_token_hash', nextGuestTokenHash)
      .is('financial_operation_key', null)
      .is('financial_operation_type', null)
      .is('financial_operation_started_at', null)
      .select('id');
    tokenRollbackFailed = !!rollbackError || !rollbackRows?.length;
    if (!tokenRollbackFailed) {
      booking.guest_mutation_token_hash = previousGuestTokenHash;
    } else {
      await logPaymentReconciliation(sb, {
        bookingId: booking.id,
        eventType: 'payment_recovery_token_rollback_failed',
        description: 'The continuation email was not confirmed delivered, and the prior customer access token could not be restored safely.',
        paymentIntentId: intent.id,
        error: rollbackError?.message || null,
      });
    }
  }

  await logActivity(sb, {
    bookingId: booking.id,
    eventType: emailDelivered ? 'payment_continuation_sent' : 'payment_continuation_failed',
    actorType: 'owner',
    actorName: 'Owner',
    description: emailDelivered
      ? 'Secure payment continuation email accepted for sending to the customer.'
      : 'Payment continuation was requested, but delivery was not confirmed and the new secure token was rolled back when possible.',
    metadata: {
      paymentIntentId: intent.id,
      stripeStatus: intent.status,
      emailError: emailResult?.error || null,
      emailSuppressed: emailResult?.suppressed === true,
      priorTokenRestored: !emailDelivered && !tokenRollbackFailed,
      tokenRollbackFailed,
    },
  }).catch(error => console.error('[send-payment-continuation] Activity log failed:', error?.message || error));

  return res.status(200).json({
    success: true,
    bookingId: booking.id,
    bookingRef: booking.ref,
    paymentStatus: booking.payment_status,
    stripeStatus: intent.status,
    emailDelivered,
    warnings: emailDelivered
      ? []
      : [
          'payment_continuation_email_failed',
          ...(tokenRollbackFailed ? ['payment_continuation_token_rollback_failed'] : []),
        ],
  });
}

async function ownerRecoveryStillUnlocked({ sb, booking, paymentIntentId, paymentStatus }) {
  let query = sb.from('bookings')
    .select('id')
    .eq('id', booking.id)
    .eq('status', booking.status)
    .eq('payment_status', paymentStatus)
    .eq('stripe_payment_intent_id', paymentIntentId)
    .is('financial_operation_key', null)
    .is('financial_operation_type', null)
    .is('financial_operation_started_at', null);
  query = booking.guest_mutation_token_hash
    ? query.eq('guest_mutation_token_hash', booking.guest_mutation_token_hash)
    : query.is('guest_mutation_token_hash', null);
  const { data, error } = await query.maybeSingle();
  if (error) return { ok: false, status: 503 };
  return data ? { ok: true } : { ok: false, status: 409 };
}

async function cancelProvenUnlinkedPaymentIntent({ stripe, sb, bookingId, paymentIntentId, context }) {
  try {
    const latest = await stripe.paymentIntents.retrieve(paymentIntentId);
    if (latest.status === 'canceled') return true;
    if (latest.status === 'succeeded') throw new Error('PaymentIntent unexpectedly succeeded');
    const cancelled = await stripe.paymentIntents.cancel(paymentIntentId);
    if (cancelled?.status === 'canceled') return true;
    throw new Error(`Stripe returned ${cancelled?.status || 'unknown'} after cancellation`);
  } catch (error) {
    console.error(`[${context}] Unlinked PaymentIntent needs reconciliation:`, error?.message || error);
    await logPaymentReconciliation(sb, {
      bookingId,
      eventType: 'payment_recovery_unlinked_intent_reconciliation_required',
      description: 'A newly-created unlinked PaymentIntent could not be confirmed cancelled and requires owner reconciliation.',
      paymentIntentId,
      error: error?.message || String(error),
    });
    return false;
  }
}

async function logPaymentReconciliation(sb, {
  bookingId,
  eventType,
  description,
  paymentIntentId,
  error = null,
}) {
  await logActivity(sb, {
    bookingId,
    eventType,
    actorType: 'system',
    actorName: 'send-payment-continuation',
    description,
    metadata: { paymentIntentId, error },
  }).catch(activityError => console.error('[send-payment-continuation] Reconciliation log failed:', activityError?.message || activityError));
}

function hasActiveFinancialOperation(booking) {
  return Boolean(
    booking?.financial_operation_key
    || booking?.financial_operation_type
    || booking?.financial_operation_started_at,
  );
}

function buildContinuationEmail({ booking, continuationUrl, total, firstName }) {
  return `<!doctype html><html><body style="margin:0;background:#f4f4f5;font-family:Arial,sans-serif;color:#18181b"><div style="max-width:580px;margin:0 auto;padding:28px 16px"><div style="background:#fff;border:1px solid #e4e4e7;border-radius:12px;padding:28px"><h1 style="margin:0 0 12px;font-size:24px">Continue your booking securely</h1><p style="line-height:1.7">Hi ${esc(firstName)}, your booking request <strong>${esc(booking.ref)}</strong> for <strong>${esc(booking.service)}</strong> is not confirmed because the card authorization was not completed.</p><div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:14px 16px;margin:18px 0"><div style="font-size:12px;color:#64748b;text-transform:uppercase;font-weight:700">Total to authorize</div><div style="font-size:24px;font-weight:800;margin-top:4px">${esc(total)}</div></div><p style="font-size:14px;line-height:1.6;color:#52525b">Your card will be authorized now and captured after completed work. Cancellation is free until 24 hours before the appointment. A disclosed late-cancellation fee may apply inside 24 hours.</p><p style="text-align:center;margin:24px 0"><a href="${esc(continuationUrl)}" style="display:inline-block;background:#00BFFF;color:#fff;text-decoration:none;padding:13px 24px;border-radius:8px;font-weight:700">Continue secure payment</a></p><p style="font-size:12px;line-height:1.6;color:#71717a">Use this link only for booking ${esc(booking.ref)}. If you did not request this booking, reply to this email or call 737-290-6129.</p></div></div></body></html>`;
}
