import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { canSendPostjobMessage, loadPostjobSuppressions } from '../api/_postjob-notifications.js';
import { broadcastFooter, unsubscribeUrl } from '../api/_broadcast.js';
import { isReminderDue } from '../api/_announcements.js';
import { governedSend, describeGovernedRun } from '../api/_send-governor.js';
import { normalizeEmail } from '../api/_broadcast.js';

// Execute the real cron/handler bodies with isolated in-memory persistence and
// provider doubles. No environment file, network, live DB, or message is used.
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
async function loadHandler(path, dependencies, exports = 'handler') {
  const source = (await readFile(new URL(`../${path}`, import.meta.url), 'utf8'))
    .replace(/^import .*;\r?\n/gm, '')
    .replace(/export default async function/g, 'async function')
    .replace(/export async function/g, 'async function')
    .replace(/export const/g, 'const');
  return new AsyncFunction(...Object.keys(dependencies), `${source}\nreturn {${exports}};`)(...Object.values(dependencies));
}

function database(initial = {}) {
  const rows = structuredClone(initial);
  const failures = new Map();
  const db = {
    rows, failures,
    from(table) {
      rows[table] ||= [];
      let op = 'select', payload, single = false;
      const predicates = [];
      const query = {
        select() { return query; },
        eq(field, value) { predicates.push(row => row[field] === value); return query; },
        in(field, values) { predicates.push(row => values.includes(row[field])); return query; },
        is(field, value) { predicates.push(row => row[field] == value); return query; },
        not(field, operator, value) {
          if (operator === 'in') predicates.push(row => !value.slice(1, -1).split(',').includes(row[field]));
          return query;
        },
        gte(field, value) { predicates.push(row => row[field] >= value); return query; },
        gt(field, value) { predicates.push(row => row[field] > value); return query; },
        lt(field, value) { predicates.push(row => row[field] < value); return query; },
        or() { return query; }, limit() { return query; },
        maybeSingle() { single = true; return query; },
        single() { single = true; return query; },
        update(value) { op = 'update'; payload = structuredClone(value); return query; },
        insert(value) { op = 'insert'; payload = structuredClone(value); return query; },
        then(resolve, reject) {
          return Promise.resolve().then(() => {
            const error = failures.get(`${table}:${op}`);
            if (error) return { data: null, error: { message: error } };
            let data = rows[table].filter(row => predicates.every(predicate => predicate(row)));
            if (op === 'insert') {
              data = (Array.isArray(payload) ? payload : [payload]).map(row => ({ id: `${table}-${rows[table].length + 1}`, ...row }));
              rows[table].push(...data);
            } else if (op === 'update') {
              data.forEach(row => Object.assign(row, payload));
            }
            return { data: structuredClone(single ? data[0] || null : data), error: null };
          }).then(resolve, reject);
        },
      };
      return query;
    },
  };
  return db;
}

const age = days => new Date(Date.now() - days * 86400000).toISOString();
const booking = overrides => ({
  id: 'booking-1', ref: 'AAE-TEST', service: 'Furniture Assembly', customer_name: 'Casey',
  customer_email: 'casey@example.com', status: 'completed', completed_at: age(2.1),
  is_test_booking: false, return_visit_required: false, review_request_count: 0,
  ...overrides,
});
const request = { headers: { authorization: 'Bearer offline-test' } };
process.env.CRON_SECRET = 'offline-test';
process.env.EMAIL_MIN_SEND_INTERVAL_MS = '1';
const response = () => ({ statusCode: null, body: null, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } });
const esc = value => String(value || '').replaceAll('&', '&amp;').replaceAll('<', '&lt;');
const dependencies = sb => ({
  getSupabase: () => sb, ownerEmail: () => 'owner@example.com', esc,
  issueReviewToken: () => 'offline-token',
  buildReviewEmail: step => ({ subject: `Review ${step}`, html: '<body>Review</body>' }),
  completionPhotoUrl: async () => null,
  bookingsWithOpenCase: async (_sb, ids) => new Set((sb.rows.operations_cases || []).filter(row => ids.includes(row.booking_id) && !['closed', 'resolved'].includes(row.status)).map(row => row.booking_id)),
  minSendIntervalMs: () => 0, remainingDailyBudget: async () => ({ remaining: 20 }),
  canSendPostjobMessage, loadPostjobSuppressions, broadcastFooter, unsubscribeUrl,
  logActivity: async (_sb, event) => {
    const result = await sb.from('activity_logs').insert({ booking_id: event.bookingId, event_type: event.eventType, description: event.description });
    return { ok: !result.error, error: result.error?.message };
  },
});

