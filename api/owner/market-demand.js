import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';
import { isActiveInstantBookingZip } from '../_source-of-truth.js';
import { parseServiceLocation } from '../_booking-location.js';
import { getEaserReadiness } from '../_easer-readiness.js';

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
  'needs_manual_dispatch', 'booking_attribution', 'created_at',
].join(', ');

const BOOKING_SELECT_WITHOUT_ATTRIBUTION = BOOKING_SELECT.replace(', booking_attribution', '');

const LEGACY_BOOKING_SELECT = [
  'id', 'ref', 'source', 'status', 'payment_status', 'customer_name',
  'customer_email', 'customer_phone', 'service', 'date', 'time', 'address',
  'total_price', 'needs_manual_dispatch', 'booking_attribution', 'created_at',
].join(', ');

const LEGACY_BOOKING_SELECT_WITHOUT_ATTRIBUTION = LEGACY_BOOKING_SELECT.replace(', booking_attribution', '');

const EASER_SUPPLY_SELECT = [
  'id', 'full_name', 'city', 'state', 'zip', 'phone', 'status', 'tier',
  'application_status', 'role', 'created_at', 'is_available', 'identity_verified',
  'contractor_agreement_signed_at', 'contractor_agreement_version',
  'code_of_conduct_agreed_at', 'application_fee_paid', 'payment_confirmed',
  'application_fee_waived', 'fee_waived_by_owner', 'account_closure_status',
  'stripe_connect_account_id', 'stripe_connect_onboarding_complete',
  'stripe_connect_charges_enabled', 'stripe_connect_payouts_enabled',
].join(', ');

export default async function handler(req, res) {
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const sb = getSupabase();
  const [requestsResult, bookingsResult, easersResult, waitlistResult] = await Promise.all([
    loadMarketRequests(sb),
    loadBookingDemand(sb),
    sb.from('profiles').select(EASER_SUPPLY_SELECT).eq('role', 'assembler'),
    sb.from('assembler_waitlist').select('id, city, state, status, created_at'),
  ]);

  if (bookingsResult.error) {
    console.error('Market demand booking load failed:', bookingsResult.error);
    return res.status(500).json({ error: 'Failed to load booking demand' });
  }

  const bookings = bookingsResult.data || [];
  const requests = requestsResult.data || [];
  const bookedIds = new Set(bookings.map(booking => booking.id));
  const unbookedRequests = requests.filter(request => !request.converted_booking_id || !bookedIds.has(request.converted_booking_id));
  // Collapse duplicate booking attempts from the same customer for the same job — a
  // customer retrying after a declined card creates a NEW booking each time, which
  // otherwise shows up as several identical "pending" demand rows. Keep the most recent
  // (bookings are ordered created_at desc); never collapse rows with no email.
  const bookingSignalsRaw = bookings.map(formatBookingSignal);
  const seenDemandKeys = new Set();
  const bookingSignals = bookingSignalsRaw.filter(signal => {
    const emailKey = String(signal.customerEmail || '').trim().toLowerCase();
    if (!emailKey) return true;
    const key = [emailKey, String(signal.requestedService || ''), String(signal.requestedDate || ''), String(signal.zip || '')].join('|');
    if (seenDemandKeys.has(key)) return false;
    seenDemandKeys.add(key);
    return true;
  });
  const requestSignals = unbookedRequests.map(request => formatRequest({ ...request, recordType: 'request' }));
  const demandSignals = [...bookingSignals, ...requestSignals]
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  const easers = easersResult.error ? [] : await Promise.all((easersResult.data || []).map(async easer => ({
    ...easer,
    marketReadiness: await getEaserReadiness(easer, { requireAvailability: false }),
  })));
  const waitlist = waitlistResult.error ? [] : (waitlistResult.data || []);
  const warnings = [
    requestsResult.warning,
    bookingsResult.locationColumnsMissing
      ? 'Apply migration 054 so future bookings save normalized city, state, and ZIP. Existing full addresses are parsed as a fallback.'
      : null,
    bookingsResult.attributionColumnMissing
      ? 'Apply migration 056 so new bookings retain privacy-safe campaign attribution.'
      : null,
    easersResult.error ? 'Easer supply could not be loaded.' : null,
    waitlistResult.error ? 'Easer waitlist supply could not be loaded.' : null,
  ].filter(Boolean);
  const unlocatedCount = demandSignals.filter(signal => !signal.city || !signal.state).length;
  if (unlocatedCount) warnings.push(`${unlocatedCount} demand signal(s) have no usable city/state and remain visible as Unlocated.`);

  const marketSupply = buildSupplyByMarket(easers, waitlist);
  const marketRows = buildMarketRows(demandSignals, marketSupply);
  const topMarkets = marketRows.slice().sort((a, b) => {
    if (b.requestCount !== a.requestCount) return b.requestCount - a.requestCount;
    return Number(b.potentialRevenue || 0) - Number(a.potentialRevenue || 0);
  }).slice(0, 12);
  const pricedDemand = demandSignals.map(signal => positiveCents(signal.estimatedRevenue)).filter(value => value != null);
  const manualDispatchDemand = bookingSignals.filter(signal => signal.needsManualDispatch
    && !['completed', 'cancelled', 'refunded'].includes(signal.status)).length;
  const newRequestCount = requestSignals.filter(signal => !['converted', 'closed'].includes(signal.status)).length;
  const topAcquisitionSources = topSources(bookingSignals);

  return res.status(200).json({
    summary: {
      activeMarkets: marketRows.filter(market => market.isActiveMarket).length,
      bookingOpenMarkets: marketRows.filter(market => market.isActiveMarket).length,
      coverageReadyMarkets: marketRows.filter(market => market.approvedEasers > 0).length,
      coverageNeededMarkets: marketRows.filter(market => market.requestCount > 0 && market.approvedEasers === 0).length,
      emergingMarkets: marketRows.filter(market => !market.isActiveMarket && market.requestCount > 0).length,
      demandSignals: demandSignals.length,
      marketRequests: demandSignals.length,
      bookedDemand: bookingSignals.length,
      unbookedDemand: requestSignals.length,
      manualDispatchDemand,
      ownerActionRequired: manualDispatchDemand + newRequestCount,
      marketConversionRate: requests.length ? (requests.length - unbookedRequests.length) / requests.length : 0,
      easerSupplyByMarket: Array.from(marketSupply.values()).reduce((sum, market) => sum + market.approvedEasers, 0),
      onlineReadyEasers: Array.from(marketSupply.values()).reduce((sum, market) => sum + market.onlineReadyEasers, 0),
      totalPotentialRevenue: pricedDemand.length ? pricedDemand.reduce((sum, value) => sum + value, 0) : null,
      pricedRequestCount: pricedDemand.length,
      unlocatedCount,
    },
    activeMarkets: ACTIVE_MARKETS,
    topMarkets,
    topAcquisitionSources,
    markets: marketRows,
    requests: demandSignals,
    supply: Array.from(marketSupply.values()),
    warnings,
  });
}

