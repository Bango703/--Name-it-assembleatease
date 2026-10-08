import assert from 'node:assert/strict';
import { acquisitionForBooking, acquisitionRange, buildAcquisitionReport } from '../api/owner/_acquisition-report.js';
import { createAcquisitionHandler } from '../api/owner/acquisition.js';
import { loadLedgerFirstFinanceRows } from '../api/owner/_finance-ledger.js';
import { loadBookingDemand } from '../api/owner/market-demand.js';

const now = new Date('2026-10-07T18:00:00Z');
const booking = changes => ({ id: 'b1', ref: 'AAE-TEST-1', status: 'completed', created_at: '2026-10-01T18:00:00Z', source: 'website', service_city: 'Austin', service_state: 'TX', service_zip: '78701', total_price: 999999, customer_email: 'first@example.test', ...changes });
const money = changes => ({ bookingId: 'b1', status: 'completed', netCharged: 12000, platformRevenue: 2700, paymentStatus: 'captured', hasLedger: true, legacyDerived: false, stripeFeeIsActual: true, ...changes });
const report = (bookings, finance = { rows: [money()] }, options = {}) => buildAcquisitionReport(bookings, finance, { now, period: 'all', totalCount: bookings.length, ...options });
let passed = 0, failed = 0;
async function test(name, check) {
  try { await check(); passed++; console.log('PASS ' + name); }
  catch (error) { failed++; console.error('FAIL ' + name + ': ' + error.message); }
}

for (const [name, value, channel] of [
  ['legacy Google label is not proof of organic', { source: 'Google' }, 'search_unclassified'],
  ['legacy nested search label remains unclassified', { booking_attribution: { source: 'google' } }, 'search_unclassified'],
  ['typed direct source remains unknown', { source: 'direct' }, 'unattributed'],
  ['self referral remains unknown', { booking_attribution: { referrerHost: 'www.assembleatease.com' } }, 'unattributed'],
  ['self subdomain is not referral', { booking_attribution: { referrerHost: 'app.assembleatease.com' } }, 'unattributed'],
  ['payment subdomain is not acquisition', { booking_attribution: { referrerHost: 'checkout.stripe.com' } }, 'unattributed'],
  ['owner manual is not credited to organic', { source: 'owner_manual' }, 'owner_recorded'],
  ['real search referrer', { booking_attribution: { referrerHost: 'www.google.com' } }, 'organic_search'],
  ['explicit organic search tag', { booking_attribution: { utmSource: 'bing', utmMedium: 'organic' } }, 'organic_search'],
  ['social referral parity with capture', { booking_attribution: { referrerHost: 'm.facebook.com' } }, 'organic_social'],
  ['tagged email', { booking_attribution: { utmSource: 'newsletter', utmMedium: 'email' } }, 'email'],
  ['partner referral', { booking_attribution: { referrerHost: 'partner.example.com' } }, 'referral'],
  ['other tagged campaign', { booking_attribution: { utmSource: 'partner', utmMedium: 'print' } }, 'campaign'],
  ['click identifier wins over organic tag', { booking_attribution: { clickId: 'valid-id', clickIdType: 'gclid', utmSource: 'google', utmMedium: 'organic' } }, 'paid_search'],
  ['legacy click identifier has unknown paid type', { booking_attribution: { clickId: 'legacy-valid-id', referrerHost: 'google.com' } }, 'paid_unclassified'],
  ['a forged v2 channel does not invent evidence', { booking_attribution: { attributionVersion: 2, channel: 'organic_search' } }, 'unattributed'],
  ['medium alone is not proof of organic', { booking_attribution: { utmMedium: 'organic' } }, 'unattributed'],
  ['self-source organic tag is not proof', { booking_attribution: { utmSource: 'assembleatease.com', utmMedium: 'organic' } }, 'unattributed'],
  ['nonsense organic source is not search', { booking_attribution: { utmSource: 'random-partner', utmMedium: 'organic' } }, 'unattributed'],
]) await test(name, () => assert.equal(acquisitionForBooking(booking(value)).channel, channel));

