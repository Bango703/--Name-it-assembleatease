import { computeBookingSplitFromSnapshot, computeBookingFinancialSummary } from '../_source-of-truth.js';
import { bookingHasCurrentEaserFeeSnapshot } from '../booking/_easer-fee-snapshot.js';
import { chicagoTodayIso, parseIsoCalendarDate, appointmentTimeZone, localCalendarDate } from '../booking/_appt-date.js';
import { normalizeOwnerOfflinePaymentMethod, offlineMethodFeeCents } from './_offline-payment.js';

const UPCOMING_LIMIT = 30;
const FINANCIAL_LIMIT = 15;
const dollars = cents => cents == null ? null : (Number(cents) / 100).toFixed(2);
const validCents = value => value != null && Number.isFinite(Number(value)) && Number(value) >= 0;

export function bookingFinanceContext(booking, row = null) {
  let estimate = null;
  if (validCents(booking.total_price) && bookingHasCurrentEaserFeeSnapshot(booking)) {
    const split = computeBookingSplitFromSnapshot({
      totalPriceCents: booking.total_price,
      taxCents: booking.tax_amount || 0,
      feePct: booking.easer_fee_pct_snapshot,
      assemblecashRedeemedCents: booking.assemblecash_redeemed_cents || 0,
    });
    const offlineMethod = booking.source === 'owner_manual'
      ? normalizeOwnerOfflinePaymentMethod(booking.payment_method) : null;
    const feeUnknown = booking.source === 'owner_manual' && !offlineMethod;
    const summary = computeBookingFinancialSummary({
      totalPriceCents: split.totalCents,
      taxAmountCents: split.taxCents,
      assemblerDueCents: split.assemblerDueCents,
      easerBonusCents: booking.easer_bonus_cents || 0,
      stripeFeeCents: offlineMethod ? offlineMethodFeeCents(offlineMethod, split.totalCents) : null,
    });
    estimate = {
      source: 'canonical_split_from_current_assignment_fee_and_booking_price',
      feeSnapshotAt: booking.easer_fee_snapshot_at,
      customerTotalDollars: dollars(split.totalCents),
      serviceSubtotalDollars: dollars(split.pretaxCollectedCents),
      taxDollars: dollars(split.taxCents),
      totalEaserEarningsDollars: dollars(summary.easerCostCents),
      platformBeforeProcessingDollars: dollars(summary.platformFeeCents),
      processingFeeEstimateDollars: feeUnknown ? null : dollars(summary.processingFeeCents),
      platformAfterProcessingEstimateDollars: feeUnknown ? null : dollars(summary.platformGrossCents),
      processingFeeBasis: feeUnknown ? 'unknown_payment_method' : offlineMethod ? 'configured_offline_method_estimate' : 'standard_card_fee_estimate',
      limitations: 'Estimate if the quoted job completes at this price; includes promised bonus and redeemed credit. Excludes overhead, future refunds, disputes, rework, and future rewards. Not collected revenue or final business profit.',
    };
  }

  const actual = row ? {
    source: row.hasLedger ? 'payout_ledger_and_booking_financial_state' : 'legacy_booking_financial_state',
    paymentStatus: row.paymentStatus,
    customerGrossDollars: dollars(row.charged),
    refundsDollars: dollars(row.refund),
    customerNetCollectedDollars: dollars(row.netCharged),
    taxDollars: dollars(row.taxCollected),
    totalEaserEarningsDollars: dollars(row.owed),
    recordedEaserPaymentDollars: row.paidOut ? dollars(row.payoutAmount) : null,
    processingFeeDollars: dollars(row.stripeFee),
    processingFeeIsActual: row.stripeFeeIsActual === true,
    platformAfterProcessingDollars: dollars(row.platformRevenue),
    platformAmountIsEstimate: row.stripeFeeIsActual !== true,
    payoutStatus: row.payoutStatus || null,
    payoutMode: row.payoutMode || null,
    transferStatus: row.stripeTransferStatus || null,
    bankPayoutStatus: row.stripeBankPayoutStatus || null,
    limitations: 'Recorded finance snapshot, not a fresh Stripe lookup. Transfer and bank payout are distinct. Excludes business overhead and future adjustments.',
  } : null;
  return {
    estimate,
    actual,
    estimateUnavailableReason: estimate ? null : 'Current assignment fee snapshot or booking price is missing; no earnings or profit estimate was invented.',
  };
}

export function buildOwnerJobContext(bookings = [], financeRows = [], now = new Date()) {
  const today = chicagoTodayIso(now);
  const rows = new Map(financeRows.filter(row => !row.isTestBooking).map(row => [row.bookingId, row]));
  const realBookings = bookings.filter(booking => booking.is_test_booking !== true);
  const candidates = realBookings.filter(booking =>
    !['cancelled', 'declined', 'refunded'].includes(booking.status)
    && (booking.status !== 'completed' || booking.return_visit_required === true));
  const dateOf = booking => booking.return_visit_required ? booking.return_visit_date : booking.date;
  const formatJob = booking => ({
    ref: booking.ref || null,
    date: dateOf(booking) || null,
    arrivalWindow: (booking.return_visit_required ? booking.return_visit_time : booking.time) || null,
    timezone: appointmentTimeZone(booking),
    service: booking.service || null,
    status: booking.status,
    paymentStatus: booking.payment_status || null,
    assignment: {
      easerName: booking.assembler_name || null,
      assigned: Boolean(booking.assembler_id),
      accepted: Boolean(booking.assembler_accepted_at),
      dispatchStatus: booking.dispatch_status || null,
    },
    returnVisit: booking.return_visit_required === true,
    financials: bookingFinanceContext(booking, rows.get(booking.id)),
  });
  const upcoming = candidates.filter(booking => parseIsoCalendarDate(dateOf(booking)) && dateOf(booking) >= localCalendarDate(now, appointmentTimeZone(booking)))
    .sort((a, b) => dateOf(a).localeCompare(dateOf(b)) || String(a.time || '').localeCompare(String(b.time || '')));
  const financialBookings = realBookings.filter(booking => rows.has(booking.id))
    .sort((a, b) => String(rows.get(b.id).eventAt || '').localeCompare(String(rows.get(a.id).eventAt || '')));
  return {
    asOf: { utc: now.toISOString(), localDate: today, timezone: 'America/Chicago' },
    upcomingJobs: {
      total: upcoming.length,
      limit: UPCOMING_LIMIT,
      truncated: upcoming.length > UPCOMING_LIMIT,
      jobs: upcoming.slice(0, UPCOMING_LIMIT).map(formatJob),
    },
    recentFinancialJobs: {
      total: financialBookings.length,
      limit: FINANCIAL_LIMIT,
      truncated: financialBookings.length > FINANCIAL_LIMIT,
      jobs: financialBookings.slice(0, FINANCIAL_LIMIT).map(formatJob),
    },
    jobsWithUnknownDate: candidates.filter(booking => !parseIsoCalendarDate(dateOf(booking)))
      .slice(0, 10).map(formatJob),
    dataLimits: 'Bounded booking lists. Excludes only flagged tests; unflagged historical work is not independently verified as real demand. Missing or omitted rows do not prove a job does not exist.',
  };
}
