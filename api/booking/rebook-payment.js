import Stripe from 'stripe';
import { getSupabase } from '../_supabase.js';
import { esc, ownerEmail, sendEmail } from '../_email.js';
import { rateLimit } from '../_ratelimit.js';
import { safeTokenHashMatch } from '../_payment-security.js';
import { isAutomaticDispatchZip } from '../_source-of-truth.js';
import { needsScheduledAuthorization, validateBookingWindowDate } from './_booking-window.js';
import { logActivity } from './_activity.js';
import { isRecoverablePaymentIntentStatus, validateBookingPaymentIntent } from './_pending-payment-recovery.js';
import { formatRebookDate } from './_rebook-payment-email.js';

const SITE = String(process.env.PUBLIC_SITE_URL || 'https://www.assembleatease.com').replace(/\/$/, '');
const BOOKING_SELECT = 'id, ref, service, status, payment_status, customer_name, customer_email, address, service_zip, date, time, details, total_price, tax_amount, call_zone, stripe_customer_id, stripe_payment_method_id, stripe_payment_intent_id, guest_mutation_token_hash, rebooked_from_booking_id, source, dispatch_status, dispatch_paused, needs_manual_dispatch, financial_operation_key, financial_operation_type, financial_operation_started_at, financial_reconciliation_required_at, cancellation_reconciliation_required_at';

export default async function handler(req, res) {
  setSecurityHeaders(res);
  if (req.method === 'GET') return renderPage(req, res);
  if (req.method === 'POST') return handleAction(req, res);
  return res.status(405).json({ error: 'Method not allowed' });
}

async function renderPage(req, res) {
  const bookingId = String(req.query?.bookingId || '').trim();
  const token = String(req.query?.token || '').trim();
  if (!bookingId || !token) {
    return res.status(400).send(buildSimplePage('This payment link is incomplete.', 'Contact AssembleAtEase for a new secure link.'));
  }

  const state = await loadRebookState({ bookingId, token, allowCompleted: true });
  if (!state.ok) {
    return res.status(state.status || 410).send(buildSimplePage(
      state.status >= 500 ? 'Secure payment is temporarily unavailable.' : 'This payment link is no longer available.',
      state.publicError || (state.status >= 500 ? 'Please try again shortly or contact AssembleAtEase.' : 'Contact AssembleAtEase if this appointment still needs payment.'),
    ));
  }
  if (state.completed) {
    const message = state.booking.payment_status === 'authorized'
      ? 'Your card is authorized and this appointment is confirmed.'
      : 'Your payment method is saved. We will authorize it closer to the appointment date.';
    return res.status(200).send(buildSimplePage('Your rebooking is confirmed.', `${message} Booking ${state.booking.ref}.`));
  }
  return res.status(200).send(buildPaymentPage({ booking: state.booking, token }));
}

async function handleAction(req, res) {
  const ip = String(req.headers?.['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  try {
    if (!await rateLimit(ip, 'booking')) return res.status(429).json({ error: 'Too many attempts. Please wait and try again.' });
  } catch (error) {
    console.error('[rebook-payment] Rate limiter unavailable:', error?.message || error);
  }

  const action = String(req.body?.action || 'prepare').trim();
  const bookingId = String(req.body?.bookingId || '').trim();
  const token = String(req.body?.token || '').trim();
  if (!bookingId || !token) return res.status(400).json({ error: 'Secure booking credentials are required.' });
  if (!['prepare', 'finalize_card'].includes(action)) return res.status(400).json({ error: 'Invalid payment action.' });

  const state = await loadRebookState({ bookingId, token, allowCompleted: true });
  if (!state.ok) return res.status(state.status || 410).json({ error: state.publicError || 'This payment link is no longer available.' });
  if (state.completed) {
    return res.status(200).json({
      confirmed: true,
      paymentStatus: state.booking.payment_status,
      bookingRef: state.booking.ref,
    });
  }

  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_PUBLISHABLE_KEY) {
    return res.status(503).json({ error: 'Secure payment is temporarily unavailable.' });
  }

  if (action === 'finalize_card') return finalizeFutureCard(req, res, state);
  return preparePayment(req, res, state);
}

