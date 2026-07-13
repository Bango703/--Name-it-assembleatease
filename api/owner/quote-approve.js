import Stripe from 'stripe';
import { getSupabase } from '../_supabase.js';
import { verifyOwner, sendEmail, ownerEmail, esc } from '../_email.js';
import { BOOKING_STATUS } from '../_source-of-truth.js';
import { dispatchBooking } from '../booking/_dispatch-internal.js';
import { rateLimit } from '../_ratelimit.js';
import { randomToken, sha256 } from '../_payment-security.js';

const QUOTE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const QUOTE_TERMS_VERSION = '2026-07-cancellation-v1';
const MAX_QUOTE_CENTS = 2_500_000;

export default async function handler(req, res) {
  if (req.method === 'GET') return renderQuoteApproval(req, res);
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (req.body?.token) return authorizeCustomerApprovedQuote(req, res);
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });
  return prepareQuote(req, res);
}

async function prepareQuote(req, res) {
  const { bookingId, finalPriceCents } = req.body || {};
  const priceCents = Number.parseInt(finalPriceCents, 10);
  if (!bookingId) return res.status(400).json({ error: 'bookingId required' });
  if (!Number.isInteger(priceCents) || priceCents < 100 || priceCents > MAX_QUOTE_CENTS) {
    return res.status(400).json({ error: 'Quote total must be between $1.00 and $25,000.00.' });
  }
  if (process.env.VERCEL_ENV === 'production' && process.env.TEXAS_TAX_CONFIGURATION_APPROVED !== 'true') {
    return res.status(503).json({
      error: 'Quote authorization is paused until the launch tax configuration is approved.',
      code: 'TAX_CONFIGURATION_REQUIRED',
    });
  }

  const sb = getSupabase();
  const { data: booking, error } = await sb.from('bookings').select('*').eq('id', bookingId).single();
  if (error || !booking) return res.status(404).json({ error: 'Booking not found' });
  if (!booking.stripe_customer_id || !booking.stripe_payment_method_id) {
    return res.status(400).json({
      error: 'No saved payment method on this booking. Customer must submit a new quote request with a card.',
      code: 'NO_PAYMENT_METHOD',
    });
  }
  if (booking.quote_approved_at || ['authorized', 'captured'].includes(booking.payment_status)) {
    return res.status(409).json({ error: 'This quote has already been customer-approved and authorized.' });
  }
  if (booking.stripe_payment_intent_id) {
    return res.status(409).json({
      error: 'A Stripe authorization attempt already exists for this quote. Reconcile or release it before issuing a new amount.',
      code: 'QUOTE_PAYMENT_STATE_EXISTS',
    });
  }

  const subtotalCents = Math.round(priceCents / 1.0825);
  const taxCents = priceCents - subtotalCents;
  const token = randomToken(32);
  const tokenHash = sha256(token);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + QUOTE_TTL_MS);

  const { error: updateErr } = await sb.from('bookings').update({
    quote_amount_cents: priceCents,
    quote_subtotal_cents: subtotalCents,
    quote_tax_cents: taxCents,
    quote_token_hash: tokenHash,
    quote_sent_at: now.toISOString(),
    quote_expires_at: expiresAt.toISOString(),
    quote_approval_started_at: null,
    quote_approved_at: null,
    quote_terms_version: QUOTE_TERMS_VERSION,
    stripe_payment_intent_id: null,
    payment_status: 'quote_pending_approval',
  }).eq('id', booking.id);

  if (updateErr) {
    console.error('quote prepare update failed:', updateErr);
    return res.status(500).json({ error: 'Could not save the quote approval request.' });
  }

  const site = process.env.PUBLIC_SITE_URL || 'https://www.assembleatease.com';
  const approvalUrl = `${site}/api/owner/quote-approve?token=${encodeURIComponent(token)}`;
  const emailResult = await sendEmail({
    to: booking.customer_email,
    from: 'AssembleAtEase <booking@assembleatease.com>',
    subject: `Review and approve your quote — ${booking.ref}`,
    html: buildQuoteReadyEmail({ booking, subtotalCents, taxCents, priceCents, approvalUrl, expiresAt }),
    replyTo: ownerEmail(),
    meta: { bookingId: booking.id, notificationType: 'quote_ready_for_approval', recipientType: 'customer' },
  });

  return res.status(200).json({
    ok: true,
    approvalPending: true,
    amount: priceCents,
    subtotalCents,
    taxCents,
    expiresAt: expiresAt.toISOString(),
    warnings: emailResult.ok ? [] : ['quote_approval_email_failed'],
  });
}

