import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';
import { loadLedgerFirstFinanceRows } from './_finance-ledger.js';

const DEFAULT_ASSUMPTIONS = Object.freeze({
  reserveRate: 0.02,
  processingRate: 0.029,
  processingFixedCents: 30,
  annualOperatingExpensesCents: 350000,
  baseAddOnAttachmentRate: 0.30,
  baseRepeatCustomerRate: 0.20,
  baseCancellationRate: 0.05,
});

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const sb = getSupabase();
  const period = normalizePeriod(req.query.period);
  const range = getPeriodRange(period);
  const cacCents = dollarsToCents(req.query.cacDollars ?? req.query.cac);

  let finance;
  try {
    finance = await loadLedgerFirstFinanceRows(sb, range);
  } catch (error) {
    console.error('Financial dashboard ledger load error:', error);
    return res.status(500).json({ error: 'Failed to load financial dashboard data' });
  }

  const rows = finance.rows || [];
  const bookingIds = rows.map(row => row.bookingId).filter(Boolean);
  const issueBookingIds = await loadIssueBookingIds(sb, bookingIds);
  const itemMetrics = await loadBookingItemMetrics(sb, bookingIds);
  const completedJobs = rows.length;
  const grossCustomerRevenue = sum(rows, row => row.charged);
  const refunds = sum(rows, row => row.refund);
  const refundedJobs = rows.filter(row => Number(row.refund || 0) > 0 || row.isRefunded).length;
  for (const row of rows) {
    if ((Number(row.refund || 0) > 0 || row.isRefunded) && row.bookingId) issueBookingIds.add(row.bookingId);
  }
  const customerRevenue = sum(rows, row => row.netCharged);
  const salesTaxCollected = sum(rows, row => row.taxCollected); // pass-through liability — never profit
  const processingFees = sum(rows, row => estimateProcessingFee(row.charged));
  const easerPayouts = sum(rows, row => payoutForProfit(row));
  const platformGrossProfit = customerRevenue - salesTaxCollected - processingFees - easerPayouts;
  const reworkRefundReserve = Math.round(customerRevenue * DEFAULT_ASSUMPTIONS.reserveRate);
  const operatingExpenses = periodOperatingExpenses(period);
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

  const grossProfitPerJob = completedJobs ? Math.round(platformGrossProfit / completedJobs) : 0;
  const averageJobValue = completedJobs ? Math.round(customerRevenue / completedJobs) : 0;
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
  const serviceProfitability = buildServiceProfitability(rows, itemMetrics);
  const expansionRows = period === 'all' ? rows : await loadExpansionRows(sb);
  const expansionReadiness = await buildExpansionReadiness(sb, expansionRows, activeEasers);

  const ledger = rows
    .slice()
    .sort((a, b) => String(b.completedAt || b.date || '').localeCompare(String(a.completedAt || a.date || '')))
    .slice(0, 100)
    .map(row => {
      const processingFee = estimateProcessingFee(row.charged);
      const easerPayout = payoutForProfit(row);
      const netCustomerRevenue = Number(row.netCharged || 0);
      return {
        bookingId: row.bookingId,
        ref: row.ref,
        completedAt: row.completedAt,
        date: row.date,
        service: row.service || 'Other',
        customerName: row.customerName || null,
        customerEmail: row.customerEmail || null,
        easerName: row.assemblerName || null,
        charged: row.charged,
        refund: row.refund,
        customerRevenue: netCustomerRevenue,
        processingFee,
        easerPayout,
        platformGrossProfit: netCustomerRevenue - processingFee - easerPayout,
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
      operatingExpenseLabel: '$3,500/year allocated to selected period',
    },
    labels: {
      customerRevenue: 'actual',
      refunds: 'actual',
      refundedJobs: 'actual',
      repeatCustomerRate: repeatCustomerStats.source,
      addOnAttachmentRate: hasRealAddOnData ? 'actual_booking_items' : 'assumption_until_booking_items_exist',
      averageAddOnValue: hasRealAddOnData ? 'actual_booking_items' : 'missing_data',
      refundReworkRate: 'actual_refunds_plus_damage_claims_when_evidence_exists',
      easerPayouts: 'actual_or_pending_due',
      processingFees: 'estimated',
      platformGrossProfit: 'estimated',
      reworkRefundReserve: 'estimated',
      operatingExpenses: 'estimated',
      cac: cacCents > 0 ? 'estimated' : 'missing_data',
      estimatedNetOperatingProfit: 'estimated',
    },
    summary: {
      completedJobs,
      grossCustomerRevenue,
      refunds,
      refundedJobs,
      customerRevenue,
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
      refundReworkJobs: issueBookingIds.size,
      refundReworkRate,
    },
    executiveOverview: {
      platformGrossProfitPerCompletedJob: grossProfitPerJob,
      totalCustomerRevenue: customerRevenue,
      completedJobs,
      averageJobValue,
      platformGrossProfit,
      estimatedNetOperatingProfit,
      addOnAttachmentRate,
      addOnAttachmentRateSource: hasRealAddOnData ? 'actual_booking_items' : 'assumption',
      totalAddOnRevenue: itemMetrics.totalAddOnRevenue,
      averageAddOnValue,
      repeatCustomerRate: repeatCustomerStats.rate,
      repeatCustomerRateSource: repeatCustomerStats.source,
      refundReworkRate,
      refundReworkRateSource: 'refunds_and_damage_claim_evidence',
      activeEasers,
    },
    serviceProfitability,
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

function periodOperatingExpenses(period) {
  const annual = DEFAULT_ASSUMPTIONS.annualOperatingExpensesCents;
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
  const completedJobs = rows.length;
  const bookingIds = rows.map(row => row.bookingId).filter(Boolean);
  const damageClaimBookingIds = await loadIssueBookingIds(sb, bookingIds);
  const refundedJobs = rows.filter(row => Number(row.refund || 0) > 0 || row.isRefunded).length;
  const customerRevenue = sum(rows, row => row.netCharged);
  const salesTaxCollected = sum(rows, row => row.taxCollected); // pass-through liability — never profit
  const processingFees = sum(rows, row => estimateProcessingFee(row.charged));
  const easerPayouts = sum(rows, row => payoutForProfit(row));
  const platformGrossProfit = customerRevenue - salesTaxCollected - processingFees - easerPayouts;
  const reworkRefundReserve = Math.round(customerRevenue * DEFAULT_ASSUMPTIONS.reserveRate);
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
    const processingShare = Math.round(estimateProcessingFee(row.charged) / count);
    const payoutShare = Math.round(payoutForProfit(row) / count);
    const refundShare = Math.round(Number(row.refund || 0) / count);

    for (const serviceName of services) {
      if (!byService.has(serviceName)) {
        byService.set(serviceName, {
          serviceName,
          completedJobs: 0,
          charged: 0,
          revenue: 0,
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
      item.baseServiceRevenue += revenueShare;
      item.processingFees += processingShare;
      item.easerPayouts += payoutShare;
      item.refunds += refundShare;
    }
  }

  return Array.from(byService.values())
    .map(item => {
      const platformGrossProfit = item.revenue - item.processingFees - item.easerPayouts;
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
    const processingShare = Math.round(estimateProcessingFee(row.charged) * ratio);
    const payoutShare = Math.round(payoutForProfit(row) * ratio);
    const refundShare = Math.round(Number(row.refund || 0) * ratio);

    if (!byService.has(group.serviceName)) {
      byService.set(group.serviceName, {
        serviceName: group.serviceName,
        completedJobs: 0,
        charged: 0,
        revenue: 0,
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
  if (netContributionEstimate <= 0 && averageTicket < 9900) return 'Add-On Only';
  if (platformGrossPerJob < 3000 && averageTicket < 9900) return 'Bundle';
  if (platformGrossPerJob < 3500) return 'Raise Price';
  if (completedJobs < 2 && averageTicket < 9900) return 'Bundle';
  return 'Keep';
}

function payoutForProfit(row) {
  if (row.paidOut) return Number(row.payoutAmount || 0);
  if (!row.isRefunded) return Number(row.owed || 0);
  return 0;
}

function dollarsToCents(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : 0;
}

function sum(rows, fn) {
  return (rows || []).reduce((total, row) => total + Number(fn(row) || 0), 0);
}