// Failure/defer never consumes a review. At most two successful requests, with
// five days between actual accepted sends; a previous three-send cohort stops.
{
  const sb = database({ bookings: [booking()], reviews: [], email_suppressions: [] });
  const messages = [];
  let outcome = { ok: false, error: 'provider rejected' };
  const { handler } = await loadHandler('api/cron/review-request.js', { ...dependencies(sb), sendEmail: async message => { messages.push(message); return outcome; } });
  await handler(request, response());
  assert.equal(sb.rows.bookings[0].review_request_count, 0);
  outcome = { ok: false, deferred: true };
  await handler(request, response());
  assert.equal(sb.rows.bookings[0].review_request_count, 0);
  outcome = { ok: true };
  await handler(request, response());
  assert.equal(sb.rows.bookings[0].review_request_count, 1);
  assert.equal(messages.at(-1).meta.notificationKey, 'review:booking-1:1');
  assert.equal(messages.at(-1).meta.routine, true);
  assert.match(messages.at(-1).html, /Unsubscribe/);
  const before = messages.length;
  await handler(request, response());
  assert.equal(messages.length, before);
  sb.rows.bookings[0].review_requested_at = age(5.1);
  sb.rows.bookings[0].completed_at = age(7.2);
  await handler(request, response());
  assert.equal(sb.rows.bookings[0].review_request_count, 2);
  assert.equal(messages.at(-1).meta.notificationKey, 'review:booking-1:2');
  sb.rows.bookings[0].review_requested_at = age(10);
  const capped = messages.length;
  await handler(request, response());
  assert.equal(messages.length, capped);
}

for (const fixture of [
  { overrides: { is_test_booking: true } },
  { overrides: { return_visit_required: true } },
  { cases: [{ booking_id: 'booking-1', status: 'open' }] },
  { suppressed: [{ email: ' CASEY@EXAMPLE.COM ' }] },
  { reviewed: [{ booking_id: 'booking-1' }] },
]) {
  const sb = database({ bookings: [booking(fixture.overrides)], operations_cases: fixture.cases || [], email_suppressions: fixture.suppressed || [], reviews: fixture.reviewed || [] });
  let calls = 0;
  const { handler } = await loadHandler('api/cron/review-request.js', { ...dependencies(sb), sendEmail: async () => { calls++; return { ok: true }; } });
  await handler(request, response());
  assert.equal(calls, 0, 'review must stop for test, return, case, preference or existing review');
}

