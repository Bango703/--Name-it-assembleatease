import assert from 'node:assert/strict';
import { createMarketDemandHandler } from '../api/owner/market-demand.js';
import { buildAcquisitionReport } from '../api/owner/_acquisition-report.js';

// One set of bookings must give the same count on Market Demand and on the
// acquisition report (all time). Test bookings count on neither.
const make = (id, patch = {}) => ({
  id, ref: `AAE-${id}`, status: 'confirmed', payment_status: 'authorized', service: 'Furniture Assembly',
  date: '2026-10-01', time: '8 AM-10 AM', customer_email: `c${id}@example.com`, address: '1 St, Austin, TX 78759',
  service_city: 'Austin', service_state: 'TX', service_zip: '78759', created_at: '2026-08-01T10:00:00Z',
  total_price: 10000, is_test_booking: false, ...patch,
});
const bookings = [
  make('a'), make('b', { status: 'completed' }), make('c', { status: 'cancelled' }),
  make('d', { created_at: '2026-03-01T10:00:00Z' }), make('t', { is_test_booking: true }),
];

function db(tables) {
  return { from(table) {
    let start = 0, end = Infinity, counted = false;
    const q = {
      select(_f, o = {}) { counted = o.count === 'exact'; return this; },
      eq() { return this; }, order() { return this; },
      range(a, b) { start = a; end = b; return this; }, limit(n) { end = n - 1; return this; },
      then(res, rej) {
        const rows = (tables[table] || []).slice(start, end + 1);
        return Promise.resolve({ data: rows, error: null, count: counted ? (tables[table] || []).length : null }).then(res, rej);
      },
    };
    return q;
  } };
}

const response = { setHeader() {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
await createMarketDemandHandler({
  getSupabase: () => db({ bookings, profiles: [], assembler_waitlist: [], market_requests: [] }),
  verifyOwner: () => true,
  now: () => new Date('2026-10-19T12:00:00Z'),
  getEaserReadiness: async () => ({ isReady: false }),
})({ method: 'GET' }, response);
assert.equal(response.code, 200);

const acquisition = buildAcquisitionReport(bookings, null, { period: 'all', now: new Date('2026-10-19T12:00:00Z'), totalCount: bookings.length });
assert.equal(acquisition.summary.bookings, 4);
assert.equal(response.body.summary.bookedDemand, acquisition.summary.bookings, 'Market Demand and Acquisition must count the same bookings');
assert.equal(response.body.summary.excludedTestBookings, acquisition.excludedTests);
assert.equal(response.body.markets.reduce((sum, m) => sum + m.bookedRows.length, 0), response.body.summary.bookedDemand, 'market cards add up to the page total');
console.log('PASS owner booking counts: Market Demand, Acquisition and the market cards agree; test bookings excluded everywhere.');