async function preparePayment(req, res, state) {
  const { booking, sb } = state;
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const futureCardOnly = needsScheduledAuthorization(booking.date);
  if (futureCardOnly) {
    let customer;
    try {
      customer = await getOrCreateCustomer(stripe, booking);
      const setupIntent = await stripe.setupIntents.create({
        customer: customer.id,
        payment_method_types: ['card'],
        usage: 'off_session',
        metadata: {
          bookingId: booking.id,
          bookingRef: booking.ref,
          type: 'owner_rebook_setup',
          email: String(booking.customer_email || '').toLowerCase(),
          appointmentDate: booking.date,
        },
      }, { idempotencyKey: `owner-rebook-card-setup-${booking.id}-${booking.date}` });
      if (!setupIntent.client_secret) throw new Error('SetupIntent client secret missing');
      const unlocked = await rebookPaymentStateStillUnlocked(sb, booking);
      if (!unlocked.ok) {
        await cancelUnlinkedSetupIntent(stripe, setupIntent.id);
        return res.status(unlocked.error ? 503 : 409).json({ error: 'Booking state changed. Reload this secure link.' });
      }
      return res.status(200).json({
        ready: true,
        mode: 'save',
        publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
        clientSecret: setupIntent.client_secret,
        setupIntentId: setupIntent.id,
        setupComplete: setupIntent.status === 'succeeded',
        bookingRef: booking.ref,
      });
    } catch (error) {
      console.error('[rebook-payment] Future card setup failed:', error?.message || error);
      return res.status(502).json({ error: 'The secure card form could not be prepared. Please try again.' });
    }
  }

  let intent = null;
  if (booking.stripe_payment_intent_id) {
    try {
      intent = await stripe.paymentIntents.retrieve(booking.stripe_payment_intent_id);
    } catch (error) {
      console.error('[rebook-payment] Linked PaymentIntent lookup failed:', error?.message || error);
      return res.status(502).json({ error: 'Payment status could not be verified. Please try again.' });
    }
    const validation = validateBookingPaymentIntent(booking, intent);
    if (!validation.ok) {
      console.error('[rebook-payment] Linked PaymentIntent mismatch:', validation.errors);
      return res.status(409).json({ error: 'Payment details do not match this booking. Contact AssembleAtEase.' });
    }
    if (intent.status === 'requires_capture') {
      return res.status(200).json({ alreadyAuthorized: true, mode: 'authorize', bookingRef: booking.ref });
    }
    if (intent.status !== 'canceled' && !isRecoverablePaymentIntentStatus(intent.status)) {
      return res.status(409).json({ error: 'This card authorization can no longer be continued. Contact AssembleAtEase.' });
    }
  }

  if (!intent || intent.status === 'canceled') {
    const oldIntentId = intent?.id || null;
    let customer;
    let replacement;
    try {
      customer = await getOrCreateCustomer(stripe, booking);
      replacement = await stripe.paymentIntents.create({
        amount: Number(booking.total_price),
        currency: 'usd',
        customer: customer.id,
        capture_method: 'manual',
        setup_future_usage: 'off_session',
        payment_method_types: ['card'],
        payment_method_options: { card: { request_three_d_secure: 'automatic' } },
        receipt_email: booking.customer_email,
        statement_descriptor_suffix: 'ASSEMBLEATEASE',
        description: `Rebooking - ${booking.service} - ${booking.customer_name}`,
        metadata: {
          bookingRef: booking.ref,
          bookingId: booking.id,
          type: 'customer_booking',
          ownerRebook: 'true',
          ...(oldIntentId ? { replacesPaymentIntentId: oldIntentId } : {}),
        },
      }, { idempotencyKey: `owner-rebook-payment-${booking.id}-${booking.total_price}-${oldIntentId || 'initial'}` });
    } catch (error) {
      console.error('[rebook-payment] PaymentIntent creation failed:', error?.message || error);
      return res.status(502).json({ error: 'The secure authorization could not be prepared. Please try again.' });
    }

    const validation = validateBookingPaymentIntent({ ...booking, stripe_payment_intent_id: replacement.id, stripe_customer_id: customer.id }, replacement);
    if (!validation.ok || (!isRecoverablePaymentIntentStatus(replacement.status) && replacement.status !== 'requires_capture')) {
      const cancelled = await quarantineUnlinkedIntent({
        stripe, sb, booking, paymentIntentId: replacement.id,
        reason: 'Stripe returned an unlinked rebooking PaymentIntent that did not match booking truth.',
      });
      return res.status(cancelled ? 502 : 503).json({
        error: cancelled
          ? 'Stripe returned payment details that could not be verified.'
          : 'Payment state needs review. Do not enter the card again; contact AssembleAtEase.',
        code: cancelled ? 'REBOOK_PAYMENT_VALIDATION_FAILED' : 'REBOOK_PAYMENT_RECONCILIATION_REQUIRED',
      });
    }

    let linkQuery = sb.from('bookings').update({
      stripe_customer_id: customer.id,
      stripe_payment_intent_id: replacement.id,
    })
      .eq('id', booking.id)
      .eq('status', 'pending')
      .eq('payment_status', 'pending')
      .eq('guest_mutation_token_hash', booking.guest_mutation_token_hash)
      .is('financial_operation_key', null)
      .is('financial_operation_type', null)
      .is('financial_operation_started_at', null)
      .is('financial_reconciliation_required_at', null)
      .is('cancellation_reconciliation_required_at', null);
    linkQuery = oldIntentId
      ? linkQuery.eq('stripe_payment_intent_id', oldIntentId)
      : linkQuery.is('stripe_payment_intent_id', null);
    const { data: linkedRows, error: linkError } = await linkQuery.select('id');
    if (linkError || !linkedRows?.length) {
      const { data: current } = await sb.from('bookings')
        .select('id, status, payment_status, stripe_payment_intent_id, stripe_customer_id')
        .eq('id', booking.id)
        .maybeSingle();
      if (current?.status !== 'pending'
          || current?.payment_status !== 'pending'
          || current?.stripe_payment_intent_id !== replacement.id
          || current?.stripe_customer_id !== customer.id) {
        const cancelled = await quarantineUnlinkedIntent({
          stripe, sb, booking, paymentIntentId: replacement.id,
          reason: 'A rebooking PaymentIntent could not be linked to the booking or safely cancelled.',
        });
        return res.status(cancelled ? (linkError ? 503 : 409) : 503).json({
          error: cancelled
            ? 'Booking payment state changed. Reload this secure link.'
            : 'Payment state needs review. Do not enter the card again; contact AssembleAtEase.',
          code: cancelled ? 'REBOOK_PAYMENT_STATE_CHANGED' : 'REBOOK_PAYMENT_RECONCILIATION_REQUIRED',
        });
      }
    }
    booking.stripe_customer_id = customer.id;
    booking.stripe_payment_intent_id = replacement.id;
    intent = replacement;
    await logActivity(sb, {
      bookingId: booking.id,
      eventType: 'rebook_payment_authorization_prepared',
      actorType: 'customer',
      actorName: 'Customer',
      description: 'Secure card authorization was prepared for the replacement appointment.',
      metadata: { paymentIntentId: intent.id, replacedPaymentIntentId: oldIntentId },
    }).catch(() => {});
  }

  if (intent.status === 'requires_capture') {
    return res.status(200).json({ alreadyAuthorized: true, mode: 'authorize', bookingRef: booking.ref });
  }
  if (!intent.client_secret) return res.status(409).json({ error: 'Card authorization could not continue. Contact AssembleAtEase.' });
  const unlocked = await rebookPaymentStateStillUnlocked(sb, booking);
  if (!unlocked.ok) {
    return res.status(unlocked.error ? 503 : 409).json({ error: 'Booking payment state changed. Reload this secure link.' });
  }
  return res.status(200).json({
    ready: true,
    mode: 'authorize',
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
    clientSecret: intent.client_secret,
    bookingRef: booking.ref,
  });
}

