import Stripe from 'stripe';
import { formatAppointmentDate } from '../booking/_appt-date.js';
import { getSupabase } from '../_supabase.js';
import { sendEmail, ownerEmail, esc, formatAddress, ensureEmailShell } from '../_email.js';
import { reserveBookingFinancialOperation } from '../booking/_financial-operation.js';
import { logCron } from './_cron-logger.js';
import { captureBeforeFromIntent, fetchCaptureDeadline, needsAuthorizationRenewal, RENEWAL_LEAD_HOURS } from '../booking/_authorization-window.js';

const LOGO = 'https://www.assembleatease.com/images/logo.jpg';
const REAUTH_OPERATION_TYPE = 'reauth_payment';
const REAUTH_RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;
const CANCELABLE_PAYMENT_INTENT_STATUSES = new Set([
  'requires_payment_method',
  'requires_confirmation',
  'requires_action',
  'processing',
  'requires_capture',
]);

/**
 * GET /api/cron/reauth-payments
 * Runs daily at 10:00 UTC via Vercel cron.
 *
 * Stripe reports each card hold's actual deadline. This cron retains the
 * five-day appointment scan, adds approaching deadlines, and inspects holds
 * whose deadline has not been recorded before deciding whether to renew:
 *
 *   1. Reserve the booking's central financial-operation lock.
 *   2. Retrieve and validate the existing PaymentIntent and saved method.
 *   3. Create and validate a new off-session manual-capture authorization.
 *   4. Link the new PaymentIntent using an exact booking/lock CAS.
 *   5. Release the old hold, then clear the exact lock and notify the customer.
 *
 * This works because booking.js sets setup_future_usage: 'off_session' on the
 * original PI, which saves the payment method to the Stripe Customer and enables
 * off-session re-authorization without customer interaction.
 *
 * If off-session confirmation fails (e.g. 3DS-required EU card), the error is
 * logged and the old PI is NOT canceled so the original auth remains in place.
 */
export default async function handler(req, res) {
  // Only allow Vercel cron or internal calls
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.authorization !== 'Bearer ' + cronSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const t = Date.now();
  const sb = getSupabase();

  // Target: booking date is exactly 5 days from today (YYYY-MM-DD)
  const now = new Date();
  const target = new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000);
  const targetStr = target.toISOString().slice(0, 10);

  // Anything whose authorization dies inside the renewal lead time is due now.
  const renewalHorizonIso = new Date(now.getTime() + RENEWAL_LEAD_HOURS * 3600000).toISOString();

  const { data: bookings, error: queryErr } = await loadReauthorizationCandidates(sb, targetStr, renewalHorizonIso);

  if (queryErr) {
    console.error('reauth-payments query error:', queryErr);
    await logCron('reauth-payments', { status: 'error', error: queryErr.message, duration: Date.now() - t });
    return res.status(500).json({ error: 'Query failed' });
  }

  if (!bookings || bookings.length === 0) {
    await logCron('reauth-payments', { status: 'ok', records: 0, duration: Date.now() - t });
    return res.status(200).json({ ok: true, reauthed: 0, message: 'No bookings require re-authorization today' });
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(500).json({ error: 'STRIPE_SECRET_KEY not configured' });
  }
  const expectedLivemode = stripeLivemodeForSecret(process.env.STRIPE_SECRET_KEY);
  if (expectedLivemode == null) {
    return res.status(500).json({ error: 'STRIPE_SECRET_KEY mode could not be verified' });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  let reauthed = 0;
  let recovered = 0;
  const errors = [];

  for (const candidate of bookings) {
    let booking = candidate;
    try {
      if (booking.is_test_booking === true) continue;
      // A linked replacement with our exact lock still needs old-hold cleanup,
      // even when its new deadline is healthy. Never skip that recovery.
      const recovering = booking.financial_operation_key === `reauth:${booking.id}`
        && booking.financial_operation_type === REAUTH_OPERATION_TYPE;
      const unlocked = !booking.financial_operation_key && !booking.financial_operation_type
        && !booking.financial_operation_started_at;
      const inspectUnknown = unlocked && booking.authorization_capture_before == null
        && booking.payment_method_type !== 'klarna';
      if (inspectUnknown) {
        const inspection = await inspectUnknownAuthorization({ stripe, booking, expectedLivemode });
        if (!inspection.ok) {
          errors.push({ ref: booking.ref, reason: inspection.reason });
          const alert = await sendCurrentPaymentReviewAlert(sb, booking, inspection);
          if (!alert?.ok && !alert?.deferred) errors.push({ ref: booking.ref, reason: 'payment_review_notification_failed' });
          continue;
        }
        const recorded = await recordInspectedDeadline(sb, booking, inspection.captureBefore);
        if (!recorded.ok) {
          if (recorded.changed) continue; // another payment operation won the race
          errors.push({ ref: booking.ref, reason: 'payment_deadline_save_failed' });
          const alert = await sendCurrentPaymentReviewAlert(sb, booking, { reason: 'payment_deadline_save_failed' });
          if (!alert?.ok && !alert?.deferred) errors.push({ ref: booking.ref, reason: 'payment_review_notification_failed' });
          continue;
        }
        booking = { ...booking, authorization_capture_before: inspection.captureBefore };
      }
      // An inspected healthy legacy hold does not need replacement just because
      // its DB deadline is missing, including on the five-day calendar scan.
      if (!recovering && !needsAuthorizationRenewal(booking, now.getTime())) continue;
      const outcome = await processBookingReauthorization({
        sb,
        stripe,
        booking,
        expectedLivemode,
        nowIso: new Date().toISOString(),
      });
      if (!outcome.ok) {
        errors.push({ ref: booking.ref, reason: outcome.reason });
        if (outcome.paymentReviewRequired) {
          const alert = await sendCurrentPaymentReviewAlert(sb, booking, outcome);
          if (!alert?.ok && !alert?.deferred) errors.push({ ref: booking.ref, reason: 'payment_review_notification_failed' });
        } else if (outcome.ownerActionRequired) {
          await sendReauthOwnerAlert(booking, outcome).catch(alertErr => {
            console.error(`reauth-payments: owner alert email failed for ${booking.ref}:`, alertErr?.message || alertErr);
          });
        } else if (outcome.authenticationRequired) {
          await sendAuthenticationRequiredAlert(booking).catch(alertErr => {
            console.error(`reauth-payments: owner authentication alert failed for ${booking.ref}:`, alertErr?.message || alertErr);
          });
        }
        continue;
      }

      if (outcome.changed) reauthed++;
      else if (outcome.recovered) recovered++;

      // Customer email is notification only and follows confirmed Stripe + DB
      // finalization. A delivery failure never changes financial truth.
      if (outcome.changed || outcome.recovered) {
        try {
          await sendEmail({
            to: booking.customer_email,
            from: 'AssembleAtEase <booking@assembleatease.com>',
            subject: `Your upcoming appointment is confirmed — ${booking.ref}`,
            html: buildReauthEmail(booking),
            replyTo: 'service@assembleatease.com',
            meta: {
              bookingId: booking.id,
              notificationType: 'payment_reauthorized',
              recipientType: 'customer',
            },
          });
        } catch (emailErr) {
          console.error(`reauth-payments: email failed for ${booking.ref}:`, emailErr?.message || emailErr);
        }
      }
    } catch (err) {
      console.error(`reauth-payments: unexpected error for ${booking.ref}:`, err);
      errors.push({ ref: booking.ref, reason: 'unexpected' });
    }
  }

  await logCron('reauth-payments', { status: errors.length ? 'partial' : 'ok', records: reauthed, duration: Date.now() - t });
  return res.status(200).json({
    ok: true,
    reauthed,
    recovered,
    skipped: errors.length,
    errors: errors.length ? errors : undefined,
  });
}

