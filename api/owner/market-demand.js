import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';
import { normalizeAssemblerProfile } from '../_assembler-state.js';
import { resolveMarketArea, knownMarketAreas } from '../_market-area.js';
import { TERMINAL_BOOKING_STATUSES } from '../_source-of-truth.js';
import { parseServiceLocation, normalizeServiceState } from '../_booking-location.js';
import { getEaserReadiness } from '../_easer-readiness.js';
import { EASER_READINESS_FIELDS } from '../_easer-readiness-select.js';

const ACTIVE_MARKETS = [{
  key: 'texas-statewide',
  label: 'Statewide Texas',
  city: 'Texas',
  state: 'TX',
  coverage: 'All valid Texas ZIP codes',
}];

const BOOKING_SELECT = [
  'id', 'ref', 'source', 'status', 'payment_status', 'customer_name',
  'customer_email', 'customer_phone', 'service', 'date', 'time', 'address',
  'service_city', 'service_state', 'service_zip', 'total_price',
  'needs_manual_dispatch', 'assembler_id', 'is_test_booking',
  'booking_attribution', 'created_at',
].join(', ');

const BOOKING_SELECT_WITHOUT_ATTRIBUTION = BOOKING_SELECT.replace(', booking_attribution', '');

const LEGACY_BOOKING_SELECT = [
  'id', 'ref', 'source', 'status', 'payment_status', 'customer_name',
  'customer_email', 'customer_phone', 'service', 'date', 'time', 'address',
  'total_price', 'needs_manual_dispatch', 'assembler_id', 'is_test_booking',
  'booking_attribution', 'created_at',
].join(', ');

const LEGACY_BOOKING_SELECT_WITHOUT_ATTRIBUTION = LEGACY_BOOKING_SELECT.replace(', booking_attribution', '');

export const EASER_SUPPLY_SELECT = [
  'id', 'full_name', 'city', 'state', 'zip', 'role', 'created_at',
  ...EASER_READINESS_FIELDS,
].join(', ');

