import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import vm from 'node:vm';
import { EASER_SUPPLY_SELECT, buildSupplyByMarket, buildMarketRows } from '../api/owner/market-demand.js';
import { getEaserReadiness } from '../api/_easer-readiness.js';
import { CONTRACTOR_AGREEMENT_VERSION } from '../api/_assembler-onboarding.js';
import { buildOwnerJobContext, bookingFinanceContext } from '../api/owner/_monitor-jobs.js';
import { computeBookingSplitFromSnapshot, computeBookingFinancialSummary } from '../api/_source-of-truth.js';

const baseProfile = {
  id: 'ready-a', full_name: 'Fixture Easer A', city: 'San Antonio', state: 'TX', zip: '78201',
  status: 'active', application_status: 'approved', role: 'assembler', tier: 'starter',
  is_available: true, identity_verified: true, phone: '210-555-0101',
  contractor_agreement_signed_at: '2026-09-01T12:00:00Z', contractor_agreement_version: CONTRACTOR_AGREEMENT_VERSION,
  code_of_conduct_agreed_at: '2026-09-01T12:00:00Z', sms_consent_at: '2026-09-01T12:00:00Z',
  sms_opted_out_at: null, application_fee_paid: false, application_fee_waived: true,
  fee_waived_by_owner: false, payment_confirmed: false, application_decision_key: null,
  application_fee_refunded: false, application_fee_refunded_cents: 0,
  application_fee_refund_pending_cents: 0, application_fee_refund_review_required_at: null,
  account_closure_status: null, stripe_connect_account_id: null,
};
const projection = EASER_SUPPLY_SELECT.split(',').map(value => value.trim());
async function project(profile) {
  const row = Object.fromEntries(projection.map(field => [field, profile[field]]));
  return { ...row, marketReadiness: await getEaserReadiness(row, { connectRequired: false, requireAvailability: false }) };
}
const profiles = await Promise.all([
  baseProfile,
  { ...baseProfile, id: 'ready-b', full_name: 'Fixture Easer B' },
  { ...baseProfile, id: 'offline', full_name: 'Fixture Offline Easer', is_available: false },
  { ...baseProfile, id: 'blocked', full_name: 'Fixture Held Easer', application_fee_refund_pending_cents: 3000 },
  { ...baseProfile, id: 'pending', full_name: 'Fixture Applicant', status: 'pending', application_status: 'applied' },
  { ...baseProfile, id: 'rejected', status: 'rejected', application_status: 'rejected' },
].map(project));
const markets = buildMarketRows([], buildSupplyByMarket(profiles, [
  { id: 'waiting', city: 'San Antonio', state: 'TX', zip: '78201', status: 'pending' },
  { id: 'applied', city: 'San Antonio', state: 'TX', zip: '78201', status: 'applied' },
]));
const sanAntonio = markets.find(row => row.marketKey === 'san_antonio');
assert.equal(sanAntonio.approvedEasers, 4, 'Active approved accounts are separate from readiness');
assert.equal(sanAntonio.readyEasers, 3, 'Consent fields must survive the exact API projection');
assert.equal(sanAntonio.onlineReadyEasers, 2, 'Offline Easer remains eligible but is not online');
assert.equal(sanAntonio.easerApplications, 1, 'Approved and rejected accounts are not pending applications');
assert.equal(sanAntonio.waitlistEasers, 1, 'Already applied waitlist entries are history');
for (const [count, rows] of [['approvedEasers','approved'], ['readyEasers','ready'], ['onlineReadyEasers','online'], ['easerApplications','pending'], ['waitlistEasers','waitlist']]) {
  assert.equal(sanAntonio[count], sanAntonio.supplyRows[rows].length);
}
assert.equal(sanAntonio.activationStatus, 'READY');
for (const patch of [
  { sms_consent_at: null }, { sms_opted_out_at: '2026-09-22' },
  { application_decision_key: 'decision-in-flight' }, { application_fee_refunded: true },
  { application_fee_refunded_cents: 3000 }, { application_fee_refund_pending_cents: 3000 },
  { application_fee_refund_review_required_at: '2026-09-22' }, { account_closure_status: 'requested' },
]) assert.equal((await project({ ...baseProfile, ...patch })).marketReadiness.isReady, false,
  `Projection must preserve blocker ${Object.keys(patch)[0]}`);

