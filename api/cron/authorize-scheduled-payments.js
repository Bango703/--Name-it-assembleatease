import Stripe from 'stripe';
import { getSupabase } from '../_supabase.js';
import { esc, ownerEmail, sendEmail } from '../_email.js';
import { randomToken, sha256 } from '../_payment-security.js';
import { isAutomaticDispatchZip } from '../_source-of-truth.js';
import { dispatchBooking } from '../booking/_dispatch-internal.js';
import { addIsoDays, SCHEDULED_AUTHORIZATION_LEAD_DAYS } from '../booking/_booking-window.js';
import { formatAppointmentDate } from '../booking/_appt-date.js';
import { chicagoTodayIso } from '../booking/_appt-date.js';
import { logActivity } from '../booking/_activity.js';
import { classifyAuthorizationOutcome } from '../booking/_authorization-outcome.js';
import { logCron } from './_cron-logger.js';

const OPERATION_TYPE = 'authorize_scheduled_payment';
const SITE = String(process.env.PUBLIC_SITE_URL || 'https://www.assembleatease.com').replace(/\/$/, '');
// One transport hiccup used to cost the customer an email and the Easer their
// Thursday. Try the confirmation twice before concluding anything.
const CONFIRM_ATTEMPTS = 2;

export default async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.authorization !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const startedAt = Date.now();
  const sb = getSupabase();
  const today = chicagoTodayIso();
  const authorizationCutoff = addIsoDays(today, SCHEDULED_AUTHORIZATION_LEAD_DAYS);
  const { data: bookings, error } = await sb.from('bookings')
    .select('*')
    .eq('status', 'confirmed')
    .or(`and(payment_status.eq.card_saved,date.gte.${today},date.lte.${authorizationCutoff}),financial_operation_type.eq.${OPERATION_TYPE}`)
    .limit(50);

  if (error) {
    await logCron('authorize-scheduled-payments', { status: 'error', error: error.message, duration: Date.now() - startedAt });
    return res.status(500).json({ error: 'Scheduled payment query failed.' });
  }
  if (!process.env.STRIPE_SECRET_KEY) return res.status(503).json({ error: 'Stripe is not configured.' });

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const expectedLivemode = stripeLivemodeForSecret(process.env.STRIPE_SECRET_KEY);
  let authorized = 0;
  let actionRequired = 0;
  let retrying = 0;
  const failures = [];

  for (const booking of bookings || []) {
    const outcome = await authorizeScheduledBooking({ sb, stripe, booking, expectedLivemode, todayIso: today });
    if (outcome.ok && outcome.authorized) authorized++;
    if (outcome.actionRequired) actionRequired++;
    if (outcome.retryScheduled) retrying++;
    if (!outcome.ok) failures.push({ ref: booking.ref, reason: outcome.reason });
  }

  // A hold an earlier run created but never confirmed. The old code moved that
  // booking to payment_status 'pending', which takes it out of the query above,
  // so nothing looked at it again and the customer was left holding a link she
  // never needed. Finish what the earlier run started instead.
  const recovered = await recoverUnconfirmedHolds({ sb, stripe, expectedLivemode, todayIso: today });
  authorized += recovered.authorized;
  failures.push(...recovered.failures);

  await logCron('authorize-scheduled-payments', {
    status: failures.length ? 'partial' : 'ok',
    records: authorized,
    duration: Date.now() - startedAt,
    // The reason a run could not authorize used to live only in an HTTP
    // response nobody reads. Article 14: write it down.
    errorText: failures.length
      ? failures.map(f => `${f.ref}: ${f.reason}`).join(' | ').slice(0, 500)
      : null,
  });
  return res.status(200).json({
    ok: true,
    authorized,
    actionRequired,
    retrying,
    recovered: recovered.authorized,
    skipped: failures.length,
    failures: failures.length ? failures : undefined,
  });
}

// Every message this job can send, in one place so a test can watch them, a
// reader can see exactly who hears about what, and a caller can silence one of
// them deliberately — e.g. clearing a booking by hand when the owner judges the
// customer has already had enough email about it.
export const DEFAULT_NOTIFIERS = {
  customerRecovery: sendCustomerRecovery,
  customerAuthorized: sendAuthorizationSuccess,
  easerHold: notifyAssignedEaserPaymentHold,
  easerCleared: notifyAssignedEaserPaymentCleared,
  owner: sendOwnerAlert,
};

