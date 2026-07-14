import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';
import { MIN_PRETAX_BOOKING_BY_ZONE } from '../_source-of-truth.js';
import { loadLedgerFirstFinanceRows } from './_finance-ledger.js';

const DEFAULT_ASSUMPTIONS = Object.freeze({
  reserveRate: 0.05,
  processingRate: 0.029,
  processingFixedCents: 30,
  annualOperatingExpensesCents: 350000,
  baseAddOnAttachmentRate: 0.30,
  baseRepeatCustomerRate: 0.20,
  baseCancellationRate: 0.05,
});

const MIN_PROFITABLE_TICKET_CENTS = MIN_PRETAX_BOOKING_BY_ZONE.austin_core;

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const sb = getSupabase();
  const period = normalizePeriod(req.query.period);
  const range = getPeriodRange(period);
  const cacCents = dollarsToCents(req.query.cacDollars ?? req.query.cac);
  const opexMonthlyCents = dollarsToCents(req.query.opexMonthlyDollars ?? req.query.opexMonthly);
  const annualOpexCents = opexMonthlyCents > 0 ? opexMonthlyCents * 12 : DEFAULT_ASSUMPTIONS.annualOperatingExpensesCents;

  let finance;
  try {
    finance = await loadLedgerFirstFinanceRows(sb, range);
  } catch (error) {
    console.error('Financial dashboard ledger load error:', error);
    return res.status(500).json({ error: 'Failed to load financial dashboard data' });
  }

  const financeRows = finance.rows || [];
  const rows = financeRows.filter(row => row.status === 'completed');
  const cancellationRows = financeRows.filter(row => row.cancellationEarnings);
  const bookingIds = rows.map(row => row.bookingId).filter(Boolean);
  const issueBookingIds = await loadIssueBookingIds(sb, bookingIds);
  const itemMetrics = await loadBookingItemMetrics(sb, bookingIds);
  const contractorTax = await loadContractorTaxYear(sb);
  const clawbacks = await loadOpenClawbacks(sb);
  const assemblecashMetrics = await loadAssembleCashMetrics(sb, range);
  const completedJobs = rows.length;
  const grossCustomerRevenue = sum(financeRows, row => row.charged);
  const refunds = sum(financeRows, row => row.refund);
  const cancellationRefunds = sum(cancellationRows, row => row.refund);
  const refundedJobs = rows.filter(row => Number(row.refund || 0) > 0 || row.isRefunded).length;
  for (const row of rows) {
    if ((Number(row.refund || 0) > 0 || row.isRefunded) && row.bookingId) issueBookingIds.add(row.bookingId);
  }
  const customerRevenue = sum(financeRows, row => row.netCharged);
  const completedCustomerRevenue = sum(rows, row => row.netCharged);
  const cancellationCustomerRevenue = sum(cancellationRows, row => row.netCharged);
  const cancellationEaserEarnings = sum(cancellationRows, row => payoutForProfit(row));
  const salesTaxCollected = sum(financeRows, row => row.taxCollected); // pass-through liability — never profit
  const processingFees = sum(financeRows, row => row.stripeFee); // actual Stripe fee when captured (migration 011), else canonical estimate
  const easerPayouts = sum(financeRows, row => payoutForProfit(row));
  const platformGrossProfit = customerRevenue - salesTaxCollected - processingFees - easerPayouts;
  const completedPlatformGrossProfit = sum(rows, row => Number(row.netCharged || 0)
    - Number(row.taxCollected || 0)
    - Number(row.stripeFee || 0)
    - payoutForProfit(row));
  const reworkRefundReserve = Math.round(completedCustomerRevenue * DEFAULT_ASSUMPTIONS.reserveRate);
  const operatingExpenses = periodOperatingExpenses(period, annualOpexCents);
  const estimatedNetOperatingProfit = platformGrossProfit - reworkRefundReserve - operatingExpenses - cacCents;

  let activeEasers = 0;
  try {
    const { count } = await sb
      .from('profiles')
      .select('id', { count: 'exact', head: true })
      .eq('role', 'assembler')
      .eq('status', 'active');
    activeEasers = count || 0;
  } catch (error) {
    console.warn('Financial dashboard active Easer count skipped:', error?.message || error);
  }

  const grossProfitPerJob = completedJobs ? Math.round(completedPlatformGrossProfit / completedJobs) : 0;
  const averageJobValue = completedJobs ? Math.round(completedCustomerRevenue / completedJobs) : 0;
  const grossMarginPct = customerRevenue > 0 ? platformGrossProfit / customerRevenue : 0;
  const netProfitPct = customerRevenue > 0 ? estimatedNetOperatingProfit / customerRevenue : 0;
  const revenuePerActiveEaser = activeEasers > 0 ? Math.round(customerRevenue / activeEasers) : 0;
  const repeatCustomerStats = getRepeatCustomerStats(rows);
  const refundReworkRate = completedJobs > 0 ? issueBookingIds.size / completedJobs : 0;
  const hasRealAddOnData = itemMetrics.persistedRows > 0;
  const addOnAttachmentRate = hasRealAddOnData
    ? (completedJobs > 0 ? itemMetrics.completedJobsWithAddOns / completedJobs : 0)
    : DEFAULT_ASSUMPTIONS.baseAddOnAttachmentRate;
  const averageAddOnValue = itemMetrics.completedJobsWithAddOns > 0
    ? Math.round(itemMetrics.totalAddOnRevenue / itemMetrics.completedJobsWithAddOns)
    : 0;
  const bundledJobs = rows.filter(row => !!row.bundleSlug).length;
  const bundleAttachRate = completedJobs > 0 ? bundledJobs / completedJobs : 0;
  const bundleAverageOrderValue = bundledJobs > 0
    ? Math.round(sum(rows.filter(row => !!row.bundleSlug), row => row.netCharged) / bundledJobs)
    : 0;
  const serviceProfitability = buildServiceProfitability(rows, itemMetrics);
  const expansionRows = period === 'all' ? financeRows : await loadExpansionRows(sb);
  const expansionReadiness = await buildExpansionReadiness(sb, expansionRows, activeEasers);

  const ledger = financeRows
    .slice()
    .sort((a, b) => String(b.eventAt || b.date || '').localeCompare(String(a.eventAt || a.date || '')))
    .slice(0, 100)
    .map(row => {
      const processingFee = Number(row.stripeFee || 0); // actual fee (migration 011) or canonical estimate — same source as the aggregate
      const easerPayout = payoutForProfit(row);
      const netCustomerRevenue = Number(row.netCharged || 0);
      const salesTax = Number(row.taxCollected || 0); // pass-through liability — excluded from profit
      return {
        bookingId: row.bookingId,
        status: row.status,
        eventType: row.eventType,
        eventAt: row.eventAt,
        ref: row.ref,
        completedAt: row.completedAt,
        cancelledAt: row.cancelledAt,
        date: row.date,
        service: row.service || 'Other',
        customerName: row.customerName || null,
        customerEmail: row.customerEmail || null,
        easerName: row.assemblerName || null,
        charged: row.charged,
        refund: row.refund,
        customerRevenue: netCustomerRevenue,
        salesTax,
        processingFee,
        easerPayout,
        bundleSlug: row.bundleSlug || null,
        assemblecashRedeemedCents: Number(row.assemblecashRedeemedCents || 0),
        platformGrossProfit: netCustomerRevenue - salesTax - processingFee - easerPayout,
        payoutStatus: row.payoutStatus || (row.paidOut ? 'paid' : 'pending'),
        dataSource: row.hasLedger ? 'ledger' : 'booking',
      };
    });

  return res.status(200).json({
    period,
    range,
    assumptions: {
      ...DEFAULT_ASSUMPTIONS,
      cacCents,
      processingFeeLabel: 'Estimated at 2.9% + $0.30 per captured transaction',
      annualOperatingExpensesCents: annualOpexCents,
      operatingExpenseLabel: opexMonthlyCents > 0
        ? `$${Math.round(opexMonthlyCents / 100).toLocaleString('en-US')}/mo (owner-entered) allocated to selected period`
        : 'Default $3,500/yr — enter your real monthly opex for an accurate net',
      launchMinimums: MIN_PRETAX_BOOKING_BY_ZONE,
    },
    labels: {
      customerRevenue: 'actual',
      refunds: 'actual',
      refundedJobs: 'actual',
      repeatCustomerRate: repeatCustomerStats.source,
      addOnAttachmentRate: hasRealAddOnData ? 'actual_booking_items' : 'assumption_until_booking_items_exist',
      averageAddOnValue: hasRealAddOnData ? 'actual_booking_items' : 'missing_data',
      bundleAttachRate: 'actual_completed_bookings_with_bundle_slug',
      refundReworkRate: 'actual_refunds_plus_damage_claims_when_evidence_exists',
      easerPayouts: 'actual_or_pending_due',
      cancellationEaserEarnings: 'actual_or_pending_due_from_captured_cancellation_fees',
      assemblecashLiability: assemblecashMetrics.available ? 'actual_rewards_ledger' : 'missing_data',
      processingFees: 'estimated',
      platformGrossProfit: 'estimated',
      reworkRefundReserve: 'estimated',
      operatingExpenses: 'estimated',
      cac: cacCents > 0 ? 'estimated' : 'missing_data',
      estimatedNetOperatingProfit: 'estimated',
    },
    summary: {
      completedJobs,
      cancellationEarningEvents: cancellationRows.length,
      cancellationCustomerRevenue,
      cancellationEaserEarnings,
      cancellationRefunds,
      grossCustomerRevenue,
      refunds,
      refundedJobs,
      customerRevenue,
      salesTaxCollected,
      processingFees,
      easerPayouts,
      platformGrossProfit,
      reworkRefundReserve,
      operatingExpenses,
      cac: cacCents,
      estimatedNetOperatingProfit,
      grossProfitPerJob,
      averageJobValue,
      grossMarginPct,
      netProfitPct,
      activeEasers,
      revenuePerActiveEaser,
      repeatCustomers: repeatCustomerStats.repeatCustomers,
      totalCustomers: repeatCustomerStats.totalCustomers,
      repeatCustomerRate: repeatCustomerStats.rate,
      addOnAttachmentRate,
      completedJobsWithAddOns: itemMetrics.completedJobsWithAddOns,
      totalAddOnRevenue: itemMetrics.totalAddOnRevenue,
      averageAddOnValue,
      bundledJobs,
      bundleAttachRate,
      bundleAverageOrderValue,
      refundReworkJobs: issueBookingIds.size,
      refundReworkRate,
      assemblecashLiabilityCents: assemblecashMetrics.liabilityCents,
    },
    executiveOverview: {
      platformGrossProfitPerCompletedJob: grossProfitPerJob,
      totalCustomerRevenue: customerRevenue,
      completedJobs,
      cancellationEarningEvents: cancellationRows.length,
      cancellationCustomerRevenue,
      cancellationEaserEarnings,
      averageJobValue,
      platformGrossProfit,
      estimatedNetOperatingProfit,
      addOnAttachmentRate,
      addOnAttachmentRateSource: hasRealAddOnData ? 'actual_booking_items' : 'assumption',
      totalAddOnRevenue: itemMetrics.totalAddOnRevenue,
      averageAddOnValue,
      bundledJobs,
      bundleAttachRate,
      bundleAverageOrderValue,
      repeatCustomerRate: repeatCustomerStats.rate,
      repeatCustomerRateSource: repeatCustomerStats.source,
      refundReworkRate,
      refundReworkRateSource: 'refunds_and_damage_claim_evidence',
      activeEasers,
      assemblecashLiabilityCents: assemblecashMetrics.liabilityCents,
    },
    serviceProfitability,
    contractorTax,
    clawbacks,
    assemblecash: assemblecashMetrics,
    addOnMetrics: {
      tableAvailable: itemMetrics.tableAvailable,
      persistedRows: itemMetrics.persistedRows,
      hasRealData: hasRealAddOnData,
      completedJobsWithAddOns: itemMetrics.completedJobsWithAddOns,
      totalAddOnRevenue: itemMetrics.totalAddOnRevenue,
      totalBaseServiceRevenue: itemMetrics.totalBaseServiceRevenue,
      averageAddOnValue,
      attachmentRate: addOnAttachmentRate,
      source: hasRealAddOnData ? 'actual_booking_items' : (itemMetrics.tableAvailable ? 'assumption_no_booking_items_yet' : 'assumption_booking_items_unavailable'),
    },
    expansionReadiness,
    ledger,
    reconciliation: finance.reconciliation,
  });
}

