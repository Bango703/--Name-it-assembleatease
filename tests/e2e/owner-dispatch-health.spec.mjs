// Greater Houston dispatch card in the signed-in owner console (owner,
// 2026-11-18: "test the dashboard using authenticated owner access and
// realistic production-shaped data"). The report is built by the server's own
// function from rows shaped exactly like production bookings, offers and
// Easers. The card only renders what the server sent, and only after the
// owner's session token reaches the endpoint.
// DH_REPORT=<path to a report JSON> renders a saved report instead (local only).
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { buildDispatchHealth } from '../../api/owner/_dispatch-health.js';

const NOW = Date.parse('2026-11-18T23:00:00Z');
const iso = (minutesAgo) => new Date(NOW - minutesAgo * 60000).toISOString();
const row = (over) => ({ is_test_booking: false, needs_manual_dispatch: false, dispatch_paused: false, cancel_reason: null, decline_reason: null, completed_at: null, assigned_at: null, assembler_accepted_at: null, assembler_id: null, ...over });
const bookings = [
  row({ id: 'b1', ref: 'AAE-TESTKATY01', service: 'Wooden catio assembly and wall mounting', service_city: 'Katy', service_zip: '77449', status: 'completed', date: '2026-10-26', time: '1:00 PM - 3:00 PM', created_at: iso(34000), confirmed_at: iso(34000), assigned_at: iso(33990), assembler_accepted_at: iso(33988), assembler_id: 'e1', completed_at: iso(31000) }),
  row({ id: 'b2', ref: 'AAE-TESTSPRING2', service: 'Outdoor & Playsets', service_city: 'Spring', service_zip: '77389', status: 'completed', date: '2026-11-08', time: '8:00 AM – 10:00 AM', created_at: iso(18000), confirmed_at: iso(18000), assigned_at: iso(17000), assembler_accepted_at: iso(16942), assembler_id: 'e1', completed_at: iso(14000) }),
  row({ id: 'b3', ref: 'AAE-TESTPEARL3', service: 'Mounting & Hanging', service_city: 'Pearland', service_zip: '77584', status: 'confirmed', date: '2026-11-19', time: '10:00 AM – 12:00 PM', created_at: iso(240), confirmed_at: iso(235) }),
  row({ id: 'b4', ref: 'AAE-TESTSUGAR4', service: 'Furniture Assembly', service_city: 'Sugar Land', service_zip: '77479', status: 'cancelled', date: '2026-11-12', time: '4:00 PM – 6:00 PM', created_at: iso(9000), confirmed_at: iso(8990), cancel_reason: 'Cancelled by customer (guest)' }),
  row({ id: 'b5', ref: 'AAE-TESTAUSTIN', service: 'Furniture Assembly', service_city: 'Austin', service_zip: '78701', status: 'confirmed', date: '2026-11-19', created_at: iso(100), confirmed_at: iso(90) }),
];
const offers = [
  { booking_id: 'b2', offer_status: 'expired', attempt_number: 1 },
  { booking_id: 'b2', offer_status: 'accepted', attempt_number: 2 },
  { booking_id: 'b3', offer_status: 'sent', attempt_number: 1 },
];
const REPORT = process.env.DH_REPORT
  ? JSON.parse(readFileSync(process.env.DH_REPORT, 'utf8'))
  : buildDispatchHealth({ bookings, offers, easers: [{ id: 'e1', isReady: true }, { id: 'e2', isReady: false }, { id: 'e3', isReady: false }], market: 'houston', now: NOW });
const MARKET_DEMAND = {
  generatedAt: '2026-11-18T23:00:00Z', supplyAvailable: true, waitlistAvailable: true,
  sourceStatus: { easers: 'available', waitlist: 'available', bookings: 'available', requests: 'available' },
  summary: { demandSignals: 0, bookedDemand: 0, unbookedDemand: 0, manualDispatchDemand: 0, readyEasers: 0, easerSupplyByMarket: 0, totalPotentialRevenue: 0 },
  trend: [], markets: [], requests: [], warnings: [],
  summaryRows: { demand: [], bookings: [], unbooked: [], manualAssignment: [], ready: [], approved: [], priced: [], allEasers: [], pending: [], reviewRecords: [], waitlist: [] },
};
const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function signInAndOpen(page, dispatchHealth) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.clock.install({ time: new Date('2026-11-18T23:00:00Z') });
  await page.route(/^(?!http:\/\/127\.0\.0\.1)/, (route) => route.abort());
  const seen = { authorization: null };
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/owner/session') return json(route, { token: 'e2e-session' });
    if (path === '/api/owner/market-demand') return json(route, MARKET_DEMAND);
    if (path === '/api/owner/dispatch-health') {
      seen.authorization = route.request().headers().authorization || null;
      if (seen.authorization !== 'Bearer e2e-session') return json(route, { error: 'Unauthorized' }, 401);
      return dispatchHealth(route);
    }
    return json(route, {});
  });
  await page.goto('/owner/index.html');
  await page.fill('#login-pw', 'local-e2e-only');
  await page.click('#login-btn');
  await expect(page.locator('#login-btn')).toBeHidden();
  await page.locator('a[data-view="market-demand"]').first().click();
  await expect(page.locator('.topbar-title')).toHaveText('Market Demand');
  return seen;
}

test('signed-in owner sees the Greater Houston dispatch card built from the server report', async ({ page }) => {
  const seen = await signInAndOpen(page, (route) => json(route, REPORT));
  const card = page.locator('#dispatch-health-card');
  await expect(card).toBeVisible();
  await expect(page.locator('#dh-status')).toContainText(`Last ${REPORT.windowDays} days`);
  expect(seen.authorization).toBe('Bearer e2e-session');

  const s = REPORT.summary;
  await expect(card).toContainText(`Ready Easers in this market${s.readyEasers} of ${s.easersOnRecord} on record`);
  await expect(card.locator('h4', { hasText: 'Unassigned now' })).toHaveText(`Unassigned now (${REPORT.unassigned.length})`);
  await expect(card.locator('h4', { hasText: 'Cancelled or declined' })).toHaveText(`Cancelled or declined (${REPORT.cancellations.length})`);
  await expect(card.locator('h4', { hasText: 'Completed' })).toHaveText(`Completed (${REPORT.completedJobs.length})`);
  for (const r of REPORT.unassigned) await expect(card).toContainText(r.ref);
  for (const r of REPORT.completedJobs) await expect(card).toContainText(r.ref);
  await expect(card).not.toContainText('AAE-TESTAUSTIN');
  const fired = REPORT.triggers.filter((t) => t.fired);
  if (fired.length) await expect(card).toContainText('Recruitment needed:');
  else await expect(card).toContainText('No recruitment trigger fired.');

  const sizes = await page.evaluate(() => ({ w: document.scrollingElement.scrollWidth, vw: innerWidth }));
  expect(sizes.w).toBeLessThanOrEqual(sizes.vw);
  if (process.env.HYBRID_SHOTS) await card.screenshot({ path: `${process.env.HYBRID_SHOTS}/owner-dispatch-health.png` });
});

test('a failed load says the numbers are unknown, never zero', async ({ page }) => {
  await signInAndOpen(page, (route) => json(route, { error: 'Dispatch offers could not be loaded, so acceptance is unknown.' }, 500));
  await expect(page.locator('#dh-status')).toContainText('acceptance is unknown');
  await expect(page.locator('#dh-status')).toContainText('These numbers are unknown, not zero.');
});