async function confirmWithRetry(stripe, intentId, idempotencyKey) {
  let lastError = null;
  for (let attempt = 1; attempt <= CONFIRM_ATTEMPTS; attempt += 1) {
    try {
      return { intent: await stripe.paymentIntents.confirm(intentId, { off_session: true }, { idempotencyKey }), error: null };
    } catch (error) {
      lastError = error;
      // A card error is the issuer's answer, not a failed request: retrying it
      // would only ask the same bank the same question.
      if (error?.type === 'StripeCardError' || error?.rawType === 'card_error') break;
      if (attempt < CONFIRM_ATTEMPTS) await new Promise(resolve => setTimeout(resolve, 400 * attempt));
    }
  }
  return { intent: null, error: lastError };
}

export async function authorizeScheduledBooking({ sb, stripe, booking, expectedLivemode, todayIso = chicagoTodayIso(), notify = DEFAULT_NOTIFIERS }) {
  const authorizationCutoff = addIsoDays(todayIso, SCHEDULED_AUTHORIZATION_LEAD_DAYS);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(booking.date || ''))
      || booking.date < todayIso
      || booking.date > authorizationCutoff) {
    if (booking.financial_operation_type === OPERATION_TYPE && booking.financial_operation_key) {
      await markReconciliation(sb, booking, booking.financial_operation_key, 'Scheduled authorization is outside the safe appointment window.');
      await notify.owner(booking,'The appointment date needs review before any card authorization.').catch(() => {});
    }
    return { ok: false, reason: 'outside_authorization_window', actionRequired: booking.date < todayIso };
  }

  const operationKey = `scheduled-auth:${booking.id}:${booking.date}`;
  const reserved = await reserveScheduledOperation(sb, booking, operationKey);
  if (!reserved.ok) return { ok: false, reason: reserved.reason };

  const locked = await loadLockedBooking(sb, booking.id, operationKey);
  if (!locked.ok) {
    await releaseScheduledOperation(sb, booking.id, operationKey).catch(() => {});
    return { ok: false, reason: 'financial_operation_reservation_unverified' };
  }
  booking = locked.booking;

  const amount = Number(booking.total_price || 0);
  const customerId = stringId(booking.stripe_customer_id);
  const paymentMethodId = stringId(booking.stripe_payment_method_id);
  if (!Number.isInteger(amount) || amount <= 0 || !customerId || !paymentMethodId || expectedLivemode == null) {
    await releaseScheduledOperation(sb, booking.id, operationKey).catch(() => {});
    await notify.owner(booking,'Saved card details or Stripe mode could not be verified.').catch(() => {});
    return { ok: false, reason: 'missing_payment_source_truth', actionRequired: true };
  }

  let intent;
  try {
    intent = await stripe.paymentIntents.create({
      amount,
      currency: 'usd',
      customer: customerId,
      payment_method: paymentMethodId,
      capture_method: 'manual',
      // NO setup_future_usage here. Stripe refuses to confirm a PaymentIntent
      // with off_session=true when setup_future_usage is set -- "the customer
      // needs to be on-session to perform the steps which may be required to
      // set up the PaymentMethod for future usage" -- so every scheduled hold
      // created this way was rejected at the confirm step, every time, and the
      // customer was then emailed that her bank wanted another confirmation.
      // Nothing needs setting up: the card was already saved and attached to
      // this customer by the SetupIntent taken at booking.
      payment_method_types: ['card'],
      receipt_email: booking.customer_email,
      statement_descriptor_suffix: 'ASSEMBLEATEASE',
      description: `${booking.service} — ${booking.customer_name}`,
      metadata: {
        bookingRef: booking.ref,
        bookingId: booking.id,
        type: 'customer_booking',
        scheduledAuthorization: 'true',
        appointmentDate: booking.date,
      },
    }, { idempotencyKey: `scheduled-auth-create-${booking.id}-${booking.date}-${amount}` });
  } catch (error) {
    await markReconciliation(sb, booking, operationKey, 'Scheduled Stripe authorization creation could not be confirmed.');
    await notify.owner(booking,'Stripe authorization creation could not be confirmed. Reconcile before dispatch.').catch(() => {});
    return { ok: false, reason: 'payment_intent_creation_unconfirmed', actionRequired: true };
  }

  const createdValidation = validateScheduledIntent(intent, { booking, amount, customerId, paymentMethodId, expectedLivemode });
  if (!createdValidation.ok) {
    const cancelled = await cancelIntent(stripe, intent, expectedLivemode, `scheduled-auth-invalid-${booking.id}-${intent.id}`);
    if (cancelled) await releaseScheduledOperation(sb, booking.id, operationKey).catch(() => {});
    else await markReconciliation(sb, booking, operationKey, 'Invalid scheduled PaymentIntent could not be safely cancelled.');
    await notify.owner(booking,'Stripe returned payment details that did not match the booking.').catch(() => {});
    return { ok: false, reason: 'payment_intent_validation_failed', actionRequired: true };
  }

  const attempt = await confirmWithRetry(stripe, intent.id, `scheduled-auth-confirm-${booking.id}-${booking.date}-${amount}`);
  const confirmError = attempt.error;
  if (attempt.intent) {
    intent = attempt.intent;
  } else {
    console.error('[scheduled-auth] confirm failed:', booking.ref, confirmError?.type || '', confirmError?.message || confirmError);
    try {
      intent = await stripe.paymentIntents.retrieve(intent.id);
    } catch (retrieveError) {
      await markReconciliation(sb, booking, operationKey, 'Scheduled Stripe authorization result could not be confirmed.');
      await notify.owner(booking, 'Stripe authorization result is unknown. Reconcile before dispatch.').catch(() => {});
      return { ok: false, reason: 'payment_confirmation_unconfirmed', actionRequired: true };
    }
  }

  // What the attempt means is decided in one place, for every caller.
  const outcome = classifyAuthorizationOutcome({
    intentStatus: intent.status,
    lastPaymentError: intent.last_payment_error || null,
    confirmError,
  });

  if (outcome.kind === 'authorized') {
    const finalValidation = validateScheduledIntent(intent, { booking, amount, customerId, paymentMethodId, expectedLivemode, requireAuthorized: true });
    if (!finalValidation.ok) {
      await markReconciliation(sb, booking, operationKey, 'Authorized Stripe payment did not match booking truth.');
      await notify.owner(booking, 'An authorization needs reconciliation before dispatch.').catch(() => {});
      return { ok: false, reason: 'authorized_payment_validation_failed', actionRequired: true };
    }

    const automaticDispatch = isAutomaticDispatchZip(booking.service_zip || booking.address);
    const { data: rows, error: updateError } = await sb.from('bookings').update({
      stripe_payment_intent_id: intent.id,
      payment_status: 'authorized',
      payment_authorized_at: new Date().toISOString(),
      dispatch_paused: false,
      needs_manual_dispatch: !automaticDispatch,
      dispatch_status: null,
      financial_operation_key: null,
      financial_operation_type: null,
      financial_operation_started_at: null,
      financial_reconciliation_required_at: null,
      financial_reconciliation_reason: null,
    })
      .eq('id', booking.id)
      .eq('status', 'confirmed')
      .eq('payment_status', 'card_saved')
      .eq('stripe_customer_id', customerId)
      .eq('stripe_payment_method_id', paymentMethodId)
      .eq('financial_operation_key', operationKey)
      .eq('financial_operation_type', OPERATION_TYPE)
      .select('id');

    if (updateError || !rows?.length) {
      const cancelled = await cancelIntent(stripe, intent, expectedLivemode, `scheduled-auth-link-failed-${booking.id}-${intent.id}`);
      if (cancelled) await releaseScheduledOperation(sb, booking.id, operationKey).catch(() => {});
      else await markReconciliation(sb, booking, operationKey, 'Authorized payment could not be linked or released safely.');
      await notify.owner(booking, 'Authorization linkage failed. Reconcile before dispatch.').catch(() => {});
      return { ok: false, reason: 'authorization_link_failed', actionRequired: true };
    }

    await logActivity(sb, {
      bookingId: booking.id,
      eventType: 'payment_authorized',
      actorType: 'system',
      actorName: 'scheduled payment',
      description: 'Customer card authorized for later capture five days before the appointment.',
      metadata: { paymentIntentId: intent.id, appointmentDate: booking.date },
    }).catch(() => {});
    await notify.customerAuthorized(booking).catch(() => {});
    if (automaticDispatch && !booking.assembler_id) {
      await dispatchBooking(booking.id).catch(error => console.error('[scheduled-auth] dispatch failed:', error?.message || error));
    }
    return { ok: true, authorized: true };
  }

  // We never got a confirmation to Stripe, so the bank was never asked and
  // nobody outside this system caused it. Leave the booking exactly as it was —
  // still card_saved, still inside the query at the top of this file — release
  // the lock, and tell the owner what actually failed. The customer keeps the
  // card she already gave us; the Easer keeps their day.
  if (outcome.kind === 'platform_retry') {
    await releaseScheduledOperation(sb, booking.id, operationKey).catch(() => {});
    await logActivity(sb, {
      bookingId: booking.id,
      eventType: 'scheduled_authorization_retry_scheduled',
      actorType: 'system',
      actorName: 'scheduled payment',
      description: outcome.ownerReason,
      metadata: { paymentIntentId: intent.id, code: outcome.code, appointmentDate: booking.date },
    }).catch(() => {});
    await notify.owner(booking, outcome.ownerReason).catch(() => {});
    return { ok: false, reason: 'confirmation_not_sent', actionRequired: false, retryScheduled: true };
  }

  if (outcome.kind === 'customer_action') {
    const { data: rows, error: updateError } = await sb.from('bookings').update({
      stripe_payment_intent_id: intent.id,
      payment_status: 'pending',
      dispatch_status: 'payment_hold',
      dispatch_paused: true,
      needs_manual_dispatch: true,
      financial_operation_key: null,
      financial_operation_type: null,
      financial_operation_started_at: null,
    })
      .eq('id', booking.id)
      .eq('payment_status', 'card_saved')
      .eq('financial_operation_key', operationKey)
      .eq('financial_operation_type', OPERATION_TYPE)
      .select('id');
    if (updateError || !rows?.length) {
      const cancelled = await cancelIntent(stripe, intent, expectedLivemode, `scheduled-auth-recovery-link-failed-${booking.id}-${intent.id}`);
      if (cancelled) await releaseScheduledOperation(sb, booking.id, operationKey).catch(() => {});
      else await markReconciliation(sb, booking, operationKey, 'Customer-action payment could not be linked safely.');
      await notify.owner(booking, 'Customer-action payment could not be linked. Reconcile before dispatch.').catch(() => {});
      return { ok: false, reason: 'payment_recovery_link_failed', actionRequired: true };
    }
    const recoveryBooking = {
      ...booking,
      payment_status: 'pending',
      stripe_payment_intent_id: intent.id,
    };
    await logActivity(sb, {
      bookingId: booking.id,
      eventType: 'scheduled_authorization_customer_action',
      actorType: 'system',
      actorName: 'scheduled payment',
      description: outcome.ownerReason,
      metadata: { paymentIntentId: intent.id, code: outcome.code, appointmentDate: booking.date },
    }).catch(() => {});
    const recoveryResult = await notify.customerRecovery(sb, recoveryBooking, outcome)
      .catch(error => ({ ok: false, error: error?.message || String(error) }));
    await notify.easerHold(sb, recoveryBooking).catch(() => {});
    await notify.owner(
      recoveryBooking,
      recoveryResult?.ok
        ? `${outcome.ownerReason} The customer was sent a secure link. Dispatch remains paused.`
        : `${outcome.ownerReason} The secure email was not delivered, so resend it from the booking before dispatch.`,
    ).catch(() => {});
    // The reason string is this function's contract with its callers and with
    // test-growth-booking-window; the specific Stripe code travels in the owner
    // alert, the activity log and cron_log rather than changing it.
    return { ok: false, reason: 'customer_authentication_required', actionRequired: true };
  }

  await markReconciliation(sb, booking, operationKey, outcome.ownerReason);
  await notify.owner(booking, outcome.ownerReason).catch(() => {});
  return { ok: false, reason: `unexpected_payment_status:${intent.status}`, actionRequired: true };
}

