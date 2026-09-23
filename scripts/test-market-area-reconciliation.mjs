import assert from 'node:assert/strict';
import { resolveMarketArea, knownMarketAreas } from '../api/_market-area.js';
import { SERVICE_MARKETS, marketForZip } from '../api/_source-of-truth.js';
import { CONTRACTOR_AGREEMENT_VERSION } from '../api/_assembler-onboarding.js';
import { getEaserReadiness } from '../api/_easer-readiness.js';
import { createMarketDemandHandler, buildSupplyByMarket, buildMarketRows, EASER_SUPPLY_SELECT } from '../api/owner/market-demand.js';

const base = {
  id: 'fixture-base', full_name: 'Fixture Easer', role: 'assembler', city: 'San Antonio', state: 'TX', zip: '78201',
  status: 'active', application_status: 'approved', tier: 'starter', is_available: true,
  identity_verified: true, phone: '210-555-0101', sms_consent_at: '2026-09-01', sms_opted_out_at: null,
  contractor_agreement_signed_at: '2026-09-01', contractor_agreement_version: CONTRACTOR_AGREEMENT_VERSION,
  code_of_conduct_agreed_at: '2026-09-01', application_fee_paid: false, application_fee_waived: true,
  fee_waived_by_owner: false, application_fee_refunded: false, application_fee_refunded_cents: 0,
  application_fee_refund_pending_cents: 0, application_fee_refund_review_required_at: null,
  application_decision_key: null, account_closure_status: null, stripe_connect_account_id: null,
};
const fixture = (id, patch = {}) => ({ ...base, id, ...patch });
const booking = (id, patch = {}) => ({
  id, ref: `AAE-${id}`, status: 'confirmed', payment_status: 'authorized',
  service: 'Furniture Assembly', date: '2026-10-01', time: '8 AM-10 AM',
  customer_email: 'fixture@example.com', address: '1 Fixture St, Austin, TX 78759',
  service_city: 'Austin', service_state: 'TX', service_zip: '78759',
  created_at: '2026-09-23T10:00:00Z', total_price: 10000, ...patch,
});

// Exercise the actual handler with a projecting Supabase boundary. Unselected
// fields disappear, as they do in production; no database or Stripe is used.
function database(tables, config = {}) {
  const reads = [];
  return {
    reads,
    from(table) {
      let fields = '*';
      let countRequested = false;
      let filter = null;
      let start = 0;
      let end = Infinity;
      let order = null;
      const query = {
        select(value, options = {}) { fields = value; countRequested = options.count === 'exact'; return this; },
        eq(key, value) { filter = [key, value]; return this; },
        order(key, options) { order = [key, options]; return this; },
        range(a, b) { start = a; end = b; return this; },
        limit(value) { end = value - 1; return this; },
        then(resolve, reject) {
          return Promise.resolve().then(() => {
            reads.push({ table, fields, start, end, order });
            if (config.throwTable === table) throw new Error('Fixture transport failure');
            if (config.failTable === table && start >= (config.failAt || 0)) return { error: { message: 'Fixture source unavailable' }, data: null, count: null };
            let rows = (tables[table] || []).filter(row => !filter || row[filter[0]] === filter[1]);
            if (order) rows = [...rows].sort((a, b) => String(a[order[0]] || '').localeCompare(String(b[order[0]] || '')) * (order[1]?.ascending === false ? -1 : 1));
            let count = rows.length;
            if (config.changedCountTable === table && start > 0) count += 1;
            rows = rows.slice(start, Math.min(end + 1, start + (config.cap || Infinity)));
            if (config.repeatPageTable === table && start > 0) rows = [tables[table][0]];
            if (fields !== '*') {
              const keys = fields.split(',').map(field => field.trim());
              rows = rows.map(row => Object.fromEntries(keys.map(key => [key, row[key]])));
            }
            return { data: rows, error: null, count: countRequested && !config.omitCount ? count : null };
          }).then(resolve, reject);
        },
      };
      return query;
    },
  };
}