await test('last 28 complete Chicago dates exclude today', () => {
  const range = acquisitionRange('28', now);
  assert.equal(range.from, '2026-09-09');
  assert.equal(range.to, '2026-10-06');
  assert.equal(range.timezone, 'America/Chicago');
});
await test('default 90-day window is exact and all-time includes older real jobs', () => {
  const range = acquisitionRange(undefined, now);
  assert.equal(range.period, '90');
  assert.equal(range.from, '2026-07-09');
  assert.equal(range.to, '2026-10-06');
  assert.equal(report([booking({ created_at: '2026-05-18T18:00:00Z' })]).summary.completed, 1);
});
await test('UTC midnight before Chicago midnight does not advance report day', () => {
  const range = acquisitionRange('28', new Date('2026-10-07T04:59:59Z'));
  assert.equal(range.to, '2026-10-05');
});
await test('Chicago spring and fall DST use calendar days', () => {
  assert.equal(acquisitionRange('28', new Date('2026-03-09T05:30:00Z')).to, '2026-03-08');
  assert.equal(acquisitionRange('28', new Date('2026-11-02T05:30:00Z')).to, '2026-10-31');
  assert.equal(acquisitionRange('28', new Date('2026-11-02T06:00:00Z')).to, '2026-11-01');
});
await test('cohort membership uses creation timestamp in Chicago, not job date', () => {
  const rows = [booking({ id: 'before', created_at: '2026-09-09T04:59:59Z' }), booking({ id: 'start', created_at: '2026-09-09T05:00:00Z', date: '2027-01-01' }), booking({ id: 'end', created_at: '2026-10-07T04:59:59Z' }), booking({ id: 'today', created_at: '2026-10-07T05:00:00Z' })];
  assert.deepEqual(report(rows, { rows: [] }, { period: '28' }).summary.rows.map(row => row.bookingId), ['start', 'end']);
});
await test('six real jobs stay real, explicit tests and duplicate rows do not inflate counts', () => {
  const rows = Array.from({ length: 6 }, (_, index) => booking({ id: 'real-' + index, created_at: index === 0 ? '2026-05-18T18:00:00Z' : '2026-07-20T18:00:00Z' }));
  const tests = Array.from({ length: 7 }, (_, index) => booking({ id: 'test-' + index, is_test_booking: true }));
  const result = report([...rows, ...tests, rows[0]], { rows: rows.map(row => money({ bookingId: row.id })) });
  assert.equal(result.summary.bookings, 6);
  assert.equal(result.summary.completed, 6);
  assert.equal(result.excludedTests, 7);
  assert.equal(result.summary.recordedPaymentsCents, 72000);
});
await test('declines and cancellations remain lost outcomes', () => {
  const result = report([booking({ id: 'a', status: 'declined' }), booking({ id: 'b', status: 'cancelled' }), booking({ id: 'c', status: 'confirmed' })], { rows: [] });
  assert.equal(result.summary.cancelled, 2);
  assert.equal(result.summary.completed, 0);
  assert.equal(result.summary.open, 1);
  assert.equal(result.summary.recordedPaymentsCents, 0);
});
await test('repeat contacts are normalized by email or phone with bridge records', () => {
  const result = report([booking({ id: 'a', customer_email: ' FIRST@example.test ', customer_phone: '(512) 555-0100' }), booking({ id: 'b', customer_email: null, customer_phone: '+1 512 555 0100' }), booking({ id: 'c', customer_email: 'first@example.test', customer_phone: '5125550101' }), booking({ id: 'd', customer_email: null, customer_phone: '5125550101' }), booking({ id: 'e', customer_email: 'invalid', customer_phone: null })], { rows: [] });
  assert.equal(result.summary.bookings, 5);
  assert.equal(result.summary.uniqueContacts, 1);
  assert.equal(result.summary.missingContact, 1);
});
await test('finance failure is unknown, never zero or quoted price', () => {
  const result = report([booking()], null);
  assert.equal(result.financeAvailable, false);
  assert.equal(result.summary.recordedPaymentsCents, null);
  assert.equal(result.summary.platformGrossCents, null);
  assert.equal(result.partial, true);
  assert.ok(result.warnings.length);
});
await test('resolved finance error object is also unavailable', () => {
  assert.equal(report([booking()], { rows: [], error: new Error('source failed') }).financeAvailable, false);
});
await test('one missing completed finance row invalidates affected totals only', () => {
  const result = report([booking(), booking({ id: 'missing', service_city: 'Dallas' })]);
  assert.equal(result.summary.recordedPaymentsCents, null);
  assert.equal(result.markets.find(row => row.key === 'austin, tx').recordedPaymentsCents, 12000);
  assert.equal(result.markets.find(row => row.key === 'dallas, tx').recordedPaymentsCents, null);
  assert.equal(result.summary.financeMissing, 1);
});
for (const field of ['netCharged', 'platformRevenue']) await test(`null ${field} cannot become zero`, () => {
  const result = report([booking()], { rows: [money({ [field]: null })] });
  assert.equal(result.summary[field === 'netCharged' ? 'recordedPaymentsCents' : 'platformGrossCents'], null);
  assert.equal(result.partial, true);
});
await test('non-finite finance values are unknown', () => {
  const result = report([booking()], { rows: [money({ netCharged: Infinity, platformRevenue: NaN })] });
  assert.equal(result.summary.recordedPaymentsCents, null);
  assert.equal(result.summary.platformGrossCents, null);
});
await test('completed but uncaptured projection cannot turn quote total into revenue', () => {
  const result = report([booking()], { rows: [money({ hasLedger: false, legacyDerived: true, paymentStatus: 'authorized', netCharged: 999999, platformRevenue: 888888 })] });
  assert.equal(result.summary.recordedPaymentsCents, null);
  assert.equal(result.summary.platformGrossCents, null);
});
await test('refund-net payment and negative gross retain canonical amounts', () => {
  const result = report([booking()], { rows: [money({ netCharged: 2000, platformRevenue: -1700, paymentStatus: 'partially_refunded' })] });
  assert.equal(result.summary.recordedPaymentsCents, 2000);
  assert.equal(result.summary.platformGrossCents, -1700);
});
async function canonicalFinance(changes = {}, manualEvents = []) {
  const row = booking({ completed_at: '2026-10-02T18:00:00Z', amount_charged: 12000, payment_status: 'captured', assembler_due: 8000, tax_amount: 1000, stripe_fee: 400, payout_mode_snapshot: 'manual', payout_status: 'pending', ...changes });
  const tables = { bookings: [row], owner_manual_payment_events: manualEvents };
  const sb = { from(table) {
    const filters = [];
    return {
      select() { return this; },
      in(key, values) { filters.push(row => values.includes(row[key])); return this; },
      eq(key, value) { filters.push(row => row[key] === value); return this; },
      order() { return this; },
      then(resolve, reject) { return Promise.resolve({ data: (tables[table] || []).filter(row => filters.every(filter => filter(row))), error: null }).then(resolve, reject); },
    };
  } };
  return loadLedgerFirstFinanceRows(sb);
}
await test('real canonical finance projection retains collected amounts, not quoted price', async () => {
  const finance = await canonicalFinance();
  const result = report([booking({ amount_charged: 12000 })], finance);
  assert.equal(result.summary.recordedPaymentsCents, 12000);
  assert.equal(result.summary.platformGrossCents, 2600);
});
await test('real canonical uncaptured quote fallback cannot enter report payments', async () => {
  const finance = await canonicalFinance({ amount_charged: null, payment_status: 'authorized' });
  assert.equal(finance.rows[0].netCharged, 999999, 'fixture exercises the canonical legacy fallback');
  assert.equal(report([booking()], finance).summary.recordedPaymentsCents, null);
});
await test('captured status without a recorded amount cannot turn a legacy quote fallback into revenue', async () => {
  const finance = await canonicalFinance({ amount_charged: null, payment_status: 'captured' });
  assert.equal(finance.rows[0].netCharged, 999999, 'capture status alone does not remove the canonical fallback');
  assert.equal(report([booking({ amount_charged: null })], finance).summary.recordedPaymentsCents, null);
});
await test('legacy financial amount disagreement is unknown rather than a guessed reconciliation', async () => {
  const finance = await canonicalFinance({ amount_charged: 12000 });
  assert.equal(report([booking({ amount_charged: 13000 })], finance).summary.recordedPaymentsCents, null);
});
for (const legacy of [false, true]) await test(`${legacy ? 'legacy' : 'current'} booking loader selects charged evidence for report reconciliation`, async () => {
  const original = booking({ amount_charged: 12000 });
  const sb = { from() {
    let fields;
    return {
      select(columns) { fields = columns.split(',').map(value => value.trim()); return this; },
      order() { return this; }, limit() { return this; },
      then(resolve, reject) {
        const missing = legacy && fields.includes('service_city');
        return Promise.resolve(missing ? { data: null, error: { message: 'service_city column missing' } } : { data: [Object.fromEntries(fields.map(field => [field, original[field]]))], count: 1, error: null }).then(resolve, reject);
      },
    };
  } };
  const loaded = await loadBookingDemand(sb);
  assert.equal(loaded.data[0].amount_charged, 12000);
  assert.equal(loaded.locationColumnsMissing, legacy);
  const result = report(loaded.data, await canonicalFinance(), { totalCount: loaded.totalCount });
  assert.equal(result.summary.recordedPaymentsCents, 12000);
});
await test('owner-manual partial collections reuse the canonical payment event ledger', async () => {
  const finance = await canonicalFinance({ source: 'owner_manual', payment_status: 'offline_recorded', amount_charged: null, payment_collected: false }, [{ booking_id: 'b1', amount_cents: 5000, refunded_cents: 1000, processing_fee_cents: 200 }]);
  assert.equal(report([booking({ source: 'owner_manual' })], finance).summary.recordedPaymentsCents, 4000);
});
await test('owner-manual uncollected quote remains zero recorded payments', async () => {
  const finance = await canonicalFinance({ source: 'owner_manual', payment_status: 'offline_recorded', amount_charged: null, payment_collected: false });
  assert.equal(report([booking({ source: 'owner_manual' })], finance).summary.recordedPaymentsCents, 0);
});
await test('estimated processing fees are identified in the row and report warning', () => {
  const result = report([booking()], { rows: [money({ stripeFeeIsActual: false })] });
  assert.equal(result.summary.rows[0].financeEstimated, true);
  assert.match(result.summary.rows[0].financeBasis, /estimated/);
  assert.ok(result.warnings.some(warning => /estimated processing fees/.test(warning)));
});
await test('test-flag disagreement with finance never imports test money', () => {
  const result = report([booking()], { rows: [money({ isTestBooking: true })] });
  assert.equal(result.summary.recordedPaymentsCents, null);
  assert.equal(result.summary.financeMissing, 1);
});
await test('city organic metrics exclude incomplete and other acquisition sources', () => {
  const rows = [booking({ booking_attribution: { referrerHost: 'google.com' } }), booking({ id: 'b2', source: 'Google' }), booking({ id: 'b3', status: 'confirmed', booking_attribution: { referrerHost: 'bing.com' } })];
  const result = report(rows, { rows: [money(), money({ bookingId: 'b2', netCharged: 25000 })] });
  assert.equal(result.markets[0].organicBookings, 2);
  assert.equal(result.markets[0].organicCompleted, 1);
  assert.equal(result.markets[0].organicRecordedPaymentsCents, 12000);
  assert.equal(result.summary.rows[0].channelKey, 'organic_search');
});
await test('missing organic finance is null while missing nonorganic finance does not erase known organic', () => {
  const organic = booking({ booking_attribution: { referrerHost: 'google.com' } });
  assert.equal(report([organic], { rows: [] }).summary.organicRecordedPaymentsCents, null);
  const result = report([organic, booking({ id: 'missing', source: 'Google' })]);
  assert.equal(result.summary.organicRecordedPaymentsCents, 12000);
  assert.equal(result.summary.recordedPaymentsCents, null);
});
await test('partial booking source and missing dates are explicitly incomplete', () => {
  assert.equal(report([booking()], undefined, { totalCount: 2001 }).partial, true);
  const invalid = report([booking({ created_at: 'invalid' })], { rows: [] }, { period: '28' });
  assert.equal(invalid.excludedInvalidDates, 1);
  assert.equal(invalid.partial, true);
});
await test('unknown source count cannot assert a complete report', () => {
  assert.equal(report([booking()], undefined, { totalCount: null }).partial, true);
});
await test('finance database row ceiling risk is surfaced despite complete cohort finance', () => {
  const rows = [booking(), ...Array.from({ length: 1000 }, (_, i) => booking({ id: 'old-' + i, status: 'cancelled', created_at: '2025-01-01T12:00:00Z' }))];
  const result = report(rows, { rows: [money()] }, { period: '28' });
  assert.equal(result.partial, true);
  assert.ok(result.warnings.some(warning => /bounded|limit|completeness/i.test(warning)));
});
await test('owner report output excludes contact, street and attribution payloads', () => {
  const result = report([booking({ customer_name: 'Private Person', customer_phone: '5125550100', address: '123 Secret Road, Austin, TX 78701', booking_attribution: { referrerHost: 'google.com', utmCampaign: 'secret-campaign', clickId: 'sensitive-id' } })]);
  const serialized = JSON.stringify(result);
  for (const value of ['first@example.test', '5125550100', 'Private Person', '123 Secret Road', 'secret-campaign', 'sensitive-id']) assert.equal(serialized.includes(value), false);
});
await test('report calculation never rewrites historical source, test or financial records', () => {
  const rows = [booking({ source: 'Google', booking_attribution: { source: 'google' } })];
  const finance = { rows: [money()] };
  const before = structuredClone({ rows, finance });
  report(rows, finance);
  assert.deepEqual({ rows, finance }, before);
});

