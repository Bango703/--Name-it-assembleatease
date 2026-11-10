// Owner dashboard in a real browser, with fixed test data (owner, 2026-11-10:
// "other major companies don't have stale data"). Each test is one promise the
// dashboard makes: a number matches the place it comes from, it refreshes on
// its own, and anything that failed to load says unknown instead of zero.
// No request leaves this machine: /api/* is answered here and every other host
// is blocked.
import { test, expect } from '@playwright/test';
import { checkDashboardAgrees } from '../e2e-live/checks.mjs';

const TODAY = '2026-11-10';
const NOW = new Date('2026-11-10T15:00:00Z'); // 9:00 in Austin

const booking = (over) => ({
  id: over.ref, ref: over.ref, status: 'confirmed', date: TODAY, time: '10:00 AM',
  service: 'Furniture Assembly', customer_name: 'Test Customer', customer_email: 'test@example.test',
  customer_phone: '5125550100', created_at: '2026-11-01T12:00:00Z', is_test_booking: false, ...over,
});

const BOOKINGS = [
  booking({ ref: 'AAE-E2E-1', customer_email: 'ann@example.test', customer_name: 'Ann' }),
  booking({ ref: 'AAE-E2E-2', status: 'cancelled', customer_email: 'ann@example.test', customer_name: 'Ann' }),
  booking({ ref: 'AAE-E2E-3', is_test_booking: true }),
  booking({ ref: 'AAE-E2E-4', status: 'completed', date: '2026-10-20', customer_email: 'bo@example.test', customer_name: 'Bo' }),
  booking({ ref: 'AAE-E2E-5', status: 'completed', date: '2026-10-28', customer_email: 'bo@example.test', customer_name: 'Bo' }),
];

const FINANCE = {
  summary: { customerRevenue: 90_000, salesTaxCollected: 6_000, processingFees: 2_700, easerPayouts: 50_000, platformGrossProfit: 31_300 },
  ledger: [],
  customerTotals: [
    { key: 'email:ann@example.test', completedJobs: 0, paidCents: 0 },
    { key: 'email:bo@example.test', completedJobs: 2, paidCents: 90_000 },
  ],
};

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

// answers: { 'path-prefix': body | (url) => body | { status, body } }
async function openDashboard(page, answers = {}) {
  const calls = [];
  await page.clock.install({ time: NOW });
  await page.route(/^(?!http:\/\/127\.0\.0\.1)/, (route) => route.abort());
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname + url.search;
    calls.push(path);
    const key = Object.keys(answers).sort((a, b) => b.length - a.length).find((k) => path.startsWith(k));
    let answer = key ? answers[key] : {};
    if (typeof answer === 'function') answer = answer(path, calls.filter((c) => c.startsWith(key)).length);
    if (answer && answer.__status) return json(route, answer.body || { error: 'Unavailable' }, answer.__status);
    return json(route, answer);
  });
  await page.goto('/owner/index.html');
  await page.fill('#login-pw', 'local-e2e-only');
  await page.click('#login-btn');
  await expect(page.locator('#login-btn')).toBeHidden();
  return calls;
}

const base = {
  '/api/owner/session': { token: 'e2e-session' },
  '/api/owner/live-ops': { businessDate: TODAY, summary: {}, alerts: [] },
  '/api/booking/list': { bookings: BOOKINGS, count: BOOKINGS.length },
  '/api/owner/financial-dashboard': FINANCE,
  '/api/owner/voice-calls': { enabled: true, reviewStateAvailable: true, unreviewed: 0, calls: [] },
};

test('Today badge appears without opening Today, and counts only real, scheduled jobs', async ({ page }) => {
  await openDashboard(page, base);
  // Three bookings are dated today: one real, one cancelled, one test.
  await expect(page.locator('#nav-today')).toHaveText('1');
  await page.click('a[data-view="today"]');
  await expect(page.locator('#today-count')).toHaveText('1');
  await expect(page.locator('#today-confirmed')).toHaveText('1');
  await expect(page.locator('#today-list .today-job-card')).toHaveCount(1);
  await expect(page.locator('#today-list')).toContainText('Ann');
  await expect(page.locator('#today-list')).not.toContainText('Test Customer');
  await expect(page.locator('#today-list')).not.toContainText('Cancelled');
  await expect(page.locator('#nav-today')).toHaveText('1');
});