// The rebooking follow-up respects the same gates and existing opt-out source,
// never marks failed/deferred sends, and fails closed on dedupe/preference errors.
{
  const sb = database({ bookings: [booking({ completed_at: age(22) })], email_suppressions: [] });
  let outcome = { ok: false };
  const messages = [];
  const { handler } = await loadHandler('api/cron/followup.js', { ...dependencies(sb), sendEmail: async message => { messages.push(message); return outcome; } });
  await handler(request, response());
  assert.equal(sb.rows.activity_logs.length, 0);
  outcome = { ok: false, deferred: true };
  await handler(request, response());
  assert.equal(sb.rows.activity_logs.length, 0);
  outcome = { ok: true };
  sb.failures.set('activity_logs:select', 'history unavailable');
  const before = messages.length;
  await handler(request, response());
  assert.equal(messages.length, before);
  sb.failures.clear();
  await handler(request, response());
  assert.equal(sb.rows.activity_logs.length, 1);
  assert.match(sb.rows.activity_logs[0].description, /provider accepted/);
  assert.equal(messages.at(-1).meta.notificationKey, 'followup:booking-1');
  assert.match(messages.at(-1).html, /Unsubscribe/);
  assert.doesNotMatch(messages.at(-1).html, /make it right|pay-after-completion/);
  const accepted = messages.length;
  await handler(request, response());
  assert.equal(messages.length, accepted);
}
for (const overrides of [{ is_test_booking: true }, { return_visit_required: true }]) {
  const sb = database({ bookings: [booking({ completed_at: age(22), ...overrides })] });
  const { handler } = await loadHandler('api/cron/followup.js', { ...dependencies(sb), sendEmail: async () => assert.fail('excluded follow-up was sent') });
  await handler(request, response());
}
for (const extra of [
  { operations_cases: [{ booking_id: 'booking-1', status: 'awaiting_customer' }] },
  { email_suppressions: [{ email: 'casey@example.com' }] },
]) {
  const sb = database({ bookings: [booking({ completed_at: age(22) })], ...extra });
  const { handler } = await loadHandler('api/cron/followup.js', { ...dependencies(sb), sendEmail: async () => assert.fail('unresolved or opted-out follow-up must stop') });
  await handler(request, response());
}
{
  const sb = database({ bookings: [booking({ completed_at: age(22) })] });
  sb.failures.set('email_suppressions:select', 'unavailable');
  const { handler } = await loadHandler('api/cron/followup.js', { ...dependencies(sb), sendEmail: async () => assert.fail('failed preference lookup must stop send') });
  const res = response(); await handler(request, res); assert.equal(res.statusCode, 503);
}

const announcement = { id: 'campaign-1', key: 'setup', title: 'Complete setup', body: 'Open your account.', channels: ['in_app', 'email', 'push'], reminder_days: [0, 2, 5] };
const easer = { id: 'easer-1', email: 'easer@example.com' };
const announcementDeps = sb => ({
  ...dependencies(sb), sendEmail: async () => ({ ok: true }), sendPushToUser: async () => ({ ok: true }),
  acquireNotificationLease: async () => ({ ok: true, token: 'test-lease' }), releaseNotificationLease: async () => {},
  ruleFor: () => ({ query: async () => ({ data: [easer] }) }),
  isReminderDue,
  loadActiveAnnouncements: async () => [announcement], logCron: async () => {},
});
const counters = () => ({ sent: 0, completed: 0, announcements: 0, targetsSeen: 0 });

