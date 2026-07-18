import { computeBookingFinancialSummary } from '../_source-of-truth.js';
import { isCurrentCompletionEvidence } from '../booking/_completion-evidence.js';
import { normalizeOwnerOfflinePaymentMethod } from './_offline-payment.js';

const RESOLVED_DISPUTE_STATUSES = new Set(['won', 'warning_closed', 'prevented']);

export function hasVerifiedOfflineOwnerPayment(booking = {}) {
  return String(booking.source || '').trim().toLowerCase() === 'owner_manual'
    && String(booking.payment_status || '').trim().toLowerCase() === 'offline_recorded'
    && booking.payment_collected === true
    && Boolean(booking.payment_collected_at)
    && String(booking.payment_collected_by || '').trim().length > 0
    && Boolean(normalizeOwnerOfflinePaymentMethod(booking.payment_method))
    && Number(booking.amount_charged ?? booking.total_price ?? 0) > 0;
}

export function deriveManualPayoutReadiness(booking, {
  paidOut = false,
  owed = 0,
  hasCurrentCompletionEvidence = false,
} = {}) {
  if (paidOut) return { disposition: 'paid', holdReasons: [], holdCodes: [] };
  if (Number(owed || 0) <= 0) {
    return { disposition: 'not_payable', holdReasons: [], holdCodes: [] };
  }

  const holdReasons = [];
  const holdCodes = [];
  const hold = (code, reason) => {
    holdCodes.push(code);
    holdReasons.push(reason);
  };
  const isCancellationEarning = booking.status === 'cancelled';
  const payoutStatus = String((isCancellationEarning
    ? (booking.cancellation_easer_payout_status || booking.payout_status)
    : booking.payout_status) || '').toLowerCase();
  const paymentStatus = String(booking.payment_status || '').toLowerCase();
  const disputeStatus = String(booking.stripe_dispute_status || '').toLowerCase();

  if (!booking.assembler_id) hold('easer_not_assigned', 'No Easer is assigned to this earning.');
  if (payoutStatus !== 'pending') hold('payout_state_reconciliation', 'Payout state must be reconciled to pending.');
  if (booking.stripe_transfer_id) hold('stripe_transfer_exists', 'A Stripe Connect transfer already exists.');
  if (booking.payout_mode_snapshot !== 'manual') {
    hold(booking.payout_mode_snapshot === 'stripe_connect' ? 'stripe_connect_path' : 'payout_mode_missing', booking.payout_mode_snapshot === 'stripe_connect'
      ? 'This earning belongs to the Stripe Connect payout path.'
      : 'Manual payout mode is missing; apply migration 037 and reconcile the booking.');
  }

  if (isCancellationEarning) {
    if (paymentStatus !== 'cancellation_fee_captured') {
      hold('cancellation_payment_uncaptured', 'The customer cancellation fee is not captured.');
    }
  } else if (paymentStatus === 'captured') {
    // Standard completed-job payout path.
  } else if (hasVerifiedOfflineOwnerPayment(booking)) {
    // Owner-recorded completed work may be paid only after an audited offline
    // customer collection exists. This remains distinct from Stripe capture.
  } else if (['partially_refunded', 'refunded'].includes(paymentStatus)) {
    const reviewComplete = booking.payout_review_status === 'approved_full'
      && !!booking.payout_reviewed_at
      && String(booking.payout_reviewed_by || '').trim().length > 0
      && String(booking.payout_review_notes || '').trim().length >= 10;
    if (!reviewComplete) hold('refund_review_incomplete', 'Refund-affected Easer earnings require a completed owner review.');
  } else if (String(booking.source || '').trim().toLowerCase() === 'owner_manual'
      && paymentStatus === 'offline_recorded') {
    hold(
      'offline_payment_not_verified',
      'Record the offline customer payment as collected from the booking before paying the Easer.',
    );
  } else {
    hold('customer_payment_uncaptured', 'Customer funds are not captured.');
  }

  if (booking.damage_review_status === 'review_required') {
    hold('damage_review_open', 'The damage payout review is still open.');
  } else if (booking.damage_review_status === 'resolved') {
    const damageReviewComplete = !!booking.damage_claim_opened_at
      && !!booking.damage_reviewed_at
      && String(booking.damage_reviewed_by || '').trim().length > 0
      && String(booking.damage_review_notes || '').trim().length >= 10;
    if (!damageReviewComplete) hold('damage_review_incomplete', 'The damage review record is incomplete.');
  }

  if (booking.stripe_dispute_hold === true
      || (booking.stripe_dispute_id && !RESOLVED_DISPUTE_STATUSES.has(disputeStatus))) {
    hold('customer_dispute_open', 'Stripe reports an unresolved customer dispute on these funds.');
  }
  if (booking.financial_operation_key || booking.financial_reconciliation_required_at) {
    hold('financial_reconciliation_open', 'A financial operation or reconciliation hold is still open.');
  }
  if (!isCancellationEarning && booking.evidence_requested_at && !hasCurrentCompletionEvidence) {
    hold('completion_evidence_missing', 'The requested current-Easer completion photo is missing.');
  }

  return {
    disposition: holdReasons.length ? 'on_hold' : 'pending',
    holdReasons,
    holdCodes,
  };
}