test('The open Today view updates on the next bookings refresh', async ({ page }) => {
  let second = false;
  await openDashboard(page, {
    ...base,
    '/api/booking/list': () => {
      const rows = second ? [...BOOKINGS, booking({ ref: 'AAE-E2E-6', customer_email: 'cy@example.test' })] : BOOKINGS;
      return { bookings: rows, count: rows.length };
    },
  });
  await page.click('a[data-view="today"]');
  await expect(page.locator('#today-count')).toHaveText('1');
  second = true;
  await page.clock.runFor(61_000);
  await expect(page.locator('#today-count')).toHaveText('2');
  await expect(page.locator('#nav-today')).toHaveText('2');
});

test('Bookings platform-gross tile is Financials\' all-time platform gross', async ({ page }) => {
  await openDashboard(page, base);
  await expect(page.locator('#stat-revenue .stat-value')).toHaveText('$313.00');
  await expect(page.locator('#stat-revenue .stat-label')).toHaveText('Platform Gross (All Time)');
});

test('Customers: repeat and spent come from Financials, not the bookings list', async ({ page }) => {
  await openDashboard(page, base);
  await page.click('a[data-view="customers"]');
  // Ann has two bookings but one was cancelled and nothing was paid: not repeat.
  await expect(page.locator('#cust-total')).toHaveText('2');
  await expect(page.locator('#cust-repeat')).toHaveText('1');
  const ann = page.locator('#cust-tbody tr', { hasText: 'ann@example.test' });
  const bo = page.locator('#cust-tbody tr', { hasText: 'bo@example.test' });
  await expect(ann).toContainText('$0.00');
  await expect(ann).not.toContainText('REPEAT');
  await expect(bo).toContainText('$900.00');
  await expect(bo).toContainText('REPEAT');
});

test('Menu badges refresh every minute without a page reload', async ({ page }) => {
  await openDashboard(page, {
    ...base,
    '/api/assembler/list': (_path, n) => ({ assemblers: [], stats: { pending: n === 1 ? 1 : 3 } }),
    '/api/owner/cases': (_path, n) => ({ cases: [], summary: { ownerActionRequired: n === 1 ? 0 : 2 } }),
  });
  await expect(page.locator('#nav-pending-apps')).toHaveText('1');
  await expect(page.locator('#nav-cases')).toBeHidden();
  await page.clock.runFor(61_000);
  await expect(page.locator('#nav-pending-apps')).toHaveText('3');
  await expect(page.locator('#nav-cases')).toHaveText('2');
});

test('Anything that fails to load says unknown, never zero', async ({ page }) => {
  await openDashboard(page, {
    ...base,
    '/api/owner/financial-dashboard': { __status: 500 },
    '/api/owner/cases': { __status: 500 },
    '/api/assembler/list': { __status: 500 },
  });
  await expect(page.locator('#stat-revenue .stat-value')).toHaveText('—');
  await expect(page.locator('#nav-cases')).toHaveText('!');
  await expect(page.locator('#nav-pending-apps')).toHaveText('!');
  await page.click('a[data-view="customers"]');
  await expect(page.locator('#cust-repeat')).toHaveText('—');
  await expect(page.locator('#cust-tbody')).not.toContainText('$0.00');
});

test('Signing out stops the badge refresh', async ({ page }) => {
  const calls = await openDashboard(page, base);
  await expect(page.locator('#nav-today')).toHaveText('1');
  await page.click('#logout-btn');
  await expect(page.locator('#login-btn')).toBeVisible();
  const before = calls.filter((c) => c.startsWith('/api/assembler/list')).length;
  await page.clock.runFor(130_000);
  expect(calls.filter((c) => c.startsWith('/api/assembler/list')).length).toBe(before);
});

// The nightly live check (tests/e2e-live/checks.mjs) passes on a dashboard that
// agrees with itself, and fails when something on it could not load.
test('Nightly live checks pass on consistent data', async ({ page }) => {
  await openDashboard(page, base);
  await checkDashboardAgrees(page);
});

test('Nightly live checks fail when a badge could not load', async ({ page }) => {
  test.setTimeout(60_000);
  await openDashboard(page, { ...base, '/api/owner/cases': { __status: 500 } });
  await expect(checkDashboardAgrees(page)).rejects.toThrow(/no menu badge failed to load/);
});