async function loadAssembleCashMetrics(sb, range = {}) {
  const empty = {
    available: false,
    liabilityCents: 0,
    earnedCentsInPeriod: 0,
    redeemedCentsInPeriod: 0,
    activeCustomers: 0,
  };
  try {
    const { data, error } = await sb
      .from('assemblecash_ledger')
      .select('customer_email, amount_earned_cents, amount_redeemed_cents, status, expires_at, created_at');
    if (error) {
      console.warn('AssembleCash metrics unavailable:', error.message || error);
      return empty;
    }
    const now = Date.now();
    const fromMs = range.from ? Date.parse(range.from) : null;
    const toMs = range.to ? Date.parse(range.to + 'T23:59:59Z') : null;
    const byEmail = new Map();
    let earnedCentsInPeriod = 0;
    let redeemedCentsInPeriod = 0;

    for (const row of data || []) {
      const email = String(row.customer_email || '').trim().toLowerCase();
      if (!email) continue;
      if (!byEmail.has(email)) byEmail.set(email, 0);

      const createdMs = Date.parse(row.created_at || '');
      const inRange = (!fromMs || createdMs >= fromMs) && (!toMs || createdMs <= toMs);
      const earned = Math.max(0, Number(row.amount_earned_cents || 0));
      const redeemed = Math.max(0, Number(row.amount_redeemed_cents || 0));

      if (row.status === 'available' && earned > 0) {
        const expiryMs = row.expires_at ? Date.parse(row.expires_at) : null;
        if (!expiryMs || expiryMs > now) {
          byEmail.set(email, byEmail.get(email) + earned);
        }
      }
      if (row.status === 'redeemed' && redeemed > 0) {
        byEmail.set(email, byEmail.get(email) - redeemed);
      }
      if (inRange && earned > 0) earnedCentsInPeriod += earned;
      if (inRange && redeemed > 0) redeemedCentsInPeriod += redeemed;
    }

    let liabilityCents = 0;
    let activeCustomers = 0;
    for (const value of byEmail.values()) {
      const balance = Math.max(0, Math.round(Number(value) || 0));
      liabilityCents += balance;
      if (balance > 0) activeCustomers += 1;
    }

    return {
      available: true,
      liabilityCents,
      earnedCentsInPeriod,
      redeemedCentsInPeriod,
      activeCustomers,
    };
  } catch (error) {
    console.warn('AssembleCash metrics skipped:', error?.message || error);
    return empty;
  }
}