export function createMarketDemandHandler(dependencies = {}) {
  const supabase = dependencies.getSupabase || getSupabase;
  const ownerAuthorized = dependencies.verifyOwner || verifyOwner;
  const readinessFor = dependencies.getEaserReadiness || getEaserReadiness;
  const now = dependencies.now || (() => new Date());
  return async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (!ownerAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const sb = supabase();
  const [requestsResult, bookingsResult, easersResult, waitlistResult] = await Promise.all([
    loadMarketRequests(sb),
    loadBookingDemand(sb),
    loadSupplyRows(sb, 'profiles', EASER_SUPPLY_SELECT),
    loadSupplyRows(sb, 'assembler_waitlist', 'id, name, city, state, zip, status, created_at'),
  ]);

  if (bookingsResult.error) {
    console.error('Market demand booking load failed:', bookingsResult.error);
    return res.status(500).json({ error: 'Failed to load booking demand' });
  }

  // The owner's own test bookings are not market demand. They were inflating
  // request counts, market rows, potential revenue and the conversion rate —
  // the same gap migration 094 closed for the summary emails and nowhere else.
  const allBookings = bookingsResult.data || [];
  const bookings = allBookings.filter(booking => booking.is_test_booking !== true);
  const excludedTestBookings = allBookings.length - bookings.length;
  const requests = requestsResult.data || [];
  // Conversion still has to see a test booking as "converted", or a request
  // that became one would be counted as demand nobody served.
  const bookedIds = new Set(allBookings.map(booking => booking.id));
  const unbookedRequests = requests.filter(request => !request.converted_booking_id || !bookedIds.has(request.converted_booking_id));
  // Collapse only pending unpaid retries with the same complete job coordinates.
  // Separate times/addresses and confirmed jobs are real demand, not duplicates.
  const bookingSignalsRaw = bookings.map(formatBookingSignal);
  const seenDemandKeys = new Set();
  const bookingSignals = bookingSignalsRaw.filter(signal => {
    const emailKey = String(signal.customerEmail || '').trim().toLowerCase();
    if (!emailKey || signal.status !== 'pending' || !['pending', 'failed'].includes(signal.paymentStatus)) return true;
    const coordinates = [signal.requestedService, signal.requestedDate, signal.zip, signal.desiredTime, signal.address];
    if (coordinates.some(value => !String(value || '').trim())) return true;
    const key = JSON.stringify([emailKey, ...coordinates.map(value => String(value).trim().replace(/\s+/g, ' ').toLowerCase())]);
    if (seenDemandKeys.has(key)) return false;
    seenDemandKeys.add(key);
    return true;
  });
  const requestSignals = unbookedRequests.map(request => formatRequest({ ...request, recordType: 'request' }));
  const demandSignals = [...bookingSignals, ...requestSignals]
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  const supplyAvailable = !easersResult.error;
  const waitlistAvailable = !waitlistResult.error;
  const easers = supplyAvailable ? await Promise.all((easersResult.data || []).map(async profile => {
    const easer = normalizeAssemblerProfile(profile);
    // This report shows job eligibility only. Connect affects payout setup,
    // never isReady; avoid a Stripe account retrieval on every dashboard poll.
    return { ...easer, marketReadiness: await readinessFor(easer, { requireAvailability: false, stripeAccount: null }) };
  })) : [];
  const waitlist = waitlistAvailable ? (waitlistResult.data || []) : [];
  const warnings = [
    requestsResult.warning,
    bookingsResult.locationColumnsMissing
      ? 'Apply migration 054 so future bookings save normalized city, state, and ZIP. Existing full addresses are parsed as a fallback.'
      : null,
    bookingsResult.attributionColumnMissing
      ? 'Apply migration 056 so new bookings retain privacy-safe campaign attribution.'
      : null,
    easersResult.error ? 'Easer supply is unavailable. Counts and coverage are unknown; retry to refresh.' : null,
    waitlistResult.error ? 'Easer waitlist is unavailable. Waitlist counts are unknown; other Easer counts are unaffected.' : null,
  ].filter(Boolean);
  const unlocatedCount = demandSignals.filter(signal => !signal.city || !signal.state).length;
  if (unlocatedCount) warnings.push(`${unlocatedCount} demand signal(s) have no usable city/state and remain visible as Unlocated.`);

  const marketSupply = buildSupplyByMarket(easers, waitlist);
  const marketRows = buildMarketRows(demandSignals, marketSupply, { supplyAvailable, waitlistAvailable });
  const allSupplyRows = kind => Array.from(marketSupply.values()).flatMap(market => market.rows[kind]);
  const profileCount = kind => supplyAvailable ? allSupplyRows(kind).length : null;
  const reviewRecords = [...allSupplyRows('all'), ...allSupplyRows('waitlist')].filter(row => row.locationIssue);
  if (reviewRecords.length) warnings.push(`${reviewRecords.length} Easer or waitlist record(s) need location review and remain included in totals.`);
  if (bookingsResult.totalCount > allBookings.length) warnings.push(`Booking demand contains the latest ${allBookings.length} of ${bookingsResult.totalCount} booking records. Easer supply is loaded in full.`);
  if (requestsResult.totalCount > requests.length) warnings.push(`Unbooked demand contains the latest ${requests.length} of ${requestsResult.totalCount} request records. Easer supply is loaded in full.`);
  const topMarkets = marketRows.slice().sort((a, b) => {
    if (b.requestCount !== a.requestCount) return b.requestCount - a.requestCount;
    return Number(b.potentialRevenue || 0) - Number(a.potentialRevenue || 0);
  }).slice(0, 12);
  const pricedDemand = demandSignals.map(signal => positiveCents(signal.estimatedRevenue)).filter(value => value != null);
  const manualAssignmentRows = bookingSignals.filter(isManualAssignmentSignal);
  const manualDispatchDemand = manualAssignmentRows.length;
  const newRequestCount = requestSignals.filter(signal => !['converted', 'closed'].includes(signal.status)).length;
  const topAcquisitionSources = topSources(bookingSignals);

  return res.status(200).json({
    generatedAt: now().toISOString(),
    supplyAvailable,
    waitlistAvailable,
    sourceStatus: {
      easers: supplyAvailable ? 'available' : 'unavailable',
      waitlist: waitlistAvailable ? 'available' : 'unavailable',
      bookings: 'available',
      requests: requestsResult.warning ? 'unavailable' : 'available',
    },
    summary: {
      activeMarkets: marketRows.filter(market => market.isActiveMarket).length,
      bookingOpenMarkets: marketRows.filter(market => market.isActiveMarket).length,
      coverageReadyMarkets: supplyAvailable ? marketRows.filter(market => market.coverageKnown && market.readyEasers > 0).length : null,
      coverageNeededMarkets: supplyAvailable ? marketRows.filter(market => market.coverageKnown && market.requestCount > 0 && market.readyEasers === 0).length : null,
      emergingMarkets: marketRows.filter(market => !market.isActiveMarket && market.requestCount > 0).length,
      demandSignals: demandSignals.length,
      marketRequests: demandSignals.length,
      bookedDemand: bookingSignals.length,
      unbookedDemand: requestSignals.length,
      manualDispatchDemand,
      ownerActionRequired: manualDispatchDemand + newRequestCount,
      excludedTestBookings,
      marketConversionRate: requests.length ? (requests.length - unbookedRequests.length) / requests.length : 0,
      totalEasers: profileCount('all'),
      easerSupplyByMarket: profileCount('approved'),
      readyEasers: profileCount('ready'),
      onlineReadyEasers: profileCount('online'),
      easerApplications: profileCount('pending'),
      waitlistEasers: waitlistAvailable ? allSupplyRows('waitlist').length : null,
      locationReviewCount: supplyAvailable && waitlistAvailable ? reviewRecords.length : null,
      totalPotentialRevenue: pricedDemand.length ? pricedDemand.reduce((sum, value) => sum + value, 0) : null,
      pricedRequestCount: pricedDemand.length,
      unlocatedCount,
    },
    activeMarkets: ACTIVE_MARKETS,
    topMarkets,
    topAcquisitionSources,
    markets: marketRows,
    requests: demandSignals,
    supply: Array.from(marketSupply.values()).map(market => ({
      ...market, supplyAvailable, waitlistAvailable,
      totalEasers: supplyAvailable ? market.totalEasers : null,
      approvedEasers: supplyAvailable ? market.approvedEasers : null,
      readyEasers: supplyAvailable ? market.readyEasers : null,
      onlineReadyEasers: supplyAvailable ? market.onlineReadyEasers : null,
      easerApplications: supplyAvailable ? market.easerApplications : null,
      waitlistEasers: waitlistAvailable ? market.waitlistEasers : null,
    })),
    summaryRows: {
      demand: demandSignals,
      bookings: bookingSignals,
      unbooked: requestSignals,
      manualAssignment: manualAssignmentRows,
      approved: allSupplyRows('approved'),
      ready: allSupplyRows('ready'),
      online: allSupplyRows('online'),
      pending: allSupplyRows('pending'),
      waitlist: allSupplyRows('waitlist'),
      allEasers: allSupplyRows('all'),
      reviewRecords,
      missingLocation: reviewRecords,
      priced: demandSignals.filter(signal => positiveCents(signal.estimatedRevenue) != null),
    },
    warnings,
  });
  };
}

