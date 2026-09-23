import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { notificationRetryEligibility } from '../api/_notification-retry-eligibility.js';
import { ASSEMBLECASH } from '../api/_assemblecash.js';
import { DISPATCH_OFFER_STATUS } from '../api/_source-of-truth.js';

// Real handler/eligibility code, isolated persistence and provider doubles.
// No environment file, network, live database, or outbound message is used.
const NOW = '2026-09-23T07:00:00.000Z';
const ago = days => new Date(Date.parse(NOW) - days * 86400000).toISOString();
class Clock extends Date {
  constructor(...args) { super(...(args.length ? args : [NOW])); }
  static now() { return Date.parse(NOW); }
}
function database(initial = {}) {
  const rows = structuredClone(initial);
  const db = { rows, fail: null, from(table) {
    rows[table] ||= [];
    let patch, order, limit = Infinity;
    const predicates = [];
    const query = {
      select() { return query; },
      eq(key, value) { predicates.push(row => row[key] === value); return query; },
      is(key, value) { predicates.push(row => row[key] == value); return query; },
      in(key, values) { predicates.push(row => values.includes(row[key])); return query; },
      gte(key, value) { predicates.push(row => row[key] >= value); return query; },
      update(value) { patch = value; return query; },
      order(key, { ascending }) { order = { key, ascending }; return query; },
      limit(value) { limit = value; return query; },
      then(resolve, reject) {
        return Promise.resolve().then(() => {
          if (db.fail?.(table, patch)) return { data: null, error: { message: 'database unavailable' } };
          let data = rows[table].filter(row => predicates.every(test => test(row)));
          if (order) data.sort((a, b) => String(a[order.key]).localeCompare(String(b[order.key])) * (order.ascending ? 1 : -1));
          data = data.slice(0, limit);
          if (patch) data.forEach(row => Object.assign(row, patch));
          return { data: structuredClone(data), error: null };
        }).then(resolve, reject);
      },
    };
    return query;
  } };
  return db;
}
const profile = overrides => ({ id: 'easer-1', full_name: 'Casey Test', email: 'casey@example.com', role: 'assembler', status: 'active',
  tier: 'starter', completed_jobs: 4, rating: 4.9, identity_verified: true, acceptance_rate: 60,
  tier_grace_started_at: null, coaching_email_at: null, acceptance_alert_at: null, reliability_alert_count: 0, ...overrides });