async function renderQuoteApproval(req, res) {
  const token = String(req.query?.token || '');
  if (!token) return res.status(400).send('Missing quote approval token.');

  const sb = getSupabase();
  const { data: booking } = await sb.from('bookings')
    .select('id, ref, service, customer_name, date, time, quote_amount_cents, quote_subtotal_cents, quote_tax_cents, quote_expires_at, quote_approved_at, quote_token_hash')
    .eq('quote_token_hash', sha256(token))
    .maybeSingle();

  if (!booking || booking.quote_approved_at || !booking.quote_amount_cents) {
    return res.status(410).send(buildSimplePage('This quote link is no longer available.', 'Contact AssembleAtEase if you need a new quote.'));
  }
  if (!booking.quote_expires_at || Date.parse(booking.quote_expires_at) <= Date.now()) {
    return res.status(410).send(buildSimplePage('This quote has expired.', 'Contact AssembleAtEase and we will issue a fresh quote for your review.'));
  }

  const publishableKey = process.env.STRIPE_PUBLISHABLE_KEY || '';
  if (!publishableKey) {
    return res.status(503).send(buildSimplePage('Secure approval is temporarily unavailable.', 'Please try again shortly or contact AssembleAtEase.'));
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).send(buildApprovalPage({ booking, token, publishableKey }));
}

async function authorizeCustomerApprovedQuote(req, res) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  if (!await rateLimit(ip, 'booking')) return res.status(429).json({ error: 'Too many attempts. Please wait and try again.' });
  if (!process.env.STRIPE_SECRET_KEY) return res.status(503).json({ error: 'Stripe is not configured.' });
  if (process.env.VERCEL_ENV === 'production' && process.env.TEXAS_TAX_CONFIGURATION_APPROVED !== 'true') {
    return res.status(503).json({
      error: 'Quote authorization is paused until the launch tax configuration is approved.',
      code: 'TAX_CONFIGURATION_REQUIRED',
    });
  }

  const token = String(req.body?.token || '');
  const action = String(req.body?.action || 'authorize');
  if (!token) return res.status(400).json({ error: 'Approval token required.' });

  const tokenHash = sha256(token);
  const sb = getSupabase();
  const { data: booking } = await sb.from('bookings').select('*').eq('quote_token_hash', tokenHash).maybeSingle();
  if (!booking || booking.quote_approved_at) return res.status(410).json({ error: 'This quote link is no longer available.' });
  if (!booking.quote_expires_at || Date.parse(booking.quote_expires_at) <= Date.now()) {
    return res.status(410).json({ error: 'This quote has expired. Contact AssembleAtEase for a new quote.' });
  }
  if (!booking.stripe_customer_id || !booking.stripe_payment_method_id || !booking.quote_amount_cents) {
    return res.status(409).json({ error: 'This quote is missing secure payment details. Contact AssembleAtEase.' });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  if (action === 'authorize') {
    let pi = null;
    if (booking.stripe_payment_intent_id) {
      pi = await stripe.paymentIntents.retrieve(booking.stripe_payment_intent_id);
      if (pi.status === 'requires_capture') {
        return finalizeQuote({ req, res, sb, stripe, booking, pi, tokenHash });
      }
      if (!['requires_payment_method', 'requires_confirmation', 'requires_action'].includes(pi.status)) {
        return res.status(409).json({ error: `The quote authorization is in an unexpected state (${pi.status}). Contact AssembleAtEase.` });
      }
    } else {
      pi = await stripe.paymentIntents.create({
        amount: booking.quote_amount_cents,
        currency: 'usd',
        customer: booking.stripe_customer_id,
        payment_method: booking.stripe_payment_method_id,
        capture_method: 'manual',
        setup_future_usage: 'off_session',
        receipt_email: booking.customer_email,
        statement_descriptor_suffix: 'ASSEMBLEATEASE',
        description: `Customer-approved quote — ${booking.service} — ${booking.customer_name}`,
        metadata: {
          bookingRef: booking.ref,
          bookingId: booking.id,
          type: 'customer_quote',
          quoteTermsVersion: booking.quote_terms_version || QUOTE_TERMS_VERSION,
        },
      }, { idempotencyKey: `quote-customer-authorize-${booking.id}-${booking.quote_amount_cents}` });

      const { error: linkErr } = await sb.from('bookings').update({
        stripe_payment_intent_id: pi.id,
        payment_status: 'quote_authorization_pending',
        quote_approval_started_at: new Date().toISOString(),
      }).eq('id', booking.id).eq('quote_token_hash', tokenHash);
      if (linkErr) {
        return res.status(500).json({
          error: 'Could not save the secure authorization attempt. Retry this page; the same unconfirmed PaymentIntent will be reused.',
        });
      }
    }

    return res.status(200).json({
      ok: true,
      requiresConfirmation: true,
      clientSecret: pi.client_secret,
    });
  }

  if (action !== 'finalize') return res.status(400).json({ error: 'Invalid quote approval action.' });
  if (!booking.stripe_payment_intent_id) return res.status(409).json({ error: 'Quote authorization has not started.' });
  const pi = await stripe.paymentIntents.retrieve(booking.stripe_payment_intent_id);
  return finalizeQuote({ req, res, sb, stripe, booking, pi, tokenHash });
}

