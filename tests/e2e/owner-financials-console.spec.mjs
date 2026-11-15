// The Financials overview of the owner console (owner, 2026-11-13). In a real
// browser with fixed data:
//   - the six cards show the server's totals and shares;
//   - the chart draws one group per month, the breakdown lists its four parts,
//     the Easer table and recent transactions come from the server rows;
//   - each section tab shows its own sections, and one period control exists;
//   - health lines open the tab that holds their rows.
// No request leaves this machine: /api/* is answered here.
import { test, expect } from '@playwright/test';

const SHOTS = process.env.HYBRID_SHOTS || '';
const FINANCE = {
  period: 'year',
  summary: {
    customerRevenue: 347316, salesTaxCollected: 26470, processingFees: 10161, easerPayouts: 227957, platformGrossProfit: 82728,
    estimatedNetOperatingProfit: 65362, completedJobs: 8, averageJobValue: 43415, grossProfitPerJob: 10341, grossMarginPct: 0.238,
    activeEasers: 9, addOnAttachmentRate: 0.25, repeatCustomerRate: 0, reworkRefundReserve: 0, operatingExpenses: 0,
  },
  // Same figures as summary, as api/owner/financial-dashboard.js sends them.
  executiveOverview: {
    platformGrossProfitPerCompletedJob: 10341, totalCustomerRevenue: 347316, completedJobs: 8, averageJobValue: 43415,
    platformGrossProfit: 82728, grossMarginPct: 0.238, estimatedNetOperatingProfit: 65362, addOnAttachmentRate: 0.25,
    addOnAttachmentRateSource: 'actual_booking_items', costedCompletedJobs: 0, operatingExpenses: 0,
  },
  labels: {}, assumptions: {},
  monthly: [
    { month: '2026-09', customerRevenue: 42651, salesTax: 3250, processingFees: 1267, easerEarnings: 27580, platformGross: 10554, completedJobs: 1 },
    { month: '2026-10', customerRevenue: 162600, salesTax: 12390, processingFees: 4744, easerEarnings: 113300, platformGross: 32166, completedJobs: 3 },
    { month: '2026-11', customerRevenue: 142065, salesTax: 10830, processingFees: 4150, easerEarnings: 87077, platformGross: 40008, completedJobs: 4 },
  ],
  breakdown: { totalCents: 347316, parts: [
    { key: 'easerEarnings', label: 'Easer earnings', cents: 227957, share: 227957 / 347316 },
    { key: 'platformGross', label: 'Platform gross', cents: 82728, share: 82728 / 347316 },
    { key: 'salesTax', label: 'Sales tax', cents: 26470, share: 26470 / 347316 },
    { key: 'processingFees', label: 'Processing fees', cents: 10161, share: 10161 / 347316 },
  ] },
  easerEarnings: [
    { easerId: 'e3', name: 'Phil Hawkins', jobs: 3, earnedCents: 135790, paidCents: 135790, owedCents: 0 },
    { easerId: 'e1', name: 'Travis Gibson', jobs: 3, earnedCents: 41557, paidCents: 30000, owedCents: 11557 },
  ],
  ledger: [
    { bookingId: 'b1', eventType: 'completed_job', status: 'completed', eventAt: '2026-10-27T18:00:00Z', service: 'Wooden patio assembly', customerName: 'Katt Tulan', customerRevenue: 16238 },
    { bookingId: 'b2', eventType: 'cancellation_earnings', status: 'cancelled', eventAt: '2026-10-18T18:00:00Z', service: 'Mounting & Hanging', customerName: 'Pamela Ray', customerRevenue: 2500 },
  ],
  serviceProfitability: [], expansionReadiness: {}, contractorTax: {}, clawbacks: { totalOwedCents: 0, items: [] },
  reconciliation: { mismatchedCount: 0, duplicateLedgerBookingCount: 0 },
};

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function openFinancials(page) {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.clock.install({ time: new Date('2026-11-13T15:00:00Z') });
  await page.route(/^(?!http:\/\/127\.0\.0\.1)/, route => route.abort());
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/owner/session') return json(route, { token: 'e2e-session' });
    if (path === '/api/owner/financial-dashboard') return json(route, FINANCE);
    if (path === '/api/booking/list') return json(route, { bookings: [], count: 0 });
    return json(route, {});
  });
  await page.goto('/owner/index.html');
  await page.fill('#login-pw', 'local-e2e-only');
  await page.click('#login-btn');
  await expect(page.locator('#login-btn')).toBeHidden();
  await page.locator('a[data-view="analytics"]').first().click();
  await expect(page.locator('.topbar-title')).toHaveText('Financials');
}