const source = (await readFile(new URL('../api/cron/tier-check.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\r?\n/gm, '').replace('export default async function', 'async function');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
process.env.CRON_SECRET = 'offline-tier-test';
async function fixture(overrides = {}, noShows = 0) {
  const sb = database({ profiles: [profile(overrides)], activity_logs: Array.from({ length: noShows }, () => ({ event_type: 'no_show_flagged', metadata: { assemblerId: 'easer-1' } })) });
  const messages = [], logs = [];
  let outcome = { ok: false, error: 'provider rejected' }, beforeSend;
  const deps = { getSupabase: () => sb, Date: Clock, console: { log() {}, error() {} }, esc: value => String(value || ''),
    ownerEmail: () => 'owner@example.com', logCron: async (_name, result) => logs.push(result),
    sendEmail: async message => { messages.push(message); beforeSend?.(); if (outcome instanceof Error) throw outcome; return outcome; } };
  const { handler, deservedTier } = await new AsyncFunction(...Object.keys(deps), `${source}\nreturn {handler,deservedTier};`)(...Object.values(deps));
  return { sb, messages, logs, deservedTier, setOutcome(value) { outcome = value; }, beforeSend(fn) { beforeSend = fn; },
    async run() { const res = { status(value) { this.code = value; return this; }, json(value) { this.body = value; return this; } };
      await handler({ headers: { authorization: 'Bearer offline-tier-test' } }, res); assert.equal(res.code, 200); return res.body; } };
}

for (const test of [
  { label: 'coaching', field: 'coaching_email_at', counter: 'coachingEmails', overrides: {}, noShows: 0, key: 'coaching:easer-1:initial' },
  { label: 'chronic decline', field: 'acceptance_alert_at', counter: 'ownerAlerts', overrides: { acceptance_rate: 40 }, noShows: 0, key: 'reliability:easer-1:chronic_decline:initial' },
  { label: 'repeat no-show', field: 'reliability_alert_count', counter: 'ownerAlerts', overrides: { acceptance_rate: 90 }, noShows: 2, key: 'reliability:easer-1:no_show:2' },
]) {
  const f = await fixture(test.overrides, test.noShows);
  const before = f.sb.rows.profiles[0][test.field];
  for (const [outcome, counter] of [
    [{ ok: false, error: 'provider rejected' }, 'notificationsFailed'],
    [{ ok: false, deferred: true }, 'notificationsQueued'],
    [{ ok: false, retryScheduled: true, logged: true }, 'notificationsQueued'],
    [{ ok: false, retryScheduled: true, logged: false }, 'notificationsFailed'],
    [new Error('provider threw'), 'notificationsFailed'],
  ]) {
    f.setOutcome(outcome);
    const result = await f.run();
    assert.equal(f.sb.rows.profiles[0][test.field], before, `${test.label} failed/queued marker must remain unchanged`);
    assert.equal(result[test.counter], 0); assert.equal(result[counter], 1);
    assert.equal(f.messages.at(-1).meta.notificationKey, test.key, 'retry event identity must remain stable');
    assert.equal(f.logs.at(-1).status, counter === 'notificationsFailed' ? 'error' : 'ok');
  }
  const acceptedAt = ago(0.5);
  f.setOutcome({ ok: true, suppressed: true, sentAt: acceptedAt });
  const reconciled = await f.run();
  assert.equal(reconciled[test.counter], 1);
  assert.equal(reconciled.notificationsAlreadySent, 1);
  assert.equal(reconciled.notificationsSent, 0);
  assert.equal(f.sb.rows.profiles[0][test.field], test.noShows || acceptedAt, 'previously accepted queue result reconciles the marker with actual delivery time');
  const calls = f.messages.length;
  await f.run(); assert.equal(f.messages.length, calls, 'successful marker prevents another request during cooldown');
}

// A new cooldown period has a new event; a previous accepted delivery can
// reconcile a lost marker write without replaying the previous provider send.
{
  const f = await fixture({ coaching_email_at: ago(31) });
  f.setOutcome({ ok: true });
  f.sb.fail = (table, patch) => table === 'profiles' && Boolean(patch?.coaching_email_at);
  const failedMarker = await f.run();
  assert.equal(failedMarker.notificationsSent, 1); assert.equal(failedMarker.notificationMarkerFailures, 1);
  assert.equal(failedMarker.coachingEmails, 0);
  assert.equal(f.sb.rows.profiles[0].coaching_email_at, ago(31));
  const key = f.messages.at(-1).meta.notificationKey;
  f.sb.fail = null; f.setOutcome({ ok: true, suppressed: true, sentAt: NOW });
  const reconciled = await f.run();
  assert.equal(f.messages.at(-1).meta.notificationKey, key);
  assert.equal(reconciled.coachingEmails, 1); assert.equal(f.sb.rows.profiles[0].coaching_email_at, NOW);
}
{
  const f = await fixture();
  f.setOutcome({ ok: true, suppressed: true, sentAt: ago(1) });
  f.beforeSend(() => { f.sb.rows.profiles[0].coaching_email_at = NOW; });
  const result = await f.run();
  assert.equal(result.coachingEmails, 0, 'concurrent reconciliation must not overwrite or double-count the marker');
  assert.equal(f.sb.rows.profiles[0].coaching_email_at, NOW);
}
{
  const f = await fixture({ email: '' });
  const result = await f.run();
  assert.equal(result.notificationsFailed, 1); assert.equal(result.coachingEmails, 0); assert.equal(f.messages.length, 0);
}

// Notification failure never rolls back or mislabels an actual tier transition.
for (const test of [
  { overrides: { completed_jobs: 30, acceptance_rate: 90 }, state: 'elite', count: 'promoted', kind: 'promoted' },
  { overrides: { tier: 'elite', acceptance_rate: 75 }, state: 'elite', count: 'graceStarted', kind: 'grace' },
  { overrides: { tier: 'elite', acceptance_rate: 75, tier_grace_started_at: ago(31) }, state: 'professional', count: 'demoted', kind: 'demoted' },
]) {
  for (const outcome of [{ ok: false, error: 'rejected' }, { ok: false, deferred: true }, { ok: true }]) {
    const f = await fixture(test.overrides); f.setOutcome(outcome);
    const result = await f.run();
    assert.equal(result[test.count], 1); assert.equal(f.sb.rows.profiles[0].tier, test.state);
    assert.equal(result[outcome.ok ? 'notificationsSent' : outcome.deferred ? 'notificationsQueued' : 'notificationsFailed'], 1);
    assert.equal(f.messages[0].meta.notificationKey, `tier:easer-1:${test.kind}:${test.state}:${NOW}`);
    assert.equal(f.messages[0].meta.routine, true);
  }
}
{
  const f = await fixture({ tier: 'professional', completed_jobs: 10, acceptance_rate: 80, tier_grace_started_at: ago(1) });
  const result = await f.run();
  assert.equal(result.graceCleared, 1); assert.equal(f.messages.length, 0);
  assert.equal(f.deservedTier(profile({ completed_jobs: 30, acceptance_rate: 85, rating: 4.8, completion_rate: 95 })), 'elite');
  assert.equal(f.deservedTier(profile({ completed_jobs: 30, acceptance_rate: 85, rating: 4.8, completion_rate: 94 })), 'professional');
  assert.equal(f.deservedTier(profile({ completed_jobs: 10, acceptance_rate: 80, rating: 4.5, completion_rate: 90 })), 'professional');
  assert.equal(f.deservedTier(profile({ completed_jobs: 10, acceptance_rate: null })), 'starter');
  assert.equal(f.deservedTier(profile({ completed_jobs: 30, acceptance_rate: 90, identity_verified: false })), 'starter');
}

// Queued dispatch offers must still be the exact open, unexpired offer.
{
  const expiry = new Date(Date.parse(NOW) + 600000).toISOString();
  const offer = { id: 'offer-1', booking_id: 'booking-1', easer_id: 'easer-1', offer_status: DISPATCH_OFFER_STATUS.SENT, expires_at: expiry };
  const sb = database({ dispatch_offers: [offer] });
  const row = { notification_type: 'dispatch_offer', booking_id: 'booking-1', recipient_user_id: 'easer-1' };
  const check = () => notificationRetryEligibility(sb, row, { meta: { expiresAt: expiry } }, null, new Date(NOW));
  assert.equal((await check()).ok, true);
  for (const change of [ { offer_status: DISPATCH_OFFER_STATUS.ACCEPTED }, { offer_status: 'declined' }, { expires_at: ago(1) }, { expires_at: new Date(Date.parse(expiry) + 60000).toISOString() }, { easer_id: 'different' }, { booking_id: 'different' } ]) {
    sb.rows.dispatch_offers[0] = { ...offer, ...change };
    assert.equal((await check()).reason, 'dispatch_offer_no_longer_available');
  }
  sb.rows.dispatch_offers[0] = offer;
  assert.equal((await notificationRetryEligibility(sb, row, { meta: { expiresAt: expiry } }, null, new Date(expiry))).ok, false, 'offer expires exactly at cutoff');
  sb.fail = () => true; assert.equal((await check()).retryable, true);
}

// Only the newest code may be retried; consumption must not resurrect an older
// pending code. Hash, lifetime, and attempt limit are checked again at send time.
{
  const code = { email: 'casey@example.com', purpose: 'assemblecash', code_hash: 'offline-hash', created_at: ago(0.002), expires_at: new Date(Date.parse(NOW) + 600000).toISOString(), attempts: 0, consumed_at: null };
  const sb = database({ customer_verification_codes: [code] });
  const row = { notification_type: 'assemblecash_access_code', recipient_email: code.email };
  const check = () => notificationRetryEligibility(sb, row, { meta: { verificationCodeHash: code.code_hash } }, null, new Date(NOW));
  assert.equal((await check()).ok, true);
  for (const change of [ { code_hash: 'replacement-hash' }, { expires_at: NOW }, { attempts: ASSEMBLECASH.CODE_MAX_ATTEMPTS }, { consumed_at: NOW } ]) {
    sb.rows.customer_verification_codes[0] = { ...code, ...change };
    assert.equal((await check()).reason, 'verification_code_replaced_or_expired');
  }
  sb.rows.customer_verification_codes = [{ ...code }, { ...code, code_hash: 'newest-hash', created_at: ago(0.001) }];
  assert.equal((await check()).ok, false, 'a newer code invalidates an older queued hash');
  sb.rows.customer_verification_codes[1].consumed_at = NOW;
  assert.equal((await check()).ok, false, 'consuming the newest code cannot revive an older queued hash');
  sb.rows.customer_verification_codes = [{ ...code, attempts: ASSEMBLECASH.CODE_MAX_ATTEMPTS - 1 }];
  assert.equal((await check()).ok, true);
  sb.fail = () => true; assert.equal((await check()).retryable, true);
}

console.log('Tier/coaching delivery truth and dispatch/access-code retry eligibility: PASS');
