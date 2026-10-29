import Stripe from 'stripe';
import { getSupabase } from '../_supabase.js';
import { captureBeforeFromIntent } from '../booking/_authorization-window.js';
import { verifyOwner, sendEmail, ownerEmail, esc } from '../_email.js';
import { guardCustomerFacing } from '../_customer-error-alert.js';
import { BOOKING_STATUS } from '../_source-of-truth.js';
import { dispatchBooking } from '../booking/_dispatch-internal.js';
import { rateLimit } from '../_ratelimit.js';
import { randomToken, sha256 } from '../_payment-security.js';
import { validateBookingPaymentIntent } from '../booking/_pending-payment-recovery.js';
import { logActivity } from '../booking/_activity.js';
import { isQuoteAwaitingPrice, quoteNeedsCardAtApproval, normalizeQuoteSlot, quoteSlotStillOpen } from '../booking/_quote-state.js';
import { BOOKING_TIME_SLOTS } from '../booking/_booking-slots.js';
import { validateBookingWindowDate } from '../booking/_booking-window.js';
import { formatAppointmentDate } from '../booking/_appt-date.js';
import { normalizePersonName } from '../_person-name.js';

const QUOTE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const QUOTE_TERMS_VERSION = '2026-07-cancellation-v1';
const MAX_QUOTE_CENTS = 2_500_000;

export default async function handler(req, res) {
  if (req.method === 'GET') return renderQuoteApproval(req, res);
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  guardCustomerFacing(req, res, 'quote approval');

  if (req.body?.token && ['decline', 'request_change'].includes(req.body?.action)) return respondToQuote(req, res);
  if (req.body?.token) return authorizeCustomerApprovedQuote(req, res);
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });
  return prepareQuote(req, res);
}

// Why a customer declines a quote (owner, 2026-10-29). Shown to the owner on
// the booking and in the decline email.
export const QUOTE_DECLINE_REASONS = Object.freeze({
  price: 'Price is too high',
  timing: 'The time does not work',
  hired_someone: 'Found someone else',
  not_needed: 'No longer needed',
  other: 'Other reason',
});

/**
 * The customer answers a quote without approving it, from the approval page.
 *   request_change: their message goes to the owner's inbox on this booking;
 *                   the quote stays open so the owner can reprice and resend.
 *   decline:        the booking is declined with their reason; the link stops
 *                   working. Once card approval has started (a PaymentIntent
 *                   exists) the customer is sent to support instead, so a hold
 *                   is never left behind or cancelled mid-approval.
 */
async function respondToQuote(req, res) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  if (!await rateLimit(ip, 'booking')) return res.status(429).json({ error: 'Too many attempts. Please wait and try again.' });
  const action = String(req.body.action);
  const tokenHash = sha256(String(req.body.token || ''));
  const note = String(req.body?.note || '').trim().slice(0, 1000);
  const sb = getSupabase();
  const { data: booking } = await sb.from('bookings').select('*').eq('quote_token_hash', tokenHash).maybeSingle();
  if (!booking
      || booking.status !== BOOKING_STATUS.PENDING
      || !['quote_pending_approval', 'quote_authorization_pending'].includes(String(booking.payment_status || ''))
      || booking.quote_approved_at) {
    return res.status(410).json({ error: 'This quote link is no longer available.' });
  }
  if (hasActiveFinancialOperation(booking)) {
    return res.status(409).json({ error: 'This quote is being updated. Try again in a moment.', code: 'FINANCIAL_OPERATION_IN_PROGRESS' });
  }
  const site = process.env.PUBLIC_SITE_URL || 'https://www.assembleatease.com';
  const ownerLink = `<p><a href="${site}/owner/">Open the booking in the dashboard</a></p>`;
  const quoted = `$${(Number(booking.quote_amount_cents || 0) / 100).toFixed(2)}`;

  if (action === 'request_change') {
    if (note.length < 3) return res.status(400).json({ error: 'Tell us what you would like changed.' });
    const { error: messageError } = await sb.from('messages').insert({
      booking_id: booking.id,
      sender: 'customer',
      sender_user_id: null,
      recipient_type: 'owner',
      recipient_user_id: null,
      body: `Quote change request: ${note}`,
    });
    if (messageError) {
      console.error('quote change request save failed:', messageError);
      return res.status(500).json({ error: 'Your request could not be sent. Please try again.' });
    }
    await logActivity(sb, {
      bookingId: booking.id,
      eventType: 'quote_change_requested',
      actorType: 'customer',
      actorName: booking.customer_name || 'Customer',
      description: `Customer asked for a change to the quote: ${note}`,
      metadata: { note, quoteAmountCents: booking.quote_amount_cents },
    });
    await sendEmail({
      to: ownerEmail(),
      subject: `Quote change requested — ${booking.ref}`,
      html: `<p><strong>${esc(booking.customer_name || 'The customer')}</strong> asked for a change to quote ${esc(booking.ref)} (${esc(booking.service || '')}, ${quoted}):</p><blockquote>${esc(note)}</blockquote><p>The quote is still open. Reply in the booking's messages, then reprice and resend if needed.</p>${ownerLink}`,
      replyTo: booking.customer_email || ownerEmail(),
      meta: { bookingId: booking.id, notificationType: 'quote_change_requested_owner', recipientType: 'owner', disableDedupe: true },
    }).catch(e => console.error('quote change owner email failed:', e?.message || e));
    return res.status(200).json({ ok: true, changeRequested: true });
  }

  const reasonKey = Object.prototype.hasOwnProperty.call(QUOTE_DECLINE_REASONS, req.body?.reason) ? req.body.reason : null;
  if (!reasonKey) return res.status(400).json({ error: 'Choose a reason for declining.' });
  if (booking.stripe_payment_intent_id) {
    return res.status(409).json({ error: 'Your card approval has already started. Please contact AssembleAtEase to cancel.', code: 'QUOTE_AUTHORIZATION_STARTED' });
  }
  const reasonLabel = QUOTE_DECLINE_REASONS[reasonKey];
  const said = `${reasonLabel}${note ? ' — ' + note : ''}`;
  const { data: rows, error: updateErr } = await sb.from('bookings').update({
    status: 'declined',
    declined_at: new Date().toISOString(),
    decline_reason: `Customer declined the quote: ${said}`,
    quote_token_hash: null,
  })
    .eq('id', booking.id)
    .eq('status', BOOKING_STATUS.PENDING)
    .eq('payment_status', booking.payment_status)
    .eq('quote_token_hash', tokenHash)
    .is('stripe_payment_intent_id', null)
    .is('financial_operation_key', null)
    .select('id');
  if (updateErr || !rows?.length) {
    if (updateErr) console.error('quote decline update failed:', updateErr);
    return res.status(updateErr ? 500 : 409).json({ error: 'The quote changed before your answer was saved. Refresh the page and try again.' });
  }
  await logActivity(sb, {
    bookingId: booking.id,
    eventType: 'quote_declined',
    actorType: 'customer',
    actorName: booking.customer_name || 'Customer',
    description: `Customer declined the quote: ${said}`,
    metadata: { reason: reasonKey, note: note || null, quoteAmountCents: booking.quote_amount_cents },
  });
  await sendEmail({
    to: ownerEmail(),
    subject: `Quote declined (${reasonLabel}) — ${booking.ref}`,
    html: `<p><strong>${esc(booking.customer_name || 'The customer')}</strong> declined quote ${esc(booking.ref)} (${esc(booking.service || '')}, ${quoted}).</p><p><strong>Reason:</strong> ${esc(reasonLabel)}</p>${note ? `<p><strong>Their note:</strong> ${esc(note)}</p>` : ''}<p>The booking is closed. Nothing was charged.</p>${ownerLink}`,
    replyTo: booking.customer_email || ownerEmail(),
    meta: { bookingId: booking.id, notificationType: 'quote_declined_owner', recipientType: 'owner', disableDedupe: true },
  }).catch(e => console.error('quote decline owner email failed:', e?.message || e));
  return res.status(200).json({ ok: true, declined: true });
}