export async function loadLedgerFirstFinanceRows(sb, { from, to, assemblerId } = {}) {
  let bookings = null;

  let bookingsQuery = sb
    .from('bookings')
    .select('id, ref, source, payment_method, payment_collected, payment_collected_at, payment_collected_by, status, created_at, completed_at, cancelled_at, date, service, customer_name, customer_email, assembler_id, assembler_name, assembler_tier, amount_charged, total_price, assembler_due, payout_status, payout_amount, paid_out_at, payout_mode_snapshot, payout_review_status, payout_reviewed_at, payout_reviewed_by, payout_review_notes, damage_review_status, damage_claim_opened_at, damage_reviewed_at, damage_reviewed_by, damage_review_notes, evidence_requested_at, job_started_at, financial_operation_key, financial_reconciliation_required_at, stripe_transfer_id, stripe_transfer_status, stripe_transfer_created_at, stripe_bank_payout_status, stripe_bank_payout_paid_at, stripe_dispute_id, stripe_dispute_status, stripe_dispute_hold, platform_fee, platform_revenue, payment_status, refund_amount, tax_amount, stripe_fee, bundle_slug, assemblecash_earned_cents, assemblecash_redeemed_cents, cancellation_fee, cancellation_easer_due_cents, cancellation_easer_payout_status')
    .in('status', ['completed', 'cancelled']);

  if (assemblerId) bookingsQuery = bookingsQuery.eq('assembler_id', assemblerId);

  const firstAttempt = await bookingsQuery;
  if (firstAttempt.error) {
    const migrationError = new Error('Finance schema is incomplete. Apply all required migrations before using owner financial reports.');
    migrationError.code = 'MIGRATION_REQUIRED';
    migrationError.cause = firstAttempt.error;
    throw migrationError;
  }
  bookings = (firstAttempt.data || [])
    .filter(booking => booking.status === 'completed'
      || (booking.status === 'cancelled' && Number(booking.cancellation_easer_due_cents || 0) > 0))
    .filter(booking => isBookingInEventRange(booking, { from, to }));

  const financeBookings = bookings || [];
  const bookingIds = financeBookings.map(b => b.id).filter(Boolean);

  const evidenceRequiredBookings = financeBookings.filter(booking =>
    booking.status === 'completed' && booking.evidence_requested_at);
  const currentEvidenceBookingIds = new Set();
  if (evidenceRequiredBookings.length) {
    const evidenceBookingIds = evidenceRequiredBookings.map(booking => booking.id);
    const evidenceBookingById = new Map(evidenceRequiredBookings.map(booking => [booking.id, booking]));
    const { data: evidenceRows, error: evidenceError } = await sb
      .from('booking_evidence')
      .select('booking_id, evidence_type, uploaded_by, created_at')
      .in('booking_id', evidenceBookingIds)
      .eq('evidence_type', 'completion_photo');
    if (evidenceError) throw evidenceError;
    for (const evidence of evidenceRows || []) {
      const booking = evidenceBookingById.get(evidence.booking_id);
      if (booking && isCurrentCompletionEvidence(evidence, booking)) {
        currentEvidenceBookingIds.add(evidence.booking_id);
      }
    }
  }

  let ledgerRows = [];
  if (bookingIds.length) {
    const { data, error } = await sb
      .from('payout_ledger')
      .select('booking_id, payout_amount, platform_revenue, amount_charged, assembler_due, payout_method, payout_notes, recorded_by, recorded_at')
      .in('booking_id', bookingIds)
      .order('recorded_at', { ascending: false });
    if (error) throw error;
    ledgerRows = data || [];
  }

  const ledgerByBooking = new Map();
  const duplicateLedgerCounts = new Map();
  for (const row of ledgerRows) {
    const id = row.booking_id;
    if (!id) continue;
    duplicateLedgerCounts.set(id, (duplicateLedgerCounts.get(id) || 0) + 1);
    if (!ledgerByBooking.has(id)) ledgerByBooking.set(id, row);
  }

  const rows = financeBookings.map(b => {
    const isCancellationEarning = b.status === 'cancelled';
    const ledger = ledgerByBooking.get(b.id) || null;
    const charged = ledger
      ? Number(ledger.amount_charged || 0)
      : Number(isCancellationEarning
        ? (b.cancellation_fee || b.amount_charged || 0)
        : (b.amount_charged || b.total_price || 0));
    const refund = Number(b.refund_amount || 0);
    const canonicalDue = Number(isCancellationEarning
      ? b.cancellation_easer_due_cents
      : b.assembler_due) || 0;
    const payoutStatus = isCancellationEarning
      ? (b.cancellation_easer_payout_status || b.payout_status)
      : b.payout_status;

    const paidOut = !!ledger || payoutStatus === 'paid';
    const payoutAmount = ledger
      ? Number(ledger.payout_amount || 0)
      : Number(b.payout_amount || (paidOut ? canonicalDue : 0) || 0);

    const owed = ledger
      ? Number(ledger.payout_amount || 0)
      : canonicalDue;

    const isRefunded = ['refunded', 'partially_refunded'].includes(b.payment_status) || refund > 0;
    const payoutReadiness = deriveManualPayoutReadiness(b, {
      paidOut,
      owed,
      hasCurrentCompletionEvidence: !b.evidence_requested_at || currentEvidenceBookingIds.has(b.id),
    });
    const payoutDisposition = payoutReadiness.disposition;
    const legacyDerived = !ledger;

    // Sales tax is a pass-through liability owed to the state — NOT platform revenue.
    // Exclude it from platform revenue so the books reconcile to true operating profit.
    const financial = computeBookingFinancialSummary({
      amountChargedCents: charged,
      totalPriceCents: b.total_price,
      refundAmountCents: refund,
      taxAmountCents: isCancellationEarning ? 0 : b.tax_amount,
      stripeFeeCents: b.stripe_fee,
      assemblerDueCents: owed,
      payoutAmountCents: paidOut ? payoutAmount : 0,
    });

    return {
      bookingId: b.id,
      status: b.status,
      eventType: isCancellationEarning ? 'cancellation_earnings' : 'completed_job',
      eventAt: isCancellationEarning ? b.cancelled_at : b.completed_at,
      ref: b.ref,
      createdAt: b.created_at,
      completedAt: b.completed_at,
      cancelledAt: b.cancelled_at,
      date: b.date,
      service: b.service,
      customerName: b.customer_name,
      customerEmail: b.customer_email,
      assemblerId: b.assembler_id,
      assemblerName: b.assembler_name,
      assemblerTier: b.assembler_tier,
      paymentStatus: b.payment_status,
      payoutStatus,
      payoutMode: b.payout_mode_snapshot || null,
      payoutReviewStatus: b.payout_review_status || 'not_required',
      payoutReviewedAt: b.payout_reviewed_at || null,
      payoutReviewNotes: b.payout_review_notes || null,
      payoutDisposition,
      payoutHoldReasons: payoutReadiness.holdReasons,
      payoutHoldCodes: payoutReadiness.holdCodes,
      cancellationEarnings: isCancellationEarning,
      bundleSlug: b.bundle_slug || null,
      assemblecashEarnedCents: Number(b.assemblecash_earned_cents || 0),
      assemblecashRedeemedCents: Number(b.assemblecash_redeemed_cents || 0),
      charged,
      refund,
      netCharged: financial.netChargedCents,
      paidOut,
      payoutAmount,
      owed,
      paidOutAt: b.paid_out_at || ledger?.recorded_at || null,
      stripeTransferStatus: b.stripe_transfer_status || null,
      stripeTransferCreatedAt: b.stripe_transfer_created_at || null,
      stripeBankPayoutStatus: b.stripe_bank_payout_status || null,
      stripeBankPayoutPaidAt: b.stripe_bank_payout_paid_at || null,
      source: b.source || null,
      paymentMethod: b.payment_method || null,
      paymentCollected: b.payment_collected === true,
      paymentCollectedAt: b.payment_collected_at || null,
      taxCollected: financial.taxCollectedCents,
      stripeFee: financial.processingFeeCents,
      stripeFeeIsActual: financial.processingFeeIsActual,
      // Platform gross profit — ONE definition shared across all finance surfaces:
      // revenue (net of refunds) MINUS Easer payout, sales tax (pass-through), and Stripe fee.
      platformRevenue: financial.platformGrossCents,
      isRefunded,
      hasLedger: !!ledger,
      legacyDerived,
      ledger,
    };
  });

  const mismatched = [];
  for (const row of rows) {
    if (!row.ledger) continue;
    const booking = financeBookings.find(b => b.id === row.bookingId);
    if (!booking) continue;

    const bookingAmountCharged = Number(booking.status === 'cancelled'
      ? (booking.cancellation_fee || booking.amount_charged || 0)
      : (booking.amount_charged || booking.total_price || 0));
    const bookingPayout = Number(booking.payout_amount || 0);
    const bookingPlatform = Number(booking.platform_revenue || 0);

    const mismatch =
      row.payoutStatus !== 'paid' ||
      bookingPayout !== Number(row.ledger.payout_amount || 0) ||
      bookingPlatform !== Number(row.ledger.platform_revenue || 0) ||
      bookingAmountCharged !== Number(row.ledger.amount_charged || 0);

    if (mismatch) mismatched.push(row.ref);
  }

  const duplicateBookingIds = Array.from(duplicateLedgerCounts.entries())
    .filter(([, count]) => count > 1)
    .map(([id]) => id);

  return {
    rows,
    reconciliation: {
      financialRows: rows.length,
      completedRows: rows.filter(row => row.status === 'completed').length,
      cancellationEarningRows: rows.filter(row => row.cancellationEarnings).length,
      ledgerRows: ledgerRows.length,
      ledgerBackedRows: rows.filter(r => r.hasLedger).length,
      legacyRows: rows.filter(r => r.legacyDerived).length,
      mismatchedCount: mismatched.length,
      mismatchedRefs: mismatched.slice(0, 25),
      duplicateLedgerBookingCount: duplicateBookingIds.length,
      duplicateLedgerBookingIds: duplicateBookingIds,
    },
  };
}

