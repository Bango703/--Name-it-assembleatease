import Stripe from 'stripe';
import { getSupabase } from '../_supabase.js';
import { esc, ownerEmail, sendEmail } from '../_email.js';
import { deriveGuestMutationToken } from '../_payment-security.js';
import { isAutomaticDispatchZip } from '../_source-of-truth.js';
import { dispatchBooking } from '../booking/_dispatch-internal.js';
import { addIsoDays, SCHEDULED_AUTHORIZATION_LEAD_DAYS } from '../booking/_booking-window.js';
import { chicagoTodayIso } from '../booking/_appt-date.js';
import { logActivity } from '../booking/_activity.js';
import { logCron } from './_cron-logger.js';

const OPERATION_TYPE = 'authorize_scheduled_payment';
const SITE = String(process.env.PUBLIC_SITE_URL || 'https://www.assembleatease.com').replace(/\/$/, '');

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
  if (!bookings?.length) {
    await logCron('authorize-scheduled-payments', { status: 'ok', records: 0, duration: Date.now() - startedAt });
    return res.status(200).json({ ok: true, authorized: 0, actionRequired: 0 });
  }
  if (!process.env.STRIPE_SECRET_KEY) return res.status(503).json({ error: 'Stripe is not configured.' });

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const expectedLivemode = stripeLivemodeForSecret(process.env.STRIPE_SECRET_KEY);
  let authorized = 0;
  let actionRequired = 0;
  const failures = [];

  for (const booking of bookings) {
    const outcome = await authorizeScheduledBooking({ sb, stripe, booking, expectedLivemode, todayIso: today });
    if (outcome.ok && outcome.authorized) authorized++;
    if (outcome.actionRequired) actionRequired++;
    if (!outcome.ok) failures.push({ ref: booking.ref, reason: outcome.reason });
  }

  await logCron('authorize-scheduled-payments', {
    status: failures.length ? 'partial' : 'ok',
    records: authorized,
    duration: Date.now() - startedAt,
  });
  return res.status(200).json({
    ok: true,
    authorized,
    actionRequired,
    skipped: failures.length,
    failures: failures.length ? failures : undefined,
  });
}

export async function authorizeScheduledBooking({ sb, stripe, booking, expectedLivemode, todayIso = chicagoTodayIso() }) {
  const authorizationCutoff = addIsoDays(todayIso, SCHEDULED_AUTHORIZATION_LEAD_DAYS);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(booking.date || ''))
      || booking.date < todayIso
      || booking.date > authorizationCutoff) {
    if (booking.financial_operation_type === OPERATION_TYPE && booking.financial_operation_key) {
      await markReconciliation(sb, booking, booking.financial_operation_key, 'Scheduled authorization is outside the safe appointment window.');
      await sendOwnerAlert(booking, 'The appointment date needs review before any card authorization.').catch(() => {});
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
    await sendOwnerAlert(booking, 'Saved card details or Stripe mode could not be verified.').catch(() => {});
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
      setup_future_usage: 'off_session',
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
    await sendOwnerAlert(booking, 'Stripe authorization creation could not be confirmed. Reconcile before dispatch.').catch(() => {});
    return { ok: false, reason: 'payment_intent_creation_unconfirmed', actionRequired: true };
  }

  const createdValidation = validateScheduledIntent(intent, { booking, amount, customerId, paymentMethodId, expectedLivemode });
  if (!createdValidation.ok) {
    const cancelled = await cancelIntent(stripe, intent, expectedLivemode, `scheduled-auth-invalid-${booking.id}-${intent.id}`);
    if (cancelled) await releaseScheduledOperation(sb, booking.id, operationKey).catch(() => {});
    else await markReconciliation(sb, booking, operationKey, 'Invalid scheduled PaymentIntent could not be safely cancelled.');
    await sendOwnerAlert(booking, 'Stripe returned payment details that did not match the booking.').catch(() => {});
    return { ok: false, reason: 'payment_intent_validation_failed', actionRequired: true };
  }

  try {
    intent = await stripe.paymentIntents.confirm(intent.id, { off_session: true }, {
      idempotencyKey: `scheduled-auth-confirm-${booking.id}-${booking.date}-${amount}`,
    });
  } catch (error) {
    try {
      intent = await stripe.paymentIntents.retrieve(intent.id);
    } catch (retrieveError) {
      await markReconciliation(sb, booking, operationKey, 'Scheduled Stripe authorization result could not be confirmed.');
      await sendOwnerAlert(booking, 'Stripe authorization result is unknown. Reconcile before dispatch.').catch(() => {});
      return { ok: false, reason: 'payment_confirmation_unconfirmed', actionRequired: true };
    }
  }

  if (intent.status === 'requires_capture') {
    const finalValidation = validateScheduledIntent(intent, { booking, amount, customerId, paymentMethodId, expectedLivemode, requireAuthorized: true });
    if (!finalValidation.ok) {
      await markReconciliation(sb, booking, operationKey, 'Authorized Stripe payment did not match booking truth.');
      await sendOwnerAlert(booking, 'An authorization needs reconciliation before dispatch.').catch(() => {});
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
      await sendOwnerAlert(booking, 'Authorization linkage failed. Reconcile before dispatch.').catch(() => {});
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
    await sendAuthorizationSuccess(booking).catch(() => {});
    if (automaticDispatch && !booking.assembler_id) {
      await dispatchBooking(booking.id).catch(error => console.error('[scheduled-auth] dispatch failed:', error?.message || error));
    }
    return { ok: true, authorized: true };
  }

  if (['requires_payment_method', 'requires_action', 'requires_confirmation'].includes(intent.status)) {
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
      await sendOwnerAlert(booking, 'Customer-action payment could not be linked. Reconcile before dispatch.').catch(() => {});
      return { ok: false, reason: 'payment_recovery_link_failed', actionRequired: true };
    }
    await sendCustomerRecovery(booking).catch(error => console.error('[scheduled-auth] customer recovery email failed:', error?.message || error));
    await sendOwnerAlert(booking, 'The customer was sent a secure link to verify their card. Dispatch remains paused.').catch(() => {});
    return { ok: false, reason: 'customer_authentication_required', actionRequired: true };
  }

  await markReconciliation(sb, booking, operationKey, `Unexpected Stripe payment state: ${intent.status}.`);
  await sendOwnerAlert(booking, `Unexpected Stripe payment state (${intent.status}). Reconcile before dispatch.`).catch(() => {});
  return { ok: false, reason: `unexpected_payment_status:${intent.status}`, actionRequired: true };
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
  await sb.from('bookings').update({
    dispatch_paused: true,
    needs_manual_dispatch: true,
    financial_reconciliation_required_at: new Date().toISOString(),
    financial_reconciliation_reason: reason,
  }).eq('id', booking.id).eq('financial_operation_key', operationKey);
}

