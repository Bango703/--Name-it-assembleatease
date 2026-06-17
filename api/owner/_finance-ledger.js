import { estimateStripeFeeCents } from '../_source-of-truth.js';

export async function loadLedgerFirstFinanceRows(sb, { from, to } = {}) {
  let bookings = null;

  // Some environments may not have refund columns yet.
  let bookingsQuery = sb
    .from('bookings')
    .select('id, ref, status, created_at, completed_at, date, service, customer_name, customer_email, assembler_id, assembler_name, assembler_tier, amount_charged, total_price, assembler_due, payout_status, payout_amount, platform_fee, platform_revenue, payment_status, refund_amount, tax_amount, stripe_fee')
    .eq('status', 'completed');
  if (from) bookingsQuery = bookingsQuery.gte('completed_at', from);
  if (to) bookingsQuery = bookingsQuery.lte('completed_at', to + 'T23:59:59Z');

  const firstAttempt = await bookingsQuery;
  if (!firstAttempt.error) {
    bookings = firstAttempt.data || [];
  } else {
    let fallbackQuery = sb
      .from('bookings')
      .select('id, ref, status, created_at, completed_at, date, service, customer_name, customer_email, assembler_id, assembler_name, assembler_tier, amount_charged, total_price, assembler_due, payout_status, payout_amount, platform_fee, platform_revenue, payment_status, tax_amount')
      .eq('status', 'completed');
    if (from) fallbackQuery = fallbackQuery.gte('completed_at', from);
    if (to) fallbackQuery = fallbackQuery.lte('completed_at', to + 'T23:59:59Z');

    const secondAttempt = await fallbackQuery;
    if (secondAttempt.error) throw secondAttempt.error;
    bookings = (secondAttempt.data || []).map(b => ({ ...b, refund_amount: null, stripe_fee: (b.stripe_fee != null ? b.stripe_fee : null) }));
  }

  const completed = bookings || [];
  const bookingIds = completed.map(b => b.id).filter(Boolean);

  let ledgerRows = [];
  if (bookingIds.length) {
    const { data, error } = await sb
      .from('payout_ledger')
      .select('booking_id, payout_amount, platform_revenue, amount_charged, assembler_due, recorded_at')
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

  const rows = completed.map(b => {
    const ledger = ledgerByBooking.get(b.id) || null;
    const charged = ledger
      ? Number(ledger.amount_charged || 0)
      : Number(b.amount_charged || b.total_price || 0);
    const refund = Number(b.refund_amount || 0);
    const netCharged = Math.max(0, charged - refund);

    const paidOut = !!ledger || b.payout_status === 'paid' || Number(b.payout_amount || 0) > 0;
    const payoutAmount = ledger
      ? Number(ledger.payout_amount || 0)
      : Number(b.payout_amount || (paidOut ? b.assembler_due : 0) || 0);

    const owed = ledger
      ? Number(ledger.payout_amount || 0)
      : Number(b.assembler_due || 0);

    const isRefunded = b.payment_status === 'refunded' || refund > 0;
    const legacyDerived = !ledger;

    // Sales tax is a pass-through liability owed to the state — NOT platform revenue.
    // Exclude it from platform revenue so the books reconcile to true operating profit.
    const taxCollected = Math.min(Math.max(0, Number(b.tax_amount || 0)), netCharged);
    // Actual Stripe fee when captured (migration 011); else the canonical estimate.
    const stripeFee = (b.stripe_fee != null ? Number(b.stripe_fee) : estimateStripeFeeCents(netCharged));
    const payoutForRevenue = paidOut ? payoutAmount : (isRefunded ? 0 : owed);

    return {
      bookingId: b.id,
      status: b.status,
      ref: b.ref,
      createdAt: b.created_at,
      completedAt: b.completed_at,
      date: b.date,
      service: b.service,
      customerName: b.customer_name,
      customerEmail: b.customer_email,
      assemblerId: b.assembler_id,
      assemblerName: b.assembler_name,
      assemblerTier: b.assembler_tier,
      paymentStatus: b.payment_status,
      payoutStatus: b.payout_status,
      charged,
      refund,
      netCharged,
      paidOut,
      payoutAmount,
      owed,
      taxCollected,
      stripeFee,
      stripeFeeIsActual: b.stripe_fee != null,
      // Platform gross profit — ONE definition shared across all finance surfaces:
      // revenue (net of refunds) MINUS Easer payout, sales tax (pass-through), and Stripe fee.
      platformRevenue: netCharged - payoutForRevenue - taxCollected - stripeFee,
      isRefunded,
      hasLedger: !!ledger,
      legacyDerived,
      ledger,
    };
  });

  const mismatched = [];
  for (const row of rows) {
    if (!row.ledger) continue;
    const booking = completed.find(b => b.id === row.bookingId);
    if (!booking) continue;

    const bookingAmountCharged = Number(booking.amount_charged || booking.total_price || 0);
    const bookingPayout = Number(booking.payout_amount || 0);
    const bookingPlatform = Number(booking.platform_revenue || 0);

    const mismatch =
      booking.payout_status !== 'paid' ||
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
      completedRows: rows.length,
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
  let paidOutJobs = 0;
  let pendingJobs = 0;
  let totalCharged = 0;
  let totalPaidOut = 0;
  let totalPlatformRevenue = 0;
  let pendingPayouts = 0;
  let totalTaxCollected = 0;
  let totalStripeFees = 0;
  let stripeFeesAllActual = true;

  for (const row of rows || []) {
    completedJobs++;
    totalCharged += Number(row.netCharged || 0);
    totalTaxCollected += Number(row.taxCollected || 0);
    totalStripeFees += Number(row.stripeFee || 0);
    if (!row.stripeFeeIsActual) stripeFeesAllActual = false;

    if (row.paidOut) {
      paidOutJobs++;
      totalPaidOut += Number(row.payoutAmount || 0);
    } else if (!row.isRefunded && Number(row.owed || 0) > 0) {
      pendingJobs++;
      pendingPayouts += Number(row.owed || 0);
    }

    totalPlatformRevenue += Number(row.platformRevenue || 0);
  }

  return {
    completedJobs,
    paidOutJobs,
    pendingJobs,
    totalCharged,
    totalPaidOut,
    totalPlatformRevenue,
    totalTaxCollected,
    totalStripeFees,
    stripeFeesAllActual,
    pendingPayouts,
  };
}