async function loadMarketRequests(sb) {
  const result = await sb.from('market_requests').select('*').order('created_at', { ascending: false }).limit(1000);
  if (!result.error) return { data: result.data || [], warning: null };
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
  let result = await sb.from('bookings').select(BOOKING_SELECT).order('created_at', { ascending: false }).limit(2000);
  if (!result.error) return { data: result.data || [], error: null, locationColumnsMissing: false };
  if (/booking_attribution/i.test(result.error.message || '')) {
    result = await sb.from('bookings').select(BOOKING_SELECT_WITHOUT_ATTRIBUTION).order('created_at', { ascending: false }).limit(2000);
    if (!result.error) return { data: result.data || [], error: null, locationColumnsMissing: false, attributionColumnMissing: true };
  }
  if (!/service_(?:city|state|zip)/i.test(result.error?.message || '')) return { data: [], error: result.error };
  result = await sb.from('bookings').select(LEGACY_BOOKING_SELECT).order('created_at', { ascending: false }).limit(2000);
  if (/booking_attribution/i.test(result.error?.message || '')) {
    result = await sb.from('bookings').select(LEGACY_BOOKING_SELECT_WITHOUT_ATTRIBUTION).order('created_at', { ascending: false }).limit(2000);
  }
  return { data: result.data || [], error: result.error || null, locationColumnsMissing: !result.error };
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
    requestedService: booking.service,
    requestedDate: booking.date,
    desiredTime: booking.time,
    estimatedRevenue: positiveCents(booking.total_price),
    needsManualDispatch: booking.needs_manual_dispatch === true,
    createdAt: booking.created_at,
  };
}