for (const failedChannel of ['email', 'push']) {
  const sb = database();
  const calls = { email: 0, push: 0 };
  let failing = true;
  const deps = announcementDeps(sb);
  deps.sendEmail = async () => { calls.email++; return failedChannel === 'email' && failing ? { ok: false, deferred: true } : { ok: true }; };
  deps.sendPushToUser = async () => { calls.push++; return failedChannel === 'push' && failing ? { ok: false, reason: 'push_delivery_failed' } : { ok: true }; };
  const { processAnnouncement } = await loadHandler('api/cron/easer-announcements.js', deps, 'processAnnouncement');
  await processAnnouncement(sb, announcement, counters(), { sleep: async () => {} });
  const delivery = sb.rows.easer_announcement_deliveries[0];
  assert.equal(delivery.reminder_count, 1, 'one outbound success consumes one step');
  assert.ok(!delivery.channels_sent.includes(failedChannel), 'failed/deferred channel must not say sent');
  failing = false;
  await processAnnouncement(sb, announcement, counters(), { sleep: async () => {} });
  assert.equal(delivery.reminder_count, 1, 'partial retry never consumes another reminder');
  assert.equal(calls[failedChannel], 2);
  assert.equal(calls[failedChannel === 'email' ? 'push' : 'email'], 1, 'successful channel is never replayed');
  await processAnnouncement(sb, announcement, counters(), { sleep: async () => {} });
  assert.deepEqual(calls, failedChannel === 'email' ? { email: 2, push: 1 } : { email: 1, push: 2 });
}
{
  const sb = database();
  const deps = announcementDeps(sb);
  deps.sendEmail = async () => ({ ok: false });
  deps.sendPushToUser = async () => ({ ok: false, reason: 'no_push_subscriptions' });
  const { processAnnouncement } = await loadHandler('api/cron/easer-announcements.js', deps, 'processAnnouncement');
  const result = counters(); await processAnnouncement(sb, announcement, result);
  const row = sb.rows.easer_announcement_deliveries[0];
  assert.equal(row.reminder_count || 0, 0);
  assert.equal(row.first_notified_at, undefined);
  assert.deepEqual(row.channels_sent, ['in_app']);
  assert.equal(result.sent, 0);
}
{
  const sb = database();
  const deps = announcementDeps(sb);
  let pushes = 0;
  deps.sendPushToUser = async () => { pushes++; throw new Error('ambiguous timeout'); };
  const { processAnnouncement } = await loadHandler('api/cron/easer-announcements.js', deps, 'processAnnouncement');
  await processAnnouncement(sb, announcement, counters());
  await processAnnouncement(sb, announcement, counters());
  assert.equal(pushes, 1, 'ambiguous push outcome must not be replayed');
  assert.deepEqual(sb.rows.easer_announcement_deliveries[0].reminder_state.uncertain_channels, ['push']);
}
{
  const sb = database();
  const deps = announcementDeps(sb);
  deps.acquireNotificationLease = async () => ({ ok: false, reason: 'busy' });
  deps.sendEmail = async () => assert.fail('overlapping announcement run must not send');
  const { processAnnouncement } = await loadHandler('api/cron/easer-announcements.js', deps, 'processAnnouncement');
  await processAnnouncement(sb, announcement, counters());
  assert.equal(sb.rows.easer_announcement_deliveries.length, 0);
}
{
  const sb = database({
    easer_announcements: [announcement],
    easer_announcement_deliveries: [{ id: 'delivery-1', announcement_id: announcement.id, easer_id: easer.id,
      reminder_count: 3, first_notified_at: age(6), last_reminded_at: age(1), completed_at: null,
      channels_sent: ['email'], reminder_state: { cycle: 'initial', step: 3, sent_channels: ['email'], completed_channels: ['email', 'push'], uncertain_channels: [] } }],
  });
  const deps = announcementDeps(sb);
  const keys = [];
  deps.sendEmail = async message => { keys.push(message.meta.notificationKey); return { ok: true }; };
  let sequence = 0;
  const { handler } = await loadHandler('api/owner/announcement-adoption.js', {
    ...deps, verifyOwner: () => true, randomUUID: () => `owner-cycle-${++sequence}`,
  });
  const req = { method: 'POST', body: { key: 'setup', easerId: easer.id } };
  const { processAnnouncement } = await loadHandler('api/cron/easer-announcements.js', deps, 'processAnnouncement');
  await handler(req, response());
  assert.equal(sb.rows.easer_announcement_deliveries[0].reminder_count, 0);
  await processAnnouncement(sb, announcement, counters());
  assert.match(keys[0], /owner-cycle-1:1:email$/);
  await handler(req, response());
  await processAnnouncement(sb, announcement, counters());
  assert.match(keys[1], /owner-cycle-2:1:email$/);
  assert.notEqual(keys[0], keys[1], 'deliberate owner reset gets a new event identity');
}