async function finalizeFutureCard(req, res, state) {
  const { booking, sb } = state;
  if (!needsScheduledAuthorization(booking.date)) {
    return res.status(409).json({
      error: 'This appointment is now inside the authorization window. Reload the page to authorize the booking.',
      code: 'REBOOK_AUTHORIZATION_NOW_REQUIRED',
    });
  }
  const setupIntentId = String(req.body?.setupIntentId || '').trim();
  if (!setupIntentId.startsWith('seti_')) return res.status(400).json({ error: 'Secure card setup reference is required.' });

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  let setupIntent;
  try {
    setupIntent = await stripe.setupIntents.retrieve(setupIntentId);
  } catch (error) {
    console.error('[rebook-payment] SetupIntent lookup failed:', error?.message || error);
    return res.status(502).json({ error: 'Card setup could not be verified. Please try again.' });
  }
  const customerId = stripeId(setupIntent.customer);
  const paymentMethodId = stripeId(setupIntent.payment_method);
  const expectedLivemode = stripeLivemodeForSecret(process.env.STRIPE_SECRET_KEY);
  const valid = setupIntent.status === 'succeeded'
    && setupIntent.metadata?.bookingId === booking.id
    && setupIntent.metadata?.bookingRef === booking.ref
    && setupIntent.metadata?.type === 'owner_rebook_setup'
    && String(setupIntent.metadata?.email || '').toLowerCase() === String(booking.customer_email || '').toLowerCase()
    && setupIntent.metadata?.appointmentDate === booking.date
    && !!customerId
    && !!paymentMethodId
    && expectedLivemode != null
    && setupIntent.livemode === expectedLivemode;
  if (!valid) return res.status(409).json({ error: 'Card setup does not match this appointment. Contact AssembleAtEase.' });

  const automaticDispatch = isAutomaticDispatchZip(booking.service_zip || '');
  const now = new Date().toISOString();
  const { data: rows, error: updateError } = await sb.from('bookings').update({
    status: 'confirmed',
    payment_status: 'card_saved',
    confirmed_at: now,
    confirmed_by: 'customer_rebook_card_setup',
    stripe_customer_id: customerId,
    stripe_payment_method_id: paymentMethodId,
    stripe_payment_intent_id: null,
    dispatch_paused: true,
    dispatch_status: null,
    needs_manual_dispatch: !automaticDispatch,
  })
    .eq('id', booking.id)
    .eq('status', 'pending')
    .eq('payment_status', 'pending')
    .eq('guest_mutation_token_hash', booking.guest_mutation_token_hash)
    .is('stripe_payment_intent_id', null)
    .is('financial_operation_key', null)
    .is('financial_operation_type', null)
    .is('financial_operation_started_at', null)
    .is('financial_reconciliation_required_at', null)
    .is('cancellation_reconciliation_required_at', null)
    .select('id');

  if (updateError || !rows?.length) {
    const { data: current } = await sb.from('bookings')
      .select('id, status, payment_status, stripe_customer_id, stripe_payment_method_id')
      .eq('id', booking.id)
      .maybeSingle();
    const alreadyFinalized = current?.status === 'confirmed'
      && current?.payment_status === 'card_saved'
      && current?.stripe_customer_id === customerId
      && current?.stripe_payment_method_id === paymentMethodId;
    if (!alreadyFinalized) {
      return res.status(updateError ? 503 : 409).json({ error: 'The card was saved, but the appointment state changed. Contact AssembleAtEase; do not enter the card again.' });
    }
  }

  await logActivity(sb, {
    bookingId: booking.id,
    eventType: 'rebook_card_saved',
    actorType: 'customer',
    actorName: 'Customer',
    description: 'Customer saved a payment method for the replacement appointment. Authorization remains scheduled closer to service.',
    metadata: { setupIntentId, appointmentDate: booking.date },
  }).catch(() => {});

  const trackUrl = `${SITE}/track?ref=${encodeURIComponent(booking.ref)}&email=${encodeURIComponent(booking.customer_email)}&token=${encodeURIComponent(String(req.body?.token || ''))}`;
  const emailResults = await Promise.all([
    sendEmail({
      to: booking.customer_email,
      from: 'AssembleAtEase <booking@assembleatease.com>',
      subject: `Your rebooking is scheduled - ${booking.ref}`,
      replyTo: ownerEmail(),
      html: `<p>Hi ${esc(booking.customer_name)},</p><p>Your payment method is saved for <strong>${esc(booking.service)}</strong> on <strong>${esc(formatRebookDate(booking.date))}</strong>${booking.time ? ` at <strong>${esc(booking.time)}</strong>` : ''}.</p><p>Nothing has been charged. We will authorize the ${money(booking.total_price)} total closer to the appointment and notify you if your bank needs any additional confirmation.</p><p>Booking reference: <strong>${esc(booking.ref)}</strong></p><p><a href="${esc(trackUrl)}">Track or manage your booking</a></p>`,
      meta: { bookingId: booking.id, notificationType: 'rebook_card_saved', recipientType: 'customer' },
    }),
    sendEmail({
      to: ownerEmail(),
      from: 'AssembleAtEase <booking@assembleatease.com>',
      subject: `Rebooking card saved - ${booking.ref}`,
      replyTo: booking.customer_email,
      html: `<p><strong>${esc(booking.ref)}</strong> has a verified payment method saved.</p><p>The ${money(booking.total_price)} authorization is scheduled closer to the ${esc(booking.date)} appointment. Dispatch remains paused until authorization succeeds.</p>`,
      meta: { bookingId: booking.id, notificationType: 'rebook_card_saved_owner', recipientType: 'owner' },
    }),
  ].map(promise => promise.catch(error => ({ ok: false, error: error?.message || String(error) }))));

  return res.status(200).json({
    confirmed: true,
    paymentStatus: 'card_saved',
    bookingRef: booking.ref,
    warnings: emailResults.some(result => result?.ok !== true) ? ['confirmation_email_failed'] : [],
  });
}