async function loadReauthorizationCandidates(sb, targetStr, renewalHorizonIso) {
  // Known due holds and locked retries precede calendar/legacy discovery.
  // Page both scans so healthy unknowns cannot crowd out urgent work.
  const priorities = [
    `financial_operation_type.eq.${REAUTH_OPERATION_TYPE},authorization_capture_before.lte.${renewalHorizonIso}`,
    `date.eq.${targetStr},authorization_capture_before.is.null`,
  ];
  const candidates = new Map();
  const pageSize = 100;
  for (const selection of priorities) {
    for (let offset = 0; ; offset += pageSize) {
      const page = await sb.from('bookings').select('*')
        .eq('status', 'confirmed').eq('payment_status', 'authorized')
        .or(selection).order('id', { ascending: true }).range(offset, offset + pageSize - 1);
      if (page.error) return page;
      for (const booking of page.data || []) if (!candidates.has(booking.id)) candidates.set(booking.id, booking);
      if ((page.data || []).length < pageSize) break;
    }
  }
  return { data: [...candidates.values()], error: null };
}

export async function inspectUnknownAuthorization({ stripe, booking, expectedLivemode }) {
  if (!booking.stripe_payment_intent_id) return { ok: false, reason: 'payment_source_missing' };
  let intent;
  try {
    intent = await stripe.paymentIntents.retrieve(booking.stripe_payment_intent_id, { expand: ['latest_charge'] });
  } catch {
    return { ok: false, reason: 'payment_verification_unavailable' };
  }
  // Deadline and identity come from the same verified Stripe response. Reading
  // another customer's deadline must never authorize this booking's renewal.
  const validation = validateReauthorizationIntent(intent, {
    booking, expectedId: booking.stripe_payment_intent_id,
    expectedType: originalPaymentType(intent), expectedLivemode, requireAuthorized: false,
  });
  if (!validation.ok) return { ok: false, reason: 'payment_details_mismatch' };
  if (intent.status === 'succeeded') return { ok: false, reason: 'payment_already_collected' };
  if (intent.status === 'canceled') return { ok: false, reason: 'payment_hold_canceled' };
  if (intent.status !== 'requires_capture' || Number(intent.amount_capturable) !== Number(booking.total_price)) {
    return { ok: false, reason: 'payment_hold_unavailable' };
  }
  const captureBefore = captureBeforeFromIntent(intent);
  if (!captureBefore) return { ok: false, reason: 'payment_deadline_unknown' };
  return { ok: true, captureBefore };
}

async function recordInspectedDeadline(sb, booking, captureBefore) {
  // A verified legacy hold becomes known to every canonical reader. This is a
  // deadline projection only; no booking/payment status or money is changed.
  let query = sb.from('bookings').update({ authorization_capture_before: captureBefore })
    .eq('id', booking.id).eq('status', 'confirmed').eq('payment_status', 'authorized')
    .eq('stripe_payment_intent_id', booking.stripe_payment_intent_id)
    .is('authorization_capture_before', null)
    .is('financial_operation_key', null).is('financial_operation_type', null)
    .is('financial_operation_started_at', null)
    .is('financial_reconciliation_required_at', null).is('cancellation_reconciliation_required_at', null);
  for (const field of ['date', 'time', 'total_price', 'stripe_customer_id',
    'return_visit_required', 'return_visit_date', 'return_visit_time']) {
    query = applyNullableEq(query, field, booking[field]);
  }
  const { data, error } = await query.select('id');
  return { ok: !error && Boolean(data?.length), changed: !error && !data?.length };
}

