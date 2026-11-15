// Market Demand in the owner console (owner, 2026-11-13). In a real browser:
//   - seven cards show the server's totals, and each opens its own records;
//   - the trend draws the server's months; coverage names every market under
//     its status; each area is a card; demand activity lists the requests;
//   - nothing runs off the side of a desktop window.
// /api/* is answered here; the trend comes from the server's own function.
import { test, expect } from '@playwright/test';
import { buildDemandTrend } from '../../api/owner/market-demand.js';

const SHOTS = process.env.HYBRID_SHOTS || '';
const signals = [
  { recordType: 'booking', createdAt: '2026-09-10T15:00:00Z' },
  { recordType: 'request', createdAt: '2026-10-05T15:00:00Z' },
  { recordType: 'booking', createdAt: '2026-10-06T15:00:00Z' },
  { recordType: 'booking', createdAt: '2026-11-02T15:00:00Z' },
  { recordType: 'request', createdAt: '2026-11-03T15:00:00Z' },
];
const easer = { id: 'e1', recordType: 'easer', name: 'Alex Example', status: 'active', city: 'Austin', state: 'TX', zip: '78701', eligible: true, isAvailable: true, missingItems: [] };
const market = (key, label, status, over = {}) => ({
  marketKey: key, marketLabel: label, isActiveMarket: true, coverageKnown: true, activationStatus: status,
  approvedEasers: 1, readyEasers: status === 'READY' ? 3 : 1, waitlistEasers: 0, topServices: [{ service: 'Furniture Assembly', count: 2 }],
  requestedZips: ['78701'], demandRows: [], bookedRows: [], unbookedRows: [], potentialRevenue: 22835,
  supplyRows: { all: [easer], approved: [easer], ready: [easer], online: [], pending: [], waitlist: [], reviewRecords: [] }, ...over,
});
const DATA = {
  generatedAt: '2026-11-13T15:00:00Z', supplyAvailable: true, waitlistAvailable: true,
  sourceStatus: { easers: 'available', waitlist: 'available', bookings: 'available', requests: 'available' },
  summary: { demandSignals: 5, bookedDemand: 3, unbookedDemand: 2, manualDispatchDemand: 1, readyEasers: 8, easerSupplyByMarket: 10, totalPotentialRevenue: 1076574 },
  trend: buildDemandTrend(signals),
  markets: [
    market('austin', 'Austin / Central Texas', 'READY'),
    market('houston', 'Houston area', 'LIMITED COVERAGE'),
    market('tyler', 'Tyler, TX 75707', 'COVERAGE UNVERIFIED', { coverageKnown: false }),
  ],
  summaryRows: { demand: [], bookings: [], unbooked: [], manualAssignment: [], ready: [easer], approved: [easer], priced: [], allEasers: [easer], pending: [], reviewRecords: [], waitlist: [] },
  requests: [
    { requestRef: 'AAE-VIP2Z8YU8', customerName: 'Stephanie Koenig', customerEmail: 'sk@example.test', city: 'Lubbock', state: 'TX', zip: '79411', requestedService: 'Outdoor & Playsets', requestedDate: 'Aug 22, 2026', estimatedRevenue: 32908, recordType: 'booking', status: 'cancelled' },
    { requestRef: 'MR-MSOWPN72', customerName: 'Requester', city: 'Austin', state: 'TX', zip: '78701', requestedService: 'Furniture Assembly', estimatedRevenue: null, recordType: 'request', status: 'closed' },
  ],
  warnings: ['1 demand signal(s) have no usable city/state and remain visible as Unlocated.'],
};

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

test('cards, trend, coverage, area cards and demand activity come from the server', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.clock.install({ time: new Date('2026-11-13T15:00:00Z') });
  await page.route(/^(?!http:\/\/127\.0\.0\.1)/, route => route.abort());
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/owner/session') return json(route, { token: 'e2e-session' });
    if (path === '/api/owner/market-demand') return json(route, DATA);
    return json(route, {});
  });
  await page.goto('/owner/index.html');
  await page.fill('#login-pw', 'local-e2e-only');
  await page.click('#login-btn');
  await expect(page.locator('#login-btn')).toBeHidden();
  await page.locator('a[data-view="market-demand"]').first().click();
  await expect(page.locator('.topbar-title')).toHaveText('Market Demand');

  await expect(page.locator('#md-active')).toHaveText('5');
  await expect(page.locator('#md-emerging')).toHaveText('3');
  await expect(page.locator('#md-requests')).toHaveText('2');
  await expect(page.locator('#md-supply')).toHaveText('8');
  await expect(page.locator('#md-potential')).toHaveText('$10,765.74');
  // Each card opens its own records.
  const ready = page.locator('#md-supply').locator('xpath=..').locator('.md-summary-rows summary');
  await expect(ready).toHaveText('View records: 1');
  await ready.click();
  await expect(page.locator('#md-supply').locator('xpath=..').locator('.md-summary-rows ul')).toContainText('Alex Example');
  await ready.click();

  // Trend: one bar per month, the bookings line through them.
  await expect(page.locator('#md-trend .fin-bar-a')).toHaveCount(3);
  await expect(page.locator('#md-trend .fin-dot')).toHaveCount(3);
  // Coverage names each market under its status.
  await expect(page.locator('#md-coverage .md-cov-row')).toHaveCount(3);
  await expect(page.locator('#md-coverage')).toContainText('Houston area');
  // Each area is a card; the warning sits above them across the width.
  await expect(page.locator('#md-top-markets .md-market-card')).toHaveCount(3);
  await expect(page.locator('#md-top-markets')).toContainText('no usable city/state');
  await expect(page.locator('#md-requests-tbody tr')).toHaveCount(2);
  await expect(page.locator('#md-requests-tbody')).toContainText('Not priced');

  const sizes = await page.evaluate(() => ({ w: document.scrollingElement.scrollWidth, vw: innerWidth }));
  expect(sizes.w).toBeLessThanOrEqual(sizes.vw);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/console-market-demand.png`, fullPage: true });
});
