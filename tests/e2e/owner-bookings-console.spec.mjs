// The Bookings screen of the owner console (owner, 2026-11-13: "nice and
// clear, no duplicates ... I can see everything without scrolling all over").
// Each test is one promise of the screen, in a real browser on a desktop
// window with fixed data:
//   - every number card equals the list it opens, and opens it;
//   - ten bookings a page, with page numbers that move through the list;
//   - the filters change the cards, the tab counts and the list together;
//   - the list and the record sit side by side and the page does not scroll.
// No request leaves this machine: /api/* is answered here.
import { test, expect } from '@playwright/test';

const NOW = new Date('2026-11-13T15:00:00Z');
const SHOTS = process.env.HYBRID_SHOTS || '';

const SERVICES = ['Furniture Assembly', 'TV Mounting', 'Smart Home Setup'];
const CITIES = ['Austin', 'Round Rock', 'Houston'];
const STATUSES = ['pending', 'confirmed', 'completed', 'completed', 'cancelled', 'cancelled', 'declined', 'en_route'];
const BOOKINGS = Array.from({ length: 26 }, (_, i) => ({
  id: `b-${i}`, ref: `AAE-CONSOLE-${String(i).padStart(2, '0')}`,
  status: STATUSES[i % STATUSES.length],
  date: `2026-11-${String(1 + (i % 28)).padStart(2, '0')}`, time: '10:00 AM – 12:00 PM',
  service: SERVICES[i % SERVICES.length], service_city: CITIES[i % CITIES.length], service_zip: '78701',
  customer_name: `Customer ${String.fromCharCode(65 + (i % 26))} Example`, customer_email: `c${i}@example.test`, customer_phone: '5125550100',
  total_price: 10000 + i * 1000, tax_amount: 800, created_at: '2026-11-01T12:00:00Z',
  is_test_booking: i >= 24,
}));

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function openBookings(page) {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.clock.install({ time: NOW });
  await page.route(/^(?!http:\/\/127\.0\.0\.1)/, route => route.abort());
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/owner/session') return json(route, { token: 'e2e-session' });
    if (path === '/api/booking/list') return json(route, { bookings: BOOKINGS, count: BOOKINGS.length });
    if (path === '/api/owner/financial-dashboard') return json(route, { summary: { platformGrossProfit: 82728 }, ledger: [], customerTotals: [] });
    if (path === '/api/owner/live-ops') return json(route, { businessDate: '2026-11-13', summary: {}, alerts: [] });
    return json(route, {});
  });
  await page.goto('/owner/index.html');
  await page.fill('#login-pw', 'local-e2e-only');
  await page.click('#login-btn');
  await expect(page.locator('#login-btn')).toBeHidden();
  await page.locator('a[data-view="bookings"]').first().click();
  await expect(page.locator('.topbar-title')).toHaveText('Bookings');
}

const real = BOOKINGS.filter(b => !b.is_test_booking);
const count = (pred) => real.filter(pred).length;
const tabCount = (page, status) => page.locator(`#tabs .tab[data-status="${status}"] .tab-count`);

