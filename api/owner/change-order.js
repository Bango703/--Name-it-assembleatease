import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';
import { logActivity } from '../booking/_activity.js';
import { createChangeOrderRequest, money } from '../booking/_change-order-request.js';
import {
  priceChangeOrder,
  changeOrderEligibility,
  CHANGE_ORDER_STATUS,
} from '../booking/_change-orders.js';

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

  const request = await createChangeOrderRequest(sb, {
    booking,
    description: cleanDescription,
    itemName,
    priced,
    createdBy: 'owner',
    actor: 'owner',
  });
  if (!request.ok) return res.status(request.status).json({ error: request.error, ...(request.code ? { code: request.code } : {}) });
  const { created, expiresAt, emailResult } = request;

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