/**
 * Finish holds a previous run created but never confirmed.
 *
 * Before this existed, a single failed confirm call moved the booking to
 * payment_status 'pending', which is outside the query this job runs, so no
 * later run could ever see it again: one dropped request stranded a staffed job
 * until a human noticed. Stripe is the truth here — if the hold is still
 * unconfirmed, confirm it; if Stripe already holds the money, repair the
 * booking to match; if the bank genuinely wants the cardholder, leave it alone.
 */
export async function recoverUnconfirmedHolds({ sb, stripe, expectedLivemode, todayIso = chicagoTodayIso(), notify = DEFAULT_NOTIFIERS }) {
  const result = { authorized: 0, failures: [] };
  const { data: stuck, error } = await sb.from('bookings')
    .select('*')
    .eq('status', 'confirmed')
    .eq('payment_status', 'pending')
    .eq('dispatch_status', 'payment_hold')
    .not('stripe_payment_intent_id', 'is', null)
    .gte('date', todayIso)
    .limit(25);
  if (error || !stuck?.length) return result;

  for (const booking of stuck) {
    const outcome = await finishUnconfirmedHold({ sb, stripe, booking, expectedLivemode, notify });
    if (outcome.authorized) result.authorized += 1;
    else if (outcome.reason) result.failures.push({ ref: booking.ref, reason: outcome.reason });
  }
  return result;
}