function normalizePeriod(value) {
  const period = String(value || 'year').toLowerCase();
  return ['today', 'week', 'month', 'year', 'all'].includes(period) ? period : 'year';
}

function getPeriodRange(period) {
  if (period === 'all') return {};
  const now = new Date();
  const start = new Date(now);
  if (period === 'today') {
    start.setHours(0, 0, 0, 0);
  } else if (period === 'week') {
    start.setDate(now.getDate() - 6);
    start.setHours(0, 0, 0, 0);
  } else if (period === 'month') {
    start.setDate(1);
    start.setHours(0, 0, 0, 0);
  } else {
    start.setMonth(0, 1);
    start.setHours(0, 0, 0, 0);
  }
  return { from: start.toISOString(), to: now.toISOString().slice(0, 10) };
}

function periodOperatingExpenses(period, annualOverrideCents) {
  const annual = (Number.isFinite(annualOverrideCents) && annualOverrideCents > 0)
    ? annualOverrideCents
    : DEFAULT_ASSUMPTIONS.annualOperatingExpensesCents;
  if (period === 'today') return Math.round(annual / 365);
  if (period === 'week') return Math.round(annual / 52);
  if (period === 'month') return Math.round(annual / 12);
  return annual;
}

async function loadExpansionRows(sb) {
  try {
    const finance = await loadLedgerFirstFinanceRows(sb, {});
    return finance.rows || [];
  } catch (error) {
    console.warn('Expansion readiness all-time finance skipped:', error?.message || error);
    return [];
  }
}