test('the overview shows the server totals, the chart, the breakdown and the tables', async ({ page }) => {
  await openFinancials(page);
  await expect(page.locator('#topbar-sub')).toHaveText('Revenue, payouts, fees and profitability for AssembleAtEase.');
  await expect(page.locator('#fin-total-platform-gross')).toHaveText('$827.28');
  await expect(page.locator('#an-gross')).toHaveText('$3,473.16');
  await expect(page.locator('#an-easer-payouts')).toHaveText('$2,279.57');
  await expect(page.locator('#fin-kpi-margin')).toHaveText('23.8% margin');
  await expect(page.locator('#fin-kpi-easer-share')).toHaveText('65.6% of payments');
  // One group of bars per month and a platform-gross point per month.
  await expect(page.locator('#fin-chart .fin-bar-a')).toHaveCount(3);
  await expect(page.locator('#fin-chart .fin-dot')).toHaveCount(3);
  await page.click('[data-fin-chart="jobs"]');
  await expect(page.locator('#fin-chart .fin-bar-b')).toHaveCount(0);
  await expect(page.locator('#fin-chart')).toContainText('Completed jobs');
  // Breakdown: four parts.
  await expect(page.locator('#fin-breakdown .fin-parts li')).toHaveCount(4);
  await expect(page.locator('#fin-breakdown')).toContainText('Easer earnings');
  // Easer table and recent transactions from the server rows.
  await expect(page.locator('#fin-easers tbody tr')).toHaveCount(2);
  await expect(page.locator('#fin-easers tbody tr').nth(1)).toContainText('Owed');
  await expect(page.locator('#fin-recent tbody tr')).toHaveCount(2);
  await expect(page.locator('#fin-recent tbody tr').nth(1)).toContainText('Cancellation fee');
  await expect(page.locator('#an-completed-jobs')).toHaveText('8');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/console-financials.png`, fullPage: true });
});

test('each section tab shows its own sections, with one period control', async ({ page }) => {
  await openFinancials(page);
  await expect(page.locator('[data-fin-period="year"]')).toHaveCount(1);
  await expect(page.locator('#fin-overview')).toBeVisible();
  await page.click('.fin-tabbar [data-fin-tab="ledger"]');
  await expect(page.locator('#fin-overview')).toBeHidden();
  await expect(page.locator('#an-ledger')).toBeVisible();
  await expect(page.locator('.fin-tabbar [data-fin-tab="ledger"]')).toHaveClass(/active/);
  // The period control keeps its own active state when the section changes.
  await expect(page.locator('[data-fin-period="year"]')).toHaveClass(/active/);
  await page.click('.fin-tabbar [data-fin-tab="more"]');
  await expect(page.locator('#fin-details')).toBeVisible();
  await expect(page.locator('#an-ledger')).toBeHidden();
  // A health line opens the tab that holds its rows.
  await page.click('.fin-tabbar [data-fin-tab="overview"]');
  await page.locator('#fin-health .fin-health-row', { hasText: 'Sales tax' }).click();
  await expect(page.locator('.fin-tabbar [data-fin-tab="tax"]')).toHaveClass(/active/);
});
