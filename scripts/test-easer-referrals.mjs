#!/usr/bin/env node
// Easer referrals (owner, 2026-11-21: "let's work on getting easers"). An Easer
// shares a link; the referrer earns $75 once the new Easer completes 2 paid
// jobs within 90 days. Nothing pays on a sign-up alone, nothing blocks an
// application, and paid rewards count as contractor income. No network.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  EASER_REFERRAL_POLICY, normalizeReferralCode, referralCodeCandidate, referralLink, referralCodeFromAttribution,
  recordReferralFromAttribution, referralRewardDecision, qualifyingJobCount, refereeDisplayName,
} from '../api/_easer-referrals.js';
import { cleanAcquisitionAttribution } from '../api/_attribution.js';
import { loadContractorTaxYear, stripeAdjustmentCsv } from '../api/owner/_contractor-tax.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
let passed = 0;
async function check(name, fn) { await fn(); passed += 1; console.log(`  ok  ${name}`); }
const DAY = 86400000;

await check('the reward is $75 after 2 paid jobs within 90 days', () => {
  assert.deepEqual({ ...EASER_REFERRAL_POLICY }, { rewardCents: 7500, qualifyingJobs: 2, windowDays: 90 });
});

await check('codes are first-name letters plus 3 digits; the link carries the code through the site attribution', () => {
  assert.equal(referralCodeCandidate('Phil Hawkins', 482), 'PHIL482');
  assert.equal(referralCodeCandidate("D'Andre O'Neil", 7), 'DANDRE007');
  assert.equal(referralCodeCandidate('', 123), 'EASER123');
  assert.equal(normalizeReferralCode('phil482'), 'PHIL482');
  for (const bad of ['', 'PHIL', '482', 'PHIL48', 'TOOLONGNAME123', 'PH-IL482', null]) assert.equal(normalizeReferralCode(bad), null, String(bad));
  const link = referralLink('PHIL482');
  assert.equal(link, 'https://www.assembleatease.com/become-an-easer?utm_source=easer_referral&utm_medium=referral&utm_campaign=referral_phil482');
  // What the browser captures from that link survives the server's cleaner.
  const cleaned = cleanAcquisitionAttribution({ utmSource: 'easer_referral', utmMedium: 'referral', utmCampaign: 'referral_phil482', landingPath: '/become-an-easer' });
  assert.equal(cleaned.utmSource, 'easer_referral');
  assert.equal(cleaned.utmCampaign, 'referral_phil482');
  assert.equal(cleaned.channel, 'referral');
  assert.equal(cleaned.entryAudience, 'easer');
  assert.equal(referralCodeFromAttribution(cleaned), 'PHIL482');
  assert.equal(referralCodeFromAttribution({ utmSource: 'partner', utmCampaign: 'referral_phil482' }), null, 'only the Easer referral source counts');
  assert.match(read('assets/js/attribution.js'), /'chatgpt\.com', 'easer_referral'\]\.indexOf\(source\)/, 'the browser keeps the same source list');
});

function fakeSb({ referrer, failInsert = false } = {}) {
  const writes = { profiles: [], rewards: [] };
  return {
    writes,
    from(table) {
      if (table === 'profiles') {
        return {
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: referrer || null, error: null }) }) }),
          update: (values) => { writes.profiles.push(values); return { eq: () => ({ is: async () => ({ error: null }) }) }; },
        };
      }
      if (table === 'easer_referral_rewards') {
        return { insert: async (row) => { writes.rewards.push(row); return { error: failInsert ? { message: 'relation does not exist' } : null }; } };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
}
const attribution = { utmSource: 'easer_referral', utmCampaign: 'referral_phil482' };
const phil = { id: 'phil', role: 'assembler', status: 'active', account_closure_status: null, referral_code: 'PHIL482' };