// Exported so the owner can run exactly this, for one booking, from the
// dashboard — the same code path the nightly job takes, not a second opinion.
export async function finishUnconfirmedHold({ sb, stripe, booking, expectedLivemode, notify = DEFAULT_NOTIFIERS }) {
  const amount = Number(booking.total_price || 0);
  const customerId = stringId(booking.stripe_customer_id);
  const paymentMethodId = stringId(booking.stripe_payment_method_id);
  if (!Number.isInteger(amount) || amount <= 0 || !customerId || !paymentMethodId || expectedLivemode == null) {
    return { authorized: false, reason: 'missing_payment_source_truth' };
  }

  let intent;
  try {
    intent = await stripe.paymentIntents.retrieve(booking.stripe_payment_intent_id);
  } catch (error) {
    return { authorized: false, reason: 'stripe_lookup_failed' };
  }

  // A hold created with setup_future_usage can never be confirmed off-session:
  // Stripe rejects the combination outright, so retrying it daily would fail
  // daily. Cancel it, put the booking back in the queue, and let the normal
  // path create a clean one.
  if (intent.status === 'requires_confirmation' && intent.setup_future_usage) {
    const cancelled = await cancelIntent(stripe, intent, expectedLivemode, `scheduled-auth-unconfirmable-${booking.id}-${intent.id}`);
    if (!cancelled) return { authorized: false, reason: 'unconfirmable_hold_cancel_failed' };
    const { data: resetRows, error: resetError } = await sb.from('bookings').update({
      payment_status: 'card_saved',
      stripe_payment_intent_id: null,
      dispatch_status: null,
    })
      .eq('id', booking.id)
      .eq('status', 'confirmed')
      .eq('payment_status', 'pending')
      .eq('stripe_payment_intent_id', intent.id)
      .select('id');
    if (resetError || !resetRows?.length) return { authorized: false, reason: 'unconfirmable_hold_reset_failed' };

    await logActivity(sb, {
      bookingId: booking.id,
      eventType: 'scheduled_authorization_hold_recreated',
      actorType: 'system',
      actorName: 'scheduled payment',
      description: 'A hold that Stripe could not confirm off-session was cancelled; a clean one is being placed on the same saved card.',
      metadata: { cancelledPaymentIntentId: intent.id, appointmentDate: booking.date },
    }).catch(() => {});

    const retry = await authorizeScheduledBooking({
      sb,
      stripe,
      booking: {
        ...booking,
        payment_status: 'card_saved',
        stripe_payment_intent_id: null,
        dispatch_status: null,
        financial_operation_key: null,
        financial_operation_type: null,
        financial_operation_started_at: null,
      },
      expectedLivemode,
      // Same rule as the rest of this path: the customer already had one email
      // about this payment and does not need another because it worked.
      notify: { ...notify, customerAuthorized: async () => ({ ok: true, skipped: 'recovery_no_customer_email' }) },
    });
    if (retry.ok && retry.authorized) {
      await notify.easerCleared(sb, booking).catch(() => {});
      return { authorized: true };
    }
    return { authorized: false, reason: retry.reason || 'hold_recreate_failed' };
  }

  let confirmError = null;
  if (intent.status === 'requires_confirmation') {
    const validation = validateScheduledIntent(intent, { booking, amount, customerId, paymentMethodId, expectedLivemode });
    if (!validation.ok) return { authorized: false, reason: `stripe_mismatch:${validation.errors.join(',')}` };
    const attempt = await confirmWithRetry(stripe, intent.id, `scheduled-auth-recover-${booking.id}-${booking.date}-${amount}`);
    confirmError = attempt.error;
    if (attempt.intent) {
      intent = attempt.intent;
    } else {
      console.error('[scheduled-auth] recovery confirm failed:', booking.ref, confirmError?.type || '', confirmError?.message || confirmError);
      try {
        intent = await stripe.paymentIntents.retrieve(intent.id);
      } catch (retrieveError) {
        return { authorized: false, reason: 'confirm_result_unknown' };
      }
    }
  }

  const outcome = classifyAuthorizationOutcome({
    intentStatus: intent.status,
    lastPaymentError: intent.last_payment_error || null,
    confirmError,
  });
  // The customer really does have to act: the recovery email already went out,
  // so this run says nothing and changes nothing.
  if (outcome.kind === 'customer_action') return { authorized: false, reason: null };
  if (outcome.kind !== 'authorized') return { authorized: false, reason: outcome.code };

  const finalValidation = validateScheduledIntent(intent, { booking, amount, customerId, paymentMethodId, expectedLivemode, requireAuthorized: true });
  if (!finalValidation.ok) return { authorized: false, reason: `authorized_payment_validation_failed:${finalValidation.errors.join(',')}` };

  const automaticDispatch = isAutomaticDispatchZip(booking.service_zip || booking.address);
  const { data: rows, error: updateError } = await sb.from('bookings').update({
    payment_status: 'authorized',
    payment_authorized_at: new Date().toISOString(),
    dispatch_paused: false,
    dispatch_status: null,
    needs_manual_dispatch: !automaticDispatch && !booking.assembler_id,
    financial_operation_key: null,
    financial_operation_type: null,
    financial_operation_started_at: null,
  })
    .eq('id', booking.id)
    .eq('status', 'confirmed')
    .eq('payment_status', 'pending')
    .eq('stripe_payment_intent_id', intent.id)
    .select('id');
  if (updateError || !rows?.length) return { authorized: false, reason: 'authorization_link_failed' };

  await logActivity(sb, {
    bookingId: booking.id,
    eventType: 'payment_authorized',
    actorType: 'system',
    actorName: 'scheduled payment',
    description: 'A hold created by an earlier run was confirmed on this run; the card is authorized for capture after the visit.',
    metadata: { paymentIntentId: intent.id, appointmentDate: booking.date, recovered: true },
  }).catch(() => {});
  // The customer is deliberately NOT emailed here. A booking reaches this path
  // only after we already wrote to her once about this payment, and a hold
  // quietly going through is not news she has to act on — her appointment
  // simply stands. The Easer IS told, because he was told to stand down.
  await notify.easerCleared(sb, booking).catch(() => {});
  if (automaticDispatch && !booking.assembler_id) {
    await dispatchBooking(booking.id).catch(error => console.error('[scheduled-auth] dispatch failed:', error?.message || error));
  }
  return { authorized: true };
}