export async function processBookingReauthorization({ sb, stripe, booking, expectedLivemode, nowIso }) {
  if (booking.payment_method_type === 'klarna') {
    return { ok: true, changed: false, recovered: false, skipped: true, reason: 'klarna_authorization_valid_28_days' };
  }
  const operationKey = `reauth:${booking.id}`;
  const hadReauthLock = booking.financial_operation_key === operationKey
    && booking.financial_operation_type === REAUTH_OPERATION_TYPE;

  try {
    await reserveBookingFinancialOperation(sb, {
      bookingId: booking.id,
      operationKey,
      operationType: REAUTH_OPERATION_TYPE,
      expectedStatuses: ['confirmed'],
      expectedAssemblerId: booking.assembler_id ?? null,
      expectedDate: booking.date,
      expectedTime: booking.time,
      checkAppointment: true,
      expectedBooking: booking,
    });
  } catch (error) {
    return {
      ok: false,
      reason: error?.code === 'FINANCIAL_OPERATION_CONFLICT'
        ? 'financial_operation_conflict'
        : 'financial_operation_reservation_failed',
    };
  }

  let lockedBooking = {
    ...booking,
    financial_operation_key: operationKey,
    financial_operation_type: REAUTH_OPERATION_TYPE,
  };
  const reservedState = await loadCurrentReauthBooking(sb, booking.id);
  const reservationVerified = !reservedState.error
    && reservedState.booking?.status === 'confirmed'
    && reservedState.booking?.payment_status === 'authorized'
    && reservedState.booking?.date === booking.date
    && reservedState.booking?.time === booking.time
    && reservedState.booking?.assembler_id === (booking.assembler_id ?? null)
    && reservedState.booking?.total_price === booking.total_price
    && reservedState.booking?.stripe_customer_id === booking.stripe_customer_id
    && reservedState.booking?.stripe_payment_intent_id === booking.stripe_payment_intent_id
    && reservedState.booking?.financial_operation_key === operationKey
    && reservedState.booking?.financial_operation_type === REAUTH_OPERATION_TYPE
    && !!reauthAttemptId(reservedState.booking?.financial_operation_started_at);
  if (!reservationVerified) {
    const released = await releaseExactReauthLock(sb, {
      booking: lockedBooking,
      operationKey,
      paymentIntentId: booking.stripe_payment_intent_id,
    });
    return {
      ok: false,
      reason: released.ok ? 'financial_operation_reservation_unverified' : 'safe_lock_release_failed',
      ownerActionRequired: !released.ok,
    };
  }
  lockedBooking = { ...lockedBooking, ...reservedState.booking };
  const operationAttemptId = reauthAttemptId(lockedBooking.financial_operation_started_at);
  if (!booking.stripe_payment_intent_id) {
    await releaseExactReauthLock(sb, {
      booking: lockedBooking,
      operationKey,
      paymentIntentId: null,
    });
    return { ok: false, reason: 'no_payment_intent' };
  }

  let currentIntent;
  try {
    currentIntent = await stripe.paymentIntents.retrieve(booking.stripe_payment_intent_id);
  } catch (error) {
    if (hadReauthLock) {
      await markReauthReconciliation(sb, {
        booking: lockedBooking,
        operationKey,
        paymentIntentId: booking.stripe_payment_intent_id,
        reason: 'reauth_current_intent_retrieve_unconfirmed',
      });
      return {
        ok: false,
        reason: 'reauth_current_intent_retrieve_unconfirmed',
        ownerActionRequired: true,
        detail: error?.message || String(error),
      };
    }
    const released = await releaseExactReauthLock(sb, {
      booking: lockedBooking,
      operationKey,
      paymentIntentId: booking.stripe_payment_intent_id,
    });
    return {
      ok: false,
      reason: released.ok ? 'payment_intent_retrieve_failed' : 'safe_lock_release_failed',
      ownerActionRequired: !released.ok,
      paymentReviewRequired: released.ok,
      detail: error?.message || String(error),
    };
  }

  const currentType = originalPaymentType(currentIntent);
  const currentValidation = validateReauthorizationIntent(currentIntent, {
    booking,
    expectedId: booking.stripe_payment_intent_id,
    expectedType: currentType,
    expectedLivemode,
    requireAuthorized: true,
  });
  if (!currentValidation.ok || !currentType) {
    if (hadReauthLock) {
      await markReauthReconciliation(sb, {
        booking: lockedBooking,
        operationKey,
        paymentIntentId: booking.stripe_payment_intent_id,
        reason: `reauth_current_intent_invalid:${currentValidation.errors.join(',') || 'type'}`,
      });
      return {
        ok: false,
        reason: 'reauth_current_intent_invalid',
        ownerActionRequired: true,
      };
    }
    const released = await releaseExactReauthLock(sb, {
      booking: lockedBooking,
      operationKey,
      paymentIntentId: booking.stripe_payment_intent_id,
    });
    return {
      ok: false,
      reason: released.ok ? `source_payment_intent_invalid:${currentValidation.errors.join(',') || 'type'}` : 'safe_lock_release_failed',
      ownerActionRequired: !released.ok,
      paymentReviewRequired: released.ok,
      paymentReviewReason: currentValidation.errors.every(field => ['status', 'amount_capturable'].includes(field))
        ? currentIntent.status === 'succeeded' ? 'payment_already_collected'
          : currentIntent.status === 'canceled' ? 'payment_hold_canceled' : 'payment_hold_unavailable'
        : 'payment_details_mismatch',
    };
  }

  const authorizationAgeMs = Date.parse(nowIso) - Date.parse(booking.payment_authorized_at);
  const recentAuthorization = Number.isFinite(authorizationAgeMs)
    && authorizationAgeMs >= -60_000
    && authorizationAgeMs <= REAUTH_RECENT_WINDOW_MS;
  const linkedReauthRecovery = isReauthorizationIntent(currentIntent)
    && (hadReauthLock || recentAuthorization);
  if (linkedReauthRecovery) {
    return finishLinkedReauthorization({
      sb,
      stripe,
      booking: lockedBooking,
      operationKey,
      newIntent: currentIntent,
      oldPaymentIntentId: currentIntent.metadata.replacesPaymentIntentId,
      expectedType: currentType,
      expectedLivemode,
      changed: false,
      recovered: hadReauthLock,
    });
  }

  const amount = Number(booking.total_price);
  const customerId = stripeObjectId(booking.stripe_customer_id);
  const paymentMethodId = stripeObjectId(currentIntent.payment_method);
  if (!Number.isInteger(amount) || amount <= 0 || !customerId || !paymentMethodId) {
    const released = await releaseExactReauthLock(sb, {
      booking: lockedBooking,
      operationKey,
      paymentIntentId: currentIntent.id,
    });
    return {
      ok: false,
      reason: released.ok ? 'missing_server_payment_source_truth' : 'safe_lock_release_failed',
      ownerActionRequired: !released.ok,
    };
  }

  const createResult = await createReauthorizationIntent({
    stripe,
    booking,
    oldIntent: currentIntent,
    amount,
    customerId,
    paymentMethodId,
    originalType: currentType,
    operationAttemptId,
  });
  const newIntent = createResult.paymentIntent;
  if (!newIntent) {
    if (createResult.ambiguous) {
      await markReauthReconciliation(sb, {
        booking: lockedBooking,
        operationKey,
        paymentIntentId: currentIntent.id,
        reason: 'reauth_create_outcome_unconfirmed',
      });
      return {
        ok: false,
        reason: 'reauth_create_outcome_unconfirmed',
        ownerActionRequired: true,
        detail: createResult.error?.message || null,
      };
    }
    const released = await releaseExactReauthLock(sb, {
      booking: lockedBooking,
      operationKey,
      paymentIntentId: currentIntent.id,
      clearReconciliation: true,
    });
    return {
      ok: false,
      reason: released.ok ? (createResult.error?.code || 'reauth_create_failed') : 'safe_lock_release_failed',
      authenticationRequired: createResult.error?.code === 'authentication_required',
      ownerActionRequired: !released.ok,
      detail: createResult.error?.message || null,
    };
  }

  const newValidation = validateReauthorizationIntent(newIntent, {
    booking,
    expectedType: currentType,
    expectedLivemode,
    expectedPaymentMethodId: paymentMethodId,
    replacesPaymentIntentId: currentIntent.id,
    requireAuthorized: true,
    requireReauthorizationMetadata: true,
  });
  if (!newValidation.ok) {
    const cancellation = await cancelAndConfirmPaymentIntent({
      stripe,
      paymentIntent: newIntent,
      expectedLivemode,
      idempotencyKey: `booking-reauth-invalid-new-${booking.id}-${newIntent.id}`,
    });
    if (!cancellation.ok) {
      await markReauthReconciliation(sb, {
        booking: lockedBooking,
        operationKey,
        paymentIntentId: currentIntent.id,
        reason: 'reauth_invalid_new_intent_cancellation_unconfirmed',
      });
      return {
        ok: false,
        reason: 'reauth_invalid_new_intent_cancellation_unconfirmed',
        ownerActionRequired: true,
      };
    }
    const released = await releaseExactReauthLock(sb, {
      booking: lockedBooking,
      operationKey,
      paymentIntentId: currentIntent.id,
      clearReconciliation: true,
    });
    return {
      ok: false,
      reason: released.ok
        ? (createResult.error?.code || `new_payment_intent_invalid:${newValidation.errors.join(',')}`)
        : 'safe_lock_release_failed',
      authenticationRequired: released.ok && createResult.error?.code === 'authentication_required',
      ownerActionRequired: !released.ok,
    };
  }

  const linkResult = await linkNewReauthorization({
    sb,
    booking: lockedBooking,
    operationKey,
    oldPaymentIntentId: currentIntent.id,
    newPaymentIntentId: newIntent.id,
    captureBefore: await fetchCaptureDeadline(stripe, newIntent.id),
    nowIso,
  });
  if (!linkResult.ok) {
    if (linkResult.ambiguous) {
      await markReauthReconciliation(sb, {
        booking: lockedBooking,
        operationKey,
        reason: 'reauth_database_link_outcome_unconfirmed',
      });
      return {
        ok: false,
        reason: 'reauth_database_link_outcome_unconfirmed',
        ownerActionRequired: true,
      };
    }

    if (!linkResult.newIntentLinked) {
      const cancellation = await cancelAndConfirmPaymentIntent({
        stripe,
        paymentIntent: newIntent,
        expectedLivemode,
        idempotencyKey: `booking-reauth-unlinked-new-${booking.id}-${newIntent.id}`,
      });
      if (!cancellation.ok) {
        await markReauthReconciliation(sb, {
          booking: lockedBooking,
          operationKey,
          reason: 'reauth_unlinked_new_intent_cancellation_unconfirmed',
        });
        return {
          ok: false,
          reason: 'reauth_unlinked_new_intent_cancellation_unconfirmed',
          ownerActionRequired: true,
        };
      }
      const released = await releaseExactReauthLock(sb, {
        booking: lockedBooking,
        operationKey,
        paymentIntentId: currentIntent.id,
        clearReconciliation: true,
      });
      return {
        ok: false,
        reason: released.ok ? 'reauth_database_link_conflict' : 'safe_lock_release_failed',
        ownerActionRequired: !released.ok,
      };
    }
  }

  return finishLinkedReauthorization({
    sb,
    stripe,
    booking: { ...lockedBooking, stripe_payment_intent_id: newIntent.id, payment_authorized_at: nowIso },
    operationKey,
    newIntent,
    oldPaymentIntentId: currentIntent.id,
    expectedType: currentType,
    expectedLivemode,
    changed: true,
    recovered: false,
  });
}

