import Stripe from 'stripe';
import { getSupabase } from '../_supabase.js';
import { esc } from '../_email.js';
import { rateLimit } from '../_ratelimit.js';
import {
  hasValidGuestPaymentToken,
  isRecoverablePaymentIntentStatus,
  isStandardRecoveryBooking,
  validateBookingPaymentIntent,
} from './_pending-payment-recovery.js';

const BOOKING_SELECT = 'id, ref, service, status, payment_status, dispatch_status, customer_name, customer_email, address, total_price, stripe_payment_intent_id, guest_mutation_token_hash, financial_operation_key, financial_operation_type, financial_operation_started_at';

export default async function handler(req, res) {
  setSecurityHeaders(res);
  if (req.method === 'GET') return renderRecoveryPage(req, res);
  if (req.method === 'POST') return startRecovery(req, res);
  return res.status(405).json({ error: 'Method not allowed' });
}

async function renderRecoveryPage(req, res) {
  const bookingId = String(req.query?.bookingId || '').trim();
  const token = String(req.query?.token || '').trim();
  if (!bookingId || !token) {
    return res.status(400).send(buildSimplePage('This payment link is incomplete.', 'Contact AssembleAtEase for a new secure link.'));
  }

  const state = await loadRecoveryState({ bookingId, token, allowAlreadyConfirmed: true });
  if (!state.ok) {
    const status = state.status || 410;
    return res.status(status).send(buildSimplePage(
      status >= 500 ? 'Secure payment is temporarily unavailable.' : 'This payment link is no longer available.',
      status >= 500 ? 'Please try again shortly or contact AssembleAtEase.' : 'Contact AssembleAtEase if your booking still needs payment.',
    ));
  }
  if (state.alreadyConfirmed) {
    return res.status(200).send(buildSimplePage('Your booking is already confirmed.', `Booking ${esc(state.booking.ref)} does not need another card authorization.`));
  }

  return res.status(200).send(buildRecoveryPage({ booking: state.booking, token }));
}