async function loadLockedBooking(sb, bookingId, operationKey) {
  const { data, error } = await sb.from('bookings').select('*').eq('id', bookingId).maybeSingle();
  return {
    ok: !error && data?.status === 'confirmed' && data?.payment_status === 'card_saved'
      && data?.financial_operation_key === operationKey && data?.financial_operation_type === OPERATION_TYPE,
    booking: data,
  };
}

async function reserveScheduledOperation(sb, booking, operationKey) {
  if (booking.financial_operation_key === operationKey && booking.financial_operation_type === OPERATION_TYPE) {
    return { ok: true, recovered: true };
  }
  if (booking.financial_operation_key || booking.financial_operation_type || booking.financial_operation_started_at) {
    return { ok: false, reason: 'financial_operation_conflict' };
  }
  let query = sb.from('bookings').update({
    financial_operation_key: operationKey,
    financial_operation_type: OPERATION_TYPE,
    financial_operation_started_at: new Date().toISOString(),
  })
    .eq('id', booking.id)
    .eq('status', 'confirmed')
    .eq('payment_status', 'card_saved')
    .eq('date', booking.date)
    .eq('time', booking.time)
    .eq('total_price', booking.total_price)
    .eq('stripe_customer_id', booking.stripe_customer_id)
    .eq('stripe_payment_method_id', booking.stripe_payment_method_id)
    .is('stripe_payment_intent_id', null)
    .is('financial_operation_key', null)
    .is('financial_operation_type', null)
    .is('financial_operation_started_at', null);
  query = booking.assembler_id == null ? query.is('assembler_id', null) : query.eq('assembler_id', booking.assembler_id);
  const { data, error } = await query.select('id');
  return error || !data?.length
    ? { ok: false, reason: error ? 'financial_operation_reservation_failed' : 'financial_operation_conflict' }
    : { ok: true, recovered: false };
}