export default createMarketDemandHandler();

// A report must not quietly stop at Supabase's default row cap. Exact count and
// stable ID order let us detect partial reads, duplicate pages and a changing
// source rather than publishing zero or incomplete supply as business truth.
export async function loadSupplyRows(sb, table, fields) {
  const rows = [];
  const seen = new Set();
  let expected = null;
  try {
    for (;;) {
      let query = sb.from(table).select(fields, { count: 'exact' });
      if (table === 'profiles') query = query.eq('role', 'assembler');
      const result = await query.order('id', { ascending: true }).range(rows.length, rows.length + 999);
      if (result.error) return { data: [], error: result.error };
      if (!Number.isInteger(result.count) || result.count < 0) throw new Error('Supply count could not be verified');
      if (expected !== null && result.count !== expected) throw new Error('Supply changed during refresh; retry');
      expected = result.count;
      const page = result.data || [];
      for (const row of page) {
        if (!row.id || seen.has(row.id)) throw new Error('Supply rows could not be reconciled');
        seen.add(row.id);
        rows.push(row);
      }
      if (rows.length === expected) return { data: rows, error: null };
      if (!page.length || rows.length > expected) throw new Error('Supply read was incomplete');
    }
  } catch (error) {
    return { data: [], error: { message: error.message || 'Supply read failed' } };
  }
}

async function loadMarketRequests(sb) {
  const result = await sb.from('market_requests').select('*', { count: 'exact' }).order('created_at', { ascending: false }).limit(1000);
  if (!result.error) return { data: result.data || [], warning: null, totalCount: result.count ?? null };
  const missing = result.error.code === '42P01' || /market_requests/i.test(result.error.message || '');
  if (missing) {
    return {
      data: [],
      warning: 'Unbooked market-request tracking is not installed. Real booking demand is still included.',
    };
  }
  console.error('Market request load failed:', result.error);
  return { data: [], warning: 'Unbooked market requests could not be loaded. Real bookings are still included.' };
}