function buildMarketRows(signals, supplyMap) {
  const map = new Map();

  for (const rawSignal of signals) {
    const signal = normalizeDemandSignal(rawSignal);
    const key = marketKey(signal.city, signal.state);
    const current = map.get(key) || emptyMarket(signal.city, signal.state);
    current.requestCount += 1;
    if (signal.recordType === 'booking') current.bookedCount += 1;
    else current.unbookedCount += 1;
    if (signal.needsManualDispatch) current.manualDispatchCount += 1;
    const verifiedEstimate = positiveCents(signal.estimatedRevenue);
    if (verifiedEstimate != null) {
      current.potentialRevenue += verifiedEstimate;
      current.pricedRequestCount += 1;
    }
    if (signal.zip) current.zips.add(signal.zip);
    if (signal.requestedService) {
      current.services.set(signal.requestedService, (current.services.get(signal.requestedService) || 0) + 1);
    }
    if (signal.status === 'converted' || rawSignal.converted_booking_id) current.convertedCount += 1;
    map.set(key, current);
  }

  for (const [key, supply] of supplyMap.entries()) {
    const current = map.get(key) || emptyMarket(supply.city, supply.state);
    current.approvedEasers = supply.approvedEasers;
    current.onlineReadyEasers = supply.onlineReadyEasers;
    current.easerApplications = supply.easerApplications;
    current.waitlistEasers = supply.waitlistEasers;
    map.set(key, current);
  }

  return Array.from(map.values()).map(market => {
    const active = isActiveMarket(market.city, market.state);
    return {
      city: market.city,
      state: market.state,
      market: market.city === 'Unlocated' ? 'Unlocated demand' : `${market.city}, ${market.state}`,
      isActiveMarket: active,
      requestCount: market.requestCount,
      bookedCount: market.bookedCount,
      unbookedCount: market.unbookedCount,
      manualDispatchCount: market.manualDispatchCount,
      convertedCount: market.convertedCount,
      conversionRate: market.requestCount ? market.convertedCount / market.requestCount : 0,
      potentialRevenue: market.pricedRequestCount ? market.potentialRevenue : null,
      pricedRequestCount: market.pricedRequestCount,
      requestedZips: Array.from(market.zips).sort(),
      topServices: Array.from(market.services.entries()).sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([service, count]) => ({ service, count })),
      approvedEasers: market.approvedEasers,
      onlineReadyEasers: market.onlineReadyEasers,
      easerApplications: market.easerApplications,
      waitlistEasers: market.waitlistEasers,
      demandToSupplyRatio: market.approvedEasers > 0 ? market.requestCount / market.approvedEasers : market.requestCount,
      activationStatus: getActivationStatus(market, active),
    };
  });
}

function buildSupplyByMarket(easers, waitlist) {
  const map = new Map();
  for (const easer of easers) {
    const city = cleanMarketCity(easer.city);
    const state = cleanState(easer.state) || inferState(easer.zip);
    if (!city || !state) continue;
    const key = marketKey(city, state);
    const current = map.get(key) || emptySupply(city, state);
    current.easerApplications += 1;
    if (easer.marketReadiness?.isReady) {
      current.approvedEasers += 1;
      if (easer.is_available === true) current.onlineReadyEasers += 1;
    }
    map.set(key, current);
  }
  for (const row of waitlist) {
    const city = cleanMarketCity(row.city);
    const state = cleanState(row.state);
    if (!city || !state) continue;
    const key = marketKey(city, state);
    const current = map.get(key) || emptySupply(city, state);
    current.waitlistEasers += 1;
    map.set(key, current);
  }
  return map;
}

function emptyMarket(city, state) {
  return {
    city: cleanMarketCity(city) || 'Unlocated',
    state: cleanState(state) || '',
    requestCount: 0,
    bookedCount: 0,
    unbookedCount: 0,
    manualDispatchCount: 0,
    convertedCount: 0,
    potentialRevenue: 0,
    pricedRequestCount: 0,
    zips: new Set(),
    services: new Map(),
    approvedEasers: 0,
    onlineReadyEasers: 0,
    easerApplications: 0,
    waitlistEasers: 0,
  };
}

function emptySupply(city, state) {
  return { city: cleanMarketCity(city), state: cleanState(state), approvedEasers: 0, onlineReadyEasers: 0, easerApplications: 0, waitlistEasers: 0 };
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
    requestedService: request.requested_service,
    requestedDate: request.requested_date,
    desiredTime: request.desired_time,
    estimatedRevenue: requestRevenueCents(request),
    needsManualDispatch: false,
    createdAt: request.created_at || request.request_timestamp,
  };
}

function getActivationStatus(market, active) {
  if (active && market.approvedEasers === 0) return 'COVERAGE NEEDED';
  if (active && market.manualDispatchCount > 0) return 'OWNER ASSIGNMENT';
  if (active && market.approvedEasers < 3) return 'LIMITED COVERAGE';
  if (active) return 'READY';
  if (market.requestCount >= 10 || market.approvedEasers >= 3) return 'READY TO REVIEW';
  if (market.requestCount > 0 && (market.easerApplications > 0 || market.waitlistEasers > 0)) return 'WATCH';
  return 'COLLECTING DEMAND';
}

function isActiveMarket(city, state) {
  return cleanState(state) === 'TX';
}

function inferState(zip) {
  return isActiveInstantBookingZip(zip) ? 'TX' : '';
}

function marketKey(city, state) {
  return `${cleanMarketCity(city).toLowerCase() || 'unlocated'}-${cleanState(state).toLowerCase() || 'unknown'}`;
}

function cleanMarketCity(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').replace(/\b\w/g, character => character.toUpperCase());
}

function cleanState(value) {
  return String(value || '').trim().slice(0, 2).toUpperCase();
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
