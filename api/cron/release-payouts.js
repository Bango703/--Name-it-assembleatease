import Stripe from 'stripe';
import { getSupabase } from '../_supabase.js';
import { sendEmail, ownerEmail, esc } from '../_email.js';
import { writeFinancialAudit } from '../_financial-audit.js';
import { isStripeConnectEnabled, getAssemblerConnectAccount } from '../_stripe-connect.js';
import { logCron } from './_cron-logger.js';
import {
  releaseBookingFinancialOperation,
  reserveBookingFinancialOperation,
} from '../booking/_financial-operation.js';
import { loadCurrentCompletionEvidence } from '../booking/_completion-evidence.js';

/**
 * GET /api/cron/release-payouts  — hourly.
 *
 * Releases held Easer payouts via Stripe Connect once the hold window has passed.
 * The hold (PAYOUT_HOLD_HOURS after completion):
 *   - gives a dispute / work-verification window before money leaves, and
 *   - lets the captured booking funds settle pending -> available (Stripe transfers
 *     need AVAILABLE balance, which is why an at-completion transfer fails).
 *
 * Eligible booking: completed, payment captured (not refunded), payout still pending,
 * assembler_due > 0, completed_at older than the hold. On a transfer error (e.g. funds
 * not yet available) the booking stays pending and is retried on the next run.
 */
// Hold window before a payout is released. Defaults to 48h; override with the
// PAYOUT_HOLD_HOURS env var (e.g. set to 0 in test to release immediately).
const PAYOUT_HOLD_HOURS = Number.isFinite(parseFloat(process.env.PAYOUT_HOLD_HOURS))
  ? parseFloat(process.env.PAYOUT_HOLD_HOURS)
  : 48;

const CONNECT_PAYOUT_RECHECK_FIELDS = [
  'id', 'status', 'assembler_id', 'assembler_due',
  'cancellation_easer_due_cents', 'cancellation_easer_payout_status',
  'payment_status', 'payout_status', 'payout_mode_snapshot',
  'stripe_dispute_hold', 'stripe_dispute_id', 'stripe_dispute_status',
  'payout_review_status', 'payout_reviewed_at', 'payout_reviewed_by', 'payout_review_notes',
  'paid_out_at', 'stripe_transfer_id', 'evidence_requested_at', 'job_started_at',
  'damage_review_status', 'damage_claim_opened_at', 'damage_reviewed_at',
  'damage_reviewed_by', 'damage_review_notes', 'financial_operation_key',
  'financial_operation_type', 'financial_operation_started_at',
].join(', ');