async function finalizeQuote({ req, res, sb, booking, pi, tokenHash }) {
  const validIntent = pi.status === 'requires_capture'
    && pi.capture_method === 'manual'
    && pi.currency === 'usd'
    && pi.amount === booking.quote_amount_cents
    && pi.metadata?.bookingId === booking.id
    && pi.metadata?.type === 'customer_quote';
  if (!validIntent) {
    return res.status(409).json({
      error: pi.status === 'requires_action'
        ? 'Card verification is not complete yet.'
        : 'Stripe authorization does not match this quote. The booking was not confirmed.',
    });
  }

  const now = new Date().toISOString();
  const { data: rows, error: updateErr } = await sb.from('bookings').update({
    total_price: booking.quote_amount_cents,
    tax_amount: booking.quote_tax_cents,
    payment_status: 'authorized',
    payment_authorized_at: now,
    status: BOOKING_STATUS.CONFIRMED,
    confirmed_at: now,
    confirmed_by: 'customer_quote_approval',
    quote_approved_at: now,
    quote_token_hash: null,
  }).eq('id', booking.id).eq('quote_token_hash', tokenHash).select('id');

  if (updateErr || !rows?.length) {
    console.error('quote finalize persistence failed:', updateErr);
    return res.status(500).json({
      error: 'Your card was authorized, but confirmation could not be saved. Please retry this page; you will not be authorized twice.',
      code: 'QUOTE_CONFIRMATION_PERSIST_FAILED',
    });
  }

  try { await dispatchBooking(booking.id); } catch (dispatchErr) {
    console.error('quote approval dispatch error:', dispatchErr?.message || dispatchErr);
  }

  const amountDisplay = `$${(booking.quote_amount_cents / 100).toFixed(2)}`;
  await Promise.allSettled([
    sendEmail({
      to: booking.customer_email,
      from: 'AssembleAtEase <booking@assembleatease.com>',
      subject: `Quote approved and booking confirmed — ${booking.ref}`,
      html: `<p>Your quote for <strong>${esc(booking.service)}</strong> was approved for <strong>${amountDisplay}</strong>.</p><p>Your card is authorized, not charged. Payment is captured only after completed work, except for disclosed cancellation fees.</p>`,
      replyTo: ownerEmail(),
      meta: { bookingId: booking.id, notificationType: 'quote_approved', recipientType: 'customer' },
    }),
    sendEmail({
      to: ownerEmail(),
      from: 'AssembleAtEase <booking@assembleatease.com>',
      subject: `Customer approved quote — ${booking.ref} — ${amountDisplay}`,
      html: `<p><strong>${esc(booking.customer_name)}</strong> approved quote <strong>${esc(booking.ref)}</strong> for ${amountDisplay}. Stripe authorization ${esc(pi.id)} is ready for capture after completion.</p>`,
      meta: { bookingId: booking.id, notificationType: 'quote_approved', recipientType: 'owner' },
    }),
  ]);

  return res.status(200).json({ ok: true, confirmed: true, paymentIntentId: pi.id, amount: booking.quote_amount_cents });
}

