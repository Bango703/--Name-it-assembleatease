import { computeBookingFinancialSummary } from '../_source-of-truth.js';

export async function loadLedgerFirstFinanceRows(sb, { from, to } = {}) {
  let bookings = null;

  let bookingsQuery = sb
    .from('bookings')
    .select('id, ref, status, created_at, completed_at, cancelled_at, date, service, customer_name, customer_email, assembler_id, assembler_name, assembler_tier, amount_charged, total_price, assembler_due, payout_status, payout_amount, payout_mode_snapshot, payout_review_status, payout_reviewed_at, payout_review_notes, platform_fee, platform_revenue, payment_status, refund_amount, tax_amount, stripe_fee, bundle_slug, assemblecash_earned_cents, assemblecash_redeemed_cents, cancellation_fee, cancellation_easer_due_cents, cancellation_easer_payout_status')
    .in('status', ['completed', 'cancelled']);

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
    const payoutDisposition = paidOut
      ? 'paid'
      : owed <= 0
        ? 'not_payable'
        : isRefunded && b.payout_review_status !== 'approved_full'
          ? 'on_hold'
          : 'pending';
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
