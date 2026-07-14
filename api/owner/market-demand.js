import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';
import {
  ACTIVE_INSTANT_BOOKING_ZIP_PREFIXES,
  ACTIVE_INSTANT_BOOKING_ZIPS,
  isActiveInstantBookingZip,
} from '../_source-of-truth.js';

const ACTIVE_CENTRAL_TEXAS_CITIES = Object.freeze([
  'Austin', 'Bee Cave', 'Buda', 'Cedar Park', 'Georgetown', 'Hutto',
  'Kyle', 'Lakeway', 'Leander', 'Manor', 'Pflugerville', 'Round Rock',
]);

const ACTIVE_MARKETS = [
  {
    key: 'austin-tx',
    label: 'Austin and Central Texas',
    city: 'Austin',
    state: 'TX',
    cities: ACTIVE_CENTRAL_TEXAS_CITIES,
    zipPrefixes: ACTIVE_INSTANT_BOOKING_ZIP_PREFIXES,
    zips: ACTIVE_INSTANT_BOOKING_ZIPS,
  },
];

export default async function handler(req, res) {
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const sb = getSupabase();

  const [requestsRes, easersRes, waitlistRes] = await Promise.all([
    sb.from('market_requests').select('*').order('created_at', { ascending: false }).limit(500),
    sb.from('profiles').select('id, full_name, city, state, zip, status, tier, application_status, role, created_at').eq('role', 'assembler'),
    sb.from('assembler_waitlist').select('id, city, state, status, created_at'),
  ]);

  if (requestsRes.error) {
    console.error('Market demand list error:', requestsRes.error);
    if (requestsRes.error.code === '42P01' || /market_requests/i.test(requestsRes.error.message || '')) {
      return res.status(200).json({
        setupNeeded: true,
        setupMessage: 'Run migration 017_market_requests.sql to enable market demand tracking.',
        summary: {
          activeMarkets: ACTIVE_MARKETS.length,
          emergingMarkets: 0,
          marketRequests: 0,
          marketConversionRate: 0,
          easerSupplyByMarket: 0,
          totalPotentialRevenue: 0,
        },
        activeMarkets: ACTIVE_MARKETS,
        topMarkets: [],
        markets: [],
        requests: [],
        supply: [],
      });
    }
    return res.status(500).json({
      error: 'Failed to load market demand',
      tableMissing: /market_requests/i.test(requestsRes.error.message || ''),
    });
  }

  const requests = requestsRes.data || [];
  const easers = easersRes.error ? [] : (easersRes.data || []);
  const waitlist = waitlistRes.error ? [] : (waitlistRes.data || []);
  const marketSupply = buildSupplyByMarket(easers, waitlist);
  const marketRows = buildMarketRows(requests, marketSupply);
  const topMarkets = marketRows.slice().sort((a, b) => {
    if (b.requestCount !== a.requestCount) return b.requestCount - a.requestCount;
    return b.potentialRevenue - a.potentialRevenue;
  }).slice(0, 8);

  const converted = requests.filter(r => r.status === 'converted' || r.converted_booking_id).length;
  const emergingMarketCount = marketRows.filter(m => !m.isActiveMarket).length;

  const summary = {
    activeMarkets: ACTIVE_MARKETS.length,
    emergingMarkets: emergingMarketCount,
    marketRequests: requests.length,
    marketConversionRate: requests.length ? converted / requests.length : 0,
    easerSupplyByMarket: Array.from(marketSupply.values()).reduce((sum, m) => sum + m.approvedEasers, 0),
    totalPotentialRevenue: requests.reduce((sum, r) => sum + cents(r.estimated_revenue), 0),
  };

  return res.status(200).json({
    summary,
    activeMarkets: ACTIVE_MARKETS,
    topMarkets,
    markets: marketRows,
    requests: requests.map(formatRequest),
    supply: Array.from(marketSupply.values()),
  });
}