async function sendAuthorizationSuccess(booking) {
  return sendEmail({
    to: booking.customer_email,
    from: 'AssembleAtEase <booking@assembleatease.com>',
    subject: `Your appointment is ready — ${booking.ref}`,
    replyTo: 'service@assembleatease.com',
    meta: { bookingId: booking.id, notificationType: 'scheduled_payment_authorized', recipientType: 'customer' },
    html: `<p>Hi ${esc(booking.customer_name)},</p><p>Your card has been verified for your ${esc(booking.service)} appointment on <strong>${esc(booking.date)}</strong> at <strong>${esc(booking.time)}</strong>.</p><p>No payment has been collected. Payment is processed after completed work.</p>`,
  });
}

async function sendCustomerRecovery(booking) {
  const token = deriveGuestMutationToken({ id: booking.id, bookingId: booking.id, ref: booking.ref, email: booking.customer_email });
  const url = `${SITE}/api/booking/payment-recovery?bookingId=${encodeURIComponent(booking.id)}&token=${encodeURIComponent(token)}`;
  return sendEmail({
    to: booking.customer_email,
    from: 'AssembleAtEase <booking@assembleatease.com>',
    subject: `Confirm your card for ${booking.ref}`,
    replyTo: 'service@assembleatease.com',
    meta: { bookingId: booking.id, notificationType: 'scheduled_payment_action_required', recipientType: 'customer' },
    html: `<p>Hi ${esc(booking.customer_name)},</p><p>Your bank needs one more confirmation before your ${esc(booking.service)} appointment on <strong>${esc(booking.date)}</strong>.</p><p><a href="${esc(url)}">Confirm your card securely</a></p><p>No payment is collected until completed work.</p>`,
  });
}

async function sendOwnerAlert(booking, message) {
  return sendEmail({
    to: ownerEmail(),
    from: 'AssembleAtEase Alerts <booking@assembleatease.com>',
    subject: `Payment action needed — ${booking.ref}`,
    replyTo: booking.customer_email || 'service@assembleatease.com',
    meta: { bookingId: booking.id, notificationType: 'scheduled_payment_owner_action', recipientType: 'owner' },
    html: `<p><strong>${esc(booking.ref)}</strong></p><p>${esc(message)}</p><p>Customer: ${esc(booking.customer_name)}<br>Appointment: ${esc(booking.date)} at ${esc(booking.time)}</p>`,
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