async function prepareQuote(req, res) {
  const { bookingId, finalPriceCents, date, time } = req.body || {};
  const priceCents = Number.parseInt(finalPriceCents, 10);
  if (!bookingId) return res.status(400).json({ error: 'bookingId required' });
  if (!Number.isInteger(priceCents) || priceCents < 100 || priceCents > MAX_QUOTE_CENTS) {
    return res.status(400).json({ error: 'Quote total must be between $1.00 and $25,000.00.' });
  }

  const sb = getSupabase();
  const { data: booking, error } = await sb.from('bookings').select('*').eq('id', bookingId).single();
  if (error || !booking) return res.status(404).json({ error: 'Booking not found' });
  if (hasActiveFinancialOperation(booking)) {
    return res.status(409).json({
      error: 'Another payment or cancellation operation is in progress. Resolve it before issuing a quote.',
      code: 'FINANCIAL_OPERATION_IN_PROGRESS',
    });
  }
  if (booking.status !== BOOKING_STATUS.PENDING) {
    return res.status(409).json({ error: 'Only a pending quote request can be priced. This booking is already closed or active.' });
  }
  if (!isQuoteAwaitingPrice(booking) && String(booking.payment_status || '') !== 'quote_pending_approval') {
    return res.status(409).json({
      error: 'This booking is not in a quote-pricing state. Reconcile its payment status before issuing a quote.',
      code: 'QUOTE_STATE_MISMATCH',
    });
  }
  // A quote sent with a card (before 2026-10-21) must still have it on file.
  // A quote sent without one gets the card on the approval page.
  if (booking.payment_status === 'card_saved' && (!booking.stripe_customer_id || !booking.stripe_payment_method_id)) {
    return res.status(400).json({
      error: 'This quote was sent with a card, but the card is missing from the booking. Reconcile it in Stripe before pricing.',
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

  // The quote carries the appointment the customer approves. The owner may set a
  // new date and time; the one asked for must still be bookable either way.
  let nextDate = booking.date;
  let nextTime = booking.time;
  if (date != null || time != null) {
    const slot = normalizeQuoteSlot(time ?? booking.time);
    const window = validateBookingWindowDate(date ?? booking.date);
    if (!BOOKING_TIME_SLOTS.includes(slot) || !window.ok) {
      return res.status(400).json({ error: 'Choose a date inside the booking window and one of the published time windows.', code: 'QUOTE_DATE_INVALID' });
    }
    nextDate = window.requestedIso;
    nextTime = slot;
  }
  if (!quoteSlotStillOpen({ date: nextDate, time: nextTime })) {
    return res.status(409).json({
      error: 'The appointment time on this quote has passed or is too soon to staff. Choose a new date and time before sending it.',
      code: 'QUOTE_DATE_PASSED',
    });
  }
  const dateChanged = nextDate !== booking.date || nextTime !== booking.time;

  const subtotalCents = Math.round(priceCents / 1.0825);
  const taxCents = priceCents - subtotalCents;
  const token = randomToken(32);
  const tokenHash = sha256(token);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + QUOTE_TTL_MS);

  let quoteUpdate = sb.from('bookings').update({
    quote_amount_cents: priceCents,
    quote_subtotal_cents: subtotalCents,
    date: nextDate,
    time: nextTime,
    quote_tax_cents: taxCents,
    quote_token_hash: tokenHash,
    quote_sent_at: now.toISOString(),
    quote_expires_at: expiresAt.toISOString(),
    quote_approval_started_at: null,
    quote_approved_at: null,
    quote_terms_version: QUOTE_TERMS_VERSION,
    stripe_payment_intent_id: null,
    payment_status: 'quote_pending_approval',
  })
    .eq('id', booking.id)
    .eq('status', BOOKING_STATUS.PENDING)
    .eq('payment_status', booking.payment_status)
    .is('stripe_payment_intent_id', null)
    .is('financial_operation_key', null)
    .is('financial_operation_type', null)
    .is('financial_operation_started_at', null);
  // Repricing leaves payment_status as quote_pending_approval, so that status
  // alone is not a sufficient compare-and-set guard. Match the prior token as
  // well so two owner requests cannot both issue different live quote links.
  quoteUpdate = booking.quote_token_hash
    ? quoteUpdate.eq('quote_token_hash', booking.quote_token_hash)
    : quoteUpdate.is('quote_token_hash', null);
  const { data: quoteRows, error: updateErr } = await quoteUpdate.select('id');

  if (updateErr || !quoteRows?.length) {
    console.error('quote prepare update failed:', updateErr);
    return res.status(updateErr ? 500 : 409).json({
      error: updateErr
        ? 'Could not save the quote approval request.'
        : 'Booking state changed before the quote could be saved. Refresh and review it before retrying.',
    });
  }

  if (dateChanged) {
    await logActivity(sb, {
      bookingId: booking.id,
      eventType: 'quote_date_set',
      actorType: 'owner',
      actorName: 'Owner',
      description: `Quote sent for ${nextDate} ${nextTime} (customer asked for ${booking.date || 'no date'} ${booking.time || ''})`.trim(),
      metadata: { fromDate: booking.date, fromTime: booking.time, toDate: nextDate, toTime: nextTime },
    });
    booking.date = nextDate;
    booking.time = nextTime;
  }

  const site = process.env.PUBLIC_SITE_URL || 'https://www.assembleatease.com';
  const approvalUrl = `${site}/api/owner/quote-approve?token=${encodeURIComponent(token)}`;
  const emailResult = await sendEmail({
    to: booking.customer_email,
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
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Referrer-Policy', 'no-referrer');
  const token = String(req.query?.token || '');
  if (!token) return res.status(400).send('Missing quote approval token.');

  const sb = getSupabase();
  const { data: booking } = await sb.from('bookings')
    .select('id, ref, service, status, payment_status, customer_name, customer_email, date, time, quote_amount_cents, quote_subtotal_cents, quote_tax_cents, quote_expires_at, quote_approved_at, quote_token_hash, stripe_payment_intent_id, stripe_payment_method_id, financial_operation_key, financial_operation_type, financial_operation_started_at')
    .eq('quote_token_hash', sha256(token))
    .maybeSingle();

  if (!booking
      || hasActiveFinancialOperation(booking)
      || booking.status !== BOOKING_STATUS.PENDING
      || !['quote_pending_approval', 'quote_authorization_pending'].includes(String(booking.payment_status || ''))
      || booking.quote_approved_at
      || !booking.quote_amount_cents) {
    return res.status(410).send(buildSimplePage('This quote link is no longer available.', 'Contact AssembleAtEase if you need a new quote.'));
  }
  if (!booking.quote_expires_at || Date.parse(booking.quote_expires_at) <= Date.now()) {
    return res.status(410).send(buildSimplePage('This quote has expired.', 'Contact AssembleAtEase and we will issue a fresh quote for your review.'));
  }
  if (booking.payment_status === 'quote_pending_approval' && !quoteSlotStillOpen(booking)) {
    return res.status(409).send(buildSimplePage('The time on this quote has passed.', `The appointment you asked for (${esc(formatAppointmentDate(booking.date))}, ${esc(booking.time || '')}) is no longer available. We will send you an updated quote with a new time. Nothing has been booked or held on your card.`));
  }

  const publishableKey = process.env.STRIPE_PUBLISHABLE_KEY || '';
  if (!publishableKey) {
    return res.status(503).send(buildSimplePage('Secure approval is temporarily unavailable.', 'Please try again shortly or contact AssembleAtEase.'));
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(200).send(buildApprovalPage({ booking, token, publishableKey, needsCard: quoteNeedsCardAtApproval(booking) }));
}

async function authorizeCustomerApprovedQuote(req, res) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  if (!await rateLimit(ip, 'booking')) return res.status(429).json({ error: 'Too many attempts. Please wait and try again.' });
  if (!process.env.STRIPE_SECRET_KEY) return res.status(503).json({ error: 'Stripe is not configured.' });

  const token = String(req.body?.token || '');
  const action = String(req.body?.action || 'authorize');
  if (!token) return res.status(400).json({ error: 'Approval token required.' });
  if (!['authorize', 'finalize'].includes(action)) return res.status(400).json({ error: 'Invalid quote approval action.' });

  const tokenHash = sha256(token);
  const sb = getSupabase();
  const { data: booking } = await sb.from('bookings').select('*').eq('quote_token_hash', tokenHash).maybeSingle();
  if (!booking
      || booking.status !== BOOKING_STATUS.PENDING
      || !['quote_pending_approval', 'quote_authorization_pending'].includes(String(booking.payment_status || ''))
      || booking.quote_approved_at) {
    return res.status(410).json({ error: 'This quote link is no longer available.' });
  }
  if (hasActiveFinancialOperation(booking)) {
    return res.status(409).json({
      error: 'Another payment or cancellation operation is in progress. Try this quote again later.',
      code: 'FINANCIAL_OPERATION_IN_PROGRESS',
    });
  }
  if (!booking.quote_expires_at || Date.parse(booking.quote_expires_at) <= Date.now()) {
    return res.status(410).json({ error: 'This quote has expired. Contact AssembleAtEase for a new quote.' });
  }
  if (!booking.quote_amount_cents) {
    return res.status(409).json({ error: 'This quote has no price yet. Contact AssembleAtEase.' });
  }
  // A quote sent with a card (before 2026-10-21) must still have it on file.
  if (booking.stripe_payment_method_id && !booking.stripe_customer_id) {
    return res.status(409).json({ error: 'This quote is missing secure payment details. Contact AssembleAtEase.' });
  }
  const cardAtApproval = quoteNeedsCardAtApproval(booking);
  // Starting approval needs a time that can still be staffed. Finalizing is not
  // re-checked: the card hold already went through moments ago.
  if (action === 'authorize' && !booking.stripe_payment_intent_id && !quoteSlotStillOpen(booking)) {
    return res.status(409).json({
      error: 'The appointment time on this quote has passed. We will send you an updated quote with a new time. Nothing has been held on your card.',
      code: 'QUOTE_DATE_PASSED',
    });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  if (action === 'authorize') {
    let pi = null;
    if (booking.stripe_payment_intent_id) {
      pi = await stripe.paymentIntents.retrieve(booking.stripe_payment_intent_id);
      const intentValidation = validateQuotePaymentIntent(booking, pi);
      if (!intentValidation.ok) {
        console.error('[quote-approve] Stored PaymentIntent mismatch:', intentValidation.errors);
        return res.status(409).json({ error: 'Stripe authorization does not match this quote. Contact AssembleAtEase.' });
      }
      if (pi.status === 'requires_capture') {
        return finalizeQuote({ req, res, sb, stripe, booking, pi, tokenHash });
      }
      if (!['requires_payment_method', 'requires_confirmation', 'requires_action'].includes(pi.status)) {
        return res.status(409).json({ error: `The quote authorization is in an unexpected state (${pi.status}). Contact AssembleAtEase.` });
      }
    } else {
      // A quote sent without a card gets its Stripe customer here; the card is
      // entered on the approval page and confirmed there by Stripe.js.
      let customerId = booking.stripe_customer_id || null;
      if (!customerId) {
        const email = String(booking.customer_email || '').trim().toLowerCase();
        const existing = await stripe.customers.list({ email, limit: 1 });
        customerId = existing.data[0]?.id || (await stripe.customers.create({
          email,
          name: booking.customer_name || email,
          metadata: { source: 'quote_approval', bookingRef: booking.ref },
        }, { idempotencyKey: `quote-approval-customer-${booking.id}` })).id;
      }
      pi = await stripe.paymentIntents.create({
        amount: booking.quote_amount_cents,
        currency: 'usd',
        customer: customerId,
        ...(cardAtApproval ? { payment_method_types: ['card'] } : { payment_method: booking.stripe_payment_method_id }),
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

      const customerLink = booking.stripe_customer_id ? {} : { stripe_customer_id: customerId };
      const { data: linkRows, error: linkErr } = await sb.from('bookings').update({
        stripe_payment_intent_id: pi.id,
        payment_status: 'quote_authorization_pending',
        quote_approval_started_at: new Date().toISOString(),
        ...customerLink,
      })
        .eq('id', booking.id)
        .eq('status', BOOKING_STATUS.PENDING)
        .eq('payment_status', 'quote_pending_approval')
        .eq('quote_token_hash', tokenHash)
        .is('stripe_payment_intent_id', null)
        .is('financial_operation_key', null)
        .is('financial_operation_type', null)
        .is('financial_operation_started_at', null)
        .select('id');
      if (linkErr || !linkRows?.length) {
        const { data: current, error: currentError } = await sb.from('bookings')
          .select('id, status, payment_status, stripe_payment_intent_id, quote_token_hash, financial_operation_key, financial_operation_type, financial_operation_started_at')
          .eq('id', booking.id)
          .maybeSingle();
        if (currentError) {
          await logActivity(sb, {
            bookingId: booking.id,
            eventType: 'quote_payment_linkage_ambiguous',
            actorType: 'system',
            actorName: 'quote-approve',
            description: 'A quote PaymentIntent was created, but its booking linkage could not be verified. It was not cancelled automatically.',
            metadata: { paymentIntentId: pi.id },
          }).catch(activityError => console.error('[quote-approve] Ambiguous linkage log failed:', activityError?.message || activityError));
          return res.status(503).json({
            error: 'The authorization linkage could not be verified. Contact AssembleAtEase and do not authorize again.',
            code: 'QUOTE_PAYMENT_LINKAGE_AMBIGUOUS',
          });
        }
        const paymentIntentIsLinked = current?.stripe_payment_intent_id === pi.id;
        const linkedByConcurrentRequest = current?.status === BOOKING_STATUS.PENDING
          && current?.payment_status === 'quote_authorization_pending'
          && paymentIntentIsLinked
          && current?.quote_token_hash === tokenHash
          && !hasActiveFinancialOperation(current);
        let linkedByRecoveryCas = false;
        const originalLinkStateStillPresent = current?.status === BOOKING_STATUS.PENDING
          && current?.payment_status === 'quote_pending_approval'
          && !current?.stripe_payment_intent_id
          && current?.quote_token_hash === tokenHash
          && !hasActiveFinancialOperation(current);
        if (!paymentIntentIsLinked && originalLinkStateStillPresent) {
          const { data: recoveryRows, error: recoveryError } = await sb.from('bookings').update({
            stripe_payment_intent_id: pi.id,
            payment_status: 'quote_authorization_pending',
            quote_approval_started_at: new Date().toISOString(),
            ...customerLink,
          })
            .eq('id', booking.id)
            .eq('status', BOOKING_STATUS.PENDING)
            .eq('payment_status', 'quote_pending_approval')
            .eq('quote_token_hash', tokenHash)
            .is('stripe_payment_intent_id', null)
            .is('financial_operation_key', null)
            .is('financial_operation_type', null)
            .is('financial_operation_started_at', null)
            .select('id');
          linkedByRecoveryCas = !recoveryError && !!recoveryRows?.length;
          if (!linkedByRecoveryCas) {
            await logActivity(sb, {
              bookingId: booking.id,
              eventType: 'quote_payment_linkage_ambiguous',
              actorType: 'system',
              actorName: 'quote-approve',
              description: 'A concurrent quote authorization may still link this PaymentIntent. It was not cancelled automatically.',
              metadata: { paymentIntentId: pi.id, recoveryError: recoveryError?.message || null },
            }).catch(activityError => console.error('[quote-approve] Ambiguous recovery log failed:', activityError?.message || activityError));
            return res.status(recoveryError ? 503 : 409).json({
              error: 'The authorization linkage is still being resolved. Reload this quote before trying again.',
              code: 'QUOTE_PAYMENT_LINKAGE_AMBIGUOUS',
            });
          }
        }
        if (!linkedByConcurrentRequest && !linkedByRecoveryCas) {
          if (!paymentIntentIsLinked) {
            const cancellationConfirmed = await cancelUnlinkedPaymentIntent(stripe, pi.id, 'quote-approve');
            if (!cancellationConfirmed) {
              await logActivity(sb, {
                bookingId: booking.id,
                eventType: 'quote_payment_reconciliation_required',
                actorType: 'system',
                actorName: 'quote-approve',
                description: 'An unlinked quote PaymentIntent could not be confirmed cancelled and requires owner reconciliation.',
                metadata: { paymentIntentId: pi.id, quoteTokenMatched: current?.quote_token_hash === tokenHash },
              }).catch(activityError => console.error('[quote-approve] Reconciliation log failed:', activityError?.message || activityError));
            }
          }
          return res.status(linkErr ? 500 : 409).json({
            error: 'Could not safely link the authorization attempt to the current quote. No booking confirmation was recorded.',
            code: 'QUOTE_PAYMENT_LINK_CONFLICT',
          });
        }
      }
      booking.stripe_payment_intent_id = pi.id;
      booking.stripe_customer_id = customerId;
      booking.payment_status = 'quote_authorization_pending';
    }

    const intentValidation = validateQuotePaymentIntent(booking, pi);
    if (!intentValidation.ok) {
      console.error('[quote-approve] PaymentIntent validation failed:', intentValidation.errors);
      return res.status(409).json({ error: 'Stripe authorization does not match this quote. Contact AssembleAtEase.' });
    }
    if (!pi.client_secret) {
      return res.status(409).json({ error: 'Stripe did not provide a confirmable authorization secret. Contact AssembleAtEase.' });
    }

    const stillUnlocked = await quoteAuthorizationStillUnlocked({ sb, booking, paymentIntentId: pi.id, tokenHash });
    if (!stillUnlocked.ok) {
      return res.status(stillUnlocked.status).json({
        error: stillUnlocked.status >= 500
          ? 'Quote authorization state could not be verified. Please try again.'
          : 'The quote state changed or another financial operation started. Reload this secure link later.',
        code: stillUnlocked.status === 409 ? 'QUOTE_AUTHORIZATION_STATE_CONFLICT' : 'QUOTE_AUTHORIZATION_STATE_UNAVAILABLE',
      });
    }

    return res.status(200).json({
      ok: true,
      requiresConfirmation: true,
      clientSecret: pi.client_secret,
    });
  }

  if (!booking.stripe_payment_intent_id) return res.status(409).json({ error: 'Quote authorization has not started.' });
  const pi = await stripe.paymentIntents.retrieve(booking.stripe_payment_intent_id);
  return finalizeQuote({ req, res, sb, stripe, booking, pi, tokenHash });
}

async function finalizeQuote({ req, res, sb, booking, pi, tokenHash }) {
  const intentValidation = validateQuotePaymentIntent(booking, pi);
  if (!intentValidation.ok || pi.status !== 'requires_capture') {
    return res.status(409).json({
      error: pi.status === 'requires_action'
        ? 'Card verification is not complete yet.'
        : 'Stripe authorization does not match this quote. The booking was not confirmed.',
    });
  }

  const now = new Date().toISOString();
  const quoteCaptureDeadline = captureBeforeFromIntent(pi);
  // A card entered on the approval page is saved to the booking here, where
  // capture after completion and re-authorization look for it.
  const intentCardId = typeof pi.payment_method === 'string' ? pi.payment_method : pi.payment_method?.id || null;
  const intentCustomerId = typeof pi.customer === 'string' ? pi.customer : pi.customer?.id || null;
  const cardLink = {
    ...(!booking.stripe_payment_method_id && intentCardId ? { stripe_payment_method_id: intentCardId } : {}),
    ...(!booking.stripe_customer_id && intentCustomerId ? { stripe_customer_id: intentCustomerId } : {}),
  };
  const { data: rows, error: updateErr } = await sb.from('bookings').update({
    ...cardLink,
    total_price: booking.quote_amount_cents,
    tax_amount: booking.quote_tax_cents,
    payment_status: 'authorized',
    payment_authorized_at: now,
    authorization_capture_before: quoteCaptureDeadline,
    status: BOOKING_STATUS.CONFIRMED,
    confirmed_at: now,
    confirmed_by: 'customer_quote_approval',
    quote_approved_at: now,
    quote_token_hash: null,
  })
    .eq('id', booking.id)
    .eq('status', BOOKING_STATUS.PENDING)
    .eq('payment_status', 'quote_authorization_pending')
    .eq('stripe_payment_intent_id', pi.id)
    .eq('quote_token_hash', tokenHash)
    .is('financial_operation_key', null)
    .is('financial_operation_type', null)
    .is('financial_operation_started_at', null)
    .select('id');

  if (updateErr || !rows?.length) {
    console.error('quote finalize persistence failed:', updateErr);
    const { data: current } = await sb.from('bookings')
      .select('id, status, payment_status, quote_approved_at, stripe_payment_intent_id, financial_operation_key, financial_operation_type, financial_operation_started_at')
      .eq('id', booking.id)
      .maybeSingle();
    if (current?.status === BOOKING_STATUS.CONFIRMED
        && current?.payment_status === 'authorized'
        && current?.quote_approved_at
        && current?.stripe_payment_intent_id === pi.id
        && !hasActiveFinancialOperation(current)) {
      return res.status(200).json({ ok: true, confirmed: true, alreadyConfirmed: true, paymentIntentId: pi.id, amount: booking.quote_amount_cents });
    }
    return res.status(updateErr ? 500 : 409).json({
      error: updateErr
        ? 'Your card was authorized, but confirmation could not be saved. Please retry this page; you will not be authorized twice.'
        : 'Your card was authorized, but the quote state changed before confirmation. Contact AssembleAtEase and do not authorize again.',
      code: updateErr ? 'QUOTE_CONFIRMATION_PERSIST_FAILED' : 'QUOTE_CONFIRMATION_STATE_CONFLICT',
    });
  }

  try { await dispatchBooking(booking.id); } catch (dispatchErr) {
    console.error('quote approval dispatch error:', dispatchErr?.message || dispatchErr);
  }

  const amountDisplay = `$${(booking.quote_amount_cents / 100).toFixed(2)}`;
  await Promise.allSettled([
    sendEmail({
      to: booking.customer_email,
      subject: `Quote approved and booking confirmed — ${booking.ref}`,
      html: `<p>Your quote for <strong>${esc(booking.service)}</strong> was approved for <strong>${amountDisplay}</strong>.</p><p>Your card is safely on file — nothing is charged now. You're only charged after completed work, except for any disclosed cancellation fee.</p>`,
      replyTo: ownerEmail(),
      meta: { bookingId: booking.id, notificationType: 'quote_approved', recipientType: 'customer' },
    }),
    sendEmail({
      to: ownerEmail(),
      subject: `Customer approved quote — ${booking.ref} — ${amountDisplay}`,
      html: `<p><strong>${esc(booking.customer_name)}</strong> approved quote <strong>${esc(booking.ref)}</strong> for ${amountDisplay}. Stripe authorization ${esc(pi.id)} is ready for capture after completion.</p>`,
      meta: { bookingId: booking.id, notificationType: 'quote_approved', recipientType: 'owner' },
    }),
  ]);

  return res.status(200).json({ ok: true, confirmed: true, paymentIntentId: pi.id, amount: booking.quote_amount_cents });
}

async function quoteAuthorizationStillUnlocked({ sb, booking, paymentIntentId, tokenHash }) {
  const { data, error } = await sb.from('bookings')
    .select('id')
    .eq('id', booking.id)
    .eq('status', BOOKING_STATUS.PENDING)
    .eq('payment_status', 'quote_authorization_pending')
    .eq('stripe_payment_intent_id', paymentIntentId)
    .eq('quote_token_hash', tokenHash)
    .is('financial_operation_key', null)
    .is('financial_operation_type', null)
    .is('financial_operation_started_at', null)
    .maybeSingle();
  if (error) return { ok: false, status: 503 };
  return data ? { ok: true } : { ok: false, status: 409 };
}

async function cancelUnlinkedPaymentIntent(stripe, paymentIntentId, context) {
  try {
    const latest = await stripe.paymentIntents.retrieve(paymentIntentId);
    if (latest.status === 'canceled') return true;
    if (latest.status === 'succeeded') return false;
    const cancelled = await stripe.paymentIntents.cancel(paymentIntentId);
    return cancelled?.status === 'canceled';
  } catch (error) {
    console.error(`[${context}] Unlinked PaymentIntent needs reconciliation:`, error?.message || error);
    return false;
  }
}

function hasActiveFinancialOperation(booking) {
  return Boolean(
    booking?.financial_operation_key
    || booking?.financial_operation_type
    || booking?.financial_operation_started_at,
  );
}

function validateQuotePaymentIntent(booking, paymentIntent) {
  const validation = validateBookingPaymentIntent(booking, paymentIntent, {
    type: 'customer_quote',
    amountCents: booking.quote_amount_cents,
  });
  const expectedTermsVersion = booking.quote_terms_version || QUOTE_TERMS_VERSION;
  if (paymentIntent?.metadata?.quoteTermsVersion !== expectedTermsVersion) {
    validation.errors.push('quote_terms_version');
    validation.ok = false;
  }
  return validation;
}

export function buildApprovalPage({ booking, token, publishableKey, needsCard = false }) {
  const firstName = esc(String(booking.customer_name || 'there').split(' ')[0]);
  const subtotal = (booking.quote_subtotal_cents / 100).toFixed(2);
  const tax = (booking.quote_tax_cents / 100).toFixed(2);
  const total = (booking.quote_amount_cents / 100).toFixed(2);
  // Quotes sent without a card (since 2026-10-21) take the card here, after the price.
  const cardField = needsCard
    ? '<label for="card" style="display:block;font-size:14px;font-weight:700;margin:18px 0 8px">Card</label><div id="card" style="padding:12px;border:1px solid #d4d4d8;border-radius:8px;background:#fff"></div><p id="card-err" class="msg" style="color:#b91c1c;margin-top:8px"></p>'
    : '';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Approve quote — AssembleAtEase</title><script src="https://js.stripe.com/v3/"></script><style>body{margin:0;background:#f4f4f5;color:#18181b;font-family:Arial,sans-serif}.card{max-width:560px;margin:40px auto;background:#fff;border:1px solid #e4e4e7;border-radius:14px;padding:28px}.row{display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid #f4f4f5}.total{font-size:20px;font-weight:800}.terms{margin:20px 0;padding:14px;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;font-size:13px;line-height:1.6}.btn{width:100%;padding:14px;border:0;border-radius:8px;background:#00BFFF;color:#002b3a;font-size:16px;font-weight:800;cursor:pointer}.btn:disabled{opacity:.55}.msg{font-size:14px;line-height:1.6;margin-top:14px}.alt{margin-top:18px;text-align:center;font-size:14px;color:#52525b}.link{background:none;border:0;color:#0369a1;font-size:14px;cursor:pointer;text-decoration:underline;padding:4px}.box{margin-top:14px;padding:14px;border:1px solid #e4e4e7;border-radius:8px}.box textarea{width:100%;box-sizing:border-box;min-height:80px;margin:8px 0;padding:10px;border:1px solid #d4d4d8;border-radius:8px;font:inherit}.box label{display:block;font-size:14px;margin:6px 0}.btn2{width:100%;padding:12px;border:1px solid #d4d4d8;border-radius:8px;background:#fff;font-size:15px;font-weight:700;cursor:pointer}.btn2.danger{color:#b91c1c;border-color:#fecaca}</style></head><body><main class="card"><h1>Review your quote, ${firstName}</h1><p>Booking <strong>${esc(booking.ref)}</strong> for ${esc(booking.service)}</p><div class="row"><span>Appointment</span><strong>${esc(formatAppointmentDate(booking.date))}, ${esc(booking.time || '')}</strong></div><div class="row"><span>Service subtotal</span><strong>$${subtotal}</strong></div><div class="row"><span>Texas sales tax</span><strong>$${tax}</strong></div><div class="row total"><span>Total</span><span>$${total}</span></div><div class="terms"><strong>Payment and cancellation:</strong> Approving places a hold of $${total} on your card. You are charged after the work is done. Cancellation is free until 24 hours before the appointment. A 10% fee on the service subtotal applies inside 24 hours, or 15% once a pro is on the way; tax is not included in a cancellation fee.</div>${cardField}<button class="btn" id="approve"${needsCard ? ' disabled' : ''}>Approve quote and hold $${total}</button><p class="msg" id="msg"></p><div id="answers"><div class="alt"><button type="button" class="link" id="show-change">Request a change</button> &middot; <button type="button" class="link" id="show-decline">Decline this quote</button></div><div class="box" id="change-box" hidden><label for="change-note">What would you like changed? The time, the work, or a question.</label><textarea id="change-note" maxlength="1000"></textarea><button type="button" class="btn2" id="send-change">Send to AssembleAtEase</button></div><div class="box" id="decline-box" hidden><p style="margin:0 0 6px;font-size:14px">Why are you declining?</p>${Object.entries(QUOTE_DECLINE_REASONS).map(([key, label]) => `<label><input type="radio" name="reason" value="${esc(key)}"> ${esc(label)}</label>`).join('')}<textarea id="decline-note" maxlength="1000" placeholder="Anything else you want us to know (optional)"></textarea><button type="button" class="btn2 danger" id="send-decline">Decline quote</button></div><p class="msg" id="alt-msg"></p></div></main><script>const stripe=Stripe(${JSON.stringify(publishableKey)});const token=${JSON.stringify(token)};const needsCard=${needsCard ? 'true' : 'false'};const btn=document.getElementById('approve');const msg=document.getElementById('msg');let card=null;if(needsCard){card=stripe.elements().create('card',{hidePostalCode:false});card.mount('#card');card.on('change',e=>{btn.disabled=!e.complete;document.getElementById('card-err').textContent=e.error?e.error.message:'';});}btn.onclick=async()=>{btn.disabled=true;msg.textContent='Approving…';try{let r=await fetch('/api/owner/quote-approve',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token,action:'authorize'})});let d=await r.json();if(!r.ok)throw new Error(d.error||'The approval could not start.');if(d.confirmed){msg.textContent='Quote approved. Your booking is confirmed.';btn.style.display='none';return;}const result=needsCard?await stripe.confirmCardPayment(d.clientSecret,{payment_method:{card}}):await stripe.confirmCardPayment(d.clientSecret);if(result.error)throw new Error(result.error.message);r=await fetch('/api/owner/quote-approve',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token,action:'finalize'})});d=await r.json();if(!r.ok)throw new Error(d.error||'The approval could not be saved.');msg.textContent='Quote approved. Your booking is confirmed.';btn.style.display='none';if(card)card.unmount();document.getElementById('answers').hidden=true;}catch(e){msg.textContent=e.message;btn.disabled=false;}};(function(){const $=id=>document.getElementById(id);const altMsg=$('alt-msg');const toggle=(show,hide)=>{$(show).hidden=!$(show).hidden;$(hide).hidden=true;altMsg.textContent='';};$('show-change').onclick=()=>toggle('change-box','decline-box');$('show-decline').onclick=()=>toggle('decline-box','change-box');async function send(body,button){button.disabled=true;altMsg.textContent='Sending…';try{const r=await fetch('/api/owner/quote-approve',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.assign({token},body))});const d=await r.json();if(!r.ok)throw new Error(d.error||'That could not be sent. Please try again.');return d;}catch(e){altMsg.textContent=e.message;button.disabled=false;return null;}}$('send-change').onclick=async function(){const note=$('change-note').value.trim();if(note.length<3){altMsg.textContent='Tell us what you would like changed.';return;}const d=await send({action:'request_change',note},this);if(!d)return;$('change-box').hidden=true;$('change-note').value='';this.disabled=false;altMsg.textContent='Sent. We will reply with an answer or an updated quote. This quote stays open until then.';};$('send-decline').onclick=async function(){const picked=document.querySelector('input[name=reason]:checked');if(!picked){altMsg.textContent='Choose a reason.';return;}const d=await send({action:'decline',reason:picked.value,note:$('decline-note').value.trim()},this);if(!d)return;document.querySelector('.terms').hidden=true;const approve=$('approve');if(approve)approve.style.display='none';const cardBox=$('card');if(cardBox)cardBox.hidden=true;$('answers').innerHTML='<p class="msg">Quote declined. Thank you for letting us know. Nothing was charged.</p>';};})();</script></body></html>`;
}

function buildQuoteReadyEmail({ booking, subtotalCents, taxCents, priceCents, approvalUrl, expiresAt }) {
  return `<div style="font-family:Arial,sans-serif;max-width:580px;margin:0 auto;padding:24px;color:#18181b"><h2>Your custom quote is ready</h2><p>Hi ${esc(normalizePersonName(String(booking.customer_name || '').trim().split(/\s+/)[0] || 'there'))}, review the price and terms, then approve to book.</p><table width="100%" style="font-size:14px"><tr><td style="padding:8px 0">Appointment</td><td style="text-align:right">${esc(formatAppointmentDate(booking.date))}, ${esc(booking.time || '')}</td></tr><tr><td style="padding:8px 0">Service subtotal</td><td style="text-align:right">$${(subtotalCents / 100).toFixed(2)}</td></tr><tr><td style="padding:8px 0">Texas sales tax</td><td style="text-align:right">$${(taxCents / 100).toFixed(2)}</td></tr><tr><td style="padding:10px 0;font-weight:700">Total</td><td style="text-align:right;font-weight:700">$${(priceCents / 100).toFixed(2)}</td></tr></table><p style="text-align:center;margin:24px 0"><a href="${esc(approvalUrl)}" style="display:inline-block;background:#00BFFF;color:#002b3a;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:700">Review and approve quote</a></p><p style="font-size:13px;color:#52525b">This secure link expires ${esc(expiresAt.toLocaleDateString('en-US', { timeZone: 'America/Chicago' }))}. Nothing is booked and nothing is held on a card until you approve.</p></div>`;
}

function buildSimplePage(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AssembleAtEase</title></head><body style="font-family:Arial,sans-serif;background:#f4f4f5;color:#18181b"><main style="max-width:560px;margin:40px auto;background:#fff;padding:28px;border-radius:12px"><h1>${esc(title)}</h1><p>${esc(body)}</p><p><a href="mailto:service@assembleatease.com">service@assembleatease.com</a> · (979) 232-5139</p></main></body></html>`;
}