export default async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.authorization !== 'Bearer ' + cronSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const t = Date.now();
  if (!isStripeConnectEnabled() || !process.env.STRIPE_SECRET_KEY) {
    await logCron('release-payouts', { status: 'ok', records: 0, duration: Date.now() - t });
    return res.status(200).json({ released: 0, message: 'Connect disabled — payouts handled manually' });
  }

  const sb = getSupabase();
  const cutoff = new Date(Date.now() - PAYOUT_HOLD_HOURS * 3600000).toISOString();

  const { data: pendingRows, error } = await sb
    .from('bookings')
    .select('id, ref, status, assembler_id, assembler_name, assembler_due, cancellation_easer_due_cents, cancellation_easer_payout_status, completed_at, cancelled_at, payment_status, payout_status, payout_amount, payout_mode_snapshot, payout_review_status, payout_reviewed_at, payout_reviewed_by, payout_review_notes, stripe_dispute_hold, stripe_dispute_id, stripe_dispute_status, paid_out_at, total_price, tax_amount, service_call_fee, amount_charged, refund_amount, is_deposit, deposit_amount, cancellation_fee, stripe_customer_id, stripe_payment_intent_id, stripe_deposit_intent_id, stripe_balance_payment_intent_id, stripe_balance_amount_captured, stripe_transfer_id, assemblecash_redeemed_cents, reschedule_count, rescheduled_at, easer_fee_snapshot_easer_id, easer_fee_pct_snapshot, easer_estimated_due_snapshot, evidence_requested_at, job_started_at, damage_review_status, damage_claim_opened_at, damage_reviewed_at, damage_reviewed_by, damage_review_notes')
    .in('status', ['completed', 'cancelled'])
    .eq('payout_status', 'pending')
    .eq('payout_mode_snapshot', 'stripe_connect')
    .order('completed_at', { ascending: true, nullsFirst: true })
    .limit(100);

  if (error) {
    console.error('release-payouts query error:', error);
    await logCron('release-payouts', { status: 'error', error: error.message, duration: Date.now() - t });
    return res.status(500).json({ error: 'Query failed' });
  }

  const due = (pendingRows || []).filter((booking) => {
    const cancellation = booking.status === 'cancelled';
    const dueCents = cancellation
      ? Number(booking.cancellation_easer_due_cents || 0)
      : Number(booking.assembler_due || 0);
    const eventAt = cancellation ? booking.cancelled_at : booking.completed_at;
    const paymentReady = cancellation
      ? booking.payment_status === 'cancellation_fee_captured'
      : (
        (booking.payment_status === 'captured' && booking.payout_review_status !== 'review_required')
        || (
          ['partially_refunded', 'refunded'].includes(booking.payment_status)
          && booking.payout_review_status === 'approved_full'
        )
      );
    return dueCents > 0
      && paymentReady
      && booking.stripe_dispute_hold !== true
      && booking.damage_review_status !== 'review_required'
      && eventAt
      && eventAt < cutoff;
  }).slice(0, 25);

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  let released = 0;
  const releasedRefs = [];

  for (const b of due || []) {
    const cancellationPayout = b.status === 'cancelled';
    const dueCents = cancellationPayout
      ? Number(b.cancellation_easer_due_cents || 0)
      : Number(b.assembler_due || 0);
    if (!cancellationPayout && b.evidence_requested_at) {
      const evidenceResult = await loadCurrentCompletionEvidence(sb, b, { select: 'id, evidence_type, uploaded_by, created_at' });
      const requestedAt = new Date(b.evidence_requested_at).getTime();
      const evidenceAt = new Date(evidenceResult.evidence?.created_at || '').getTime();
      if (evidenceResult.error
          || !evidenceResult.evidence
          || !Number.isFinite(requestedAt)
          || !Number.isFinite(evidenceAt)
          || evidenceAt < requestedAt) {
        console.error(`release-payouts evidence hold remains for ${b.ref}:`, evidenceResult.error?.message || evidenceResult.reason);
        continue;
      }
    }
    const idem = `transfer-booking-${b.id}`;
    const operationKey = `payout:connect:${b.id}`;
    let reservationHeld = false;
    let transferAttempted = false;
    try {
      await reserveBookingFinancialOperation(sb, {
        bookingId: b.id,
        operationKey,
        operationType: 'payout_connect',
        expectedStatuses: [b.status],
        expectedAssemblerId: b.assembler_id,
        expectedBooking: b,
      });
      reservationHeld = true;

      // Re-read every durable payout hold only after the row-locking reservation
      // commits. This catches stale cron query rows before any Connect lookup.
      const postReservation = await verifyConnectPayoutReleaseState(sb, b, operationKey, dueCents);
      if (!postReservation.ok) {
        console.error(`release-payouts post-reservation hold for ${b.ref}: ${postReservation.reason}`);
        await releaseReservedConnectPayout(sb, b, operationKey);
        reservationHeld = false;
        continue;
      }

      const connectState = await getAssemblerConnectAccount(sb, b.assembler_id);
      if (!connectState.ok) {
        await releaseReservedConnectPayout(sb, b, operationKey);
        reservationHeld = false;
        continue;
      }

      await writeFinancialAudit(sb, {
        eventType: 'transfer_attempt', eventSource: 'cron_release_payouts',
        bookingId: b.id, paymentIntentId: b.stripe_payment_intent_id, idempotencyKey: idem,
        status: 'processing', metadata: { ref: b.ref, destinationAccount: connectState.accountId, amount: dueCents, cancellationPayout },
      });

      // Keep this check immediately adjacent to the Stripe mutation. Evidence
      // and damage workflows row-lock against this reservation; the final read
      // also catches any out-of-band service-role write that ignored the lock.
      const immediatelyBeforeTransfer = await verifyConnectPayoutReleaseState(sb, b, operationKey, dueCents);
      if (!immediatelyBeforeTransfer.ok) {
        console.error(`release-payouts final payout hold for ${b.ref}: ${immediatelyBeforeTransfer.reason}`);
        await releaseReservedConnectPayout(sb, b, operationKey);
        reservationHeld = false;
        continue;
      }

      transferAttempted = true;
      const transfer = await stripe.transfers.create({
        amount: dueCents,
        currency: 'usd',
        destination: connectState.accountId,
        transfer_group: `booking_${b.id}`,
        metadata: { bookingId: b.id, bookingRef: b.ref, type: 'assembler_payout' },
      }, { idempotencyKey: idem });

      const notes = `Stripe Connect transfer ${transfer.id} created after ${PAYOUT_HOLD_HOURS}h hold; bank payout not yet verified`;
      const { error: transferStateErr, data: transferredRows } = await sb.from('bookings').update({
        payout_status: 'transferred',
        payout_amount: dueCents,
        payout_notes: notes,
        stripe_transfer_id: transfer.id,
        stripe_destination_account_id: connectState.accountId,
        stripe_transfer_status: 'succeeded',
        stripe_transfer_created_at: new Date().toISOString(),
        stripe_bank_payout_status: 'pending',
        cancellation_easer_payout_status: cancellationPayout ? 'transferred' : b.cancellation_easer_payout_status,
        financial_operation_key: null,
        financial_operation_type: null,
        financial_operation_started_at: null,
      })
        .eq('id', b.id)
        .eq('payout_status', 'pending')
        .eq('financial_operation_key', operationKey)
        .eq('financial_operation_type', 'payout_connect')
        .eq('assembler_id', b.assembler_id)
        .eq('stripe_dispute_hold', false)
        .select('id');
      if (transferStateErr || !transferredRows?.length) {
        throw new Error(`Transfer created but booking state failed: ${transferStateErr?.message || 'reservation changed'}`);
      }
      reservationHeld = false;

      await writeFinancialAudit(sb, {
        eventType: 'transfer_attempt', eventSource: 'cron_release_payouts',
        bookingId: b.id, paymentIntentId: b.stripe_payment_intent_id, idempotencyKey: idem,
        status: 'processed', metadata: {
          ref: b.ref,
          transferId: transfer.id,
          amount: dueCents,
          transferStatus: 'succeeded',
          bankPayoutStatus: 'pending',
        },
      });

      released++;
      releasedRefs.push(b.ref);
    } catch (err) {
      if (reservationHeld && !transferAttempted) {
        await releaseReservedConnectPayout(sb, b, operationKey);
        reservationHeld = false;
      }
      // Most common transient cause: platform balance not yet available. Leave pending; retry next run.
      console.error('release-payouts transfer error for ' + b.ref + ':', err.message);
      await writeFinancialAudit(sb, {
        eventType: 'transfer_attempt', eventSource: 'cron_release_payouts',
        bookingId: b.id, paymentIntentId: b.stripe_payment_intent_id, idempotencyKey: idem,
        status: 'failed', metadata: { ref: b.ref, amount: dueCents, cancellationPayout }, error: err?.message || 'transfer failed',
      });
    }
  }

  await logCron('release-payouts', { status: 'ok', records: released, duration: Date.now() - t });
  return res.status(200).json({ released, refs: releasedRefs });
}