async function buildExpansionReadiness(sb, rows, activeEasers) {
  const financeRows = rows || [];
  const completedRows = financeRows.filter(row => row.status === 'completed');
  const completedJobs = completedRows.length;
  const bookingIds = completedRows.map(row => row.bookingId).filter(Boolean);
  const damageClaimBookingIds = await loadIssueBookingIds(sb, bookingIds);
  const refundedJobs = completedRows.filter(row => Number(row.refund || 0) > 0 || row.isRefunded).length;
  const customerRevenue = sum(financeRows, row => row.netCharged);
  const completedCustomerRevenue = sum(completedRows, row => row.netCharged);
  const salesTaxCollected = sum(financeRows, row => row.taxCollected); // pass-through liability — never profit
  const processingFees = sum(financeRows, row => row.stripeFee); // actual Stripe fee when captured (migration 011), else canonical estimate
  const easerPayouts = sum(financeRows, row => payoutForProfit(row));
  const platformGrossProfit = customerRevenue - salesTaxCollected - processingFees - easerPayouts;
  const reworkRefundReserve = Math.round(completedCustomerRevenue * DEFAULT_ASSUMPTIONS.reserveRate);
  const estimatedOperatingProfit = platformGrossProfit - reworkRefundReserve - periodOperatingExpenses('all');
  const refundRate = completedJobs > 0 ? refundedJobs / completedJobs : 0;
  const reworkRate = completedJobs > 0 ? damageClaimBookingIds.size / completedJobs : 0;
  const ratingStats = await loadCustomerRatingStats(sb);

  const checks = [
    {
      key: 'completed_jobs',
      label: '250+ completed jobs',
      value: completedJobs,
      target: 250,
      passed: completedJobs >= 250,
      display: String(completedJobs),
    },
    {
      key: 'customer_rating',
      label: '4.8+ customer rating',
      value: ratingStats.averageRating,
      target: 4.8,
      passed: ratingStats.averageRating >= 4.8,
      display: ratingStats.count ? ratingStats.averageRating.toFixed(2) : 'No reviews',
    },
    {
      key: 'operating_profit',
      label: 'Positive operating profit',
      value: estimatedOperatingProfit,
      target: 1,
      passed: estimatedOperatingProfit > 0,
      display: centsLabel(estimatedOperatingProfit),
    },
    {
      key: 'refund_rate',
      label: 'Refund rate under 2%',
      value: refundRate,
      target: 0.02,
      passed: refundRate < 0.02,
      display: percentLabel(refundRate),
    },
    {
      key: 'rework_rate',
      label: 'Rework rate under 5%',
      value: reworkRate,
      target: 0.05,
      passed: reworkRate < 0.05,
      display: percentLabel(reworkRate),
    },
    {
      key: 'active_easers',
      label: '10+ active Easers',
      value: activeEasers,
      target: 10,
      passed: activeEasers >= 10,
      display: String(activeEasers || 0),
    },
  ];

  return {
    scope: 'all_time',
    status: checks.every(check => check.passed) ? 'READY FOR EXPANSION' : 'NOT READY FOR EXPANSION',
    ready: checks.every(check => check.passed),
    completedJobs,
    customerRating: ratingStats.averageRating,
    reviewCount: ratingStats.count,
    activeEasers,
    estimatedOperatingProfit,
    refundRate,
    reworkRate,
    checks,
  };
}