async function request(options = {}, requestOptions = {}) {
  const calls = [];
  const handler = createAcquisitionHandler({
    verifyOwner: () => options.authorized !== false,
    getSupabase: () => { calls.push('database'); return {}; },
    loadBookingDemand: options.loadBookingDemand || (async () => ({ data: [booking()], totalCount: 1 })),
    loadFinance: options.loadFinance || (async () => ({ rows: [money()] })), now: () => now,
  });
  const response = { statusCode: 200, headers: {}, status(code) { this.statusCode = code; return this; }, setHeader(name, value) { this.headers[name] = value; }, json(body) { this.body = body; return this; } };
  await handler({ method: 'GET', query: { period: 'all' }, ...requestOptions }, response);
  return { ...response, calls };
}
await test('owner authorization precedes every data load', async () => {
  const result = await request({ authorized: false });
  assert.equal(result.statusCode, 401);
  assert.deepEqual(result.calls, []);
  assert.match(result.headers['Cache-Control'], /private.*no-store/);
});
await test('read-only route rejects mutations and invalid periods before queries', async () => {
  for (const [options, status] of [[{ method: 'POST' }, 405], [{ query: { period: '999999' } }, 400]]) {
    const result = await request({}, options);
    assert.equal(result.statusCode, status);
    assert.deepEqual(result.calls, []);
  }
});
await test('booking query failure returns unavailable instead of zero', async () => {
  for (const loadBookingDemand of [async () => { throw new Error('down'); }, async () => ({ error: { message: 'down' }, data: [] }), async () => ({ data: null })]) {
    assert.equal((await request({ loadBookingDemand })).statusCode, 503);
  }
});
await test('finance failure preserves booking counts and returns null financial totals', async () => {
  const result = await request({ loadFinance: async () => { throw new Error('private database detail'); } });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.summary.bookings, 1);
  assert.equal(result.body.summary.recordedPaymentsCents, null);
  assert.equal(JSON.stringify(result.body).includes('private database detail'), false);
});
await test('synchronous finance adapter failure also preserves booking counts', async () => {
  const result = await request({ loadFinance: () => { throw new Error('source down'); } });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.summary.bookings, 1);
  assert.equal(result.body.financeAvailable, false);
});
await test('missing attribution/location columns carry completeness warnings', async () => {
  const result = await request({ loadBookingDemand: async () => ({ data: [booking()], totalCount: 1, attributionColumnMissing: true, locationColumnsMissing: true }) });
  assert.ok(result.body.warnings.some(warning => /attribution column/i.test(warning)));
  assert.ok(result.body.warnings.some(warning => /location/i.test(warning)));
});
console.log(`Owner acquisition report: ${passed} passed, ${failed} failed.`);
if (failed) process.exitCode = 1;