// The business inquiry uses the common logged sender and preserves failure
// truth without dropping the owner lead when only the acknowledgement fails.
{
  const { createHash } = await import('node:crypto');
  const messages = [];
  let failOwner = true;
  const { handler } = await loadHandler('api/business-inquiry.js', {
    createHash, ownerEmail: () => 'owner@example.com', escapeHtml: esc,
    rateLimit: async () => true, normalizeUsPhone: value => value, formatUsPhone: value => value,
    upsertContact: async () => null, addNote: async () => {},
    sendEmail: async message => { messages.push(message); return { ok: message.meta.recipientType === 'owner' ? !failOwner : false }; },
  });
  const req = { method: 'POST', headers: {}, body: { name: 'Casey', email: 'casey@example.com', company: 'Example', type: 'Office assembly', details: 'Two desks' } };
  const first = response(); await handler(req, first);
  assert.equal(first.statusCode, 503);
  assert.equal(messages.length, 1);
  failOwner = false;
  const second = response(); await handler(req, second);
  assert.equal(second.statusCode, 200);
  assert.equal(first.body.ref, second.body.ref, 'identical same-day retry keeps its reference');
  assert.equal(messages[0].meta.notificationKey, messages[1].meta.notificationKey);
  assert.equal(messages[2].meta.notificationType, 'business_inquiry_received');
}