async function loadRebookState({ bookingId, token, allowCompleted = false }) {
  const sb = getSupabase();
  const { data: booking, error } = await sb.from('bookings')
    .select(BOOKING_SELECT)
    .eq('id', bookingId)
    .maybeSingle();
  if (error) return { ok: false, status: 503, publicError: 'Booking payment state could not be verified.' };
  if (!booking || !safeTokenHashMatch(token, booking.guest_mutation_token_hash)) return { ok: false, status: 410 };
  if (booking.source !== 'online' || !booking.rebooked_from_booking_id) return { ok: false, status: 409, publicError: 'This link is not for a replacement appointment.' };
  if (hasActiveFinancialOperation(booking)) return { ok: false, status: 409, publicError: 'Another payment or cancellation action is in progress. Try again shortly.' };
  if (allowCompleted && booking.status === 'confirmed' && ['authorized', 'card_saved'].includes(booking.payment_status)) {
    return { ok: true, completed: true, booking, sb };
  }
  if (booking.status !== 'pending' || booking.payment_status !== 'pending') {
    return { ok: false, status: 409, publicError: 'This replacement appointment is not awaiting a payment method.' };
  }
  const dateCheck = validateBookingWindowDate(booking.date);
  if (!dateCheck.ok) return { ok: false, status: 410, publicError: 'The appointment date is no longer available. Contact AssembleAtEase to update it.' };
  if (!Number.isInteger(Number(booking.total_price)) || Number(booking.total_price) <= 0) {
    return { ok: false, status: 409, publicError: 'The appointment total needs review before payment can continue.' };
  }
  return { ok: true, booking, sb };
}

