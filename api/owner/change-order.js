import { getSupabase } from '../_supabase.js';
import { verifyOwner, sendEmail, ownerEmail, esc } from '../_email.js';
import { randomToken, sha256 } from '../_payment-security.js';
import { logActivity } from '../booking/_activity.js';
import { writeFinancialAudit } from '../_financial-audit.js';
import {
  priceChangeOrder,
  changeOrderEligibility,
  loadChangeOrders,
  summarizeChangeOrders,
  CHANGE_ORDER_STATUS,
  CHANGE_ORDER_APPROVAL_TTL_MS,
} from '../booking/_change-orders.js';

const SITE = process.env.PUBLIC_SITE_URL || 'https://www.assembleatease.com';

/**
 * POST /api/owner/change-order — owner raises additional scope on a LIVE booking.
 *
 * The customer approves before anything is charged. Nothing is authorized here;
 * this only creates the request and emails the approval link. The charge is
 * created by api/booking/change-order-approve.js when the customer says yes.
 *
 * Actions:
 *   create  — price it, store it, email the customer (default)
 *   void    — withdraw an unapproved change order
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const { bookingId, changeOrderId, action = 'create', description, subtotalDollars, itemName } = req.body || {};
  const sb = getSupabase();

  // ── VOID ────────────────────────────────────────────────────────────────────
  if (action === 'void') {
    if (!changeOrderId) return res.status(400).json({ error: 'changeOrderId is required' });
    const { data: voided, error: voidErr } = await sb
      .from('booking_change_orders')
      .update({ status: CHANGE_ORDER_STATUS.VOIDED, updated_at: new Date().toISOString() })
      .eq('id', changeOrderId)
      // Only an un-approved request can be withdrawn. Once the customer has
      // approved, money exists and the refund path owns it.
      .eq('status', CHANGE_ORDER_STATUS.PENDING_CUSTOMER_APPROVAL)
      .is('stripe_payment_intent_id', null)
      .select('id, booking_id, total_cents');
    if (voidErr) return res.status(500).json({ error: 'Could not withdraw the change order.' });
    if (!voided?.length) {
      return res.status(409).json({
        error: 'This change order is no longer pending — the customer may have just approved it. Refresh and check before retrying.',
        code: 'CHANGE_ORDER_NOT_PENDING',
      });
    }
    await logActivity(sb, {
      bookingId: voided[0].booking_id,
      eventType: 'change_order_voided',
      actor: 'owner',
      description: 'Change order withdrawn before customer approval',
    }).catch(() => {});
    return res.status(200).json({ ok: true, voided: true });
  }

  // ── CREATE ──────────────────────────────────────────────────────────────────
  if (!bookingId) return res.status(400).json({ error: 'bookingId is required' });

  const cleanDescription = String(description || '').trim().slice(0, 500);
  if (cleanDescription.length < 3) {
    return res.status(400).json({ error: 'Describe the additional work — the customer sees this before approving.' });
  }

  // Server prices it. The browser sends a subtotal to price, never a total.
  const subtotalCents = Math.round(Number(subtotalDollars) * 100);
  const priced = priceChangeOrder(subtotalCents);
  if (!priced.ok) return res.status(400).json({ error: priced.error });

  const { data: booking, error: bErr } = await sb
    .from('bookings')
    .select('id, ref, service, status, payment_status, payment_method_type, total_price, tax_amount, customer_name, customer_email, assembler_id, assembler_name, stripe_customer_id, stripe_payment_method_id, stripe_dispute_id, financial_operation_key, financial_operation_type, financial_operation_started_at')
    .eq('id', bookingId)
    .single();
  if (bErr || !booking) return res.status(404).json({ error: 'Booking not found' });

  const eligible = changeOrderEligibility(booking);
  if (!eligible.ok) return res.status(409).json({ error: eligible.reason, code: 'CHANGE_ORDER_NOT_ELIGIBLE' });

  if (!booking.customer_email) {
    return res.status(409).json({
      error: 'This booking has no customer email, so the customer cannot be asked to approve additional work.',
      code: 'NO_CUSTOMER_EMAIL',
    });
  }

  // One open request at a time. Stacking approval links for the same job is how a
  // customer ends up approving the wrong amount, or the same work twice.
  const existing = await loadChangeOrders(booking.id, { sb }).catch(() => new Map());
  const summary = summarizeChangeOrders(existing.get(booking.id) || []);
  if (summary.pendingCount > 0) {
    return res.status(409).json({
      error: 'There is already a change order waiting on this customer. Withdraw it or wait for their answer before sending another.',
      code: 'CHANGE_ORDER_ALREADY_PENDING',
    });
  }

  const token = randomToken(32);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + CHANGE_ORDER_APPROVAL_TTL_MS);

  const { data: created, error: insertErr } = await sb
    .from('booking_change_orders')
    .insert({
      booking_id: booking.id,
      description: cleanDescription,
      item_name: itemName ? String(itemName).trim().slice(0, 120) : null,
      subtotal_cents: priced.subtotalCents,
      tax_cents: priced.taxCents,
      total_cents: priced.totalCents,
      status: CHANGE_ORDER_STATUS.PENDING_CUSTOMER_APPROVAL,
      approval_token_hash: sha256(token),
      approval_expires_at: expiresAt.toISOString(),
      created_by: 'owner',
      requested_by_easer_id: booking.assembler_id || null,
      booking_status_at_creation: booking.status,
    })
    .select('id, total_cents')
    .single();
  if (insertErr || !created) {
    console.error('Change order insert error:', insertErr);
    return res.status(500).json({ error: 'Could not save the change order. Nothing was sent to the customer.' });
  }

  await writeFinancialAudit(sb, {
    eventType: 'change_order_created',
    eventSource: 'owner_change_order',
    bookingId: booking.id,
    idempotencyKey: `change-order-create-${created.id}`,
    status: 'processed',
    metadata: { ref: booking.ref, changeOrderId: created.id, totalCents: created.total_cents },
  }).catch(() => {});

  await logActivity(sb, {
    bookingId: booking.id,
    eventType: 'change_order_created',
    actor: 'owner',
    description: `Additional work sent for customer approval — ${cleanDescription} (${money(priced.totalCents)})`,
  }).catch(() => {});

  const approvalUrl = `${SITE}/api/booking/change-order-approve?token=${encodeURIComponent(token)}`;
  const emailResult = await sendEmail({
    to: booking.customer_email,
    from: 'AssembleAtEase <booking@assembleatease.com>',
    subject: `Approval needed for additional work — ${booking.ref}`,
    html: buildApprovalEmail({ booking, description: cleanDescription, priced, approvalUrl, expiresAt }),
    replyTo: ownerEmail(),
    meta: {
      bookingId: booking.id,
      notificationType: 'change_order_approval',
      recipientType: 'customer',
      disableDedupe: true,
    },
  });

  return res.status(200).json({
    ok: true,
    changeOrderId: created.id,
    subtotalCents: priced.subtotalCents,
    taxCents: priced.taxCents,
    totalCents: priced.totalCents,
    expiresAt: expiresAt.toISOString(),
    emailDelivered: emailResult?.ok === true,
    message: emailResult?.ok === true
      ? `Sent to ${booking.customer_name || 'the customer'} for approval — ${money(priced.totalCents)}. Nothing is charged until they approve.`
      : `Change order saved for ${money(priced.totalCents)}, but the approval email FAILED to send. Contact the customer before doing the work.`,
  });
}

function money(cents) {
  return `$${(Number(cents || 0) / 100).toFixed(2)}`;
}

function buildApprovalEmail({ booking, description, priced, approvalUrl, expiresAt }) {
  const expires = expiresAt.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;color:#1a1a1a">
<div style="max-width:560px;margin:0 auto;padding:24px 16px">
  <div style="background:#fff;border:1px solid #e4e4e7;border-radius:10px;overflow:hidden">
    <div style="padding:22px 24px;border-bottom:3px solid #00BFFF">
      <div style="font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:#0369a1">Approval needed</div>
      <div style="font-size:20px;font-weight:800;margin-top:6px">Additional work on your ${esc(booking.service || 'booking')}</div>
    </div>
    <div style="padding:24px">
      <p style="margin:0 0 16px;font-size:15px;line-height:1.7;color:#52525b">Hi ${esc((booking.customer_name || '').split(' ')[0] || 'there')}, while working on your job${booking.assembler_name ? ` your pro, ${esc(booking.assembler_name)},` : ' we'} found work that was not part of the original booking. <strong>Nothing has been charged</strong> — this only happens if you approve it.</p>

      <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-radius:8px;margin-bottom:18px">
        <tr><td style="padding:14px 16px">
          <p style="margin:0 0 10px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#71717a">Additional work</p>
          <p style="margin:0 0 14px;font-size:15px;color:#1a1a1a;line-height:1.6">${esc(description)}</p>
          <table width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;color:#52525b">
            <tr><td style="padding:3px 0">Additional work</td><td style="padding:3px 0;text-align:right">${money(priced.subtotalCents)}</td></tr>
            <tr><td style="padding:3px 0">Sales tax</td><td style="padding:3px 0;text-align:right">${money(priced.taxCents)}</td></tr>
            <tr><td style="padding:9px 0 0;border-top:1px solid #e4e4e7;font-weight:800;color:#1a1a1a">Added to your total</td><td style="padding:9px 0 0;border-top:1px solid #e4e4e7;text-align:right;font-weight:800;color:#1a1a1a">${money(priced.totalCents)}</td></tr>
          </table>
        </td></tr>
      </table>

      <p style="margin:0 0 18px;font-size:14px;line-height:1.7;color:#52525b">This is charged to the card already on your booking, and only when the job is finished — exactly like the original amount. Your original booking total is unchanged.</p>

      <div style="text-align:center;margin:22px 0">
        <a href="${esc(approvalUrl)}" style="display:inline-block;background:#00BFFF;color:#fff;padding:14px 34px;border-radius:8px;text-decoration:none;font-size:16px;font-weight:700">Review &amp; approve ${money(priced.totalCents)}</a>
      </div>

      <p style="margin:0;font-size:13px;color:#71717a;line-height:1.6">If this does not look right, reply to this email and we will sort it out — do not approve it. This link expires on ${esc(expires)}.</p>
      <p style="margin:14px 0 0;font-size:13px;color:#71717a">Booking ${esc(booking.ref)}</p>
    </div>
  </div>
</div></body></html>`;
}
