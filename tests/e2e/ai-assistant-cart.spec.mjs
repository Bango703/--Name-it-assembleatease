// A booking link from the AI assistant connector, opened in the real booking
// page (owner, 2026-11-17: "BUILD IT OUT AND FULLY TEST"). What the assistant
// quoted is what the customer sees:
//   - the link fills the cart with the same items and quantities;
//   - the page's own total equals the connector's estimate in every
//     service-call zone (the server re-prices at checkout as always);
//   - a name the catalog does not have is skipped, never priced;
//   - the visit is remembered as coming from that assistant.
// No request leaves this machine: /api/* is answered with empty JSON.
import { test, expect } from '@playwright/test';
import { callTool, ZONE_SAMPLE_ZIPS } from '../../api/_mcp-tools.js';
import { calculateBookingPricing } from '../../api/_pricing.js';

const CART = [
  { service: 'Furniture Assembly', item: 'Bed frame — queen', quantity: 1 },
  { service: 'Furniture Assembly', item: 'Dresser (up to 6 drawers)', quantity: 2 },
  { service: 'Mounting & Hanging', item: 'TV 41"–55" (standard wall)', quantity: 1 },
];

async function openBookingLink(page, link, { consent = false } = {}) {
  if (consent) await page.addInitScript(() => { try { localStorage.setItem('cookie-consent', 'accepted'); } catch (e) {} });
  await page.route('**/api/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  const url = new URL(link);
  await page.goto(`/book${url.search}`);
  await page.waitForFunction(() => window.BOOK && Array.isArray(BOOK.selectedServices) && BOOK.selectedServices.length > 0);
}

test('an assistant\'s cart link opens the booking page with the same cart and the same total', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const estimate = callTool('estimate_price', { items: CART }, { source: 'claude' }).structuredContent;
  await openBookingLink(page, estimate.bookingUrl);

  const selected = await page.evaluate(() => BOOK.selectedItems);
  expect(selected).toEqual({
    'Furniture Assembly': [
      expect.objectContaining({ name: 'Bed frame — queen', qty: 1, price: 119 }),
      expect.objectContaining({ name: 'Dresser (up to 6 drawers)', qty: 2, price: 109 }),
    ],
    'Mounting & Hanging': [expect.objectContaining({ name: 'TV 41"–55" (standard wall)', qty: 1, price: 119 })],
  });
  await expect(page.locator('body')).toContainText('Furniture Assembly has 3 items selected');

  for (const zip of Object.values(ZONE_SAMPLE_ZIPS)) {
    const pageTotal = await page.evaluate((z) => getPricingSnapshot(z).grandTotal, zip);
    const engine = calculateBookingPricing({
      services: ['Furniture Assembly', 'Mounting & Hanging'],
      itemsByService: {
        'Furniture Assembly': [{ name: 'Bed frame — queen', qty: 1 }, { name: 'Dresser (up to 6 drawers)', qty: 2 }],
        'Mounting & Hanging': [{ name: 'TV 41"–55" (standard wall)', qty: 1 }],
      },
      zip,
    });
    expect(Math.round(pageTotal * 100), `page total for ${zip}`).toBe(engine.totalCents);
    expect(engine.totalCents, `connector total for ${zip}`).toBe(estimate.totalCents);
  }
  expect(errors).toEqual([]);
});

test('names the catalog does not have are skipped, quantities are bounded, repeats add up', async ({ page }) => {
  const link = new URL('https://www.assembleatease.com/book');
  link.searchParams.append('add', 'Furniture Assembly|Bed frame — queen|500');
  link.searchParams.append('add', 'Furniture Assembly|Hot tub|1');
  link.searchParams.append('add', 'Plumbing|Sink|1');
  link.searchParams.append('add', 'Furniture Assembly|Bed frame — queen|abc');
  link.searchParams.append('add', 'Mounting & Hanging');
  await openBookingLink(page, link.toString());
  const selected = await page.evaluate(() => BOOK.selectedItems);
  expect(Object.keys(selected)).toEqual(['Furniture Assembly']);
  expect(selected['Furniture Assembly']).toEqual([expect.objectContaining({ name: 'Bed frame — queen', qty: 99, price: 119 })]);
});

test('a link with no catalog item falls back to the normal start of booking', async ({ page }) => {
  const link = new URL('https://www.assembleatease.com/book');
  link.searchParams.append('add', 'Furniture Assembly|Hot tub|1');
  await page.route('**/api/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await page.goto(`/book${link.search}`);
  await page.waitForFunction(() => window.BOOK);
  expect(await page.evaluate(() => BOOK.selectedServices.length)).toBe(0);
});

test('the visit is remembered as coming from the assistant (after cookies are accepted)', async ({ page }) => {
  const estimate = callTool('estimate_price', { items: CART.slice(0, 1) }, { source: 'chatgpt' }).structuredContent;
  await openBookingLink(page, estimate.bookingUrl, { consent: true });
  // cookie-consent.js loads attribution.js only on assembleatease.com, never on
  // this local server, so the test loads it the same way after Accept.
  await page.evaluate(() => { window.AAEAnalytics = Object.assign(window.AAEAnalytics || {}, { hasConsent: () => true }); });
  if (!(await page.evaluate(() => !!window.AAE_ATTRIBUTION))) await page.addScriptTag({ url: '/assets/js/attribution.js' });
  const captured = await page.evaluate(() => window.AAE_ATTRIBUTION.capture());
  expect(captured).toEqual(expect.objectContaining({ utmSource: 'chatgpt', utmMedium: 'ai_assistant', utmCampaign: 'mcp_estimate_price', landingPath: '/book' }));
});
