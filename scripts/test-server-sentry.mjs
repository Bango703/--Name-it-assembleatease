#!/usr/bin/env node
// Server failures reach Sentry (api/_sentry.js), with nothing personal in them,
// without slowing or breaking the request that failed.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  sentryDsn, parseDsn, buildEnvelope, reportServerError, isReportableOperationalEvent, _resetSentryForTests,
} from '../api/_sentry.js';

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const TEST_DSN = 'https://publickey@o1.ingest.us.sentry.io/42';

// Where reports go.
{
  assert.equal(sentryDsn({}), '', 'nothing is sent from a laptop or CI');
  assert.equal(sentryDsn({ VERCEL_ENV: 'preview' }), '', 'nothing from preview deployments');
  const browserDsn = read('assets/js/sentry-init.js').match(/var SENTRY_DSN = '([^']+)'/)[1];
  assert.equal(sentryDsn({ VERCEL_ENV: 'production' }), browserDsn, 'production reports to the same project as the browser');
  assert.equal(sentryDsn({ VERCEL_ENV: 'production', SENTRY_DSN: TEST_DSN }), TEST_DSN);
  assert.equal(sentryDsn({ VERCEL_ENV: 'production', SENTRY_DSN: 'off' }), '', 'can be switched off without a deploy');
  assert.deepEqual(parseDsn(TEST_DSN), { key: 'publickey', envelopeUrl: 'https://o1.ingest.us.sentry.io/api/42/envelope/' });
  assert.equal(parseDsn('not a dsn'), null);
}
console.log('PASS dsn: production only, same project as the browser, can be switched off');

// What is sent.
{
  const lines = buildEnvelope({ message: 'Cron reminders failed', detail: 'boom', tags: { cron: 'reminders', empty: '' }, fingerprint: ['cron', 'reminders'], dsn: TEST_DSN, env: { VERCEL_ENV: 'production', VERCEL_GIT_COMMIT_SHA: 'abc123' } }).split('\n');
  assert.equal(lines.length, 3);
  const event = JSON.parse(lines[2]);
  assert.equal(JSON.parse(lines[1]).length, Buffer.byteLength(lines[2]));
  assert.equal(event.message.formatted, 'Cron reminders failed');
  assert.deepEqual(event.tags, { runtime: 'server', cron: 'reminders' });
  assert.equal(event.environment, 'production');
  assert.equal(event.release, 'abc123');
  assert.deepEqual(Object.keys(event).sort(), ['environment', 'event_id', 'extra', 'fingerprint', 'level', 'logger', 'message', 'platform', 'release', 'tags', 'timestamp']);
}
console.log('PASS envelope: message, short tags and redacted detail only');

// Sending: waits for Sentry, never throws, never repeats inside a minute.
{
  _resetSentryForTests();
  const sent = [];
  let clock = 1_000_000;
  const env = { SENTRY_DSN: TEST_DSN };
  const fetchImpl = async (url, init) => { sent.push({ url, init }); return { ok: true }; };
  const report = { message: 'x failed', tags: { route: '/api/x' } };
  assert.equal(await reportServerError(report, { env, fetchImpl, now: () => clock }), true);
  assert.equal(sent[0].url, 'https://o1.ingest.us.sentry.io/api/42/envelope/');
  assert.match(sent[0].init.headers['X-Sentry-Auth'], /sentry_key=publickey/);
  assert.equal(await reportServerError(report, { env, fetchImpl, now: () => clock + 30_000 }), false, 'same failure inside a minute: grouped, not resent');
  assert.equal(await reportServerError(report, { env, fetchImpl, now: () => clock + 61_000 }), true);
  assert.equal(sent.length, 2);
  assert.equal(await reportServerError(report, { env: {}, fetchImpl }), false, 'off: nothing sent');
  assert.equal(await reportServerError({ message: 'y' }, { env, fetchImpl: async () => { throw new Error('offline'); } }), false, 'Sentry down: no throw');
  const started = Date.now();
  const hung = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  assert.equal(await reportServerError({ message: 'z' }, { env, fetchImpl: hung }), false);
  assert.ok(Date.now() - started < 2_500, 'a slow Sentry costs the request at most 1.5 seconds');
}
console.log('PASS sending: awaited, bounded, grouped, and never breaks the caller');

// Which recorded events are failures.
{
  assert.equal(isReportableOperationalEvent({ event_type: 'sms_inbox_write_failed' }), true);
  assert.equal(isReportableOperationalEvent({ event_type: 'owner_call_failed' }), true);
  assert.equal(isReportableOperationalEvent({ event_type: 'dispatch_accept', status_code: 500 }), true);
  assert.equal(isReportableOperationalEvent({ event_type: 'dispatch_accept', status_code: 409 }), false, 'a refusal with a reason is not a server failure');
  assert.equal(isReportableOperationalEvent({ event_type: 'stranded_booking_alert' }), false);
  assert.equal(isReportableOperationalEvent({ event_type: 'runtime_error' }), false, 'browser errors already reach Sentry from the browser');
}
console.log('PASS events: failures and 5xx are reported; refusals, alerts and browser errors are not');

// Wired in where every failure is already recorded, with customer details removed.
{
  _resetSentryForTests();
  const { insertOperationalEventFailOpen, recordOperationalEvents } = await import('../api/_observability.js');
  const sent = [];
  const realFetch = globalThis.fetch;
  process.env.SENTRY_DSN = TEST_DSN;
  globalThis.fetch = async (url, init) => { sent.push(JSON.parse(String(init.body).split('\n')[2])); return { ok: true }; };
  const quiet = { warn() {}, error() {} };
  const okDb = { from: () => ({ insert: async () => ({ error: null }) }) };
  const refusingDb = { from: () => ({ insert: async () => ({ error: { message: 'null value in column "request_id"' } }) }) };
  try {
    await insertOperationalEventFailOpen(okDb, { event_type: 'owner_call_failed', route: '/api/owner/call', reason_detail: 'Telnyx refused call to jane@example.com at 512-555-0100' }, { logger: quiet });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].message.formatted, 'owner_call_failed at /api/owner/call');
    assert.doesNotMatch(JSON.stringify(sent[0]), /jane@example\.com|555-0100/, 'no email or phone leaves in a report');
    await insertOperationalEventFailOpen(okDb, { event_type: 'dispatch_accept', route: '/api/booking/accept-dispatch', status_code: 200 }, { logger: quiet });
    assert.equal(sent.length, 1, 'ordinary events are not reported');
    await recordOperationalEvents(refusingDb, [{ event_type: 'stranded_booking_alert' }], { logger: quiet });
    assert.equal(sent.length, 2);
    assert.equal(sent[1].message.formatted, 'operational_events insert refused', 'a refused record is reported: the table can never show it');
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.SENTRY_DSN;
  }
  const cron = read('api/cron/_cron-logger.js');
  assert.match(cron, /if \(finalStatus === 'error'\) \{\s*await reportServerError\(\{\s*message: `Cron \$\{cronName\} failed`,\s*detail: redactString\(finalErrorText\),/);
  assert.ok(cron.indexOf('await reportServerError(') < cron.indexOf("sb.from('cron_log').insert"), 'reported before the cron_log write, which can fail too');
  assert.doesNotMatch(read('api/_sentry.js'), /^import /m, '_sentry imports nothing, so observability can import it');
}
console.log('PASS wiring: operational failures, refused records and failed crons reach Sentry, redacted');

console.log('\nServer Sentry tests passed.');
