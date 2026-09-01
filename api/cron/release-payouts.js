import Stripe from 'stripe';
import { getSupabase } from '../_supabase.js';
import { sendEmail, ownerEmail, esc } from '../_email.js';
import { buildPayoutEmail, expectedPayoutArrival } from '../booking/payout.js';
import { writeFinancialAudit } from '../_financial-audit.js';
import { isStripeConnectEnabled, getAssemblerConnectAccount } from '../_stripe-connect.js';
import { logCron } from './_cron-logger.js';
import { PAYOUT_HOLD_HOURS } from '../_source-of-truth.js';
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
// Hold window before a payout is released. Defaults to 24h; override with the
// PAYOUT_HOLD_HOURS env var (e.g. set to 0 in test to release immediately).
// Imported, not redeclared: this number and the one an Easer is told must
// never be two separate values.


const CONNECT_PAYOUT_RECHECK_FIELDS = [
  'id', 'status', 'assembler_id', 'assembler_due',
  'cancellation_easer_due_cents', 'cancellation_easer_payout_status', 'easer_bonus_cents',
  'payment_status', 'payout_status', 'payout_mode_snapshot',
  'stripe_dispute_id', 'stripe_dispute_status',
  'payout_review_status', 'payout_reviewed_at', 'payout_reviewed_by', 'payout_review_notes',
  'paid_out_at', 'stripe_transfer_id', 'evidence_requested_at', 'job_started_at',
  'damage_review_status', 'damage_claim_opened_at', 'damage_reviewed_at',
  'damage_reviewed_by', 'damage_review_notes', 'financial_operation_key',
  'financial_operation_type', 'financial_operation_started_at',
].join(', ');