async function loadBookingDemand(sb) {
  let result = await sb.from('bookings').select(BOOKING_SELECT, { count: 'exact' }).order('created_at', { ascending: false }).limit(2000);
  if (!result.error) return { data: result.data || [], error: null, totalCount: result.count ?? null, locationColumnsMissing: false };
  if (/booking_attribution/i.test(result.error.message || '')) {
    result = await sb.from('bookings').select(BOOKING_SELECT_WITHOUT_ATTRIBUTION, { count: 'exact' }).order('created_at', { ascending: false }).limit(2000);
    if (!result.error) return { data: result.data || [], error: null, totalCount: result.count ?? null, locationColumnsMissing: false, attributionColumnMissing: true };
  }
  if (!/service_(?:city|state|zip)/i.test(result.error?.message || '')) return { data: [], error: result.error };
  result = await sb.from('bookings').select(LEGACY_BOOKING_SELECT, { count: 'exact' }).order('created_at', { ascending: false }).limit(2000);
  if (/booking_attribution/i.test(result.error?.message || '')) {
    result = await sb.from('bookings').select(LEGACY_BOOKING_SELECT_WITHOUT_ATTRIBUTION, { count: 'exact' }).order('created_at', { ascending: false }).limit(2000);
  }
  return { data: result.data || [], error: result.error || null, totalCount: result.count ?? null, locationColumnsMissing: !result.error };
}

function formatBookingSignal(booking) {
  const location = parseServiceLocation({
    address: booking.address,
    city: booking.service_city,
    state: booking.service_state,
    zip: booking.service_zip,
  });
  return {
    id: booking.id,
    bookingId: booking.id,
    requestRef: booking.ref,
    recordType: 'booking',
    status: booking.status || 'pending',
    paymentStatus: booking.payment_status || null,
    source: booking.booking_attribution?.utmSource
      || booking.booking_attribution?.source
      || booking.source
      || 'direct',
    customerName: booking.customer_name,
    customerEmail: booking.customer_email,
    customerPhone: booking.customer_phone,
    city: location.city,
    state: location.state,
    zip: location.zip,
    marketArea: resolveMarketArea({ city: booking.service_city, state: booking.service_state, zip: booking.service_zip, address: booking.address }),
    requestedService: booking.service,
    requestedDate: booking.date,
    desiredTime: booking.time,
    address: booking.address || null,
    estimatedRevenue: positiveCents(booking.total_price),
    // A job with an Easer on it is not waiting for the owner to assign one. The
    // flag alone is not proof: expire-offers can set it while a live offer is
    // still acceptable, so a booking can carry it AND an Easer. ops-alert.js
    // has always paired the two; this count did not.
    assemblerId: booking.assembler_id || null,
    needsManualDispatch: booking.needs_manual_dispatch === true && !booking.assembler_id,
    createdAt: booking.created_at,
  };
}