await check('an application through the link credits an active Easer once, as a pending reward', async () => {
  const sb = fakeSb({ referrer: phil });
  const r = await recordReferralFromAttribution(sb, { refereeId: 'new1', attribution, nowIso: '2026-11-22T10:00:00Z' });
  assert.deepEqual(r, { recorded: true, referrerId: 'phil', code: 'PHIL482' });
  assert.deepEqual(sb.writes.profiles[0], { referred_by_easer_id: 'phil' });
  assert.equal(sb.writes.rewards[0].status, 'pending');
  assert.equal(sb.writes.rewards[0].amount_cents, 7500);
  assert.equal(sb.writes.rewards[0].referred_at, '2026-11-22T10:00:00Z');
});
await check('no credit for a self-referral, an unknown code, an inactive referrer or no code', async () => {
  assert.equal((await recordReferralFromAttribution(fakeSb({ referrer: phil }), { refereeId: 'phil', attribution })).reason, 'self_referral');
  assert.equal((await recordReferralFromAttribution(fakeSb({}), { refereeId: 'new1', attribution })).reason, 'unknown_code');
  assert.equal((await recordReferralFromAttribution(fakeSb({ referrer: { ...phil, status: 'suspended' } }), { refereeId: 'new1', attribution })).reason, 'referrer_not_active');
  assert.equal((await recordReferralFromAttribution(fakeSb({ referrer: phil }), { refereeId: 'new1', attribution: {} })).reason, 'no_code');
});
await check('a referral can never block an application', async () => {
  const r = await recordReferralFromAttribution(fakeSb({ referrer: phil, failInsert: true }), { refereeId: 'new1', attribution });
  assert.equal(r.recorded, false);
  const broken = { from() { throw new Error('database down'); } };
  assert.equal((await recordReferralFromAttribution(broken, { refereeId: 'new1', attribution })).reason, 'error');
  const apply = read('api/assembler/apply.js');
  assert.match(apply, /await recordReferralFromAttribution\(sb, \{ refereeId: userId, attribution: coreProfile\.application_attribution \}\);/);
});

await check('earned after 2 paid jobs; voided when the window passes or the new Easer is rejected', () => {
  const reward = { status: 'pending', qualifying_jobs: 2, referred_at: '2026-11-22T10:00:00Z' };
  const t0 = Date.parse(reward.referred_at);
  assert.deepEqual(referralRewardDecision(reward, { completedJobs: 1, nowMs: t0 + 10 * DAY }), { action: 'wait' });
  assert.deepEqual(referralRewardDecision(reward, { completedJobs: 2, nowMs: t0 + 10 * DAY }), { action: 'earned' });
  assert.deepEqual(referralRewardDecision(reward, { completedJobs: 1, nowMs: t0 + 91 * DAY }), { action: 'void', reason: 'window_expired' });
  assert.deepEqual(referralRewardDecision(reward, { completedJobs: 0, referee: { application_status: 'rejected' }, nowMs: t0 + DAY }), { action: 'void', reason: 'referee_not_approved' });
  assert.deepEqual(referralRewardDecision({ ...reward, status: 'paid' }, { completedJobs: 5 }), { action: 'none' });
});
await check('only completed, captured, non-test jobs inside the window count', async () => {
  const sb = { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ gte: () => ({ lte: async () => ({ data: [
    { status: 'completed', payment_status: 'captured', is_test_booking: false },
    { status: 'completed', payment_status: 'captured', is_test_booking: true },
    { status: 'completed', payment_status: 'authorized', is_test_booking: false },
    { status: 'completed', payment_status: 'captured', is_test_booking: null },
  ], error: null }) }) }) }) }) }) };
  assert.equal(await qualifyingJobCount(sb, { refereeId: 'new1', referredAt: '2026-11-22T10:00:00Z' }), 2);
});