export function summarizeFinanceRows(rows) {
  let completedJobs = 0;
  let cancellationEarningEvents = 0;
  let paidOutJobs = 0;
  let pendingJobs = 0;
  let heldJobs = 0;
  let totalCharged = 0;
  let totalPaidOut = 0;
  let totalPlatformRevenue = 0;
  let pendingPayouts = 0;
  let heldPayouts = 0;
  let totalTaxCollected = 0;
  let totalStripeFees = 0;
  let stripeFeesAllActual = true;

  for (const row of rows || []) {
    if (row.status === 'completed') completedJobs++;
    if (row.cancellationEarnings) cancellationEarningEvents++;
    totalCharged += Number(row.netCharged || 0);
    totalTaxCollected += Number(row.taxCollected || 0);
    totalStripeFees += Number(row.stripeFee || 0);
    if (!row.stripeFeeIsActual) stripeFeesAllActual = false;

    if (row.paidOut) {
      paidOutJobs++;
      totalPaidOut += Number(row.payoutAmount || 0);
    } else if (row.payoutDisposition === 'pending' && Number(row.owed || 0) > 0) {
      pendingJobs++;
      pendingPayouts += Number(row.owed || 0);
    } else if (row.payoutDisposition === 'on_hold' && Number(row.owed || 0) > 0) {
      heldJobs++;
      heldPayouts += Number(row.owed || 0);
      // A hold is still a potential contractor liability and must remain in
      // the owner's reserve total until explicitly reviewed.
      pendingPayouts += Number(row.owed || 0);
    }

    totalPlatformRevenue += Number(row.platformRevenue || 0);
  }

  return {
    completedJobs,
    cancellationEarningEvents,
    paidOutJobs,
    pendingJobs,
    heldJobs,
    totalCharged,
    totalPaidOut,
    totalPlatformRevenue,
    totalTaxCollected,
    totalStripeFees,
    stripeFeesAllActual,
    pendingPayouts,
    heldPayouts,
  };
}

function isBookingInEventRange(booking, { from, to } = {}) {
  const eventAt = booking.status === 'cancelled' ? booking.cancelled_at : booking.completed_at;
  const eventMs = new Date(eventAt || booking.date || booking.created_at || 0).getTime();
  if (!Number.isFinite(eventMs)) return false;

  if (from) {
    const fromMs = new Date(from).getTime();
    if (Number.isFinite(fromMs) && eventMs < fromMs) return false;
  }
  if (to) {
    const toText = String(to);
    const toMs = new Date(/^\d{4}-\d{2}-\d{2}$/.test(toText) ? `${toText}T23:59:59.999Z` : toText).getTime();
    if (Number.isFinite(toMs) && eventMs > toMs) return false;
  }
  return true;
}