// Conditions can change during quiet hours or channel spacing. The worker
// rechecks eligibility at delivery time and distinguishes outages from stops.
{
  const sb = database({ bookings: [booking()], reviews: [], email_suppressions: [] });
  const { notificationRetryEligibility: eligible } = await loadHandler('api/_notification-retry-eligibility.js', {
    ...dependencies(sb), ruleFor: () => null,
  }, 'notificationRetryEligibility');
  const row = { booking_id: 'booking-1', notification_type: 'review_request_1' };
  assert.equal((await eligible(sb, row, {}, null)).ok, true);
  sb.rows.reviews.push({ booking_id: 'booking-1' });
  assert.equal((await eligible(sb, row, {}, null)).reason, 'review_already_recorded');
  sb.rows.reviews.length = 0;
  sb.rows.bookings[0].return_visit_required = true;
  assert.equal((await eligible(sb, row, {}, null)).reason, 'postjob_no_longer_eligible');
  sb.rows.bookings[0].return_visit_required = false;
  sb.rows.email_suppressions.push({ email: 'casey@example.com' });
  assert.equal((await eligible(sb, row, {}, null)).ok, false);
  sb.rows.email_suppressions.length = 0;
  sb.rows.bookings[0].review_request_count = 1;
  assert.equal((await eligible(sb, row, {}, null)).reason, 'review_request_already_recorded');
  sb.rows.bookings[0].review_request_count = 0;
  sb.failures.set('reviews:select', 'offline');
  assert.equal((await eligible(sb, row, {}, null)).retryable, true);
}
{
  const sb = database({
    easer_announcements: [{ ...announcement, status: 'active', starts_at: age(1) }],
    profiles: [{ ...easer, role: 'assembler', done: false }],
    easer_announcement_deliveries: [{ announcement_id: announcement.id, easer_id: easer.id, reminder_state: { cycle: 'initial' } }],
  });
  const { notificationRetryEligibility: eligible } = await loadHandler('api/_notification-retry-eligibility.js', {
    ...dependencies(sb), ruleFor: () => ({ active: () => true, incomplete: p => !p.done && !p.sms_opted_out_at }),
  }, 'notificationRetryEligibility');
  const row = { notification_type: 'easer_required_action_setup', recipient_user_id: easer.id, recipient_email: easer.email };
  const payload = { meta: { announcementCycle: 'initial' } };
  assert.equal((await eligible(sb, row, payload, null)).ok, true);
  sb.rows.profiles[0].done = true;
  assert.equal((await eligible(sb, row, payload, null)).reason, 'announcement_action_complete');
  sb.rows.profiles[0].done = false;
  sb.rows.profiles[0].sms_opted_out_at = age(0);
  assert.equal((await eligible(sb, row, payload, null)).ok, false);
  sb.rows.profiles[0].sms_opted_out_at = null;
  sb.rows.easer_announcement_deliveries[0].reminder_state.cycle = 'replacement';
  assert.equal((await eligible(sb, row, payload, null)).reason, 'announcement_reminder_replaced');
  sb.rows.easer_announcement_deliveries[0].reminder_state.cycle = 'initial';
  sb.rows.profiles[0].email = 'new@example.com';
  assert.equal((await eligible(sb, row, payload, null)).reason, 'announcement_recipient_changed');
  sb.rows.profiles[0].email = easer.email;
  sb.rows.easer_announcements[0].ends_at = age(0.1);
  assert.equal((await eligible(sb, row, payload, null)).reason, 'announcement_inactive');
}
{
  const sb = database();
  const result = await governedSend(['accepted', 'deferred', 'already_sent', 'failed'], async value => ({
    accepted: { ok: true }, deferred: { ok: false, deferred: true, status: 503 },
    already_sent: { ok: true, suppressed: true }, failed: { ok: false },
  })[value], { sb });
  assert.equal(result.sent, 1); assert.equal(result.deferred, 1);
  assert.equal(result.alreadySent, 1); assert.equal(result.failed, 1);
  assert.equal(result.retried, 0, 'durable queue owns deferred retries');
  assert.match(describeGovernedRun(result), /1 queued, 1 previously sent/);
  const boolResult = await governedSend([true, false], async value => value, { sb });
  assert.equal(boolResult.sent, 1); assert.equal(boolResult.failed, 1);
}
{
  const { createHash } = await import('node:crypto');
  const sb = database({ bookings: [{ customer_email: 'casey@example.com' }] });
  let outcome = { ok: false, error: 'provider unavailable' };
  const messages = [];
  const { handler } = await loadHandler('api/owner/broadcast.js', {
    ...dependencies(sb), createHash, normalizeEmail, verifyOwner: () => true, governedSend, describeGovernedRun,
    sendEmail: async message => { messages.push(message); return outcome; },
  });
  const req = { method: 'POST', body: { audience: 'past_customers', subject: 'Assembly services', bodyHtml: '<p>Services</p>', testEmail: 'casey@example.com' } };
  const failed = response(); await handler(req, failed);
  assert.equal(failed.statusCode, 502);
  assert.equal(failed.body.sent, 0);
  assert.equal(sb.rows.email_broadcasts[0].failed_count, 1, 'returned failure object cannot count as truthy success');
  delete req.body.testEmail;
  outcome = { ok: false, deferred: true };
  const queued = response(); await handler(req, queued);
  assert.equal(queued.body.sent, 0); assert.equal(queued.body.failed, 0); assert.equal(queued.body.deferred, 1);
  assert.equal(sb.rows.email_broadcasts.at(-1).deferred_count, 1);
  const key = messages.at(-1).meta.notificationKey;
  outcome = { ok: true, suppressed: true };
  const duplicate = response(); await handler(req, duplicate);
  assert.equal(duplicate.body.sent, 0); assert.equal(duplicate.body.failed, 0); assert.equal(duplicate.body.alreadySent, 1);
  assert.equal(messages.at(-1).meta.notificationKey, key, 'same-day repeated campaign retains its identity');
  const { notificationRetryEligibility: eligible } = await loadHandler('api/_notification-retry-eligibility.js', {
    ...dependencies(sb), ruleFor: () => null,
  }, 'notificationRetryEligibility');
  const row = { notification_type: 'broadcast', recipient_email: 'casey@example.com' };
  assert.equal((await eligible(sb, row, {}, null)).ok, true);
  sb.rows.email_suppressions.push({ email: 'casey@example.com' });
  assert.equal((await eligible(sb, row, {}, null)).reason, 'marketing_opted_out');
  sb.rows.email_suppressions.length = 0;
  assert.equal((await eligible(sb, row, { meta: { broadcastAudience: 'marketing_optins' } }, null)).reason, 'marketing_optin_removed');
}

console.log('Post-job, announcement channel retry, and logged business-inquiry behavior: PASS');
