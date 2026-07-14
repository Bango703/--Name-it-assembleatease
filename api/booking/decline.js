import { getSupabase } from '../_supabase.js';
import { verifyOwner, sendEmail, buildStatusEmail, ownerEmail, esc } from '../_email.js';
import { updateDealStage } from '../_hubspot.js';
import { logActivity } from './_activity.js';
import { BOOKING_STATUS } from '../_source-of-truth.js';
import { getTransitionError } from './_workflow-engine.js';
import { bookingCancellationPaymentIntentIds } from './_cancellation-stripe-truth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const { bookingId, ref, reason } = req.body;
  if (!bookingId && !ref) return res.status(400).json({ error: 'bookingId or ref is required' });

  const sb = getSupabase();

  let query = sb.from('bookings').select('*');
  if (bookingId) query = query.eq('id', bookingId);
  else query = query.eq('ref', ref);
  const { data: booking, error: fetchErr } = await query.single();

  if (fetchErr || !booking) return res.status(404).json({ error: 'Booking not found' });
  const transitionErr = getTransitionError(booking.status, BOOKING_STATUS.DECLINED);
  if (transitionErr) return res.status(400).json({ error: transitionErr });

  if (booking.financial_operation_key) {
    return res.status(409).json({
      error: 'A payment, cancellation, completion, refund, or payout action is already in progress. Refresh before changing this request.',
      code: 'BOOKING_FINANCIAL_OPERATION_IN_PROGRESS',
    });
  }

  // Decline is only the no-money terminal path. Any linked Stripe intent or
  // recorded financial/payout evidence must go through the cancellation flow,
  // which reconciles Stripe before changing database state.
  const hasFinancialEvidence = bookingCancellationPaymentIntentIds(booking).length > 0
    || Number(booking.amount_charged || 0) > 0
    || Number(booking.refund_amount || 0) > 0
    || Number(booking.payout_amount || 0) > 0
    || ['paid', 'transferred'].includes(String(booking.payout_status || ''))
    || ['paid', 'transferred'].includes(String(booking.cancellation_easer_payout_status || ''))
    || Boolean(booking.stripe_transfer_id || booking.paid_out_at);
  const { data: payoutLedgerRows, error: payoutLedgerError } = hasFinancialEvidence
    ? { data: [], error: null }
    : await sb.from('payout_ledger').select('id').eq('booking_id', booking.id).limit(1);
  if (payoutLedgerError) {
    return res.status(503).json({
      error: 'Payout history could not be verified. The request was not declined.',
      code: 'DECLINE_PAYOUT_VERIFICATION_UNAVAILABLE',
    });
  }
  if (hasFinancialEvidence || payoutLedgerRows?.length) {
    return res.status(409).json({
      error: 'This request has linked payment or payout activity. Use Cancel Booking so Stripe and the booking record are reconciled safely.',
      code: 'DECLINE_REQUIRES_CANCELLATION',
    });
  }

  let declineUpdate = sb
    .from('bookings')
    .update({ status: BOOKING_STATUS.DECLINED, declined_at: new Date().toISOString(), decline_reason: reason || null })
    .eq('id', booking.id)
    .eq('status', booking.status)
    .is('stripe_payment_intent_id', null)
    .is('stripe_deposit_intent_id', null)
    .is('stripe_balance_payment_intent_id', null)
    .is('financial_operation_key', null)
    .is('financial_operation_type', null)
    .is('financial_operation_started_at', null);
  declineUpdate = booking.payment_status == null
    ? declineUpdate.is('payment_status', null)
    : declineUpdate.eq('payment_status', booking.payment_status);
  const { data: updatedRows, error: updateErr } = await declineUpdate.select('id');

  if (updateErr) {
    console.error('Decline update error:', updateErr);
    return res.status(503).json({ error: 'Failed to update booking safely. Refresh before retrying.' });
  }
  if (!updatedRows?.length) {
    return res.status(409).json({
      error: 'Booking or payment state changed before it could be declined. Refresh and reconcile before retrying.',
      code: 'DECLINE_STATE_CHANGED',
    });
  }

  // Send decline email to customer
  try {
    const reasonHtml = reason
      ? `<table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-radius:6px;margin-bottom:20px"><tr><td style="padding:14px 18px">
           <p style="margin:0 0 4px;font-size:11px;font-weight:600;text-transform:uppercase;color:#71717a">Reason</p>
           <p style="margin:0;font-size:14px;color:#1a1a1a;line-height:1.6">${esc(reason)}</p>
         </td></tr></table>`
      : '';

    const html = buildStatusEmail({
      customerName: booking.customer_name,
      ref: booking.ref,
      status: 'UNABLE TO FULFIL',
      statusColor: '#71717a',
      statusBg: '#f4f4f5',
      headline: `We're sorry, ${esc(booking.customer_name)} — we can't take this one.`,
      bodyHtml: `
        <p style="margin:0 0 20px;font-size:15px;color:#52525b;line-height:1.7">Unfortunately we are not able to accommodate your request for <strong>${esc(booking.service)}</strong> at this time. No charge has been made to your card.</p>
        ${reasonHtml}
        <p style="margin:0 0 20px;font-size:14px;color:#52525b;line-height:1.7">We'd love to help you on another date or with a different service. Feel free to submit a new booking and we'll do our best to make it work.</p>
        <p style="margin:0;font-size:14px;color:#52525b;line-height:1.7">We apologize for any inconvenience and appreciate your understanding.</p>`,
    });

    await sendEmail({
      to: booking.customer_email,
      from: 'AssembleAtEase <booking@assembleatease.com>',
      subject: 'Your Booking Request — ' + booking.ref,
      html,
      replyTo: ownerEmail(),
    });
  } catch (emailErr) {
    console.error('Decline email error:', emailErr);
  }

  // Non-blocking HubSpot stage update
  if (booking.hubspot_deal_id) {
    updateDealStage(booking.hubspot_deal_id, 'closedlost').catch(e => console.error('HubSpot decline stage error:', e));
  }

  await logActivity(sb, { bookingId: booking.id, eventType: 'declined', actorType: 'owner', actorName: 'Owner', description: `Booking declined${reason ? ': ' + reason : ''}` })
    .catch(error => console.error('Decline activity log error:', error));
  return res.status(200).json({ success: true, booking: { id: booking.id, ref: booking.ref, status: BOOKING_STATUS.DECLINED } });
}
