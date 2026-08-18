import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');

const loaderUrl = 'https://js.sentry-cdn.com/d5e773248c17d9f13dcf8b0a5f5dd73f.min.js';
const monitoredPages = [
  'index.html',
  'book.html',
  'track.html',
  'review.html',
  'owner/index.html',
  'owner/email.html',
  'assembler/index.html',
  'assembler/profile.html',
  'assembler/payouts.html',
  'assembler/my-assignments.html',
  'assembler/apply.html',
  'assembler/verify-identity.html',
  'assembler/contractor-agreement.html',
  'auth/login.html',
  'auth/forgot-password.html',
  'auth/reset-password.html',
  'auth/set-password.html',
];

for (const page of monitoredPages) {
  const html = read(page);
  const initIndex = html.indexOf('/assets/js/sentry-init.js');
  const loaderIndex = html.indexOf(loaderUrl);
  assert.ok(initIndex > -1, `${page} must load the privacy-safe Sentry initializer`);
  assert.ok(loaderIndex > initIndex, `${page} must configure Sentry before loading the SDK`);
  assert.equal(html.match(/js\.sentry-cdn\.com\/d5e773248c17d9f13dcf8b0a5f5dd73f\.min\.js/g)?.length, 1, `${page} must load Sentry once`);
}

const source = read('assets/js/sentry-init.js');
let options;
const windowMock = {
  location: {
    hostname: 'www.assembleatease.com',
    origin: 'https://www.assembleatease.com',
  },
  Sentry: {
    init(value) {
      options = value;
    },
  },
};
const context = vm.createContext({ window: windowMock, URL, Set });
vm.runInContext(source, context, { filename: 'assets/js/sentry-init.js' });
windowMock.sentryOnLoad();

assert.ok(options, 'Sentry must initialize when the loader becomes ready');
assert.equal(options.enabled, true, 'Production monitoring must be enabled');
assert.equal(options.environment, 'production');
assert.equal(options.sendDefaultPii, false, 'Default PII collection must stay disabled');
assert.equal(options.tracesSampleRate, 0.1, 'Tracing must stay at the approved 10% sample');
assert.equal(options.replaysSessionSampleRate, 0, 'Routine session replay must stay disabled');
assert.equal(options.replaysOnErrorSampleRate, 0, 'Error session replay must stay disabled');

const scrubbed = options.beforeSend({
  message: 'Failure for kposey@moog.com, 214-460-9830, AAE-URF7O9P3XY and pi_123abc',
  user: { email: 'kposey@moog.com' },
  extra: { customerAddress: '6904 Shumard Circle' },
  request: {
    url: 'https://www.assembleatease.com/track?token=secret#booking',
    headers: { authorization: 'Bearer secret' },
    cookies: { session: 'secret' },
    data: { card: '4242' },
    query_string: 'token=secret',
  },
  breadcrumbs: [
    { category: 'console', message: 'Customer kposey@moog.com' },
    { category: 'fetch', data: { method: 'POST', url: '/api/booking?id=secret', request_body: 'private' } },
  ],
});

assert.equal(scrubbed.user, undefined);
assert.equal(scrubbed.extra, undefined);
assert.equal(scrubbed.request.url, 'https://www.assembleatease.com/track');
assert.equal(scrubbed.request.headers, undefined);
assert.equal(scrubbed.request.cookies, undefined);
assert.equal(scrubbed.request.data, undefined);
assert.equal(scrubbed.request.query_string, undefined);
assert.ok(!scrubbed.message.includes('kposey@moog.com'));
assert.ok(!scrubbed.message.includes('214-460-9830'));
assert.ok(!scrubbed.message.includes('AAE-URF7O9P3XY'));
assert.ok(!scrubbed.message.includes('pi_123abc'));
assert.equal(scrubbed.breadcrumbs.length, 1, 'Console breadcrumbs must be removed');
assert.equal(scrubbed.breadcrumbs[0].data.url, 'https://www.assembleatease.com/api/booking');
assert.equal(scrubbed.breadcrumbs[0].data.request_body, undefined);

const vercel = JSON.parse(read('vercel.json'));
const globalHeaders = vercel.headers.find((entry) => entry.source === '/(.*)')?.headers || [];
const csp = globalHeaders.find((header) => header.key === 'Content-Security-Policy')?.value || '';
assert.match(csp, /https:\/\/js\.sentry-cdn\.com/);
assert.match(csp, /https:\/\/browser\.sentry-cdn\.com/);
assert.match(csp, /https:\/\/o4511934287249408\.ingest\.us\.sentry\.io/);

const privacy = read('privacy.html');
assert.match(privacy, /Error and performance monitoring/);
assert.match(privacy, /Session replay is disabled/);
assert.match(privacy, /Sentry Privacy Policy/);

console.log('PASS Sentry browser monitoring is scoped, privacy-scrubbed, CSP-allowed, and replay-disabled.');