async function releaseScheduledOperation(sb, bookingId, operationKey) {
  const { data, error } = await sb.from('bookings').update({
    financial_operation_key: null,
    financial_operation_type: null,
    financial_operation_started_at: null,
  })
    .eq('id', bookingId)
    .eq('financial_operation_key', operationKey)
    .eq('financial_operation_type', OPERATION_TYPE)
    .select('id');
  if (error || !data?.length) throw error || new Error('Scheduled payment lock release failed.');
  return true;
}

function validateScheduledIntent(intent, { booking, amount, customerId, paymentMethodId, expectedLivemode, requireAuthorized = false }) {
  const errors = [];
  if (!intent?.id?.startsWith('pi_')) errors.push('id');
  if (intent?.amount !== amount || intent?.currency !== 'usd') errors.push('amount_currency');
  if (stringId(intent?.customer) !== customerId) errors.push('customer');
  if (stringId(intent?.payment_method) !== paymentMethodId) errors.push('payment_method');
  if (intent?.capture_method !== 'manual') errors.push('capture_method');
  if (intent?.livemode !== expectedLivemode) errors.push('livemode');
  if (intent?.metadata?.bookingId !== booking.id || intent?.metadata?.type !== 'customer_booking') errors.push('metadata');
  if (requireAuthorized && intent?.status !== 'requires_capture') errors.push('status');
  return { ok: errors.length === 0, errors };
}