async function getOrCreateCustomer(stripe, booking) {
  const linkedId = stripeId(booking.stripe_customer_id);
  if (linkedId) {
    const linked = await stripe.customers.retrieve(linkedId);
    if (!linked?.deleted) return linked;
  }
  const existing = await stripe.customers.list({ email: booking.customer_email, limit: 1 });
  const reusable = existing.data.find(customer => !customer?.deleted);
  return reusable || stripe.customers.create({
    email: booking.customer_email,
    name: booking.customer_name,
    metadata: { bookingRef: booking.ref, source: 'owner_rebook' },
  });
}

async function cancelUnlinkedIntent(stripe, paymentIntentId) {
  try {
    const current = await stripe.paymentIntents.retrieve(paymentIntentId);
    if (current.status === 'canceled') return true;
    if (current.status === 'succeeded' || current.status === 'requires_capture') return false;
    const cancelled = await stripe.paymentIntents.cancel(paymentIntentId);
    return cancelled.status === 'canceled';
  } catch (error) {
    console.error('[rebook-payment] Unlinked PaymentIntent cancellation could not be verified:', error?.message || error);
    return false;
  }
}

async function quarantineUnlinkedIntent({ stripe, sb, booking, paymentIntentId, reason }) {
  const cancelled = await cancelUnlinkedIntent(stripe, paymentIntentId);
  if (cancelled) return true;

  const now = new Date().toISOString();
  await sb.from('bookings').update({
    dispatch_paused: true,
    needs_manual_dispatch: true,
    financial_reconciliation_required_at: now,
    financial_reconciliation_reason: reason,
  })
    .eq('id', booking.id)
    .eq('status', 'pending')
    .eq('payment_status', 'pending')
    .eq('guest_mutation_token_hash', booking.guest_mutation_token_hash)
    .is('financial_operation_key', null)
    .is('financial_operation_type', null)
    .is('financial_operation_started_at', null)
    .is('financial_reconciliation_required_at', null)
    .is('cancellation_reconciliation_required_at', null);
  await logActivity(sb, {
    bookingId: booking.id,
    eventType: 'rebook_payment_reconciliation_required',
    actorType: 'system',
    actorName: 'payment safety',
    description: reason,
    metadata: { paymentIntentId },
  }).catch(() => {});
  return false;
}