const ACTIVE_FINANCIAL_LOCK_MINUTES = 15;

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
    .select('id, ref, status, assembler_id, assembler_name, assembler_due, cancellation_easer_due_cents, cancellation_easer_payout_status, easer_bonus_cents, completed_at, cancelled_at, payment_status, payout_status, payout_amount, payout_mode_snapshot, payout_review_status, payout_reviewed_at, payout_reviewed_by, payout_review_notes, stripe_dispute_id, stripe_dispute_status, paid_out_at, total_price, tax_amount, service_call_fee, amount_charged, refund_amount, is_deposit, deposit_amount, cancellation_fee, stripe_customer_id, stripe_payment_intent_id, stripe_deposit_intent_id, stripe_balance_payment_intent_id, stripe_balance_amount_captured, stripe_transfer_id, assemblecash_redeemed_cents, reschedule_count, rescheduled_at, easer_fee_snapshot_easer_id, easer_fee_pct_snapshot, easer_estimated_due_snapshot, evidence_requested_at, job_started_at, damage_review_status, damage_claim_opened_at, damage_reviewed_at, damage_reviewed_by, damage_review_notes, financial_operation_key, financial_operation_type, financial_operation_started_at, financial_reconciliation_required_at')
    .in('status', ['completed', 'cancelled'])
    .eq('payout_status', 'pending')
    .eq('payout_mode_snapshot', 'stripe_connect')
    .is('financial_reconciliation_required_at', null)
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
      : Number(booking.assembler_due || 0) + Number(booking.easer_bonus_cents || 0);
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
      && !(booking.stripe_dispute_id && !['won', 'warning_closed', 'prevented'].includes(String(booking.stripe_dispute_status || '').toLowerCase()))
      && booking.damage_review_status !== 'review_required'
      && eventAt
      && eventAt < cutoff;
  }).slice(0, 25);

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  let released = 0;
  const releasedRefs = [];

  for (const b of due || []) {
    const cancellationPayout = b.status === 'cancelled';
    // The owner-funded bonus rides on top of the split, exactly like the
    // same-day rush bonus. It is added HERE rather than inside
    // computeBookingSplit, which must stay a pure function of what the
    // customer paid. A cancellation payout has no bonus: there was no job.
    const dueCents = cancellationPayout
      ? Number(b.cancellation_easer_due_cents || 0)
      : Number(b.assembler_due || 0) + Number(b.easer_bonus_cents || 0);
    if (!cancellationPayout && b.evidence_requested_at) {
      const evidenceResult = await loadCurrentCompletionEvidence(sb, b, {
        select: 'id, evidence_type, uploaded_by, uploaded_on_behalf_of, created_at',
        acceptSuppliedOnBehalf: true,
      });
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
    const lockState = classifyConnectPayoutLock(b, operationKey);
    if (lockState === 'active_foreign') continue;
    if (lockState === 'stale_foreign') {
      await holdStaleConnectPayoutLock(sb, b, { dueCents, cancellationPayout });
      continue;
    }
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

      // source_transaction is what stops an Easer waiting on OUR settlement.
      //
      // A plain transfer draws on the platform's AVAILABLE balance, and a card
      // charge sits in PENDING for two days first — so without this the transfer
      // simply fails until the money settles, and the Easer waits for a delay
      // that has nothing to do with their work. Naming the originating charge
      // lets Stripe accept the transfer immediately and execute it the moment
      // that specific charge clears. No platform float, no failed retries, and
      // the hold below goes back to being purely a work-verification window
      // rather than a settlement queue.
      //
      // Resolved rather than stored: the charge id is not on the booking, and one
      // retrieve per payout is cheaper than a migration plus a backfill.
      let sourceCharge = null;
      let fundsAvailableAt = null;
      try {
        // balance_transaction expanded: available_on is when the customer's
        // payment actually settles, which is the real base for any date we
        // promise the Easer.
        const intent = await stripe.paymentIntents.retrieve(b.stripe_payment_intent_id, {
          expand: ['latest_charge.balance_transaction'],
        });
        const bt = intent?.latest_charge?.balance_transaction;
        if (bt?.available_on) fundsAvailableAt = new Date(bt.available_on * 1000);
        sourceCharge = typeof intent?.latest_charge === 'string'
          ? intent.latest_charge
          : intent?.latest_charge?.id || null;
      } catch (chargeErr) {
        // Fall through to a plain transfer. It still succeeds once funds are
        // available, so a lookup failure delays the payout — it never loses it.
        console.error('[release-payouts] charge lookup failed:', b.ref, chargeErr?.message || chargeErr);
      }

      const transfer = await stripe.transfers.create({
        amount: dueCents,
        currency: 'usd',
        destination: connectState.accountId,
        transfer_group: `booking_${b.id}`,
        ...(sourceCharge ? { source_transaction: sourceCharge } : {}),
        metadata: {
          bookingId: b.id,
          bookingRef: b.ref,
          type: 'assembler_payout',
          sourceCharge: sourceCharge || 'unresolved',
        },
      }, { idempotencyKey: idem });

      // What the Easer will be told, captured at transfer time from THEIR OWN
      // payout schedule. Stored rather than recomputed so the dashboard shows
      // the same date the email promised, and so a later schedule change cannot
      // silently rewrite history. Estimate only — Stripe's real arrival_date
      // does not exist until it creates the bank payout.
      let arrivalDelayDays = null;
      let expectedArrivalAt = null;
      try {
        const acctForSchedule = await stripe.accounts.retrieve(connectState.accountId);
        arrivalDelayDays = acctForSchedule?.settings?.payouts?.schedule?.delay_days ?? null;
        // Base it on when the money actually REACHES the platform, not on when
        // this cron ran. Stripe is explicit that a source_transaction transfer
        // succeeds immediately but does not execute until the source charge
        // settles, so counting from now() promised Trapper Tuesday when the
        // truth was Friday. Being three days early about someone's money is how
        // they stop believing anything else we tell them.
        expectedArrivalAt = fundsAvailableAt
          ? expectedPayoutArrival(fundsAvailableAt, arrivalDelayDays)
          : null;
      } catch (schedErr) {
        console.error('[release-payouts] payout schedule unreadable for ' + b.ref + ':', schedErr?.message || schedErr);
      }

      const notes = `Stripe Connect transfer ${transfer.id} created after ${PAYOUT_HOLD_HOURS}h hold; bank payout not yet verified`;
      const transferPatch = {
        payout_status: 'transferred',
        payout_amount: dueCents,
        payout_notes: notes,
        stripe_transfer_id: transfer.id,
        stripe_destination_account_id: connectState.accountId,
        stripe_transfer_status: 'succeeded',
        stripe_transfer_created_at: new Date().toISOString(),
        stripe_bank_payout_status: 'pending',
        expected_bank_arrival_at: expectedArrivalAt ? expectedArrivalAt.toISOString() : null,
        cancellation_easer_payout_status: cancellationPayout ? 'transferred' : b.cancellation_easer_payout_status,
        financial_operation_key: null,
        financial_operation_type: null,
        financial_operation_started_at: null,
      };

      // expected_bank_arrival_at arrives with migration 086. If the code ships
      // first, naming it here makes PostgREST reject the WHOLE update — and the
      // transfer has already been created by this point, so the booking would be
      // left claiming the money never moved. Losing a nice-to-have date is fine;
      // losing the record of a real transfer is not.
      const applyTransferState = patch => sb.from('bookings').update(patch)
        .eq('id', b.id)
        .eq('payout_status', 'pending')
        .eq('financial_operation_key', operationKey)
        .eq('financial_operation_type', 'payout_connect')
        .eq('assembler_id', b.assembler_id)
        .select('id');

      let { error: transferStateErr, data: transferredRows } = await applyTransferState(transferPatch);
      if (transferStateErr && /expected_bank_arrival_at|PGRST204|42703/i.test(String(transferStateErr.message || transferStateErr.code || ''))) {
        console.warn('[release-payouts] migration 086 not applied; recording the transfer without an arrival estimate');
        const { expected_bank_arrival_at: _skip, ...withoutArrival } = transferPatch;
        ({ error: transferStateErr, data: transferredRows } = await applyTransferState(withoutArrival));
      }
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


      // The Easer has just been paid and, until now, was told nothing: sendEmail
      // was imported in this file and never called, so the automated rail — the
      // one that actually pays people — was silent. Rule 10: an Easer must
      // always know when and how they get paid.
      //
      // This can never affect the payout. The transfer is already created and
      // recorded; a notification failure is logged and nothing more (Rule 7).
      try {
        const { data: easerProfile } = await sb
          .from('profiles')
          .select('email, full_name')
          .eq('id', b.assembler_id)
          .maybeSingle();
        if (easerProfile?.email) {
          // Read the real schedule off their own account rather than hardcoding
          // a number that belongs to Stripe and can differ per Easer.
          let delayDays = arrivalDelayDays;
          try {
            if (delayDays == null) {
              const acct = await stripe.accounts.retrieve(connectState.accountId);
              delayDays = acct?.settings?.payouts?.schedule?.delay_days ?? null;
            }
          } catch { /* copy stays non-specific rather than inventing a figure */ }

          const payoutDisplay = '$' + (dueCents / 100).toFixed(2);
          await sendEmail({
            to: easerProfile.email,
            from: 'AssembleAtEase <booking@assembleatease.com>',
            subject: `Your payment is on the way — ${payoutDisplay}` + (b.service ? ` for ${b.service}` : ''),
            html: buildPayoutEmail({
              firstName: (easerProfile.full_name || b.assembler_name || 'there').split(' ')[0],
              ref: b.ref,
              service: b.service || 'your job',
              date: b.completed_at ? String(b.completed_at).slice(0, 10) : '',
              payoutDisplay,
              notes: '',
              method: 'stripe',
              isCancellation: cancellationPayout,
              viaStripeConnect: true,
              delayDays,
              arrivalAt: expectedArrivalAt,
            }),
            replyTo: ownerEmail(),
            meta: {
              bookingId: b.id,
              notificationType: 'easer_payout_transferred',
              recipientType: 'easer',
              recipientUserId: b.assembler_id,
              disableDedupe: true,
            },
          });
        }
      } catch (notifyErr) {
        console.error('[release-payouts] Easer payout notice failed for ' + b.ref + ':', notifyErr?.message || notifyErr);
      }
      released++;
      releasedRefs.push(b.ref);
    } catch (err) {
      if (reservationHeld && !transferAttempted) {
        await releaseReservedConnectPayout(sb, b, operationKey);
        reservationHeld = false;
      }
      // Most common transient cause: platform balance not yet available. Leave pending; retry next run.
      console.error('release-payouts transfer error for ' + b.ref + ':', err.message);
      const auditError = err?.cause?.message
        ? `${err.message} Database reason: ${err.cause.message}`
        : err?.message || 'transfer failed';
      await writeFinancialAudit(sb, {
        eventType: 'transfer_attempt', eventSource: 'cron_release_payouts',
        bookingId: b.id, paymentIntentId: b.stripe_payment_intent_id, idempotencyKey: idem,
        status: 'failed', metadata: { ref: b.ref, amount: dueCents, cancellationPayout }, error: auditError,
      });
    }
  }

  await logCron('release-payouts', { status: 'ok', records: released, duration: Date.now() - t });
  return res.status(200).json({ released, refs: releasedRefs });
}