function buildMarketRows(requests, supplyMap) {
  const map = new Map();

  for (const req of requests) {
    const key = marketKey(req.city, req.state);
    const current = map.get(key) || emptyMarket(req.city, req.state);
    current.requestCount += 1;
    current.potentialRevenue += cents(req.estimated_revenue);
    current.zips.add(req.zip_code);
    current.services.set(req.requested_service, (current.services.get(req.requested_service) || 0) + 1);
    if (req.status === 'converted' || req.converted_booking_id) current.convertedCount += 1;
    map.set(key, current);
  }

  for (const [key, supply] of supplyMap.entries()) {
    const current = map.get(key) || emptyMarket(supply.city, supply.state);
    current.approvedEasers = supply.approvedEasers;
    current.easerApplications = supply.easerApplications;
    current.waitlistEasers = supply.waitlistEasers;
    map.set(key, current);
  }

  return Array.from(map.values()).map(m => {
    const isActive = isActiveMarket(m.city, m.state);
    const topServices = Array.from(m.services.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([service, count]) => ({ service, count }));
    const demandToSupplyRatio = m.approvedEasers > 0 ? m.requestCount / m.approvedEasers : (m.requestCount || 0);
    const activationStatus = getActivationStatus(m, isActive);

    return {
      city: m.city,
      state: m.state,
      market: `${m.city}, ${m.state}`,
      isActiveMarket: isActive,
      requestCount: m.requestCount,
      convertedCount: m.convertedCount,
      conversionRate: m.requestCount ? m.convertedCount / m.requestCount : 0,
      potentialRevenue: m.potentialRevenue,
      requestedZips: Array.from(m.zips).filter(Boolean).sort(),
      topServices,
      approvedEasers: m.approvedEasers,
      easerApplications: m.easerApplications,
      waitlistEasers: m.waitlistEasers,
      demandToSupplyRatio,
      activationStatus,
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
    if (isApprovedEaser(easer)) current.approvedEasers += 1;
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
    city: cleanMarketCity(city) || 'Unknown',
    state: cleanState(state) || 'US',
    requestCount: 0,
    convertedCount: 0,
    potentialRevenue: 0,
    zips: new Set(),
    services: new Map(),
    approvedEasers: 0,
    easerApplications: 0,
    waitlistEasers: 0,
  };
}

function emptySupply(city, state) {
  return {
    city: cleanMarketCity(city),
    state: cleanState(state),
    approvedEasers: 0,
    easerApplications: 0,
    waitlistEasers: 0,
  };
}

function formatRequest(req) {
  return {
    id: req.id,
    requestRef: req.request_ref,
    status: req.status,
    source: req.source,
    customerName: req.customer_name,
    customerEmail: req.customer_email,
    customerPhone: req.customer_phone,
    city: req.city,
    state: req.state,
    zip: req.zip_code,
    requestedService: req.requested_service,
    requestedDate: req.requested_date,
    desiredTime: req.desired_time,
    estimatedRevenue: cents(req.estimated_revenue),
    createdAt: req.created_at || req.request_timestamp,
  };
}

function getActivationStatus(m, isActive) {
  if (isActive) return 'ACTIVE';
  if (m.requestCount >= 10 || m.approvedEasers >= 3) return 'READY TO REVIEW';
  if (m.requestCount > 0 && (m.easerApplications > 0 || m.waitlistEasers > 0)) return 'WATCH';
  return 'COLLECTING DEMAND';
}

function isApprovedEaser(easer) {
  if (easer.status === 'active') return true;
  if (easer.application_status === 'approved') return true;
  return ['starter', 'professional', 'elite', 'verified'].includes(easer.tier);
}

function isActiveMarket(city, state) {
  const normalizedCity = cleanMarketCity(city);
  const normalizedState = cleanState(state);
  return ACTIVE_MARKETS.some(m =>
    normalizedState === m.state
    && (m.cities || [m.city]).some(activeCity => cleanMarketCity(activeCity) === normalizedCity)
  );
}

function inferState(zip) {
  return isActiveInstantBookingZip(zip) ? 'TX' : '';
}

function marketKey(city, state) {
  return `${cleanMarketCity(city).toLowerCase()}-${cleanState(state).toLowerCase()}`;
}

function cleanMarketCity(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function cleanState(value) {
  return String(value || '').trim().slice(0, 2).toUpperCase();
}

function cents(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
}