const now = new Date('2026-09-23T15:00:00Z');
const booking = {
  id: 'upcoming', ref: 'AAE-FIXTURE24', date: '2026-09-24', time: '8 AM-10 AM',
  service: 'Outdoor & Playsets', status: 'confirmed', payment_status: 'authorized',
  assembler_id: 'ready-a', assembler_name: 'Fixture Easer A', assembler_accepted_at: '2026-09-22T15:00:00Z',
  total_price: 10825, tax_amount: 825, easer_fee_snapshot_easer_id: 'ready-a',
  easer_fee_pct_snapshot: 30, easer_estimated_due_snapshot: 7000,
  easer_fee_snapshot_at: '2026-09-22T14:00:00Z',
};
const context = buildOwnerJobContext([
  booking,
  { ...booking, id: 'test', is_test_booking: true },
  { ...booking, id: 'cancelled', status: 'cancelled' },
  { ...booking, id: 'done', status: 'completed' },
  { ...booking, id: 'past', date: '2026-09-22' },
  { ...booking, id: 'invalid', date: '2026-02-30' },
  { ...booking, id: 'return', date: '2026-09-01', status: 'completed', return_visit_required: true, return_visit_date: '2026-09-25', return_visit_time: '1 PM-3 PM' },
], [], now);
assert.equal(context.asOf.localDate, '2026-09-23');
assert.equal(context.upcomingJobs.total, 2);
assert.equal(context.upcomingJobs.jobs[0].ref, 'AAE-FIXTURE24');
assert.equal(context.upcomingJobs.jobs[0].date, '2026-09-24');
assert.equal(context.upcomingJobs.jobs[0].assignment.accepted, true);
assert.equal(context.upcomingJobs.jobs[1].date, '2026-09-25');
assert.equal(context.jobsWithUnknownDate.length, 1);
const split = computeBookingSplitFromSnapshot({ totalPriceCents: 10825, taxCents: 825, feePct: 30 });
const expected = computeBookingFinancialSummary({ totalPriceCents: 10825, taxAmountCents: 825, assemblerDueCents: split.assemblerDueCents });
assert.equal(context.upcomingJobs.jobs[0].financials.actual, null, 'Authorization is not collected revenue');
assert.equal(context.upcomingJobs.jobs[0].financials.estimate.totalEaserEarningsDollars, '70.00');
assert.equal(context.upcomingJobs.jobs[0].financials.estimate.platformAfterProcessingEstimateDollars, (expected.platformGrossCents / 100).toFixed(2));
assert.equal(bookingFinanceContext({ ...booking, assembler_id: 'new-assignee' }).estimate, null, 'Stale assignment snapshot cannot estimate pay');
assert.equal(bookingFinanceContext({ ...booking, total_price: null }).estimate, null, 'Missing price stays unknown');
assert.equal(bookingFinanceContext({ ...booking, source: 'owner_manual' }).estimate.processingFeeEstimateDollars, null, 'Unknown offline fee is not zero');
assert.equal(bookingFinanceContext({ ...booking, source: 'owner_manual', payment_method: 'cash' }).estimate.processingFeeEstimateDollars, '0.00');
const creditAndBonus = bookingFinanceContext({ ...booking, assemblecash_redeemed_cents: 1000, easer_bonus_cents: 500 });
assert.equal(creditAndBonus.estimate.totalEaserEarningsDollars, '82.00', 'Credit protection plus owner bonus use canonical split');
assert.equal(creditAndBonus.estimate.platformBeforeProcessingDollars, '18.00');
const actual = bookingFinanceContext(booking, {
  hasLedger: true, paymentStatus: 'captured', charged: 10825, refund: 0, netCharged: 10825,
  taxCollected: 825, owed: 7000, payoutAmount: 0, paidOut: false, stripeFee: 344,
  stripeFeeIsActual: false, platformRevenue: 2656, payoutStatus: 'transferred',
  payoutMode: 'stripe_connect', stripeTransferStatus: 'succeeded', stripeBankPayoutStatus: 'pending',
}).actual;
assert.equal(actual.recordedEaserPaymentDollars, null);
assert.equal(actual.platformAmountIsEstimate, true);
assert.equal(actual.transferStatus, 'succeeded');
assert.equal(actual.bankPayoutStatus, 'pending');
const bounded = buildOwnerJobContext(Array.from({ length: 40 }, (_, i) => ({ ...booking, id: String(i) })), [], now);
assert.equal(bounded.upcomingJobs.jobs.length, 30);
assert.equal(bounded.upcomingJobs.truncated, true);
assert.equal(buildOwnerJobContext([booking], [], new Date('2026-09-24T01:00:00Z')).asOf.localDate, '2026-09-23');
const mountain = buildOwnerJobContext([{ ...booking, date:'2026-09-23', service_city:'El Paso', service_zip:'79901' }], [], new Date('2026-09-24T05:30:00Z'));
assert.equal(mountain.asOf.localDate,'2026-09-24');
assert.equal(mountain.upcomingJobs.jobs[0].date,'2026-09-23', 'Mountain job is still on its local current date after Central midnight');
assert.equal(mountain.upcomingJobs.jobs[0].timezone,'America/Denver');