await check('paid rewards are contractor income; outside-Stripe ones go into the Stripe delta file', async () => {
  const tables = {
    payout_ledger: [],
    bookings: [{ id: 'b1', status: 'completed', assembler_id: 'phil', assembler_name: 'Phil', payout_amount: 100000, easer_reimbursement_cents: 2000, stripe_destination_account_id: 'acct_PHIL', stripe_transfer_id: 'tr_1', stripe_transfer_created_at: '2026-06-01T00:00:00Z' }],
    easer_referral_rewards: [
      { referrer_id: 'phil', status: 'paid', amount_cents: 7500, paid_at: '2026-07-01T00:00:00Z', paid_method: 'outside_stripe' },
      { referrer_id: 'phil', status: 'paid', amount_cents: 7500, paid_at: '2026-08-01T00:00:00Z', paid_method: 'stripe_transfer' },
      { referrer_id: 'phil', status: 'earned', amount_cents: 7500, paid_at: null, paid_method: null },
    ],
  };
  class Q {
    constructor(t) { this.t = t; this.f = []; }
    select() { return this; }
    gte(k, v) { this.f.push(r => r[k] != null && r[k] >= v); return this; }
    lt(k, v) { this.f.push(r => r[k] != null && r[k] < v); return this; }
    not(k, _op, v) { this.f.push(r => (r[k] ?? null) !== v); return this; }
    then(res, rej) { return Promise.resolve({ data: (tables[this.t] || []).filter(r => this.f.every(f => f(r))), error: null }).then(res, rej); }
  }
  const tax = await loadContractorTaxYear({ from: t => new Q(t) }, 2026);
  const p = tax.easers.find(e => e.assemblerId === 'phil');
  assert.equal(p.referralPaidCents, 15000);
  assert.equal(p.ytdPaidCents, 98000 + 15000, 'job pay minus reimbursement, plus both paid rewards');
  assert.equal(stripeAdjustmentCsv(tax.easers), 'stripe_account_id,nonemployee_compensation_delta\nacct_PHIL,55.00\n',
    'Stripe saw the Stripe-sent reward; the outside one (+75) and the reimbursement (-20) are the delta');
});

await check('the owner records payment; nothing here moves money; the Easer sees first names only', () => {
  const owner = read('api/owner/referral-rewards.js');
  assert.match(owner, /verifyOwner\(req\)/);
  assert.match(owner, /\['stripe_transfer', 'outside_stripe'\]\.includes\(method\)/);
  assert.match(owner, /\.eq\('status', 'earned'\)/, 'only an earned reward can be marked paid');
  assert.doesNotMatch(owner, /stripe\.transfers|transfers\.create/, 'no money moves from this endpoint');
  assert.equal(refereeDisplayName('Georgette Hernandez'), 'Georgette');
  const easer = read('api/assembler/referral.js');
  assert.match(easer, /name: names\.get\(r\.referee_id\)/);
  assert.doesNotMatch(easer, /email|phone/i, 'no contact details of the referred person');
  const cron = read('api/cron/referral-rewards.js');
  assert.match(cron, /process\.env\.CRON_SECRET/);
  assert.match(cron, /notificationKey: `referral-earned:\$\{reward\.id\}:owner`/);
  assert.ok(JSON.parse(read('vercel.json')).crons.some(c => c.path === '/api/cron/referral-rewards'));
});
await check('migration 134 matches the code', () => {
  const sql = read('api/migrations/134_easer_referrals.sql');
  assert.match(sql, /ADD COLUMN IF NOT EXISTS referral_code TEXT,/);
  assert.match(sql, /referred_by_easer_id UUID REFERENCES public\.profiles\(id\) ON DELETE SET NULL/);
  assert.match(sql, /CHECK \(referral_code IS NULL OR referral_code ~ '\^\[A-Z\]\{1,8\}\[0-9\]\{3\}\$'\)/);
  assert.match(sql, /referee_id\s+uuid NOT NULL UNIQUE/);
  assert.match(sql, /CHECK \(status IN \('pending', 'earned', 'paid', 'void'\)\)/);
  assert.match(sql, /paid_method IN \('stripe_transfer', 'outside_stripe'\)/);
});

console.log(`easer referrals: ${passed} checks passed`);