async function loadCustomerRatingStats(sb) {
  try {
    let query = sb.from('reviews').select('rating').eq('approved', true);
    let { data, error } = await query;
    if (error) {
      const fallback = await sb.from('reviews').select('rating');
      data = fallback.data;
      error = fallback.error;
    }
    if (error) throw error;
    const ratings = (data || []).map(row => Number(row.rating || 0)).filter(rating => rating > 0);
    const total = ratings.reduce((sumRating, rating) => sumRating + rating, 0);
    return {
      count: ratings.length,
      averageRating: ratings.length ? total / ratings.length : 0,
    };
  } catch (error) {
    console.warn('Expansion readiness customer rating skipped:', error?.message || error);
    return { count: 0, averageRating: 0 };
  }
}

function centsLabel(cents) {
  const n = Number(cents || 0);
  const prefix = n < 0 ? '-$' : '$';
  return prefix + (Math.abs(n) / 100).toFixed(2);
}

function percentLabel(value) {
  return (Number(value || 0) * 100).toFixed(1) + '%';
}

function estimateProcessingFee(cents) {
  const amount = Number(cents || 0);
  return amount > 0
    ? Math.round(amount * DEFAULT_ASSUMPTIONS.processingRate) + DEFAULT_ASSUMPTIONS.processingFixedCents
    : 0;
}

async function loadIssueBookingIds(sb, bookingIds) {
  const issueIds = new Set();
  if (!bookingIds.length) return issueIds;

  try {
    const { data, error } = await sb
      .from('booking_evidence')
      .select('booking_id')
      .in('booking_id', bookingIds)
      .eq('evidence_type', 'damage_claim');
    if (!error) {
      for (const row of data || []) {
        if (row.booking_id) issueIds.add(row.booking_id);
      }
    }
  } catch (error) {
    console.warn('Financial dashboard issue evidence skipped:', error?.message || error);
  }

  return issueIds;
}