// Execute the real inline renderers, rather than checking only copy strings.
const dashboard = await readFile(new URL('../owner/index.html', import.meta.url), 'utf8');
function fn(name) {
  const start = dashboard.indexOf(`  function ${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  const end = dashboard.indexOf('\n  }', start) + '\n  }'.length;
  return dashboard.slice(start, end);
}
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const elements = new Map([['md-top-markets', { innerHTML: '' }]]);
const uiContext = vm.createContext({
  esc, asmConnectRequired: true, document: { getElementById: id => elements.get(id) },
  fmt$: value => '$' + (value / 100).toFixed(2),
});
const rendererNames = ['mdCountRows','mdSupplyCount','mdDemandCount','mdMiniMetric','mdStatusPill','renderMarketRows','payoutCapabilityBadge','easerTierBadge'];
vm.runInContext(rendererNames.map(fn).join('\n'), uiContext);
uiContext.renderMarketRows(markets);
const marketHtml = elements.get('md-top-markets').innerHTML;
assert.match(marketHtml, /Most requested services/);
assert.match(marketHtml, /No requests recorded yet/);
assert.match(marketHtml, /Requested ZIPs/);
assert.match(marketHtml, /Pending applications: 1/);
assert.match(marketHtml, /Eligible Easers: 3/);
assert.match(marketHtml, /Availability on: 2/);
assert.match(marketHtml, /data-demand-easer="ready-a"/);
assert.doesNotMatch(marketHtml, /No services yet/);
assert.match(uiContext.payoutCapabilityBadge({ stripe_connect_payouts_enabled: true }), />Enabled</);
assert.match(uiContext.payoutCapabilityBadge({ stripe_connect_payouts_enabled: false }), />Not enabled</);
uiContext.asmConnectRequired = false;
assert.match(uiContext.payoutCapabilityBadge({}), /MANUAL PAYOUT/);
assert.match(uiContext.easerTierBadge('professional'), /Stored platform tier/);
assert.doesNotMatch(uiContext.mdSupplyCount('Ready', [{ id: 'safe', name: '<script>alert(1)</script>' }]), /<script>/);
for (const script of dashboard.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
  if (script[1].trim()) new vm.Script(script[1]);
}

// Optional no-credential browser fixture made from the production renderer/CSS.
if (process.argv.includes('--fixture')) {
  const style = [...dashboard.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(match => match[1]).join('\n');
  const fixture = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${style}</style></head><body style="padding:20px"><main style="max-width:900px;margin:auto"><h1>Notification audit fixture</h1><p>Local fictional data. Open each count to inspect exact records.</p>${marketHtml}<h2>Easer roster labels</h2><p>Active means approved. Readiness and availability are checked separately.</p><p>${uiContext.easerTierBadge('professional')} Grace since Sep 14, 2026</p><p>${uiContext.payoutCapabilityBadge({})}</p><p>Details last sent: Sep 23, 2026, 8:25 AM CDT<br>Latest reminder: Sep 23, 2026, 9:00 AM CDT</p></main></body></html>`;
  await mkdir(new URL('../tmp/', import.meta.url), { recursive: true });
  await writeFile(new URL('../tmp/notification-dashboard-fixture.html', import.meta.url), fixture);
}
console.log('Notification dashboard fixes: PASS (projection blockers, exact count lists, future-job context, canonical estimates, payout states, actual UI renderers)');
