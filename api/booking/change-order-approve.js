import Stripe from 'stripe';
import { getSupabase } from '../_supabase.js';
import { sendEmail, ownerEmail, esc } from '../_email.js';
import { sha256 } from '../_payment-security.js';
import { writeFinancialAudit } from '../_financial-audit.js';
import { logActivity } from './_activity.js';
import { CHANGE_ORDER_STATUS, changeOrderEligibility } from './_change-orders.js';

/**
 * GET  /api/booking/change-order-approve?token=…  — the customer's approval page
 * POST /api/booking/change-order-approve          — they clicked Approve
 *
 * This is the only place a change order becomes money. It authorizes the extra
 * amount on the card already saved against the booking, with manual capture, so
 * it is taken at completion alongside the original — the customer sees one job,
 * one completion, and never a charge they did not agree to (Rule 9).
 *
 * The booking's own PaymentIntent is never touched. Completion capture validates
 * the original intent against bookings.total_price, and raising that would break
 * capture for every booking on the platform.
 */
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Referrer-Policy', 'no-referrer');

  const token = String((req.query?.token ?? req.body?.token) || '');
  if (!token) return respondPage(res, 400, 'Missing link', 'This approval link is incomplete. Use the button in your email.');

  const sb = getSupabase();
  const tokenHash = sha256(token);

  const { data: changeOrder } = await sb
    .from('booking_change_orders')
    .select('id, booking_id, description, subtotal_cents, tax_cents, total_cents, status, approval_expires_at, approved_at, stripe_payment_intent_id')
    .eq('approval_token_hash', tokenHash)
    .maybeSingle();

  if (!changeOrder) {
    return respondPage(res, 404, 'Link not valid', 'This approval link is invalid or has already been used. If you still need to approve additional work, ask us to resend it.');
  }
  if (changeOrder.status === CHANGE_ORDER_STATUS.VOIDED) {
    return respondPage(res, 409, 'Withdrawn', 'This request for additional work was withdrawn. Nothing has been charged.');
  }
  if (changeOrder.status === CHANGE_ORDER_STATUS.DECLINED) {
    return respondPage(res, 409, 'Already declined', 'You previously declined this additional work. Nothing has been charged.');
  }
  if ([CHANGE_ORDER_STATUS.AUTHORIZED, CHANGE_ORDER_STATUS.CAPTURED].includes(changeOrder.status)) {
    return respondPage(res, 200, 'Already approved', `You approved this additional work${changeOrder.approved_at ? ' on ' + new Date(changeOrder.approved_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric' }) : ''}. Nothing further is needed — it is charged with the job when the work is finished.`);
  }
  if (changeOrder.approval_expires_at && new Date(changeOrder.approval_expires_at).getTime() <= Date.now()) {
    return respondPage(res, 410, 'Link expired', 'This approval link has expired and nothing was charged. Contact us and we will send a new one.');
  }

  const { data: booking } = await sb
    .from('bookings')
    .select('id, ref, service, status, customer_name, customer_email, total_price, stripe_customer_id, stripe_payment_method_id, stripe_dispute_id, financial_operation_key, financial_operation_type, financial_operation_started_at')
    .eq('id', changeOrder.booking_id)
    .maybeSingle();
  if (!booking) return respondPage(res, 404, 'Booking not found', 'We could not find the booking for this request.');

  // ── GET: show what they are approving ──────────────────────────────────────
  if (req.method === 'GET') {
    return respondApprovalPage(res, { booking, changeOrder, token });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ── Decline ────────────────────────────────────────────────────────────────
  if (String(req.body?.decision || '').toLowerCase() === 'decline') {
    await sb.from('booking_change_orders').update({
      status: CHANGE_ORDER_STATUS.DECLINED,
      declined_at: new Date().toISOString(),
      approval_token_hash: null,
      updated_at: new Date().toISOString(),
    }).eq('id', changeOrder.id).eq('status', CHANGE_ORDER_STATUS.PENDING_CUSTOMER_APPROVAL);

    await logActivity(sb, {
      bookingId: booking.id,
      eventType: 'change_order_declined',
      actor: 'customer',
      description: `Customer declined additional work — ${changeOrder.description}`,
    }).catch(() => {});

    await sendEmail({
      to: ownerEmail(),
      from: 'AssembleAtEase <booking@assembleatease.com>',
      subject: `Customer declined additional work — ${booking.ref}`,
      html: `<p>${esc(booking.customer_name || 'The customer')} declined the additional work on <strong>${esc(booking.ref)}</strong>.</p>
             <p>${esc(changeOrder.description)} — ${money(changeOrder.total_cents)}</p>
             <p>Nothing was charged. The original booking is unaffected.</p>`,
      replyTo: ownerEmail(),
      meta: { bookingId: booking.id, notificationType: 'change_order_declined', recipientType: 'owner', disableDedupe: true },
    }).catch(() => {});

    return respondPage(res, 200, 'Declined', 'Thanks — we have let the team know, and nothing has been charged. Your original booking is unchanged.');
  }

  // ── Approve: authorize the extra amount ────────────────────────────────────
  const eligible = changeOrderEligibility(booking);
  if (!eligible.ok) {
    return respondPage(res, 409, 'Cannot be approved right now', eligible.reason + ' Nothing has been charged.');
  }
  if (!process.env.STRIPE_SECRET_KEY) {
    return respondPage(res, 503, 'Temporarily unavailable', 'Payments are unavailable right now. Nothing was charged — please try the link again shortly.');
  }

  // Claim the row FIRST. Two clicks on the same link must never create two
  // authorizations, so the compare-and-set happens before Stripe is called.
  const claimedAt = new Date().toISOString();
  const { data: claimed, error: claimErr } = await sb
    .from('booking_change_orders')
    .update({ approved_at: claimedAt, approval_token_hash: null, updated_at: claimedAt })
    .eq('id', changeOrder.id)
    .eq('status', CHANGE_ORDER_STATUS.PENDING_CUSTOMER_APPROVAL)
    .is('stripe_payment_intent_id', null)
    .is('approved_at', null)
    .select('id')
    .maybeSingle();
  if (claimErr) {
    console.error('Change order claim error:', claimErr);
    return respondPage(res, 503, 'Please try again', 'We could not record your approval. Nothing was charged — please use the link again.');
  }
  if (!claimed) {
    return respondPage(res, 200, 'Already approved', 'This additional work is already approved. Nothing further is needed.');
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const idempotencyKey = `change-order-authorize-${changeOrder.id}`;
  await writeFinancialAudit(sb, {
    eventType: 'change_order_authorize',
    eventSource: 'customer_change_order_approval',
    bookingId: booking.id,
    idempotencyKey,
    status: 'processing',
    metadata: { ref: booking.ref, changeOrderId: changeOrder.id, totalCents: changeOrder.total_cents },
  }).catch(() => {});

  let pi;
  try {
    pi = await stripe.paymentIntents.create({
      amount: changeOrder.total_cents,
      currency: 'usd',
      customer: booking.stripe_customer_id,
      payment_method: booking.stripe_payment_method_id,
      capture_method: 'manual',
      confirm: true,
      off_session: true,
      receipt_email: booking.customer_email,
      statement_descriptor_suffix: 'ASSEMBLEATEASE',
      description: `Additional approved work — ${booking.service} — ${booking.ref}`,
      metadata: {
        bookingRef: booking.ref,
        bookingId: booking.id,
        changeOrderId: changeOrder.id,
        type: 'customer_change_order',
      },
    }, { idempotencyKey });
  } catch (stripeErr) {
    // Release the claim so the customer can retry with the same link.
    await sb.from('booking_change_orders').update({
      approved_at: null,
      approval_token_hash: tokenHash,
      updated_at: new Date().toISOString(),
    }).eq('id', changeOrder.id).is('stripe_payment_intent_id', null);

    await writeFinancialAudit(sb, {
      eventType: 'change_order_authorize',
      eventSource: 'customer_change_order_approval',
      bookingId: booking.id,
      idempotencyKey,
      status: 'failed',
      metadata: { ref: booking.ref, changeOrderId: changeOrder.id, error: stripeErr?.message || String(stripeErr) },
    }).catch(() => {});

    console.error('Change order authorization failed:', stripeErr?.message || stripeErr);
    return respondPage(res, 402, 'Card could not be authorized',
      'Your card could not be authorized for the additional amount, so nothing was charged and the extra work was not approved. Your original booking is unaffected. Please contact us and we will sort it out.');
  }

  if (pi.status !== 'requires_capture') {
    await sb.from('booking_change_orders').update({
      stripe_payment_intent_id: pi.id,
      updated_at: new Date().toISOString(),
    }).eq('id', changeOrder.id);
    return respondPage(res, 409, 'One more step needed',
      'Your bank needs to confirm this additional amount. Nothing has been charged yet — please contact us and we will send a secure confirmation link.');
  }

  await sb.from('booking_change_orders').update({
    status: CHANGE_ORDER_STATUS.AUTHORIZED,
    stripe_payment_intent_id: pi.id,
    authorized_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('id', changeOrder.id);

  await writeFinancialAudit(sb, {
    eventType: 'change_order_authorize',
    eventSource: 'customer_change_order_approval',
    bookingId: booking.id,
    paymentIntentId: pi.id,
    idempotencyKey,
    status: 'processed',
    metadata: { ref: booking.ref, changeOrderId: changeOrder.id, amountCents: changeOrder.total_cents },
  }).catch(() => {});

  await logActivity(sb, {
    bookingId: booking.id,
    eventType: 'change_order_approved',
    actor: 'customer',
    description: `Customer approved additional work — ${changeOrder.description} (${money(changeOrder.total_cents)}); card authorized, captured at completion`,
  }).catch(() => {});

  await sendEmail({
    to: ownerEmail(),
    from: 'AssembleAtEase <booking@assembleatease.com>',
    subject: `Customer approved additional work — ${booking.ref}`,
    html: `<p>${esc(booking.customer_name || 'The customer')} approved additional work on <strong>${esc(booking.ref)}</strong>.</p>
           <p>${esc(changeOrder.description)} — <strong>${money(changeOrder.total_cents)}</strong> authorized on their saved card.</p>
           <p>It is captured with the job at completion. The Easer's earnings are calculated on the combined total.</p>`,
    replyTo: ownerEmail(),
    meta: { bookingId: booking.id, notificationType: 'change_order_approved', recipientType: 'owner', disableDedupe: true },
  }).catch(() => {});

  return respondPage(res, 200, 'Approved — thank you',
    `The additional work is approved and ${money(changeOrder.total_cents)} is authorized on your card. Nothing is taken until the job is finished, exactly like your original booking total.`);
}

function money(cents) {
  return `$${(Number(cents || 0) / 100).toFixed(2)}`;
}

function shell(title, bodyHtml) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/><title>${esc(title)} — AssembleAtEase</title></head>
<body style="margin:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;color:#1a1a1a">
<div style="max-width:520px;margin:0 auto;padding:40px 16px">
  <div style="background:#fff;border:1px solid #e4e4e7;border-radius:12px;padding:28px 26px">${bodyHtml}</div>
  <p style="text-align:center;font-size:12px;color:#a1a1aa;margin-top:18px">AssembleAtEase &bull; service@assembleatease.com</p>
</div></body></html>`;
}

function respondPage(res, status, title, message) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(status).send(shell(title, `
    <h1 style="margin:0 0 10px;font-size:22px">${esc(title)}</h1>
    <p style="margin:0;font-size:15px;line-height:1.7;color:#52525b">${esc(message)}</p>`));
}

function respondApprovalPage(res, { booking, changeOrder, token }) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(200).send(shell('Approve additional work', `
    <div style="font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:#0369a1">Approval needed</div>
    <h1 style="margin:6px 0 14px;font-size:22px">Additional work on your ${esc(booking.service || 'booking')}</h1>
    <p style="margin:0 0 16px;font-size:15px;line-height:1.7;color:#52525b">Nothing has been charged. This only goes ahead if you approve it.</p>
    <div style="background:#fafafa;border:1px solid #e4e4e7;border-radius:8px;padding:14px 16px;margin-bottom:18px">
      <p style="margin:0 0 12px;font-size:15px;line-height:1.6">${esc(changeOrder.description)}</p>
      <div style="display:flex;justify-content:space-between;font-size:14px;color:#52525b"><span>Additional work</span><span>${money(changeOrder.subtotal_cents)}</span></div>
      <div style="display:flex;justify-content:space-between;font-size:14px;color:#52525b"><span>Sales tax</span><span>${money(changeOrder.tax_cents)}</span></div>
      <div style="display:flex;justify-content:space-between;font-size:15px;font-weight:800;border-top:1px solid #e4e4e7;margin-top:9px;padding-top:9px"><span>Added to your total</span><span>${money(changeOrder.total_cents)}</span></div>
    </div>
    <p style="margin:0 0 18px;font-size:14px;line-height:1.7;color:#52525b">Charged to the card on your booking, and only when the job is finished. Your original total is unchanged.</p>
    <form method="POST" action="/api/booking/change-order-approve" style="margin:0">
      <input type="hidden" name="token" value="${esc(token)}"/>
      <button type="submit" name="decision" value="approve" style="width:100%;background:#00BFFF;color:#fff;border:none;padding:15px;border-radius:8px;font-size:16px;font-weight:700;cursor:pointer">Approve ${money(changeOrder.total_cents)}</button>
      <button type="submit" name="decision" value="decline" style="width:100%;background:none;color:#71717a;border:1px solid #e4e4e7;padding:12px;border-radius:8px;font-size:14px;margin-top:10px;cursor:pointer">No thanks &mdash; do not do this work</button>
    </form>
    <p style="margin:16px 0 0;font-size:13px;color:#71717a;line-height:1.6">Booking ${esc(booking.ref)}. If this does not look right, email us instead of approving.</p>`));
}