function buildMarketRows(signals, supplyMap, options = {}) {
  const supplyAvailable = options.supplyAvailable !== false;
  const waitlistAvailable = options.waitlistAvailable !== false;
  const map = new Map(knownMarketAreas().map(area => [area.marketKey, emptyMarket(area)]));
  for (const rawSignal of signals) {
    const signal = normalizeDemandSignal(rawSignal);
    const area = rawSignal.marketArea || resolveMarketArea({ ...rawSignal, zip: rawSignal.zip || rawSignal.zip_code });
    const current = map.get(area.marketKey) || emptyMarket(area);
    current.requestCount += 1;
    current.demandRows.push(rawSignal);
    if (signal.recordType === 'booking') current.bookedCount += 1;
    else current.unbookedCount += 1;
    if (isManualAssignmentSignal(signal)) current.manualDispatchCount += 1;
    const verifiedEstimate = positiveCents(signal.estimatedRevenue);
    if (verifiedEstimate != null) {
      current.potentialRevenue += verifiedEstimate;
      current.pricedRequestCount += 1;
    }
    if (signal.zip) current.zips.add(signal.zip);
    if (signal.requestedService) current.services.set(signal.requestedService, (current.services.get(signal.requestedService) || 0) + 1);
    if (signal.status === 'converted' || rawSignal.converted_booking_id) current.convertedCount += 1;
    map.set(area.marketKey, current);
  }
  for (const [key, supply] of supplyMap.entries()) {
    const current = map.get(key) || emptyMarket(supply);
    current.supplyRows = supply.rows;
    map.set(key, current);
  }
  return Array.from(map.values()).map(market => {
    const active = isActiveMarket(market.city, market.state);
    const count = kind => supplyAvailable ? market.supplyRows[kind].length : null;
    const row = {
      city: market.city, state: market.state,
      marketKey: market.marketKey, marketLabel: market.marketLabel, market: market.marketLabel,
      coverageKnown: market.coverageKnown, locationIssue: market.locationIssue,
      supplyAvailable, waitlistAvailable,
      isActiveMarket: active,
      requestCount: market.requestCount, bookedCount: market.bookedCount,
      unbookedCount: market.unbookedCount, manualDispatchCount: market.manualDispatchCount,
      convertedCount: market.convertedCount,
      conversionRate: market.requestCount ? market.convertedCount / market.requestCount : 0,
      potentialRevenue: market.pricedRequestCount ? market.potentialRevenue : null,
      pricedRequestCount: market.pricedRequestCount,
      requestedZips: Array.from(market.zips).sort(),
      topServices: Array.from(market.services.entries()).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([service, count]) => ({ service, count })),
      totalEasers: count('all'), approvedEasers: count('approved'), readyEasers: count('ready'),
      onlineReadyEasers: count('online'), easerApplications: count('pending'),
      waitlistEasers: waitlistAvailable ? market.supplyRows.waitlist.length : null,
      demandRows: market.demandRows,
      bookedRows: market.demandRows.filter(signal => signal.recordType === 'booking'),
      unbookedRows: market.demandRows.filter(signal => signal.recordType !== 'booking'),
      supplyRows: market.supplyRows,
    };
    row.demandToSupplyRatio = supplyAvailable && market.coverageKnown && row.readyEasers > 0 ? row.requestCount / row.readyEasers : null;
    row.activationStatus = getActivationStatus(row, active);
    return row;
  });
}

function buildSupplyByMarket(easers, waitlist) {
  const map = new Map();
  const seenEasers = new Set();
  const seenWaitlist = new Set();
  for (const profile of easers) {
    if (!profile.id || seenEasers.has(profile.id)) continue;
    seenEasers.add(profile.id);
    const easer = normalizeAssemblerProfile(profile);
    const area = resolveMarketArea(easer);
    const current = map.get(area.marketKey) || emptySupply(area);
    const row = personRow(easer, area, 'easer');
    current.rows.all.push(row);
    if (row.locationIssue) current.rows.reviewRecords.push(row);
    if (easer.marketReadiness?.ownerApproved) current.rows.approved.push(row);
    if (easer.status === 'pending' && ['applied', 'pending', 'waitlist'].includes(String(easer.application_status || '').trim().toLowerCase())) current.rows.pending.push(row);
    if (easer.marketReadiness?.isReady) {
      current.rows.ready.push(row);
      if (easer.is_available === true) current.rows.online.push(row);
    }
    updateSupplyCounts(current);
    map.set(area.marketKey, current);
  }
  for (const entry of waitlist) {
    if (!entry.id || seenWaitlist.has(entry.id)) continue;
    seenWaitlist.add(entry.id);
    // Only actual waiting leads count, not closed/converted application history.
    if (!['pending', 'invited'].includes(String(entry.status || '').trim().toLowerCase())) continue;
    const area = resolveMarketArea(entry);
    const current = map.get(area.marketKey) || emptySupply(area);
    const row = personRow(entry, area, 'waitlist');
    current.rows.waitlist.push(row);
    if (row.locationIssue) current.rows.reviewRecords.push(row);
    updateSupplyCounts(current);
    map.set(area.marketKey, current);
  }
  return map;
}

function personRow(profile, area, recordType) {
  return {
    id: profile.id, name: profile.full_name || profile.name || (recordType === 'easer' ? 'Unnamed Easer' : 'Waitlist entry'),
    status: profile.status || null, applicationStatus: profile.application_status || null,
    city: profile.city ?? null, state: profile.state ?? null, zip: profile.zip ?? null,
    marketKey: area.marketKey, marketLabel: area.marketLabel, recordType,
    isAvailable: profile.is_available === true, eligible: profile.marketReadiness?.isReady === true,
    missingItems: profile.marketReadiness?.missingItems || [], locationIssue: area.locationIssue,
  };
}