test('every number card equals the list it opens, and opens it', async ({ page }) => {
  await openBookings(page);
  await expect(page.locator('#topbar-sub')).toHaveText('Manage bookings, dispatch and service across AssembleAtEase.');
  await expect(page.locator('#stats-row .kpi')).toHaveCount(7);
  const expected = {
    pending: count(b => b.status === 'pending'),
    confirmed: count(b => ['confirmed', 'en_route', 'arrived', 'in_progress'].includes(b.status)),
    completed: count(b => b.status === 'completed'),
    cancelled: count(b => b.status === 'cancelled'),
    declined: count(b => b.status === 'declined'),
    all: real.length,
  };
  const cardFor = { pending: '#stat-pending', confirmed: '#stat-confirmed', completed: '#stat-completed', cancelled: '#stat-cancelled', declined: '#stat-declined', all: '#stat-total' };
  for (const [tab, n] of Object.entries(expected)) {
    await expect(page.locator(`${cardFor[tab]} .kpi-value`)).toHaveText(String(n));
    await expect(tabCount(page, tab)).toHaveText(String(n));
  }
  await expect(page.locator('#stat-revenue .kpi-value')).toHaveText('$827.28');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/console-bookings.png` });

  // A card opens its tab, and the list holds exactly its count.
  await page.click('#stat-cancelled');
  await expect(page.locator('#tabs .tab.active')).toHaveAttribute('data-status', 'cancelled');
  await expect(page.locator('#bookings-list .bk-row')).toHaveCount(expected.cancelled);
  await expect(page.locator('#bookings-pager .bk-pager-count')).toHaveText(`Showing 1–${expected.cancelled} of ${expected.cancelled} bookings`);
  // Platform gross opens Financials.
  await page.click('#stat-revenue');
  await expect(page.locator('.topbar-title')).toHaveText('Financials');
});

test('ten bookings a page, and the page numbers move through the list', async ({ page }) => {
  await openBookings(page);
  await page.click('#tabs .tab[data-status="all"]');
  await expect(page.locator('#bookings-list .bk-row')).toHaveCount(10);
  await expect(page.locator('#bookings-pager .bk-pager-count')).toHaveText(`Showing 1–10 of ${real.length} bookings`);
  await page.click('#bookings-pager .bk-page[data-page="3"]');
  await expect(page.locator('#bookings-list .bk-row')).toHaveCount(real.length - 20);
  await expect(page.locator('#bookings-pager .bk-pager-count')).toHaveText(`Showing 21–${real.length} of ${real.length} bookings`);
  await expect(page.locator('#bookings-pager .bk-page[aria-label="Next page"]')).toBeDisabled();
  // Every row shows who, when, status and amount.
  const row = page.locator('#bookings-list .bk-row').first();
  await expect(row.locator('.bk-avatar')).toHaveText(/^[A-Z]{1,2}$/);
  await expect(row.locator('.bk-amount')).toHaveText(/^\$\d/);
});

test('the filters change the cards, the tab counts and the list together', async ({ page }) => {
  await openBookings(page);
  await page.selectOption('#bk-filter-service', 'TV Mounting');
  const tv = real.filter(b => b.service === 'TV Mounting');
  await expect(page.locator('#stat-total .kpi-value')).toHaveText(String(tv.length));
  await expect(tabCount(page, 'all')).toHaveText(String(tv.length));
  await page.click('#tabs .tab[data-status="all"]');
  await expect(page.locator('#bookings-list .bk-row')).toHaveCount(Math.min(10, tv.length));
  await page.selectOption('#bk-filter-area', 'Houston');
  const both = tv.filter(b => b.service_city === 'Houston');
  await expect(page.locator('#stat-total .kpi-value')).toHaveText(String(both.length));
  await expect(page.locator('#bookings-list .bk-row')).toHaveCount(both.length);
  // The sidebar's pending badge is the business, not the filter.
  await expect(page.locator('#nav-pending')).toHaveText(String(count(b => b.status === 'pending')));
});

test('list and record side by side, and the page itself does not scroll', async ({ page }) => {
  await openBookings(page);
  await page.click('#tabs .tab[data-status="all"]');
  await page.locator('#bookings-list .bk-row').first().click();
  await expect(page.locator('#detail-panel')).toBeVisible();
  const list = await page.locator('.bk-list-card').boundingBox();
  const record = await page.locator('#detail-panel').boundingBox();
  expect(record.x).toBeGreaterThan(list.x + list.width - 1);
  expect(Math.abs(record.y - list.y)).toBeLessThan(4);
  const sizes = await page.evaluate(() => ({ h: document.scrollingElement.scrollHeight, vh: innerHeight, w: document.scrollingElement.scrollWidth, vw: innerWidth }));
  expect(sizes.w).toBeLessThanOrEqual(sizes.vw);
  expect(sizes.h).toBeLessThanOrEqual(sizes.vh + 1);
  // Items & Add-ons spans the Job Details card: label above, list below at full width.
  const items = page.locator('.dg-job .detail-field', { has: page.locator('label', { hasText: 'Items & Add-ons' }) });
  await expect(items).toHaveClass(/dg-wide/);
  const label = await items.locator('label').boundingBox();
  const value = await items.locator('span').first().boundingBox();
  expect(Math.abs(value.x - label.x)).toBeLessThan(2);
  expect(value.y).toBeGreaterThan(label.y + label.height - 1);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/console-bookings-record.png` });
});