async function cancelUnlinkedSetupIntent(stripe, setupIntentId) {
  try {
    const current = await stripe.setupIntents.retrieve(setupIntentId);
    if (current.status === 'canceled') return true;
    if (!['requires_payment_method', 'requires_confirmation', 'requires_action'].includes(current.status)) return false;
    const cancelled = await stripe.setupIntents.cancel(setupIntentId);
    return cancelled.status === 'canceled';
  } catch (error) {
    console.error('[rebook-payment] Unlinked SetupIntent cancellation could not be verified:', error?.message || error);
    return false;
  }
}

async function rebookPaymentStateStillUnlocked(sb, booking) {
  const { data: current, error } = await sb.from('bookings')
    .select('id, status, payment_status, date, total_price, stripe_payment_intent_id, guest_mutation_token_hash, financial_operation_key, financial_operation_type, financial_operation_started_at, financial_reconciliation_required_at, cancellation_reconciliation_required_at')
    .eq('id', booking.id)
    .maybeSingle();
  if (error) return { ok: false, error };
  return {
    ok: current?.status === 'pending'
      && current?.payment_status === 'pending'
      && current?.date === booking.date
      && Number(current?.total_price) === Number(booking.total_price)
      && current?.stripe_payment_intent_id === booking.stripe_payment_intent_id
      && current?.guest_mutation_token_hash === booking.guest_mutation_token_hash
      && !hasActiveFinancialOperation(current),
  };
}

function stripeId(value) {
  return typeof value === 'string' ? value : value?.id || null;
}

function stripeLivemodeForSecret(secret) {
  if (String(secret || '').startsWith('sk_live_')) return true;
  if (String(secret || '').startsWith('sk_test_')) return false;
  return null;
}