async function cancelIntent(stripe, intent, expectedLivemode, idempotencyKey) {
  try {
    let current = intent;
    if (!current?.id) return false;
    if (current.livemode !== expectedLivemode) return false;
    if (current.status === 'canceled') return true;
    if (['succeeded'].includes(current.status)) return false;
    current = await stripe.paymentIntents.cancel(current.id, {}, { idempotencyKey });
    return current?.status === 'canceled' && current?.livemode === expectedLivemode;
  } catch (error) {
    console.error('[scheduled-auth] cancellation failed:', error?.message || error);
    return false;
  }
}

async function markReconciliation(sb, booking, operationKey, reason) {
  let query = sb.from('bookings').update({
    dispatch_paused: true,
    needs_manual_dispatch: true,
    financial_reconciliation_required_at: new Date().toISOString(),
    financial_reconciliation_reason: reason,
  }).eq('id', booking.id);
  query = operationKey
    ? query.eq('financial_operation_key', operationKey)
    : query.is('financial_operation_key', null);
  await query;
}

async function sendAuthorizationSuccess(booking) {
  return sendEmail({
    to: booking.customer_email,
    from: 'AssembleAtEase <booking@assembleatease.com>',
    subject: `Your appointment is ready — ${booking.ref}`,
    replyTo: 'service@assembleatease.com',
    meta: { bookingId: booking.id, notificationType: 'scheduled_payment_authorized', recipientType: 'customer' },
    html: `<p>Hi ${esc(booking.customer_name)},</p><p>Your card is safely on file for your ${esc(booking.service)} appointment on <strong>${esc(formatAppointmentDate(booking.date))}</strong> at <strong>${esc(booking.time)}</strong>.</p><p>Nothing has been charged — you're only charged after the work is complete.</p>`,
  });
}

// Only ever called when Stripe itself asked for the cardholder: an
// authentication request or a refusal from the issuer. The headline states
// which one, because "your bank needs one more confirmation" on a card the bank
// never saw is how this job lost a customer's trust once already.
async function sendCustomerRecovery(sb, booking, outcome = null) {
  const previousHash = booking.guest_mutation_token_hash || null;
  const token = randomToken(32);
  const nextHash = sha256(token);
  let tokenQuery = sb.from('bookings').update({ guest_mutation_token_hash: nextHash })
    .eq('id', booking.id)
    .eq('status', 'confirmed')
    .eq('payment_status', 'pending')
    .eq('stripe_payment_intent_id', booking.stripe_payment_intent_id)
    .is('financial_operation_key', null)
    .is('financial_operation_type', null)
    .is('financial_operation_started_at', null)
    .is('financial_reconciliation_required_at', null)
    .is('cancellation_reconciliation_required_at', null);
  tokenQuery = previousHash
    ? tokenQuery.eq('guest_mutation_token_hash', previousHash)
    : tokenQuery.is('guest_mutation_token_hash', null);
  const { data: tokenRows, error: tokenError } = await tokenQuery.select('id');
  if (tokenError || !tokenRows?.length) {
    return { ok: false, error: tokenError?.message || 'Booking state changed before the secure link was saved.' };
  }

  const url = `${SITE}/api/booking/payment-recovery?bookingId=${encodeURIComponent(booking.id)}&token=${encodeURIComponent(token)}`;
  const emailResult = await sendEmail({
    to: booking.customer_email,
    from: 'AssembleAtEase <booking@assembleatease.com>',
    subject: `Confirm your card for ${booking.ref}`,
    replyTo: 'service@assembleatease.com',
    meta: { bookingId: booking.id, notificationType: 'scheduled_payment_action_required', recipientType: 'customer', dedupeWindowMin: 2 },
    html: `<p>Hi ${esc(booking.customer_name)},</p><p>${esc(outcome?.customerHeadline || 'Your bank needs one more confirmation')} before your ${esc(booking.service)} appointment on <strong>${esc(formatAppointmentDate(booking.date))}</strong>.</p><p><a href="${esc(url)}">Confirm your card securely</a></p><p>No payment is collected until completed work.</p>`,
  }).catch(error => ({ ok: false, error: error?.message || String(error) }));

  const delivered = emailResult?.ok === true && emailResult?.suppressed !== true;
  if (delivered) return { ok: true };

  let rollbackQuery = sb.from('bookings').update({ guest_mutation_token_hash: previousHash })
    .eq('id', booking.id)
    .eq('status', 'confirmed')
    .eq('payment_status', 'pending')
    .eq('stripe_payment_intent_id', booking.stripe_payment_intent_id)
    .eq('guest_mutation_token_hash', nextHash)
    .is('financial_operation_key', null)
    .is('financial_operation_type', null)
    .is('financial_operation_started_at', null);
  const { data: rollbackRows, error: rollbackError } = await rollbackQuery.select('id');
  if (rollbackError || !rollbackRows?.length) {
    await markReconciliation(sb, booking, null, 'Scheduled customer payment email failed and secure-link rollback could not be verified.');
    return { ok: false, error: 'Secure-link rollback could not be verified.' };
  }
  return { ok: false, error: emailResult?.error || 'Customer payment email was not delivered.' };
}