export async function verifyConnectPayoutReleaseState(sb, expected, operationKey, expectedDueCents) {
  const { data: current, error } = await sb.from('bookings')
    .select(CONNECT_PAYOUT_RECHECK_FIELDS)
    .eq('id', expected.id)
    .maybeSingle();
  if (error || !current) {
    return { ok: false, reason: error?.message || 'booking_missing' };
  }
  if (current.status !== expected.status || current.assembler_id !== expected.assembler_id) {
    return { ok: false, reason: 'booking_or_assignee_changed' };
  }
  if (current.financial_operation_key !== operationKey
      || current.financial_operation_type !== 'payout_connect'
      || !current.financial_operation_started_at) {
    return { ok: false, reason: 'connect_payout_reservation_missing' };
  }
  if (current.payout_status !== 'pending'
      || current.payout_mode_snapshot !== 'stripe_connect'
      || current.stripe_transfer_id
      || current.paid_out_at) {
    return { ok: false, reason: 'payout_already_changed' };
  }
  if (!['not_required', 'resolved'].includes(current.damage_review_status)) {
    return { ok: false, reason: 'damage_review_hold' };
  }
  if (current.stripe_dispute_hold === true) {
    return { ok: false, reason: 'stripe_dispute_payout_hold' };
  }
  if (current.damage_review_status === 'resolved'
      && (!current.damage_claim_opened_at
        || !current.damage_reviewed_at
        || !String(current.damage_reviewed_by || '').trim()
        || String(current.damage_review_notes || '').trim().length < 10)) {
    return { ok: false, reason: 'damage_review_truth_incomplete' };
  }

  const cancellation = current.status === 'cancelled';
  const currentDueCents = cancellation
    ? Number(current.cancellation_easer_due_cents || 0)
    : Number(current.assembler_due || 0);
  if (currentDueCents <= 0 || currentDueCents !== Number(expectedDueCents)) {
    return { ok: false, reason: 'canonical_payout_amount_changed' };
  }

  if (cancellation) {
    if (current.payment_status !== 'cancellation_fee_captured'
        || ['paid', 'transferred'].includes(current.cancellation_easer_payout_status)) {
      return { ok: false, reason: 'cancellation_payout_not_ready' };
    }
  } else {
    const refundAffected = ['partially_refunded', 'refunded'].includes(current.payment_status);
    const paymentReady = current.payment_status === 'captured'
      ? current.payout_review_status !== 'review_required'
      : refundAffected && current.payout_review_status === 'approved_full';
    if (!paymentReady) return { ok: false, reason: 'payment_or_payout_review_hold' };
    if (current.payout_review_status === 'approved_full'
        && (!current.payout_reviewed_at
          || !String(current.payout_reviewed_by || '').trim()
          || String(current.payout_review_notes || '').trim().length < 10)) {
      return { ok: false, reason: 'payout_review_truth_incomplete' };
    }
    if (current.evidence_requested_at) {
      const evidenceResult = await loadCurrentCompletionEvidence(sb, current, {
        select: 'id, evidence_type, uploaded_by, created_at',
      });
      if (evidenceResult.error || !evidenceResult.evidence) {
        return { ok: false, reason: evidenceResult.error?.message || evidenceResult.reason || 'evidence_hold' };
      }
      const requestedAt = new Date(current.evidence_requested_at).getTime();
      const evidenceAt = new Date(evidenceResult.evidence.created_at).getTime();
      if (!Number.isFinite(requestedAt) || !Number.isFinite(evidenceAt) || evidenceAt < requestedAt) {
        return { ok: false, reason: 'post_request_completion_evidence_missing' };
      }
    }
  }

  return { ok: true, current };
}

async function releaseReservedConnectPayout(sb, booking, operationKey) {
  try {
    const released = await releaseBookingFinancialOperation(sb, {
      bookingId: booking.id,
      operationKey,
    });
    if (!released) console.error(`release-payouts could not release unused reservation for ${booking.ref}`);
    return released;
  } catch (error) {
    console.error(`release-payouts reservation cleanup failed for ${booking.ref}:`, error?.message || error);
    return false;
  }
}