async function request(tables = {}, config = {}, requestOptions = {}) {
  const sb = database(tables, config);
  const observedReadiness = [];
  const handler = createMarketDemandHandler({
    getSupabase: () => sb,
    verifyOwner: () => requestOptions.authorized !== false,
    now: () => new Date('2026-09-23T12:00:00Z'),
    getEaserReadiness: async (profile, options) => {
      observedReadiness.push({ profile, options });
      return getEaserReadiness(profile, { ...options, connectRequired: false });
    },
  });
  const response = { code: null, body: null, headers: {},
    setHeader(key, value) { this.headers[key] = value; },
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; },
  };
  await handler({ method: requestOptions.method || 'GET' }, response);
  return { ...response, reads: sb.reads, observedReadiness };
}

const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Network is forbidden in market-area tests'); };
try {
  assert.deepEqual(knownMarketAreas().map(area => area.marketKey), Object.keys(SERVICE_MARKETS));
  for (const [key, prefixes] of Object.entries(SERVICE_MARKETS)) {
    for (const prefix of prefixes) {
      const zip = `${prefix}01`;
      assert.equal(resolveMarketArea({ city: 'Recorded base', state: 'TX', zip }).marketKey, marketForZip(zip));
      assert.equal(resolveMarketArea({ city: 'Recorded base', state: 'TX', zip }).marketKey, key);
    }
  }
  assert.equal(resolveMarketArea({ city: 'Austin', state: 'Texas', zip: '78660-1234' }).marketKey, 'central_texas');
  assert.equal(resolveMarketArea({ city: 'Pflugerville', state: '', zip: '78759' }).marketKey, 'central_texas');
  assert.equal(resolveMarketArea({ city: 'San Antonio', state: 'TX', zip: '78006' }).marketKey, 'san_antonio');
  const unknown = resolveMarketArea({ city: 'Caddo Mills', state: 'TX', zip: '75135' });
  assert.equal(unknown.coverageKnown, false);
  assert.equal(unknown.locationIssue, null);
  assert.match(unknown.marketLabel, /Caddo Mills, TX 75135/);
  assert.notEqual(unknown.marketKey, 'central_texas');
  for (const patch of [
    { city: null }, { zip: null }, { zip: 'bad 78201' }, { state: 'ZZ' },
    { state: 'CA', zip: '78201' }, { state: 'TX', zip: '10001' },
  ]) {
    const area = resolveMarketArea({ ...base, ...patch });
    assert.equal(area.marketKey, 'location-review');
    assert.equal(area.coverageKnown, false);
    assert.ok(area.locationIssue);
  }

  const tables = {
    profiles: [
      fixture('central', { city: 'Austin', zip: '78660' }),
      fixture('sa-near', { city: 'San Antonio', zip: '78006' }),
      fixture('sa-normalized', { status: null, tier: 'verified', state: 'Texas' }),
      fixture('offline', { city: 'Houston', zip: '77002', is_available: false }),
      fixture('blocked', { city: 'Lubbock', zip: '79401', sms_consent_at: null }),
      fixture('pending', { city: 'Caddo Mills', zip: '75135', status: 'pending', application_status: 'applied', tier: 'pending' }),
      fixture('suspended', { status: null, tier: 'suspended', application_status: 'applied' }),
      fixture('rejected', { status: null, tier: 'rejected', application_status: 'applied' }),
      fixture('review', { city: null }),
      { id: 'customer', role: 'customer' },
    ],
    bookings: [booking('austin'), booking('sa', { service_city: 'Boerne', service_zip: '78006', address: '2 Fixture St, Boerne, TX 78006' })],
    assembler_waitlist: [
      { id: 'waiting', name: 'Waiting fixture', city: 'Houston', state: 'TX', zip: '77301', status: 'pending' },
      { id: 'invited', name: 'Invited fixture', city: 'Houston', state: 'TX', zip: null, status: 'invited' },
      ...['applied', 'approved', 'closed', 'rejected', 'suspended'].map(status => ({ id: `history-${status}`, city: 'Houston', state: 'TX', zip: '77001', status })),
    ],
    market_requests: [],
  };
  const result = await request(tables);
  assert.equal(result.code, 200);
  assert.equal(result.headers['Cache-Control'], 'private, no-store');
  assert.equal(result.body.generatedAt, '2026-09-23T12:00:00.000Z');
  assert.equal(result.body.supplyAvailable, true);
  assert.equal(result.body.waitlistAvailable, true);
  assert.deepEqual(result.body.sourceStatus, { easers: 'available', waitlist: 'available', bookings: 'available', requests: 'available' });
  assert.equal(result.body.summary.totalEasers, 9);
  assert.equal(result.body.summary.easerSupplyByMarket, 6);
  assert.equal(result.body.summary.readyEasers, 5);
  assert.equal(result.body.summary.onlineReadyEasers, 4);
  assert.equal(result.body.summary.easerApplications, 1);
  assert.equal(result.body.summary.waitlistEasers, 2);
  assert.equal(result.body.summary.locationReviewCount, 2);
  for (const [summaryField, marketField, kind] of [
    ['totalEasers', 'totalEasers', 'all'], ['easerSupplyByMarket', 'approvedEasers', 'approved'],
    ['readyEasers', 'readyEasers', 'ready'], ['onlineReadyEasers', 'onlineReadyEasers', 'online'],
    ['easerApplications', 'easerApplications', 'pending'], ['waitlistEasers', 'waitlistEasers', 'waitlist'],
  ]) {
    const rows = result.body.markets.flatMap(market => market.supplyRows[kind]);
    assert.equal(new Set(rows.map(row => row.id)).size, rows.length);
    assert.equal(result.body.markets.reduce((sum, market) => sum + market[marketField], 0), result.body.summary[summaryField]);
    assert.equal(rows.length, result.body.summary[summaryField]);
    for (const market of result.body.markets) assert.equal(market[marketField], market.supplyRows[kind].length);
  }
  const area = key => result.body.markets.find(row => row.marketKey === key);
  assert.equal(area('central_texas').requestCount, 1);
  assert.equal(area('central_texas').readyEasers, 1);
  assert.equal(area('san_antonio').readyEasers, 2);
  assert.equal(area('san_antonio').requestCount, 1);
  assert.equal(area('permian_basin').totalEasers, 0);
  assert.equal(area(unknown.marketKey).easerApplications, 1);
  assert.equal(area(unknown.marketKey).activationStatus, 'COVERAGE UNVERIFIED');
  assert.equal(area('location-review').readyEasers, 1, 'Location review must not erase a ready person from global totals');
  assert.equal(area('location-review').activationStatus, 'LOCATION REVIEW');
  const originalLocation = area('san_antonio').supplyRows.ready.find(row => row.id === 'sa-normalized');
  assert.equal(originalLocation.state, 'Texas', 'Preserve recorded profile location in drilldown');
  assert.equal(originalLocation.status, 'active', 'Same status normalization as owner roster');
  assert.equal(originalLocation.eligible, true);
  assert.deepEqual(originalLocation.missingItems, []);
  assert.ok(area('lubbock').supplyRows.all[0].missingItems.includes('Job texts enabled'));
  assert.ok(result.reads.some(read => read.table === 'profiles' && read.fields === EASER_SUPPLY_SELECT));
  assert.ok(result.reads.some(read => read.table === 'assembler_waitlist' && read.fields.includes('zip')));
  assert.ok(result.observedReadiness.every(({ options }) => options.stripeAccount === null && options.requireAvailability === false));
  const connectOn = await getEaserReadiness(base, { connectRequired: true, stripeAccount: null, requireAvailability: false });
  const connectOff = await getEaserReadiness(base, { connectRequired: false, stripeAccount: null, requireAvailability: false });
  assert.equal(connectOn.isReady, connectOff.isReady);
  assert.deepEqual(connectOn.missingItems, connectOff.missingItems);

  const duplicateProfile = { ...base, marketReadiness: { ownerApproved: true, isReady: true, missingItems: [] } };
  const duplicates = buildMarketRows([], buildSupplyByMarket([duplicateProfile, { ...duplicateProfile, city: 'Austin', zip: '78759' }], []));
  assert.equal(duplicates.reduce((sum, row) => sum + row.readyEasers, 0), 1);
  assert.equal(buildMarketRows([], new Map()).length, Object.keys(SERVICE_MARKETS).length);

  for (const config of [{ failTable: 'profiles' }, { throwTable: 'profiles' }]) {
    const failed = (await request(tables, config)).body;
    assert.equal(failed.supplyAvailable, false);
    assert.equal(failed.waitlistAvailable, true);
    for (const key of ['totalEasers', 'easerSupplyByMarket', 'readyEasers', 'onlineReadyEasers', 'easerApplications', 'coverageReadyMarkets', 'coverageNeededMarkets', 'locationReviewCount']) assert.equal(failed.summary[key], null);
    assert.equal(failed.summary.waitlistEasers, 2);
    assert.equal(failed.summaryRows.allEasers.length, 0);
    assert.ok(failed.markets.every(row => row.approvedEasers === null && row.activationStatus === 'SUPPLY UNAVAILABLE'));
    assert.ok(failed.supply.every(row => row.approvedEasers === null));
  }
  const waitlistFailure = (await request(tables, { failTable: 'assembler_waitlist' })).body;
  assert.equal(waitlistFailure.supplyAvailable, true);
  assert.equal(waitlistFailure.waitlistAvailable, false);
  assert.equal(waitlistFailure.summary.readyEasers, 5);
  assert.equal(waitlistFailure.summary.waitlistEasers, null);
  assert.equal(waitlistFailure.summary.locationReviewCount, null);
  assert.ok(waitlistFailure.markets.every(row => row.waitlistEasers === null));

  const manyProfiles = Array.from({ length: 1005 }, (_, i) => fixture(`paged-${String(i).padStart(4, '0')}`));
  const paged = await request({ profiles: manyProfiles }, { cap: 400 });
  assert.equal(paged.body.summary.totalEasers, 1005);
  assert.equal(paged.body.summary.onlineReadyEasers, 1005);
  assert.deepEqual(paged.reads.filter(read => read.table === 'profiles').map(read => read.start), [0, 400, 800]);
  for (const config of [
    { failTable: 'profiles', failAt: 400, cap: 400 },
    { changedCountTable: 'profiles', cap: 400 },
    { repeatPageTable: 'profiles', cap: 400 },
    { omitCount: true },
  ]) {
    const failed = (await request({ profiles: manyProfiles }, config)).body;
    assert.equal(failed.supplyAvailable, false, 'Never publish a truncated supply count after paging failure');
    assert.equal(failed.summary.totalEasers, null);
  }

  const retry = { status: 'pending', payment_status: 'failed' };
  const demand = (await request({ bookings: [
    booking('confirmed-a'), booking('confirmed-b'),
    booking('retry-a', retry), booking('retry-b', retry),
    booking('other-time', { ...retry, time: '1 PM-3 PM' }),
    booking('other-address', { ...retry, address: '99 Other St, Austin, TX 78759' }),
    booking('unassigned', { needs_manual_dispatch: true }),
    ...['completed', 'cancelled', 'refunded', 'declined'].map(status => booking(`terminal-${status}`, { status, needs_manual_dispatch: true })),
    booking('assigned', { needs_manual_dispatch: true, assembler_id: 'fixture' }),
    booking('test', { is_test_booking: true }),
  ] })).body;
  assert.equal(demand.summary.bookedDemand, 11, 'Only one matching unpaid retry is collapsed; confirmed and distinct jobs survive');
  assert.equal(demand.summary.excludedTestBookings, 1);
  assert.equal(demand.summary.manualDispatchDemand, 1);
  assert.equal(demand.summaryRows.manualAssignment.length, 1);
  assert.equal(demand.markets.reduce((sum, row) => sum + row.manualDispatchCount, 0), 1);
  const limitedDemand = (await request({ bookings: Array.from({ length: 6 }, (_, i) => booking(`cap-${i}`)) }, { cap: 3 })).body;
  assert.ok(limitedDemand.warnings.some(warning => warning.includes('latest 3 of 6 booking')));
  const unauthorized = await request(tables, {}, { authorized: false });
  assert.equal(unauthorized.code, 401);
  assert.equal(unauthorized.reads.length, 0);
  const method = await request(tables, {}, { method: 'POST' });
  assert.equal(method.code, 405);
  assert.equal(method.reads.length, 0);
  console.log('Market-area reporting: normalization, geographic grouping, profile reconciliation, partial failures, paging, and actual-handler guards PASS');
} finally {
  globalThis.fetch = originalFetch;
}