function hasActiveFinancialOperation(booking) {
  return Boolean(
    booking?.financial_operation_key
    || booking?.financial_operation_type
    || booking?.financial_operation_started_at
    || booking?.financial_reconciliation_required_at
    || booking?.cancellation_reconciliation_required_at
  );
}

function setSecurityHeaders(res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Content-Security-Policy', "default-src 'none'; script-src https://js.stripe.com 'unsafe-inline'; style-src 'unsafe-inline'; frame-src https://js.stripe.com https://hooks.stripe.com; connect-src 'self' https://api.stripe.com; img-src https://www.assembleatease.com data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
}

function buildPaymentPage({ booking, token }) {
  const amount = money(booking.total_price);
  const subtotal = money(Number(booking.total_price || 0) - Number(booking.tax_amount || 0));
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Complete rebooking - AssembleAtEase</title><script src="https://js.stripe.com/v3/"></script><style>body{margin:0;background:#f4f4f5;color:#18181b;font-family:Arial,sans-serif}.card{max-width:590px;margin:32px auto;background:#fff;border:1px solid #e4e4e7;border-radius:14px;padding:28px;box-sizing:border-box}.brand{font-size:13px;font-weight:800;color:#0369a1;text-transform:uppercase;letter-spacing:.08em}.summary{background:#f8fafc;border:1px solid #e2e8f0;border-radius:9px;padding:14px 16px;margin:18px 0}.row{display:flex;justify-content:space-between;gap:18px;padding:6px 0;font-size:14px}.row span{min-width:0;overflow-wrap:anywhere}.row span:last-child{text-align:right}.total{font-size:19px;font-weight:800;border-top:1px solid #e2e8f0;margin-top:5px;padding-top:11px}.stripe-box{border:1px solid #cbd5e1;border-radius:8px;padding:14px}.terms{display:flex;gap:9px;align-items:flex-start;font-size:13px;line-height:1.55;color:#52525b;margin:16px 0}.btn{width:100%;padding:14px;border:0;border-radius:8px;background:#00BFFF;color:#002b3a;font-size:16px;font-weight:800;cursor:pointer}.btn:disabled{opacity:.5;cursor:not-allowed}.msg{font-size:14px;line-height:1.6;margin-top:14px;color:#52525b}@media(max-width:640px){.card{margin:0;min-height:100vh;border:0;border-radius:0;padding:24px 18px}.row{gap:10px}}</style></head><body><main class="card"><div class="brand">AssembleAtEase</div><h1>Complete your rebooking</h1><p>Review the appointment and add a payment method for booking <strong>${esc(booking.ref)}</strong>.</p><div class="summary"><div class="row"><span>Service</span><span><strong>${esc(booking.service)}</strong></span></div><div class="row"><span>Date</span><span>${esc(formatRebookDate(booking.date))}${booking.time ? ` at ${esc(booking.time)}` : ''}</span></div><div class="row"><span>Address</span><span>${esc(booking.address)}</span></div>${booking.details ? `<div class="row"><span>Job details</span><span>${esc(booking.details)}</span></div>` : ''}<div class="row"><span>Service subtotal</span><span>${subtotal}</span></div><div class="row"><span>Texas sales tax</span><span>${money(booking.tax_amount)}</span></div><div class="row total"><span>Total</span><span>${amount}</span></div></div><div id="card" class="stripe-box"></div><label class="terms"><input id="terms" type="checkbox"><span>I reviewed the appointment total and agree to the <a href="/terms" target="_blank" rel="noopener">Terms</a>, including the cancellation policy, and acknowledge the <a href="/privacy" target="_blank" rel="noopener">Privacy Notice</a>.</span></label><button class="btn" id="continue" disabled>Add payment method</button><p class="msg" id="msg">Loading secure payment...</p></main><script>const bookingId=${jsonForScript(booking.id)};const token=${jsonForScript(token)};const customerName=${jsonForScript(booking.customer_name)};const customerEmail=${jsonForScript(booking.customer_email)};const button=document.getElementById('continue');const checkbox=document.getElementById('terms');const msg=document.getElementById('msg');let stripe;let card;let startData;let cardComplete=false;function sync(){button.disabled=!(startData&&checkbox.checked&&(cardComplete||startData.setupComplete));}checkbox.onchange=sync;async function finalizeBooking(){const response=await fetch('/api/booking-confirmed',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({bookingId,guestMutationToken:token})});const data=await response.json();if(!response.ok)throw new Error(data.error||'Authorization succeeded, but confirmation is pending. Contact support and do not enter the card again.');done('Your card is authorized and your rebooking is confirmed.');}async function finalizeCard(setupIntentId){const response=await fetch('/api/booking/rebook-payment',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'finalize_card',bookingId,token,setupIntentId})});const data=await response.json();if(!response.ok)throw new Error(data.error||'Your card was saved, but confirmation is pending. Contact support and do not enter the card again.');done('Your payment method is saved and your rebooking is scheduled. We will authorize it closer to the appointment date.');}function done(message){msg.textContent=message;button.style.display='none';document.getElementById('card').style.display='none';document.querySelector('.terms').style.display='none';}async function start(){try{const response=await fetch('/api/booking/rebook-payment',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'prepare',bookingId,token})});startData=await response.json();if(!response.ok)throw new Error(startData.error||'Secure payment could not be loaded.');if(startData.confirmed){done(startData.paymentStatus==='authorized'?'Your card is authorized and your rebooking is confirmed.':'Your payment method is saved and your rebooking is scheduled.');return;}if(startData.alreadyAuthorized){msg.textContent='Authorization complete. Confirming your rebooking...';await finalizeBooking();return;}if(startData.setupComplete&&startData.setupIntentId){msg.textContent='Finishing your saved payment method...';await finalizeCard(startData.setupIntentId);return;}stripe=Stripe(startData.publishableKey);card=stripe.elements().create('card');card.mount('#card');card.on('change',event=>{cardComplete=event.complete;msg.textContent=event.error?event.error.message:(event.complete?'Card details ready.':'Enter your card details.');sync();});button.textContent=startData.mode==='save'?'Save payment method':'Authorize ${esc(amount)} and confirm';msg.textContent=startData.mode==='save'?'Add your card securely. Nothing is charged today.':'Add your card securely. The total will be authorized, not charged today.';sync();}catch(error){msg.textContent=error.message;button.disabled=true;}}button.onclick=async()=>{button.disabled=true;msg.textContent=startData.mode==='save'?'Saving securely...':'Authorizing securely...';try{if(startData.mode==='save'){const result=await stripe.confirmCardSetup(startData.clientSecret,{payment_method:{card,billing_details:{name:customerName,email:customerEmail}}});if(result.error)throw new Error(result.error.message);if(!result.setupIntent||result.setupIntent.status!=='succeeded')throw new Error('The card was not saved. Please try again.');await finalizeCard(result.setupIntent.id);}else{const result=await stripe.confirmCardPayment(startData.clientSecret,{payment_method:{card,billing_details:{name:customerName,email:customerEmail}}});if(result.error)throw new Error(result.error.message);if(!result.paymentIntent||result.paymentIntent.status!=='requires_capture')throw new Error('The authorization did not reach the expected secure state.');await finalizeBooking();}}catch(error){msg.textContent=error.message;sync();}};start();</script></body></html>`;
}

function buildSimplePage(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AssembleAtEase</title></head><body style="font-family:Arial,sans-serif;background:#f4f4f5;color:#18181b"><main style="max-width:560px;margin:40px auto;background:#fff;padding:28px;border-radius:12px"><h1>${esc(title)}</h1><p style="line-height:1.65">${esc(body)}</p><p><a href="mailto:service@assembleatease.com">service@assembleatease.com</a> | 737-290-6129</p></main></body></html>`;
}

function jsonForScript(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

function money(cents) {
  return `$${(Number(cents || 0) / 100).toFixed(2)}`;
}