async function loadBookingItemMetrics(sb, bookingIds) {
  const empty = {
    tableAvailable: false,
    persistedRows: 0,
    rows: [],
    byBookingId: new Map(),
    completedJobsWithAddOns: 0,
    totalAddOnRevenue: 0,
    totalBaseServiceRevenue: 0,
  };
  if (!bookingIds.length) return { ...empty, tableAvailable: true };

  try {
    const { data, error } = await sb
      .from('booking_items')
      .select('booking_id, service_category, service_name, item_name, item_price, quantity, is_add_on, add_on_name, add_on_price, line_total, add_on_revenue, base_service_revenue')
      .in('booking_id', bookingIds);

    if (error) {
      console.warn('Financial dashboard booking_items unavailable:', error.message || error);
      return empty;
    }

    const rows = data || [];
    const byBookingId = new Map();
    let totalAddOnRevenue = 0;
    let totalBaseServiceRevenue = 0;

    for (const item of rows) {
      const bookingId = item.booking_id;
      if (!bookingId) continue;
      if (!byBookingId.has(bookingId)) byBookingId.set(bookingId, []);
      byBookingId.get(bookingId).push(item);
      totalAddOnRevenue += Number(item.add_on_revenue || (item.is_add_on ? item.line_total : 0) || 0);
      totalBaseServiceRevenue += Number(item.base_service_revenue || (!item.is_add_on ? item.line_total : 0) || 0);
    }

    let completedJobsWithAddOns = 0;
    for (const items of byBookingId.values()) {
      if (items.some(item => item.is_add_on || Number(item.add_on_revenue || 0) > 0)) completedJobsWithAddOns++;
    }

    return {
      tableAvailable: true,
      persistedRows: rows.length,
      rows,
      byBookingId,
      completedJobsWithAddOns,
      totalAddOnRevenue,
      totalBaseServiceRevenue,
    };
  } catch (error) {
    console.warn('Financial dashboard booking_items skipped:', error?.message || error);
    return empty;
  }
}

// Open clawbacks = refunds issued after the Easer was already paid (recorded by
// refund.js as financial_event_audit 'clawback_required'). Money owed back to the
// platform. Read-only here; degrades gracefully if the audit table is missing.
async function loadOpenClawbacks(sb) {
  try {
    const { data, error } = await sb
      .from('financial_event_audit')
      .select('booking_id, refund_id, metadata, processed_at, status')
      .eq('event_type', 'clawback_required')
      .order('processed_at', { ascending: false })
      .limit(100);
    if (error) {
      console.warn('Clawbacks load unavailable:', error.message || error);
      return { available: false, items: [], totalOwedCents: 0, count: 0 };
    }
    const items = (data || [])
      .filter(r => (r.status || 'open') !== 'resolved')
      .map(r => {
        const m = r.metadata || {};
        return {
          bookingRef: m.ref || null,
          assemblerName: m.assemblerName || 'Easer',
          clawbackOwedCents: Number(m.clawbackOwedCents || 0),
          refundAmountCents: Number(m.refundAmountCents || 0),
          at: r.processed_at,
        };
      });
    return {
      available: true,
      items,
      totalOwedCents: items.reduce((s, i) => s + i.clawbackOwedCents, 0),
      count: items.length,
    };
  } catch (error) {
    console.warn('Clawbacks load skipped:', error?.message || error);
    return { available: false, items: [], totalOwedCents: 0, count: 0 };
  }
}

// Calendar-year payouts per Easer from the immutable ledger — drives 1099-NEC
// tracking (current $2,000 threshold for payments made after 2025-12-31).
// Read-only; stores no TIN/SSN. Graceful if the
// ledger table is unavailable.
async function loadContractorTaxYear(sb) {
  const year = new Date().getFullYear();
  const yearStart = new Date(Date.UTC(year, 0, 1)).toISOString();
  const THRESHOLD_CENTS = 200000;
  try {
    const { data, error } = await sb
      .from('payout_ledger')
      .select('assembler_id, assembler_name, payout_amount, recorded_at')
      .gte('recorded_at', yearStart);
    if (error) {
      console.warn('Contractor tax payout_ledger unavailable:', error.message || error);
      return { year, thresholdCents: THRESHOLD_CENTS, available: false, easers: [], countNeeding1099: 0 };
    }
    const byEaser = new Map();
    for (const row of data || []) {
      const id = row.assembler_id;
      if (!id) continue;
      if (!byEaser.has(id)) byEaser.set(id, { assemblerId: id, name: row.assembler_name || 'Easer', ytdPaidCents: 0, payoutCount: 0 });
      const e = byEaser.get(id);
      e.ytdPaidCents += Number(row.payout_amount || 0);
      e.payoutCount += 1;
    }
    const easers = Array.from(byEaser.values())
      .map(e => ({ ...e, needs1099: e.ytdPaidCents >= THRESHOLD_CENTS }))
      .sort((a, b) => b.ytdPaidCents - a.ytdPaidCents);
    return {
      year,
      thresholdCents: THRESHOLD_CENTS,
      available: true,
      easers,
      countNeeding1099: easers.filter(e => e.needs1099).length,
    };
  } catch (error) {
    console.warn('Contractor tax year load skipped:', error?.message || error);
    return { year, thresholdCents: THRESHOLD_CENTS, available: false, easers: [], countNeeding1099: 0 };
  }
}