function emptyRows() {
  return { all: [], approved: [], ready: [], online: [], pending: [], waitlist: [], reviewRecords: [] };
}

function emptyMarket(area) {
  return {
    ...area, locationIssue: area.marketKey === 'location-review' ? 'Location needs review' : null,
    requestCount: 0, bookedCount: 0, unbookedCount: 0, manualDispatchCount: 0,
    convertedCount: 0, potentialRevenue: 0, pricedRequestCount: 0,
    zips: new Set(), services: new Map(), demandRows: [], supplyRows: emptyRows(),
  };
}

function emptySupply(area) {
  const supply = { ...area, rows: emptyRows() };
  updateSupplyCounts(supply);
  return supply;
}

function updateSupplyCounts(supply) {
  supply.totalEasers = supply.rows.all.length;
  supply.approvedEasers = supply.rows.approved.length;
  supply.readyEasers = supply.rows.ready.length;
  supply.onlineReadyEasers = supply.rows.online.length;
  supply.easerApplications = supply.rows.pending.length;
  supply.waitlistEasers = supply.rows.waitlist.length;
}

function normalizeDemandSignal(signal) {
  const location = parseServiceLocation({
    city: signal.city,
    state: signal.state,
    zip: signal.zip || signal.zip_code,
    address: signal.address,
  });
  return {
    recordType: signal.recordType || 'request',
    city: location.city,
    state: location.state,
    zip: location.zip,
    status: String(signal.status || 'new').toLowerCase(),
    requestedService: signal.requestedService || signal.requested_service || null,
    estimatedRevenue: signal.estimatedRevenue ?? requestRevenueCents(signal),
    needsManualDispatch: signal.needsManualDispatch === true || signal.needs_manual_dispatch === true,
  };
}

function formatRequest(request) {
  const location = parseServiceLocation({ city: request.city, state: request.state, zip: request.zip_code, address: request.address });
  return {
    id: request.id,
    bookingId: null,
    requestRef: request.request_ref,
    recordType: request.recordType || 'request',
    status: request.status || 'new',
    source: request.source,
    customerName: request.customer_name,
    customerEmail: request.customer_email,
    customerPhone: request.customer_phone,
    city: location.city,
    state: location.state,
    zip: location.zip,
    marketArea: resolveMarketArea({ city: request.city, state: request.state, zip: request.zip_code, address: request.address }),
    requestedService: request.requested_service,
    requestedDate: request.requested_date,
    desiredTime: request.desired_time,
    estimatedRevenue: requestRevenueCents(request),
    needsManualDispatch: false,
    createdAt: request.created_at || request.request_timestamp,
  };
}

function getActivationStatus(market, active) {
  if (!market.supplyAvailable) return 'SUPPLY UNAVAILABLE';
  if (market.locationIssue) return 'LOCATION REVIEW';
  if (!market.coverageKnown) return 'COVERAGE UNVERIFIED';
  if (active && market.readyEasers === 0) return 'COVERAGE NEEDED';
  if (active && market.manualDispatchCount > 0) return 'OWNER ASSIGNMENT';
  if (active && market.readyEasers < 3) return 'LIMITED COVERAGE';
  if (active) return 'READY';
  if (market.requestCount >= 10 || market.readyEasers >= 3) return 'READY TO REVIEW';
  if (market.requestCount > 0 && (market.easerApplications > 0 || market.waitlistEasers > 0)) return 'WATCH';
  return 'COLLECTING DEMAND';
}

function isActiveMarket(city, state) {
  return normalizeServiceState(state) === 'TX';
}

function isManualAssignmentSignal(signal) {
  return signal.needsManualDispatch === true && !TERMINAL_BOOKING_STATUSES.includes(signal.status);
}

function cents(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : 0;
}

function positiveCents(value) {
  const amount = cents(value);
  return amount > 0 ? amount : null;
}

function requestRevenueCents(request) {
  return positiveCents(request?.verified_revenue_cents) ?? positiveCents(request?.estimated_revenue);
}

function topSources(signals) {
  const counts = new Map();
  for (const signal of signals) {
    const source = String(signal.source || 'direct').trim().toLowerCase() || 'direct';
    counts.set(source, (counts.get(source) || 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([source, count]) => ({ source, count }));
}

export {
  buildMarketRows,
  buildSupplyByMarket,
  formatBookingSignal,
  formatRequest,
  isActiveMarket,
  loadBookingDemand,
};