async function finishLinkedReauthorization({
  sb,
  stripe,
  booking,
  operationKey,
  newIntent,
  oldPaymentIntentId,
  expectedType,
  expectedLivemode,
  changed,
  recovered,
}) {
  if (!oldPaymentIntentId || oldPaymentIntentId === newIntent.id) {
    await markReauthReconciliation(sb, {
      booking,
      operationKey,
      paymentIntentId: newIntent.id,
      reason: 'reauth_replaced_intent_identity_invalid',
    });
    return { ok: false, reason: 'reauth_replaced_intent_identity_invalid', ownerActionRequired: true };
  }

  const newValidation = validateReauthorizationIntent(newIntent, {
    booking,
    expectedId: booking.stripe_payment_intent_id,
    expectedType,
    expectedLivemode,
    replacesPaymentIntentId: oldPaymentIntentId,
    requireAuthorized: true,
    requireReauthorizationMetadata: true,
  });
  if (!newValidation.ok) {
    await markReauthReconciliation(sb, {
      booking,
      operationKey,
      paymentIntentId: newIntent.id,
      reason: `reauth_linked_intent_invalid:${newValidation.errors.join(',')}`,
    });
    return { ok: false, reason: 'reauth_linked_intent_invalid', ownerActionRequired: true };
  }

  let oldIntent;
  try {
    oldIntent = await stripe.paymentIntents.retrieve(oldPaymentIntentId);
  } catch (error) {
    await markReauthReconciliation(sb, {
      booking,
      operationKey,
      paymentIntentId: newIntent.id,
      reason: 'reauth_old_intent_retrieve_unconfirmed',
    });
    return {
      ok: false,
      reason: 'reauth_old_intent_retrieve_unconfirmed',
      ownerActionRequired: true,
      detail: error?.message || String(error),
    };
  }

  const oldValidation = validateReauthorizationIntent(oldIntent, {
    booking,
    expectedId: oldPaymentIntentId,
    expectedType,
    expectedLivemode,
    requireAuthorized: false,
  });
  if (!oldValidation.ok) {
    await markReauthReconciliation(sb, {
      booking,
      operationKey,
      paymentIntentId: newIntent.id,
      reason: `reauth_old_intent_invalid:${oldValidation.errors.join(',')}`,
    });
    return { ok: false, reason: 'reauth_old_intent_invalid', ownerActionRequired: true };
  }

  const releaseResult = await cancelAndConfirmPaymentIntent({
    stripe,
    paymentIntent: oldIntent,
    expectedLivemode,
    idempotencyKey: `booking-reauth-release-old-${booking.id}-${oldPaymentIntentId}`,
  });
  if (!releaseResult.ok) {
    await markReauthReconciliation(sb, {
      booking,
      operationKey,
      paymentIntentId: newIntent.id,
      reason: 'reauth_old_hold_release_unconfirmed',
    });
    return {
      ok: false,
      reason: 'reauth_old_hold_release_unconfirmed',
      ownerActionRequired: true,
      detail: releaseResult.status || null,
    };
  }

  const finalized = await releaseExactReauthLock(sb, {
    booking,
    operationKey,
    paymentIntentId: newIntent.id,
    clearReconciliation: true,
  });
  if (!finalized.ok) {
    if (finalized.alreadyReleased) {
      return { ok: true, changed, recovered, alreadyComplete: true };
    }
    await markReauthReconciliation(sb, {
      booking,
      operationKey,
      paymentIntentId: newIntent.id,
      reason: 'reauth_finalization_persistence_unconfirmed',
    });
    return { ok: false, reason: 'reauth_finalization_persistence_unconfirmed', ownerActionRequired: true };
  }

  return { ok: true, changed, recovered, alreadyComplete: !changed && !recovered };
}