function getRepeatCustomerStats(rows) {
  const byCustomer = new Map();
  for (const row of rows || []) {
    const key = customerKey(row);
    if (!key) continue;
    byCustomer.set(key, (byCustomer.get(key) || 0) + 1);
  }
  const totalCustomers = byCustomer.size;
  const repeatCustomers = Array.from(byCustomer.values()).filter(count => count > 1).length;
  return {
    totalCustomers,
    repeatCustomers,
    rate: totalCustomers > 0 ? repeatCustomers / totalCustomers : DEFAULT_ASSUMPTIONS.baseRepeatCustomerRate,
    source: totalCustomers > 0 ? 'actual_completed_customer_history_in_period' : 'assumption_no_completed_customer_history',
  };
}

function customerKey(row) {
  const email = String(row.customerEmail || '').trim().toLowerCase();
  if (email) return `email:${email}`;
  const name = String(row.customerName || '').trim().toLowerCase();
  return name ? `name:${name}` : '';
}

function buildServiceProfitability(rows, itemMetrics = {}) {
  const byService = new Map();
  const itemsByBooking = itemMetrics.byBookingId || new Map();

  for (const row of rows || []) {
    const bookingItems = row.bookingId ? (itemsByBooking.get(row.bookingId) || []) : [];
    if (bookingItems.length) {
      addBookingItemServiceAllocations(byService, row, bookingItems);
      continue;
    }

    const services = splitServiceNames(row.service);
    const count = services.length || 1;
    const chargedShare = Math.round(Number(row.charged || 0) / count);
    const revenueShare = Math.round(Number(row.netCharged || 0) / count);
    const processingShare = Math.round(Number(row.stripeFee || 0) / count);
    const payoutShare = Math.round(payoutForProfit(row) / count);
    const refundShare = Math.round(Number(row.refund || 0) / count);
    const taxShare = Math.round(Number(row.taxCollected || 0) / count);

    for (const serviceName of services) {
      if (!byService.has(serviceName)) {
        byService.set(serviceName, {
          serviceName,
          completedJobs: 0,
          charged: 0,
          revenue: 0,
          salesTax: 0,
          baseServiceRevenue: 0,
          addOnRevenue: 0,
          jobsWithAddOns: 0,
          processingFees: 0,
          easerPayouts: 0,
          refunds: 0,
        });
      }
      const item = byService.get(serviceName);
      item.completedJobs += 1;
      item.charged += chargedShare;
      item.revenue += revenueShare;
      item.salesTax += taxShare;
      item.baseServiceRevenue += revenueShare;
      item.processingFees += processingShare;
      item.easerPayouts += payoutShare;
      item.refunds += refundShare;
    }
  }

  return Array.from(byService.values())
    .map(item => {
      const platformGrossProfit = item.revenue - (item.salesTax || 0) - item.processingFees - item.easerPayouts;
      const reworkRefundReserve = Math.round(item.revenue * DEFAULT_ASSUMPTIONS.reserveRate);
      const netContributionEstimate = platformGrossProfit - reworkRefundReserve;
      const averageTicket = item.completedJobs ? Math.round(item.revenue / item.completedJobs) : 0;
      const platformGrossPerJob = item.completedJobs ? Math.round(platformGrossProfit / item.completedJobs) : 0;
      return {
        ...item,
        averageTicket,
        platformGrossProfit,
        platformGrossPerJob,
        reworkRefundReserve,
        netContributionEstimate,
        addOnAttachmentRate: item.completedJobs ? item.jobsWithAddOns / item.completedJobs : 0,
        averageAddOnValue: item.jobsWithAddOns ? Math.round(item.addOnRevenue / item.jobsWithAddOns) : 0,
        recommendedAction: recommendServiceAction({
          serviceName: item.serviceName,
          completedJobs: item.completedJobs,
          averageTicket,
          platformGrossPerJob,
          netContributionEstimate,
        }),
      };
    })
    .sort((a, b) => b.platformGrossProfit - a.platformGrossProfit);
}

