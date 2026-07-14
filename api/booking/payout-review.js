import Stripe from 'stripe';
import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';
import { logActivity } from './_activity.js';
import { loadBookingStripeDisputeTruth } from './_stripe-dispute-truth.js';

/**
 * POST /api/booking/payout-review
 * Owner-only resolution of refund or damage holds on canonical Easer earnings.
 * The browser never supplies or changes the payout amount.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const bookingId = String(req.body?.bookingId || '').trim();
  const decision = String(req.body?.decision || '').trim().toLowerCase();
  const notes = String(req.body?.notes || '').trim();
  if (!bookingId) return res.status(400).json({ error: 'bookingId is required' });
  if (!['approve_full', 'resolve_damage_review', 'resolve_stripe_dispute'].includes(decision)) {
    return res.status(400).json({
      error: 'Decision must be approve_full, resolve_damage_review, or resolve_stripe_dispute. None of these actions sends money or changes the server-calculated amount.',
    });
  }
  if (notes.length < 10 || notes.length > 1000) {
    return res.status(400).json({ error: 'Enter a review note between 10 and 1000 characters.' });
  }

  const sb = getSupabase();
  const { data: booking, error: fetchError } = await sb
    .from('bookings')
    .select('id, ref, status, payment_status, refund_amount, assembler_id, assembler_name, assembler_due, payout_status, stripe_transfer_id, payout_mode_snapshot, payout_review_status, financial_operation_key, financial_reconciliation_required_at, damage_review_status, damage_claim_opened_at, damage_reviewed_at, damage_reviewed_by, stripe_customer_id, stripe_payment_intent_id, stripe_deposit_intent_id, stripe_balance_payment_intent_id, stripe_dispute_hold, stripe_dispute_id, stripe_dispute_status, stripe_dispute_amount_cents')
    .eq('id', bookingId)
    .maybeSingle();
  if (fetchError) return res.status(500).json({ error: 'Could not verify the payout review state.' });
  if (!booking) return res.status(404).json({ error: 'Booking not found' });

  if (decision === 'resolve_damage_review') {
    return resolveDamageReview({ sb, res, booking, notes });
  }
  if (decision === 'resolve_stripe_dispute') {
    return resolveStripeDispute({ sb, res, booking, notes });
  }

  if (booking.stripe_dispute_hold === true) {
    return res.status(409).json({
      error: 'The Stripe dispute hold must be resolved from fresh Stripe truth before Easer earnings can be approved.',
      code: 'STRIPE_DISPUTE_PAYOUT_HOLD',
    });
  }

  if (booking.status !== 'completed'
      || !['partially_refunded', 'refunded'].includes(booking.payment_status)
      || Number(booking.refund_amount || 0) <= 0) {
    return res.status(409).json({ error: 'Only a completed, refund-affected booking can use this review.' });
  }
  if (!booking.assembler_id || Number(booking.assembler_due || 0) <= 0) {
    return res.status(409).json({ error: 'This booking has no canonical Easer earnings to approve.' });
  }
  if (['paid', 'transferred'].includes(booking.payout_status) || booking.stripe_transfer_id) {
    return res.status(409).json({ error: 'This Easer payment has already been recorded or transferred.' });
  }
  if (!['manual', 'stripe_connect'].includes(booking.payout_mode_snapshot)) {
    return res.status(409).json({
      error: 'This earning has no verified payout path. Reconcile its payout mode before approval.',
      code: 'PAYOUT_MODE_RECONCILIATION_REQUIRED',
    });
  }
  if (booking.financial_operation_key || booking.financial_reconciliation_required_at) {
    return res.status(409).json({ error: 'Another payment action is in progress. Reload before reviewing Easer earnings.' });
  }
  if (booking.payout_review_status === 'approved_full') {
    return res.status(200).json({
      success: true,
      alreadyApproved: true,
      bookingRef: booking.ref,
      assemblerDue: Number(booking.assembler_due),
    });
  }
  if (booking.payout_review_status !== 'review_required') {
    return res.status(409).json({ error: 'This booking is not awaiting payout review.' });
  }

  const reviewedAt = new Date().toISOString();
  let updateQuery = sb
    .from('bookings')
    .update({
      payout_review_status: 'approved_full',
      payout_reviewed_at: reviewedAt,
      payout_reviewed_by: 'owner',
      payout_review_notes: notes,
    })
    .eq('id', booking.id)
    .eq('payout_review_status', 'review_required')
    .eq('payment_status', booking.payment_status)
    .eq('refund_amount', Number(booking.refund_amount))
    .is('stripe_transfer_id', null)
    .is('financial_operation_key', null);
  updateQuery = booking.payout_status == null
    ? updateQuery.is('payout_status', null)
    : updateQuery.eq('payout_status', booking.payout_status);
  const { data: updatedRows, error: updateError } = await updateQuery.select('id');

  if (updateError) {
    console.error('Payout review update error:', updateError);
    return res.status(500).json({ error: 'Could not save the payout review. No payout was recorded.' });
  }
  if (!updatedRows?.length) {
    return res.status(409).json({ error: 'Payout state changed during review. Reload before taking action.' });
  }

  await logActivity(sb, {
    bookingId: booking.id,
    eventType: 'payout_review_approved',
    actorType: 'owner',
    actorName: 'Owner',
    description: `Full canonical Easer earnings approved after refund review: $${(Number(booking.assembler_due) / 100).toFixed(2)}.`,
    metadata: {
      decision: 'approve_full',
      assemblerId: booking.assembler_id,
      assemblerName: booking.assembler_name || null,
      assemblerDueCents: Number(booking.assembler_due),
      payoutMode: booking.payout_mode_snapshot,
      notes,
    },
  });

  return res.status(200).json({
    success: true,
    bookingRef: booking.ref,
    assemblerDue: Number(booking.assembler_due),
    payoutMode: booking.payout_mode_snapshot,
    payoutReviewStatus: 'approved_full',
  });
}

async function resolveStripeDispute({ sb, res, booking, notes }) {
  if (booking.stripe_dispute_hold !== true || !booking.stripe_dispute_id) {
    return res.status(409).json({ error: 'This booking does not have an open Stripe dispute hold.' });
  }
  if (booking.financial_operation_key || booking.stripe_transfer_id
      || ['paid', 'transferred'].includes(booking.payout_status)) {
    return res.status(409).json({
      error: 'A payment operation or Easer payment already exists. Reconcile the financial timeline before resolving this hold.',
      code: 'STRIPE_DISPUTE_RESOLUTION_CONFLICT',
    });
  }
  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(503).json({ error: 'Stripe dispute verification is unavailable. The payout hold remains open.' });
  }

  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const aggregate = await loadBookingStripeDisputeTruth({ stripe, booking });
    const stored = aggregate.disputes.find(entry => entry.dispute.id === booking.stripe_dispute_id);
    if (!stored
        || Number(stored.dispute.amount) !== Number(booking.stripe_dispute_amount_cents || 0)) {
      throw new Error('Stored Stripe dispute is missing or its amount changed in fresh aggregate truth');
    }

    const observedAt = new Date().toISOString();
    for (const entry of aggregate.disputes) {
      const status = String(entry.dispute.status || '').toLowerCase();
      const paymentIntentId = entry.paymentIntent.id;
      const { data: syncRows, error: syncError } = await sb.rpc('hold_booking_stripe_dispute', {
        p_booking_id: booking.id,
        p_payment_intent_id: paymentIntentId,
        p_charge_id: entry.charge.id,
        p_dispute_id: entry.dispute.id,
        p_dispute_status: status,
        p_dispute_amount_cents: Number(entry.dispute.amount),
        p_currency: entry.dispute.currency,
        p_dispute_reason: entry.dispute.reason || null,
        p_livemode: entry.dispute.livemode,
        p_funds_withdrawn: false,
        p_funds_reinstated: false,
        p_observed_at: observedAt,
      });
      if (syncError || !(Array.isArray(syncRows) ? syncRows[0] : syncRows)?.result_action) {
        throw syncError || new Error('Fresh dispute aggregate could not be persisted');
      }
    }

    const blockingFresh = aggregate.disputes.filter(entry => ![
      'won', 'warning_closed', 'prevented',
    ].includes(String(entry.dispute.status || '').toLowerCase()));
    if (blockingFresh.length) {
      return res.status(409).json({
        error: 'Fresh complete Stripe truth still contains an unresolved or lost dispute. The payout hold remains open.',
        code: 'STRIPE_DISPUTE_HOLD_REMAINS',
        disputes: blockingFresh.map(entry => ({
          id: entry.dispute.id,
          status: entry.dispute.status,
          amountCents: Number(entry.dispute.amount),
        })),
      });
    }

    const resolvedAt = new Date().toISOString();
    const { data: cleared, error: clearError } = await sb.rpc('clear_booking_stripe_dispute_hold', {
      p_booking_id: booking.id,
      p_dispute_id: stored.dispute.id,
      p_live_status: String(stored.dispute.status || '').toLowerCase(),
      p_resolved_at: resolvedAt,
    });
    if (clearError || cleared !== true) throw clearError || new Error('Stripe dispute resolution returned no authoritative result');
    await logActivity(sb, {
      bookingId: booking.id,
      eventType: 'stripe_dispute_hold_resolved',
      actorType: 'owner',
      actorName: 'Owner',
      description: `Owner verified complete fresh Stripe dispute truth and cleared the payout hold for ${booking.ref}. No Easer payment was sent.`,
      metadata: {
        disputeId: stored.dispute.id,
        disputeStatus: stored.dispute.status,
        amountCents: Number(stored.dispute.amount),
        disputeCount: aggregate.disputes.length,
        notes,
        paymentSent: false,
      },
    });
    return res.status(200).json({
      success: true,
      bookingRef: booking.ref,
      disputeId: stored.dispute.id,
      disputeStatus: stored.dispute.status,
      stripeDisputeHold: false,
      paymentSent: false,
    });
  } catch (error) {
    console.error('Stripe dispute hold resolution failed:', error?.message || error);
    return res.status(['40001', '55P03', '23514'].includes(error?.code) ? 409 : 503).json({
      error: 'Fresh Stripe truth could not safely clear the dispute payout hold.',
      code: 'STRIPE_DISPUTE_RESOLUTION_FAILED',
    });
  }
}

async function resolveDamageReview({ sb, res, booking, notes }) {
  const { data: resolvedRows, error: resolveError } = await sb.rpc('resolve_booking_damage_review', {
    p_booking_id: booking.id,
    p_notes: notes,
    p_reviewed_by: 'owner',
  });
  if (resolveError) {
    console.error('Damage review resolution error:', resolveError);
    const status = resolveError.code === 'P0002'
      ? 404
      : (['23514', '55P03', '22000'].includes(resolveError.code) ? 409 : 503);
    return res.status(status).json({
      error: status === 503
        ? 'Damage review safety checks could not be verified. The payout hold remains open.'
        : resolveError.message,
      code: status === 503 ? 'DAMAGE_REVIEW_RESOLUTION_FAILED' : 'DAMAGE_REVIEW_CONFLICT',
    });
  }

  const resolved = Array.isArray(resolvedRows) ? resolvedRows[0] : resolvedRows;
  if (!resolved) {
    return res.status(503).json({
      error: 'Damage review returned no durable result. The payout hold must be treated as open.',
      code: 'DAMAGE_REVIEW_RESOLUTION_FAILED',
    });
  }

  if (!resolved.already_resolved) {
    await logActivity(sb, {
      bookingId: booking.id,
      eventType: 'damage_review_resolved',
      actorType: 'owner',
      actorName: 'Owner',
      description: 'Owner reviewed the damage evidence and resolved the damage payout hold. No payment was sent.',
      metadata: {
        decision: 'resolve_damage_review',
        assemblerId: resolved.assembler_id || booking.assembler_id || null,
        assemblerName: resolved.assembler_name || booking.assembler_name || null,
        assemblerDueCents: Number(resolved.assembler_due || booking.assembler_due || 0),
        payoutStatus: resolved.payout_status || booking.payout_status || null,
        payoutMode: resolved.payout_mode_snapshot || booking.payout_mode_snapshot || null,
        notes,
      },
    });
  }

  return res.status(200).json({
    success: true,
    alreadyResolved: resolved.already_resolved === true,
    bookingRef: resolved.booking_ref || booking.ref,
    assemblerDue: Number(resolved.assembler_due || booking.assembler_due || 0),
    payoutStatus: resolved.payout_status || booking.payout_status || null,
    payoutMode: resolved.payout_mode_snapshot || booking.payout_mode_snapshot || null,
    damageReviewStatus: 'resolved',
    paymentSent: false,
  });
}