async function createReauthorizationIntent({
  stripe,
  booking,
  oldIntent,
  amount,
  customerId,
  paymentMethodId,
  originalType,
  operationAttemptId,
}) {
  const params = {
    amount,
    currency: 'usd',
    customer: customerId,
    payment_method: paymentMethodId,
    capture_method: 'manual',
    confirm: true,
    off_session: true,
    metadata: {
      bookingRef: booking.ref,
      bookingId: booking.id,
      type: originalType,
      reauthorized: 'true',
      originalPaymentType: originalType,
      replacesPaymentIntentId: oldIntent.id,
    },
    // Keep every idempotent retry byte-for-byte stable even if non-financial
    // display fields are edited after an earlier definitive failure.
    description: `Payment reauthorization - ${booking.ref}`,
  };
  const options = { idempotencyKey: `booking-reauth-${booking.id}-${oldIntent.id}-${operationAttemptId}` };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return { paymentIntent: await stripe.paymentIntents.create(params, options), error: null, ambiguous: false };
    } catch (error) {
      const errorIntentId = stripeObjectId(error?.payment_intent || error?.raw?.payment_intent);
      if (errorIntentId) {
        try {
          const paymentIntent = await stripe.paymentIntents.retrieve(errorIntentId);
          return { paymentIntent, error, ambiguous: false };
        } catch (retrieveError) {
          return { paymentIntent: null, error: retrieveError, ambiguous: true };
        }
      }
      const ambiguous = isAmbiguousStripeMutationError(error);
      if (!ambiguous || attempt === 1) return { paymentIntent: null, error, ambiguous };
    }
  }
  return { paymentIntent: null, error: new Error('Stripe create outcome is unknown'), ambiguous: true };
}