function addBookingItemServiceAllocations(byService, row, bookingItems) {
  const grouped = new Map();
  let totalLineRevenue = 0;

  for (const item of bookingItems) {
    const serviceName = String(item.service_category || item.service_name || row.service || 'Other').trim() || 'Other';
    const lineTotal = Number(item.line_total || 0);
    const addOnRevenue = Number(item.add_on_revenue || (item.is_add_on ? lineTotal : 0) || 0);
    const baseServiceRevenue = Number(item.base_service_revenue || (!item.is_add_on ? lineTotal : 0) || 0);

    totalLineRevenue += lineTotal;
    if (!grouped.has(serviceName)) {
      grouped.set(serviceName, {
        serviceName,
        lineTotal: 0,
        baseServiceRevenue: 0,
        addOnRevenue: 0,
        hasAddOn: false,
      });
    }
    const group = grouped.get(serviceName);
    group.lineTotal += lineTotal;
    group.baseServiceRevenue += baseServiceRevenue;
    group.addOnRevenue += addOnRevenue;
    if (addOnRevenue > 0 || item.is_add_on) group.hasAddOn = true;
  }

  const groups = Array.from(grouped.values());
  const fallbackShare = groups.length ? 1 / groups.length : 1;

  for (const group of groups) {
    const ratio = totalLineRevenue > 0 ? group.lineTotal / totalLineRevenue : fallbackShare;
    const chargedShare = Math.round(Number(row.charged || 0) * ratio);
    const revenueShare = Math.round(Number(row.netCharged || 0) * ratio);
    const processingShare = Math.round(Number(row.stripeFee || 0) * ratio);
    const payoutShare = Math.round(payoutForProfit(row) * ratio);
    const refundShare = Math.round(Number(row.refund || 0) * ratio);
    const taxShare = Math.round(Number(row.taxCollected || 0) * ratio);

    if (!byService.has(group.serviceName)) {
      byService.set(group.serviceName, {
        serviceName: group.serviceName,
        completedJobs: 0,
        charged: 0,
        revenue: 0,
        salesTax: 0,
        baseServiceRevenue: 0,
        addOnRevenue: 0,
        jobsWithAddOns: 0,
        processingFees: 0,
        easerPayouts: 0,
        refunds: 0,
      });
    }
    const item = byService.get(group.serviceName);
    item.completedJobs += 1;
    item.charged += chargedShare;
    item.revenue += revenueShare;
    item.salesTax += taxShare;
    item.baseServiceRevenue += group.baseServiceRevenue;
    item.addOnRevenue += group.addOnRevenue;
    item.jobsWithAddOns += group.hasAddOn ? 1 : 0;
    item.processingFees += processingShare;
    item.easerPayouts += payoutShare;
    item.refunds += refundShare;
  }
}

function splitServiceNames(service) {
  const text = String(service || 'Other').trim();
  if (!text) return ['Other'];
  const parts = [];
  let current = '';
  let depth = 0;
  for (const char of text) {
    if (char === '(') depth++;
    if (char === ')') depth = Math.max(0, depth - 1);
    if (char === ',' && depth === 0) {
      pushServicePart(parts, current);
      current = '';
    } else {
      current += char;
    }
  }
  pushServicePart(parts, current);
  return parts.length ? Array.from(new Set(parts)) : ['Other'];
}

function pushServicePart(parts, value) {
  const service = String(value || '')
    .replace(/\s*\([^)]*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (service) parts.push(service);
}

function recommendServiceAction({ serviceName, completedJobs, averageTicket, platformGrossPerJob, netContributionEstimate }) {
  const name = String(serviceName || '').toLowerCase();
  if (name.includes('other') || name.includes('custom')) return 'Custom Quote';
  if (netContributionEstimate <= 0 && averageTicket < MIN_PROFITABLE_TICKET_CENTS) return 'Add-On Only';
  if (platformGrossPerJob < 3000 && averageTicket < MIN_PROFITABLE_TICKET_CENTS) return 'Bundle';
  if (platformGrossPerJob < 3500) return 'Raise Price';
  if (completedJobs < 2 && averageTicket < MIN_PROFITABLE_TICKET_CENTS) return 'Bundle';
  return 'Keep';
}

function payoutForProfit(row) {
  if (row.paidOut) return Number(row.payoutAmount || 0);
  // A refund hold does not erase contractor earnings. Until the owner reviews
  // the job, the canonical amount remains a potential liability and must stay
  // in profitability and reserve calculations.
  return Number(row.owed || 0);
}

function dollarsToCents(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : 0;
}

function sum(rows, fn) {
  return (rows || []).reduce((total, row) => total + Number(fn(row) || 0), 0);
}