function buildApprovalPage({ booking, token, publishableKey }) {
  const firstName = esc(String(booking.customer_name || 'there').split(' ')[0]);
  const subtotal = (booking.quote_subtotal_cents / 100).toFixed(2);
  const tax = (booking.quote_tax_cents / 100).toFixed(2);
  const total = (booking.quote_amount_cents / 100).toFixed(2);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Approve quote — AssembleAtEase</title><script src="https://js.stripe.com/v3/"></script><style>body{margin:0;background:#f4f4f5;color:#18181b;font-family:Arial,sans-serif}.card{max-width:560px;margin:40px auto;background:#fff;border:1px solid #e4e4e7;border-radius:14px;padding:28px}.row{display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid #f4f4f5}.total{font-size:20px;font-weight:800}.terms{margin:20px 0;padding:14px;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;font-size:13px;line-height:1.6}.btn{width:100%;padding:14px;border:0;border-radius:8px;background:#00BFFF;color:#002b3a;font-size:16px;font-weight:800;cursor:pointer}.btn:disabled{opacity:.55}.msg{font-size:14px;line-height:1.6;margin-top:14px}</style></head><body><main class="card"><h1>Review your quote, ${firstName}</h1><p>Booking <strong>${esc(booking.ref)}</strong> for ${esc(booking.service)}</p><div class="row"><span>Service subtotal</span><strong>$${subtotal}</strong></div><div class="row"><span>Texas sales tax</span><strong>$${tax}</strong></div><div class="row total"><span>Total authorized</span><span>$${total}</span></div><div class="terms"><strong>Payment and cancellation terms:</strong> Your card will be authorized now and captured after completed work. Cancellation is free until 24 hours before the appointment. A 10% service-subtotal fee may apply inside 24 hours, or 15% once a pro is on the way; tax is not included in the cancellation fee.</div><button class="btn" id="approve">Approve quote and authorize $${total}</button><p class="msg" id="msg"></p></main><script>const stripe=Stripe(${JSON.stringify(publishableKey)});const token=${JSON.stringify(token)};const btn=document.getElementById('approve');const msg=document.getElementById('msg');btn.onclick=async()=>{btn.disabled=true;msg.textContent='Starting secure authorization…';try{let r=await fetch('/api/owner/quote-approve',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token,action:'authorize'})});let d=await r.json();if(!r.ok)throw new Error(d.error||'Could not start authorization.');if(d.confirmed){msg.textContent='Quote approved. Your booking is confirmed.';btn.style.display='none';return;}const result=await stripe.confirmCardPayment(d.clientSecret);if(result.error)throw new Error(result.error.message);r=await fetch('/api/owner/quote-approve',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token,action:'finalize'})});d=await r.json();if(!r.ok)throw new Error(d.error||'Could not save confirmation.');msg.textContent='Quote approved. Your booking is confirmed.';btn.style.display='none';}catch(e){msg.textContent=e.message;btn.disabled=false;}};</script></body></html>`;
}

function buildQuoteReadyEmail({ booking, subtotalCents, taxCents, priceCents, approvalUrl, expiresAt }) {
  return `<div style="font-family:Arial,sans-serif;max-width:580px;margin:0 auto;padding:24px;color:#18181b"><h2>Your custom quote is ready</h2><p>Hi ${esc(String(booking.customer_name || '').split(' ')[0])}, review the exact price and terms before authorizing your card.</p><table width="100%" style="font-size:14px"><tr><td style="padding:8px 0">Service subtotal</td><td style="text-align:right">$${(subtotalCents / 100).toFixed(2)}</td></tr><tr><td style="padding:8px 0">Texas sales tax</td><td style="text-align:right">$${(taxCents / 100).toFixed(2)}</td></tr><tr><td style="padding:10px 0;font-weight:700">Total</td><td style="text-align:right;font-weight:700">$${(priceCents / 100).toFixed(2)}</td></tr></table><p><a href="${esc(approvalUrl)}" style="display:inline-block;background:#00BFFF;color:#002b3a;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:700">Review and approve quote</a></p><p style="font-size:13px;color:#52525b">This secure link expires ${esc(expiresAt.toLocaleDateString('en-US', { timeZone: 'America/Chicago' }))}. No appointment is confirmed and no amount is authorized until you approve.</p></div>`;
}

function buildSimplePage(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AssembleAtEase</title></head><body style="font-family:Arial,sans-serif;background:#f4f4f5;color:#18181b"><main style="max-width:560px;margin:40px auto;background:#fff;padding:28px;border-radius:12px"><h1>${esc(title)}</h1><p>${esc(body)}</p><p><a href="mailto:service@assembleatease.com">service@assembleatease.com</a> · (737) 290-6129</p></main></body></html>`;
}