async function startRecovery(req, res) {
  const ip = String(req.headers?.['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  try {
    if (!await rateLimit(ip, 'booking')) return res.status(429).json({ error: 'Too many attempts. Please wait and try again.' });
  } catch (rateError) {
    console.error('[payment-recovery] Rate limiter unavailable:', rateError?.message || rateError);
  }

  const bookingId = String(req.body?.bookingId || '').trim();
  const token = String(req.body?.token || '').trim();
  if (!bookingId || !token) return res.status(400).json({ error: 'Secure booking credentials are required.' });

  const state = await loadRecoveryState({ bookingId, token, allowAlreadyConfirmed: true });
  if (!state.ok) return res.status(state.status || 410).json({ error: state.publicError || 'This payment link is no longer available.' });
  if (state.alreadyConfirmed) return res.status(200).json({ confirmed: true, bookingRef: state.booking.ref });

  const { booking, intent, sb } = state;
  // booking-confirmed and the Stripe webhook only promote payment_status=pending.
  // Reset a prior failed row after live Stripe validation, including the case
  // where Stripe already reached requires_capture before the failed state was
  // recorded locally.
  if (booking.payment_status === 'failed') {
    const { data: resetRows, error: resetError } = await sb.from('bookings').update({ payment_status: 'pending' })
      .eq('id', booking.id)
      .eq('status', booking.status)
      .eq('payment_status', 'failed')
      .eq('stripe_payment_intent_id', intent.id)
      .is('financial_operation_key', null)
      .is('financial_operation_type', null)
      .is('financial_operation_started_at', null)
      .select('id');
    if (resetError) return res.status(503).json({ error: 'Payment recovery could not be prepared. Please try again.' });
    if (!resetRows?.length) {
      const { data: current } = await sb.from('bookings')
        .select('id, status, payment_status, stripe_payment_intent_id, financial_operation_key, financial_operation_type, financial_operation_started_at')
        .eq('id', booking.id)
        .maybeSingle();
      const safelyResetByConcurrentRequest = current?.status === booking.status
        && current?.payment_status === 'pending'
        && current?.stripe_payment_intent_id === intent.id
        && !hasActiveFinancialOperation(current);
      if (!safelyResetByConcurrentRequest) {
        return res.status(409).json({ error: 'Booking payment state changed. Reload this secure link.' });
      }
    }
    booking.payment_status = 'pending';
  }

  const currentState = await verifyRecoveryStillUnlocked({ sb, booking, intent });
  if (!currentState.ok) {
    return res.status(currentState.status).json({
      error: currentState.status >= 500
        ? 'Booking payment state could not be verified. Please try again.'
        : 'Another payment or cancellation operation is in progress. Reload this secure link later.',
      code: currentState.status === 409 ? 'FINANCIAL_OPERATION_IN_PROGRESS' : 'PAYMENT_RECOVERY_STATE_UNAVAILABLE',
    });
  }

  if (intent.status === 'requires_capture') {
    return res.status(200).json({
      alreadyAuthorized: true,
      bookingId: booking.id,
      bookingRef: booking.ref,
    });
  }
  if (!isRecoverablePaymentIntentStatus(intent.status)) {
    return res.status(409).json({ error: 'This card authorization can no longer be continued. Contact AssembleAtEase.' });
  }
  if (!intent.client_secret) {
    return res.status(409).json({ error: 'Stripe could not continue this card authorization. Contact AssembleAtEase.' });
  }

  return res.status(200).json({
    ready: true,
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
    clientSecret: intent.client_secret,
    bookingId: booking.id,
    bookingRef: booking.ref,
  });
}

async function loadRecoveryState({ bookingId, token, allowAlreadyConfirmed = false }) {
  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_PUBLISHABLE_KEY) {
    return { ok: false, status: 503, publicError: 'Secure payment recovery is not configured.' };
  }
  const sb = getSupabase();
  const { data: booking, error } = await sb.from('bookings')
    .select(BOOKING_SELECT)
    .eq('id', bookingId)
    .maybeSingle();
  if (error) return { ok: false, status: 503, publicError: 'Booking payment state could not be verified.' };
  if (!booking || !hasValidGuestPaymentToken(booking, token)) return { ok: false, status: 410 };
  if (hasActiveFinancialOperation(booking)) {
    return {
      ok: false,
      status: 409,
      publicError: 'Another payment or cancellation operation is in progress. Try this secure link again later.',
    };
  }

  const fullyConfirmed = booking.status === 'confirmed' && booking.payment_status === 'authorized';
  if (allowAlreadyConfirmed && fullyConfirmed) return { ok: true, alreadyConfirmed: true, booking, sb };
  if (!isStandardRecoveryBooking(booking)) {
    return {
      ok: false,
      status: 409,
      publicError: 'This booking is not in a recoverable payment state. Contact AssembleAtEase.',
    };
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  let intent;
  try {
    intent = await stripe.paymentIntents.retrieve(booking.stripe_payment_intent_id);
  } catch (stripeError) {
    console.error('[payment-recovery] Stripe lookup failed:', stripeError?.message || stripeError);
    return { ok: false, status: 502, publicError: 'Stripe payment state could not be verified.' };
  }
  const validation = validateBookingPaymentIntent(booking, intent);
  if (!validation.ok) {
    console.error('[payment-recovery] PaymentIntent mismatch:', {
      bookingId: booking.id,
      paymentIntentId: intent?.id || null,
      errors: validation.errors,
    });
    return { ok: false, status: 409, publicError: 'Payment details do not match this booking. Contact AssembleAtEase.' };
  }

  if (intent.status !== 'requires_capture' && !isRecoverablePaymentIntentStatus(intent.status)) {
    return { ok: false, status: 409, publicError: 'This payment can no longer be continued. Contact AssembleAtEase.' };
  }
  return { ok: true, booking, intent, stripe, sb };
}

async function verifyRecoveryStillUnlocked({ sb, booking, intent }) {
  const { data, error } = await sb.from('bookings')
    .select('id')
    .eq('id', booking.id)
    .eq('status', booking.status)
    .eq('payment_status', booking.payment_status)
    .eq('stripe_payment_intent_id', intent.id)
    .eq('guest_mutation_token_hash', booking.guest_mutation_token_hash)
    .is('financial_operation_key', null)
    .is('financial_operation_type', null)
    .is('financial_operation_started_at', null)
    .maybeSingle();
  if (error) return { ok: false, status: 503 };
  return data ? { ok: true } : { ok: false, status: 409 };
}

function hasActiveFinancialOperation(booking) {
  return Boolean(
    booking?.financial_operation_key
    || booking?.financial_operation_type
    || booking?.financial_operation_started_at,
  );
}

function setSecurityHeaders(res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Content-Security-Policy', "default-src 'none'; script-src https://js.stripe.com 'unsafe-inline'; style-src 'unsafe-inline'; frame-src https://js.stripe.com https://hooks.stripe.com; connect-src 'self' https://api.stripe.com; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
}

function buildRecoveryPage({ booking, token }) {
  const amount = `$${(Number(booking.total_price || 0) / 100).toFixed(2)}`;
  const bookingIdJson = jsonForScript(booking.id);
  const tokenJson = jsonForScript(token);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Continue secure payment - AssembleAtEase</title><script src="https://js.stripe.com/v3/"></script><style>body{margin:0;background:#f4f4f5;color:#18181b;font-family:Arial,sans-serif}.card{max-width:560px;margin:40px auto;background:#fff;border:1px solid #e4e4e7;border-radius:14px;padding:28px}.summary{background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:14px 16px;margin:18px 0}.row{display:flex;justify-content:space-between;gap:16px;padding:5px 0}.total{font-size:20px;font-weight:800}.terms{font-size:13px;line-height:1.6;color:#52525b;margin:18px 0}.stripe-box{border:1px solid #d4d4d8;border-radius:8px;padding:14px}.btn{width:100%;margin-top:16px;padding:14px;border:0;border-radius:8px;background:#00BFFF;color:#fff;font-size:16px;font-weight:800;cursor:pointer}.btn:disabled{opacity:.55}.msg{font-size:14px;line-height:1.6;margin-top:14px;color:#52525b}</style></head><body><main class="card"><h1>Continue your secure booking</h1><p>Booking <strong>${esc(booking.ref)}</strong> for ${esc(booking.service)}</p><div class="summary"><div class="row"><span>Card authorization</span><strong class="total">${esc(amount)}</strong></div></div><div id="card" class="stripe-box"></div><div class="terms">Your card will be authorized now and captured after completed work. Cancellation is free until 24 hours before the appointment. A disclosed late-cancellation fee may apply inside 24 hours.</div><button class="btn" id="continue" disabled>Authorize ${esc(amount)} and confirm booking</button><p class="msg" id="msg">Loading secure payment...</p></main><script>const bookingId=${bookingIdJson};const token=${tokenJson};const button=document.getElementById('continue');const msg=document.getElementById('msg');let stripe;let card;let startData;async function finishConfirmation(){const response=await fetch('/api/booking-confirmed',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({bookingId,guestMutationToken:token})});const data=await response.json();if(!response.ok)throw new Error(data.error||'Payment was authorized, but booking confirmation is still pending. Contact support and do not pay again.');msg.textContent='Booking confirmed. You will receive your booking confirmation by email.';button.style.display='none';if(card)document.getElementById('card').style.display='none';}async function start(){try{const response=await fetch('/api/booking/payment-recovery',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({bookingId,token})});startData=await response.json();if(!response.ok)throw new Error(startData.error||'Secure payment could not be loaded.');if(startData.confirmed){msg.textContent='Your booking is already confirmed. No additional payment authorization is needed.';document.getElementById('card').style.display='none';button.style.display='none';return;}if(startData.alreadyAuthorized){msg.textContent='Your card is already authorized. Finishing booking confirmation...';await finishConfirmation();return;}stripe=Stripe(startData.publishableKey);card=stripe.elements().create('card');card.mount('#card');button.disabled=false;msg.textContent='Enter your card details to continue.';}catch(error){msg.textContent=error.message;button.disabled=true;}}button.onclick=async()=>{button.disabled=true;msg.textContent='Authorizing securely...';try{const result=await stripe.confirmCardPayment(startData.clientSecret,{payment_method:{card}});if(result.error)throw new Error(result.error.message);if(!result.paymentIntent||result.paymentIntent.status!=='requires_capture')throw new Error('The card authorization did not reach the expected secure state.');msg.textContent='Authorization complete. Confirming your booking...';await finishConfirmation();}catch(error){msg.textContent=error.message;button.disabled=false;}};start();</script></body></html>`;
}

function buildSimplePage(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AssembleAtEase secure payment</title><style>body{margin:0;background:#f4f4f5;color:#18181b;font-family:Arial,sans-serif}.card{max-width:540px;margin:50px auto;background:#fff;border:1px solid #e4e4e7;border-radius:12px;padding:28px}p{line-height:1.7;color:#52525b}</style></head><body><main class="card"><h1>${esc(title)}</h1><p>${body}</p><p>Support: <a href="mailto:service@assembleatease.com">service@assembleatease.com</a> or 737-290-6129.</p></main></body></html>`;
}

function jsonForScript(value) {
  return JSON.stringify(String(value || '')).replace(/</g, '\\u003c');
}