async function linkNewReauthorization({ sb, booking, operationKey, oldPaymentIntentId, newPaymentIntentId, nowIso, captureBefore = null }) {
  let query = sb.from('bookings').update({
    stripe_payment_intent_id: newPaymentIntentId,
    payment_authorized_at: nowIso,
    // The replacement hold has its own deadline. Leaving the previous one in
    // place would read as verified while describing an intent that is gone.
    authorization_capture_before: captureBefore,
  })
    .eq('id', booking.id)
    .eq('status', 'confirmed')
    .eq('payment_status', 'authorized')
    .eq('date', booking.date)
    .eq('stripe_payment_intent_id', oldPaymentIntentId)
    .eq('financial_operation_key', operationKey)
    .eq('financial_operation_type', REAUTH_OPERATION_TYPE)
    .eq('financial_operation_started_at', booking.financial_operation_started_at);
  query = applyNullableEq(query, 'time', booking.time);
  query = applyNullableEq(query, 'assembler_id', booking.assembler_id);
  query = applyNullableEq(query, 'stripe_customer_id', booking.stripe_customer_id);
  query = applyNullableEq(query, 'total_price', booking.total_price);
  const { data, error } = await query.select('id');
  if (!error && data?.length) return { ok: true, newIntentLinked: true, ambiguous: false };

  const current = await loadCurrentReauthBooking(sb, booking.id);
  if (current.error) return { ok: false, newIntentLinked: false, ambiguous: true };
  return {
    ok: current.booking?.stripe_payment_intent_id === newPaymentIntentId,
    newIntentLinked: current.booking?.stripe_payment_intent_id === newPaymentIntentId,
    ambiguous: false,
    current: current.booking,
  };
}

async function releaseExactReauthLock(sb, {
  booking,
  operationKey,
  paymentIntentId,
  clearReconciliation = false,
}) {
  const payload = {
    financial_operation_key: null,
    financial_operation_type: null,
    financial_operation_started_at: null,
  };
  if (clearReconciliation) {
    payload.financial_reconciliation_required_at = null;
    payload.financial_reconciliation_reason = null;
  }

  let query = sb.from('bookings').update(payload)
    .eq('id', booking.id)
    .eq('status', 'confirmed')
    .eq('payment_status', 'authorized')
    .eq('date', booking.date)
    .eq('financial_operation_key', operationKey)
    .eq('financial_operation_type', REAUTH_OPERATION_TYPE)
    .eq('financial_operation_started_at', booking.financial_operation_started_at);
  query = applyNullableEq(query, 'time', booking.time);
  query = applyNullableEq(query, 'assembler_id', booking.assembler_id);
  query = applyNullableEq(query, 'stripe_payment_intent_id', paymentIntentId);
  query = applyNullableEq(query, 'stripe_customer_id', booking.stripe_customer_id);
  query = applyNullableEq(query, 'total_price', booking.total_price);
  const { data, error } = await query.select('id');
  if (!error && data?.length) return { ok: true, alreadyReleased: false };

  const current = await loadCurrentReauthBooking(sb, booking.id);
  const alreadyReleased = !current.error
    && current.booking?.status === 'confirmed'
    && current.booking?.payment_status === 'authorized'
    && current.booking?.date === booking.date
    && current.booking?.stripe_payment_intent_id === paymentIntentId
    && !current.booking?.financial_operation_key
    && !current.booking?.financial_operation_type;
  return { ok: alreadyReleased, alreadyReleased, error: error || current.error || null };
}

async function markReauthReconciliation(sb, {
  booking,
  operationKey,
  paymentIntentId,
  reason,
}) {
  let query = sb.from('bookings').update({
    financial_reconciliation_required_at: new Date().toISOString(),
    financial_reconciliation_reason: String(reason || 'reauth_payment_reconciliation_required').slice(0, 500),
  })
    .eq('id', booking.id)
    .eq('status', 'confirmed')
    .eq('payment_status', 'authorized')
    .eq('date', booking.date)
    .eq('financial_operation_key', operationKey)
    .eq('financial_operation_type', REAUTH_OPERATION_TYPE)
    .eq('financial_operation_started_at', booking.financial_operation_started_at);
  query = applyNullableEq(query, 'time', booking.time);
  if (paymentIntentId !== undefined) query = applyNullableEq(query, 'stripe_payment_intent_id', paymentIntentId);
  const { data, error } = await query.select('id');
  if (error || !data?.length) {
    console.error(`reauth-payments: reconciliation marker failed for ${booking.ref}:`, error?.message || 'booking state changed');
    return false;
  }
  return true;
}

async function loadCurrentReauthBooking(sb, bookingId) {
  const { data, error } = await sb.from('bookings')
    .select('id, status, payment_status, date, time, assembler_id, total_price, stripe_customer_id, stripe_payment_intent_id, payment_authorized_at, financial_operation_key, financial_operation_type, financial_operation_started_at, financial_reconciliation_required_at, financial_reconciliation_reason')
    .eq('id', bookingId)
    .maybeSingle();
  return { booking: data || null, error: error || null };
}

async function cancelAndConfirmPaymentIntent({ stripe, paymentIntent, expectedLivemode, idempotencyKey }) {
  let current = paymentIntent;
  if (!current?.id) return { ok: false, ambiguous: true, status: null };
  if (current.livemode !== expectedLivemode) return { ok: false, ambiguous: false, status: 'livemode_mismatch' };
  if (current.status === 'canceled') return { ok: true, status: 'canceled' };
  if (!CANCELABLE_PAYMENT_INTENT_STATUSES.has(current.status)) {
    return { ok: false, ambiguous: false, status: current.status || 'unknown' };
  }

  try {
    const cancelled = await stripe.paymentIntents.cancel(current.id, {}, { idempotencyKey });
    if (cancelled?.id === current.id && cancelled?.livemode === expectedLivemode && cancelled?.status === 'canceled') {
      return { ok: true, status: 'canceled' };
    }
  } catch (error) {
    console.error(`reauth-payments: Stripe cancellation needs verification for ${current.id}:`, error?.message || error);
  }

  try {
    current = await stripe.paymentIntents.retrieve(current.id);
    return current?.id === paymentIntent.id
      && current?.livemode === expectedLivemode
      && current?.status === 'canceled'
      ? { ok: true, status: 'canceled' }
      : { ok: false, ambiguous: false, status: current?.status || 'unknown' };
  } catch (error) {
    return { ok: false, ambiguous: true, status: null, error };
  }
}