// An owner may now attach an Easer to a booking whose hold is still scheduled,
// so a failed authorization can strand a pro who has already planned their day
// around the job. The owner alert and the customer recovery email existed; the
// person who blocked out the time was the one nobody told (Rule 10).
async function notifyAssignedEaserPaymentHold(sb, booking) {
  if (!booking.assembler_id) return { ok: true, skipped: 'no_easer_assigned' };
  let easerEmail = null;
  try {
    const { data } = await sb.auth.admin.getUserById(booking.assembler_id);
    easerEmail = data?.user?.email || null;
  } catch (lookupError) {
    console.error('[scheduled-auth] easer lookup failed:', lookupError?.message || lookupError);
  }
  if (!easerEmail) return { ok: false, reason: 'easer_email_unresolved' };
  return sendEmail({
    to: easerEmail,
    from: 'AssembleAtEase <booking@assembleatease.com>',
    subject: `Job on hold — ${booking.ref}`,
    replyTo: 'service@assembleatease.com',
    meta: { bookingId: booking.id, notificationType: 'scheduled_payment_easer_hold', recipientType: 'easer', recipientUserId: booking.assembler_id },
    html: `<p>Your job <strong>${esc(booking.ref)}</strong> on ${esc(formatAppointmentDate(booking.date))} at ${esc(booking.time)} is <strong>on hold</strong>.</p>`
      + "<p>The customer's payment needs to be confirmed before the work can go ahead. We have contacted them and will let you know as soon as it clears.</p>"
      + '<p><strong>Do not travel to this job until it is confirmed.</strong> Your earnings for it are unchanged; nothing about your account or payouts is affected.</p>',
  }).catch(error => ({ ok: false, error: error?.message || String(error) }));
}

// The other half of the hold email. A pro told "do not travel" is owed the
// moment it clears, or they write the day off anyway (Rule 10).
async function notifyAssignedEaserPaymentCleared(sb, booking) {
  if (!booking.assembler_id) return { ok: true, skipped: 'no_easer_assigned' };
  let easerEmail = null;
  try {
    const { data } = await sb.auth.admin.getUserById(booking.assembler_id);
    easerEmail = data?.user?.email || null;
  } catch (lookupError) {
    console.error('[scheduled-auth] easer lookup failed:', lookupError?.message || lookupError);
  }
  if (!easerEmail) return { ok: false, reason: 'easer_email_unresolved' };
  return sendEmail({
    to: easerEmail,
    from: 'AssembleAtEase <booking@assembleatease.com>',
    subject: `Job confirmed — ${booking.ref}`,
    replyTo: 'service@assembleatease.com',
    meta: { bookingId: booking.id, notificationType: 'scheduled_payment_easer_cleared', recipientType: 'easer', recipientUserId: booking.assembler_id },
    html: `<p>Your job <strong>${esc(booking.ref)}</strong> on ${esc(formatAppointmentDate(booking.date))} at ${esc(booking.time)} is <strong>confirmed</strong>.</p>`
      + '<p>The payment hold cleared, so the earlier hold notice no longer applies. Plan for this job as normal.</p>',
  }).catch(error => ({ ok: false, error: error?.message || String(error) }));
}

async function sendOwnerAlert(booking, message) {
  return sendEmail({
    to: ownerEmail(),
    from: 'AssembleAtEase Alerts <booking@assembleatease.com>',
    subject: `Payment action needed — ${booking.ref}`,
    replyTo: booking.customer_email || 'service@assembleatease.com',
    meta: { bookingId: booking.id, notificationType: 'scheduled_payment_owner_action', recipientType: 'owner' },
    html: `<p><strong>${esc(booking.ref)}</strong></p><p>${esc(message)}</p><p>Customer: ${esc(booking.customer_name)}<br>Appointment: ${esc(formatAppointmentDate(booking.date))} at ${esc(booking.time)}</p>`,
  });
}

function stripeLivemodeForSecret(secret) {
  if (String(secret || '').startsWith('sk_live_')) return true;
  if (String(secret || '').startsWith('sk_test_')) return false;
  return null;
}

function stringId(value) {
  return typeof value === 'string' ? value : value?.id || null;
}