export function classifyConnectPayoutLock(booking, operationKey, nowMs = Date.now()) {
  const hasAnyLock = Boolean(
    booking?.financial_operation_key
    || booking?.financial_operation_type
    || booking?.financial_operation_started_at,
  );
  if (!hasAnyLock) return 'unlocked';
  if (booking.financial_operation_key === operationKey
      && booking.financial_operation_type === 'payout_connect'
      && booking.financial_operation_started_at) {
    return 'resumable';
  }
  const startedAtMs = new Date(booking?.financial_operation_started_at || '').getTime();
  const activeAfterMs = nowMs - ACTIVE_FINANCIAL_LOCK_MINUTES * 60_000;
  return Number.isFinite(startedAtMs) && startedAtMs >= activeAfterMs
    ? 'active_foreign'
    : 'stale_foreign';
}

async function holdStaleConnectPayoutLock(sb, booking, { dueCents, cancellationPayout }) {
  const reason = `Automatic payout blocked by stale ${booking.financial_operation_type || 'malformed'} financial operation lock from ${booking.financial_operation_started_at || 'an unknown time'}. Reconcile the booking before retrying.`;
  let query = sb.from('bookings').update({
    financial_reconciliation_required_at: new Date().toISOString(),
    financial_reconciliation_reason: reason,
  })
    .eq('id', booking.id)
    .eq('payout_status', 'pending')
    .is('financial_reconciliation_required_at', null);
  query = booking.financial_operation_key
    ? query.eq('financial_operation_key', booking.financial_operation_key)
    : query.is('financial_operation_key', null);
  query = booking.financial_operation_type
    ? query.eq('financial_operation_type', booking.financial_operation_type)
    : query.is('financial_operation_type', null);
  query = booking.financial_operation_started_at
    ? query.eq('financial_operation_started_at', booking.financial_operation_started_at)
    : query.is('financial_operation_started_at', null);
  const { data, error } = await query.select('id');
  if (error || !data?.length) {
    console.error(`release-payouts stale lock hold failed for ${booking.ref}:`, error?.message || 'lock changed');
    return false;
  }
  await writeFinancialAudit(sb, {
    eventType: 'transfer_reconciliation_required',
    eventSource: 'cron_release_payouts',
    bookingId: booking.id,
    paymentIntentId: booking.stripe_payment_intent_id,
    idempotencyKey: `transfer-lock-hold-${booking.id}-${booking.financial_operation_started_at || 'malformed'}`,
    status: 'failed',
    metadata: { ref: booking.ref, amount: dueCents, cancellationPayout },
    error: reason,
  });
  return true;
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
  if (current.stripe_dispute_id && !['won', 'warning_closed', 'prevented'].includes(String(current.stripe_dispute_status || '').toLowerCase())) {
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
    : Number(current.assembler_due || 0) + Number(current.easer_bonus_cents || 0);
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
        select: 'id, evidence_type, uploaded_by, uploaded_on_behalf_of, created_at',
        acceptSuppliedOnBehalf: true,
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