export function validateReauthorizationIntent(intent, {
  booking,
  expectedId = null,
  expectedType = null,
  expectedLivemode,
  expectedPaymentMethodId = null,
  replacesPaymentIntentId = null,
  requireAuthorized = true,
  requireReauthorizationMetadata = false,
} = {}) {
  const errors = [];
  const amount = Number(booking?.total_price);
  const customerId = stripeObjectId(booking?.stripe_customer_id);
  if (!intent?.id || (expectedId && intent.id !== expectedId)) errors.push('id');
  if (requireAuthorized && intent?.status !== 'requires_capture') errors.push('status');
  if (intent?.capture_method !== 'manual') errors.push('capture_method');
  if (!Number.isInteger(amount) || amount <= 0 || Number(intent?.amount) !== amount) errors.push('amount');
  if (requireAuthorized && Number(intent?.amount_capturable) !== amount) errors.push('amount_capturable');
  if (String(intent?.currency || '').toLowerCase() !== 'usd') errors.push('currency');
  if (!customerId || stripeObjectId(intent?.customer) !== customerId) errors.push('customer');
  if (intent?.livemode !== expectedLivemode) errors.push('livemode');
  if (intent?.metadata?.bookingId !== booking?.id) errors.push('metadata_booking_id');
  if (intent?.metadata?.bookingRef !== booking?.ref) errors.push('metadata_booking_ref');
  if (!expectedType || intent?.metadata?.type !== expectedType) errors.push('metadata_type');
  if (expectedPaymentMethodId && stripeObjectId(intent?.payment_method) !== expectedPaymentMethodId) errors.push('payment_method');
  if (requireReauthorizationMetadata) {
    if (intent?.metadata?.reauthorized !== 'true') errors.push('metadata_reauthorized');
    if (intent?.metadata?.originalPaymentType !== expectedType) errors.push('metadata_original_type');
    if (!replacesPaymentIntentId || intent?.metadata?.replacesPaymentIntentId !== replacesPaymentIntentId) {
      errors.push('metadata_replaces');
    }
  }
  return { ok: errors.length === 0, errors };
}

export function stripeLivemodeForSecret(secret) {
  const value = String(secret || '').trim();
  if (/^(?:sk|rk)_live_/.test(value)) return true;
  if (/^(?:sk|rk)_test_/.test(value)) return false;
  return null;
}

export function isAmbiguousStripeMutationError(error) {
  if (!error) return true;
  if (Number(error.statusCode) >= 500) return true;
  if (['StripeAPIError', 'StripeConnectionError', 'StripeIdempotencyError', 'StripeRateLimitError'].includes(error.type)) return true;
  return /(?:ECONNRESET|ETIMEDOUT|EAI_AGAIN|api[_ ]connection|network|timeout)/i.test(String(error.code || error.message || ''));
}

function originalPaymentType(intent) {
  const type = intent?.metadata?.type;
  if (!['customer_booking', 'customer_quote'].includes(type)) return null;
  if (intent?.metadata?.reauthorized === 'true'
      && intent?.metadata?.originalPaymentType !== type) return null;
  return type;
}

function isReauthorizationIntent(intent) {
  return intent?.metadata?.reauthorized === 'true'
    && originalPaymentType(intent)
    && !!intent?.metadata?.replacesPaymentIntentId;
}

function stripeObjectId(value) {
  if (typeof value === 'string') return value.trim() || null;
  if (value && typeof value.id === 'string') return value.id.trim() || null;
  return null;
}

function applyNullableEq(query, field, value) {
  return value == null ? query.is(field, null) : query.eq(field, value);
}

function reauthAttemptId(value) {
  const normalized = String(value || '').replace(/[^a-z0-9]/gi, '');
  return normalized || null;
}

async function sendCurrentPaymentReviewAlert(sb, booking, outcome) {
  // An email must not send the owner chasing a booking already captured,
  // refreshed, rescheduled or picked up by another financial operation.
  const { data: current, error } = await sb.from('bookings').select('*').eq('id', booking.id).maybeSingle();
  if (error) return { ok: false, error: 'Current booking payment state could not be verified.' };
  if (!current || current.is_test_booking === true || current.status !== 'confirmed' || current.payment_status !== 'authorized'
      || current.financial_operation_key || current.financial_operation_type || current.financial_operation_started_at
      || current.financial_reconciliation_required_at || current.cancellation_reconciliation_required_at) {
    return { ok: true, suppressed: true };
  }
  const reviewFields = ['stripe_payment_intent_id', 'total_price', 'stripe_customer_id', 'date', 'time',
    'authorization_capture_before', 'return_visit_required', 'return_visit_date', 'return_visit_time'];
  for (const field of reviewFields) {
    if ((current[field] ?? null) !== (booking[field] ?? null)) return { ok: true, suppressed: true };
  }
  const reason = outcome.paymentReviewReason || outcome.reason;
  const description = {
    payment_already_collected: 'Stripe shows this payment was collected, but the booking still shows a card hold. Verify the payment record before requesting any further payment. Do not charge the customer again.',
    payment_hold_canceled: 'Stripe shows that the existing card hold was canceled. Contact the customer to arrange a valid payment authorization before work starts.',
    payment_hold_unavailable: 'The existing card hold is not available for the full booking amount. Verify the payment and contact the customer if a new authorization is needed before work starts.',
    payment_details_mismatch: 'The linked payment details do not match this booking. Verify the amount and booking reference before requesting any payment or sending an Easer.',
    payment_source_missing: 'This booking has no linked card payment to verify. Confirm the payment arrangement before sending an Easer.',
    payment_deadline_unknown: 'Stripe did not provide a card hold deadline, so we could not verify that the hold lasts through this appointment. Confirm the payment arrangement before work starts.',
    payment_deadline_save_failed: 'The card hold was verified, but its deadline could not be saved to the booking. The booking still needs payment review before work starts.',
  }[reason] || 'The current card hold could not be verified. This does not establish that the card was declined. Confirm the payment arrangement before work starts.';
  return sendEmail({
    to: ownerEmail(), from: 'AssembleAtEase <booking@assembleatease.com>',
    subject: `Payment review before appointment: ${booking.ref}`,
    html: ensureEmailShell(`<h1 style="font-size:22px">Review this booking's payment</h1><p><strong>${esc(booking.ref)}</strong>: ${esc(booking.service || 'Service')}, ${esc(formatAppointmentDate(booking.date))}.</p><p>${esc(description)}</p><p>Open the booking in the owner dashboard and review its payment details and timeline. If the records disagree, check the linked payment in Stripe before taking action. Do not mark work complete just to collect payment.</p><p>This check did not create a new card hold, collect a payment, or cancel a payment.</p><p><a href="https://www.assembleatease.com/owner/">Open the owner dashboard</a></p>`, 'owner'),
    replyTo: 'service@assembleatease.com',
    meta: { bookingId: booking.id, notificationType: 'payment_authorization_review', recipientType: 'owner',
      paymentReviewSnapshot: Object.fromEntries(reviewFields.map(field => [field, current[field] ?? null])),
      notificationKey: `payment-review:${booking.id}:${booking.stripe_payment_intent_id || 'missing'}:${booking.date}:${booking.time || ''}:${reason}` },
  });
}

