import { getSupabase } from '../_supabase.js';
import { verifyOwner, sendEmail, buildStatusEmail, ownerEmail } from '../_email.js';
import { updateDealStage } from '../_hubspot.js';
import { logActivity } from './_activity.js';
import { BOOKING_STATUS } from '../_source-of-truth.js';
import { getTransitionError } from './_workflow-engine.js';
import { bookingCancellationPaymentIntentIds } from './_cancellation-stripe-truth.js';
import { isOpenCustomQuote } from './_quote-state.js';
import { normalizePersonName } from '../_person-name.js';
import { releaseBookingGiftCard } from '../_gift-cards.js';
import { ownerDeclineReason, declineReasonText, declineEmail } from './_decline-reasons.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const { bookingId, ref } = req.body || {};
  if (!bookingId && !ref) return res.status(400).json({ error: 'bookingId or ref is required' });
  // Why it is declined decides the customer email (api/booking/_decline-reasons.js).
  const reasonCode = String(req.body.reasonCode || '');
  const note = String(req.body.note || '').trim().slice(0, 1000);
  if (!ownerDeclineReason(reasonCode)) {
    return res.status(400).json({ error: 'Choose why this request is being declined.', code: 'DECLINE_REASON_REQUIRED' });
  }
  const reason = declineReasonText(reasonCode, note);

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

  await releaseBookingGiftCard(sb, booking, 'returned: booking declined');

  // The customer email this reason sends; duplicate and test requests send none.
  // A quote sent without a card (2026-10-21) never had one; say nothing about a
  // card unless the customer actually saved one.
  const email = declineEmail({
    code: reasonCode,
    note,
    firstName: normalizePersonName(String(booking.customer_name || '').trim().split(/\s+/)[0] || '') || 'there',
    service: booking.service,
    ref: booking.ref,
    isQuote: isOpenCustomQuote(booking),
    hasCard: Boolean(booking.stripe_payment_method_id),
  });
  let notificationDelivered = null;
  if (email) {
    try {
      const html = buildStatusEmail({
        customerName: booking.customer_name,
        ref: booking.ref,
        status: email.status,
        statusColor: email.statusColor,
        statusBg: email.statusBg,
        headline: email.headline,
        bodyHtml: email.bodyHtml,
      });
      const sent = await sendEmail({
        to: booking.customer_email,
        subject: email.subject,
        html,
        replyTo: ownerEmail(),
        meta: { bookingId: booking.id, notificationType: 'booking_declined', recipientType: 'customer' },
      });
      notificationDelivered = sent?.ok === true;
      if (!notificationDelivered) console.error('Decline email not sent:', sent?.error || 'unknown');
    } catch (emailErr) {
      notificationDelivered = false;
      console.error('Decline email error:', emailErr);
    }
  }

  // Non-blocking HubSpot stage update
  if (booking.hubspot_deal_id) {
    updateDealStage(booking.hubspot_deal_id, 'closedlost').catch(e => console.error('HubSpot decline stage error:', e));
  }

  await logActivity(sb, {
    bookingId: booking.id,
    eventType: 'declined',
    actorType: 'owner',
    actorName: 'Owner',
    description: `Booking declined: ${reason}${email ? '' : ' (no customer email)'}`,
    metadata: { reasonCode, note: note || null, customerEmailed: notificationDelivered === true },
  }).catch(error => console.error('Decline activity log error:', error));
  return res.status(200).json({
    success: true,
    booking: { id: booking.id, ref: booking.ref, status: BOOKING_STATUS.DECLINED },
    emailSent: notificationDelivered === true,
    notificationDelivered: email ? notificationDelivered : null,
  });
}