async function sendAuthenticationRequiredAlert(booking) {
  return sendEmail({
    to: ownerEmail(),
    from: 'AssembleAtEase <booking@assembleatease.com>',
    subject: `ACTION REQUIRED: Card re-auth failed for ${booking.ref} — customer authentication required`,
    html: `<p>The payment re-authorization for booking <strong>${esc(booking.ref)}</strong> (${esc(booking.customer_name)}, ${esc(booking.service)}, ${esc(formatAppointmentDate(booking.date))}) requires customer authentication.</p><p>The original authorization remains linked. Contact the customer before it expires.</p>`,
    replyTo: 'service@assembleatease.com',
    meta: { bookingId: booking.id, notificationType: 'payment_reauth_authentication_required', recipientType: 'owner' },
  });
}

async function sendReauthOwnerAlert(booking, outcome) {
  return sendEmail({
    to: ownerEmail(),
    from: 'AssembleAtEase <booking@assembleatease.com>',
    subject: `ACTION REQUIRED: Payment re-authorization needs reconciliation — ${booking.ref}`,
    html: `<p>Booking <strong>${esc(booking.ref)}</strong> is locked against further financial changes because payment re-authorization could not be safely finalized.</p><p>Reason: <strong>${esc(outcome.reason)}</strong></p><p>Review the booking's current and replacement PaymentIntents in Stripe before clearing the financial reconciliation marker.</p>`,
    replyTo: 'service@assembleatease.com',
    meta: { bookingId: booking.id, notificationType: 'payment_reauth_reconciliation_required', recipientType: 'owner' },
  });
}

function buildReauthEmail(booking) {
  const customerFirst = (booking.customer_name || 'there').split(' ')[0];
  const dateStr = booking.date || '';
  const timeStr = booking.time || '';

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"/></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1a1a1a">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">

  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px 8px 0 0;border-bottom:1px solid #e4e4e7">
    <tr><td style="padding:20px 24px;text-align:center">
      <img src="${LOGO}" alt="AssembleAtEase" width="44" height="44" style="border-radius:50%;display:inline-block"/>
      <p style="margin:8px 0 0;font-size:17px;font-weight:700;color:#1a1a1a">AssembleAtEase</p>
    </td></tr>
  </table>

  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-left:1px solid #e4e4e7;border-right:1px solid #e4e4e7">
    <tr><td style="padding:28px 24px">

      <p style="margin:0 0 20px;font-size:20px;font-weight:700;color:#1a1a1a">Your booking is all set, ${esc(customerFirst)}!</p>

      <p style="margin:0 0 20px;font-size:14px;color:#52525b;line-height:1.7">We refreshed your payment authorization for your upcoming appointment. No additional charge &mdash; just keeping your booking secure as your appointment date approaches.</p>

      <table width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;margin-bottom:24px">
        <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#71717a;width:140px">Booking ref</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-family:monospace;font-size:13px">${esc(booking.ref)}</td></tr>
        <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#71717a">Service</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-weight:600">${esc(booking.service)}</td></tr>
        <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#71717a">Date</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-weight:700">${esc(dateStr)}</td></tr>
        ${timeStr ? `<tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#71717a">Time</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-weight:700">${esc(timeStr)}</td></tr>` : ''}
        ${booking.address ? `<tr><td style="padding:10px 0;color:#71717a">Address</td><td style="padding:10px 0">${esc(formatAddress(booking.address))}</td></tr>` : ''}
      </table>

      <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0fdf9;border:1px solid #bbf7e0;border-radius:6px;margin-bottom:24px">
        <tr><td style="padding:14px 18px;font-size:13px;color:#166534;line-height:1.6">
          Your card is still safely on file — you're only charged after the job is complete.
        </td></tr>
      </table>

      <p style="margin:0;font-size:13px;color:#71717a;line-height:1.6">Have questions? Reply to this email or reach us at <a href="mailto:service@assembleatease.com" style="color:#00BFFF">service@assembleatease.com</a>.</p>

    </td></tr>
  </table>

  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-top:none;border-radius:0 0 8px 8px">
    <tr><td style="padding:16px 24px;text-align:center;font-size:11px;color:#a1a1aa">
      AssembleAtEase &bull; Serving customers across Texas &bull; <a href="mailto:service@assembleatease.com" style="color:#71717a">service@assembleatease.com</a>
    </td></tr>
  </table>

</div>
</body></html>`;
}
