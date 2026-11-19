// The item step of /book on a phone (owner, 2026-11-18). Measured on the live
// site: after a customer ticked a TV, nothing on screen showed a total or a next
// step; the Continue button was ~2.5 screens down because `overflow-x: hidden`
// on its containers silently disabled its sticky position, and a separate
// optional notes screen followed. Only 7 of 40 measured /book visitors finished
// this step. These tests lock the fix:
//   - a running subtotal appears as soon as an item is picked;
//   - Continue is on screen (pinned) on a phone without scrolling;
//   - one tap on Continue reaches scheduling; notes and the custom-quote choice
//     sit on the same screen; desktop is unchanged in outcome.
// No request leaves this machine: /api/* is answered with empty JSON.
import { test, expect } from '@playwright/test';

const PHONE = { width: 390, height: 844 };
const TV_LINK = '/book?service=Mounting+%26+Hanging';

async function open(page, viewport) {
  await page.setViewportSize(viewport);
  await page.route('**/api/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await page.goto(TV_LINK);
  await page.waitForFunction(() => window.BOOK && BOOK.currentSvc === 'Mounting & Hanging' && BOOK.itemStage === 'items');
}

async function continueBox(page) {
  return page.evaluate(() => {
    const btn = document.getElementById('s1-next');
    const r = btn.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, viewport: window.innerHeight, disabled: btn.disabled, text: btn.innerText.replace(/\s+/g, ' ').trim() };
  });
}

test('phone: a picked item shows a running subtotal and Continue stays on screen', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page, PHONE);

  const before = await continueBox(page);
  expect(before.disabled).toBe(true);
  expect(before.text).toBe('Choose an item first');
  expect(before.bottom, 'the disabled button is visible too, so the next step is never hidden').toBeLessThanOrEqual(before.viewport);

  await page.getByText('TV 41"–55" (standard wall)', { exact: false }).first().click();
  await expect(page.getByTestId('running-subtotal')).toHaveText('$119');
  const after = await continueBox(page);
  expect(after.disabled).toBe(false);
  expect(after.text).toContain('Review job plan & schedule');
  expect(after.top, 'Continue is on screen without scrolling').toBeGreaterThanOrEqual(0);
  expect(after.bottom, 'Continue is on screen without scrolling').toBeLessThanOrEqual(after.viewport);

  await page.getByText('Soundbar mount (below/above TV)', { exact: false }).first().click();
  await expect(page.getByTestId('running-subtotal')).toHaveText('$174');

  // Scrolled to the middle of the list, Continue is still pinned on screen.
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight / 2));
  const mid = await continueBox(page);
  expect(mid.bottom).toBeLessThanOrEqual(mid.viewport);
  expect(mid.top).toBeGreaterThanOrEqual(0);

  // No sideways scrolling was introduced by switching hidden to clip.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  expect(errors).toEqual([]);
});

test('phone: one tap on Continue reaches scheduling; notes and custom quote are on the item screen', async ({ page }) => {
  await open(page, PHONE);
  await page.getByText('TV 56"–65" (standard wall)', { exact: false }).first().click();
  await expect(page.locator('#s1-details')).toBeVisible();
  await expect(page.locator('#s1-quote')).toBeAttached();
  await expect(page.locator('#item-stage-secondary-btn')).toBeVisible();
  await page.locator('#s1-details').fill('Second floor, elevator available');

  await page.locator('#s1-next').click();
  await expect(page.locator('#step-3')).toBeVisible();
  const state = await page.evaluate(() => ({ details: BOOK.details, items: BOOK.selectedItems['Mounting & Hanging'].map((i) => i.name) }));
  expect(state.details).toBe('Second floor, elevator available');
  expect(state.items).toEqual(['TV 56"–65" (standard wall)']);
  await expect(page.locator('#step-3')).toContainText('$149');
});

test('phone: Continue is refused until a main item is picked', async ({ page }) => {
  await open(page, PHONE);
  await page.evaluate(() => handleServiceStageContinue());
  await expect(page.locator('#s1-err')).toContainText('Pick the main item first');
  await expect(page.locator('#step-3')).toBeHidden();
});

test('desktop: picking an item and pressing Continue still reaches scheduling', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page, { width: 1280, height: 900 });
  await page.getByText('TV 41"–55" (standard wall)', { exact: false }).first().click();
  const box = await continueBox(page);
  expect(box.disabled).toBe(false);
  await page.locator('#s1-next').click();
  await expect(page.locator('#step-3')).toBeVisible();
  expect(errors).toEqual([]);
});

// First visit on a phone (every ad click): the cookie banner is open. Both the
// consent choice and Continue must be visible and usable at the same time, and
// answering the banner must still record the choice exactly as before.
test('phone, first visit: cookie banner and Continue are both visible and usable', async ({ page }) => {
  await open(page, PHONE);
  const banner = page.locator('#cookie-banner');
  await expect(banner).toBeVisible();
  await page.getByText('TV 41"–55" (standard wall)', { exact: false }).first().click();
  await expect(page.getByTestId('running-subtotal')).toHaveText('$119');
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

  const topAt = (selector) => page.evaluate((sel) => {
    const el = document.querySelector(sel);
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { onScreen: r.top >= 0 && r.bottom <= window.innerHeight, unobstructed: !!hit && (hit === el || el.contains(hit)) };
  }, selector);
  expect(await topAt('#s1-next')).toEqual({ onScreen: true, unobstructed: true });
  expect(await topAt('button.cookie-decline')).toEqual({ onScreen: true, unobstructed: true });
  expect(await topAt('button.cookie-accept')).toEqual({ onScreen: true, unobstructed: true });

  // Answering the banner works as before, and the bar drops back to the bottom.
  await page.locator('button.cookie-decline').click();
  await expect(banner).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem('cookie-consent'))).toBe('declined');
  expect(await page.evaluate(() => document.documentElement.style.getPropertyValue('--aae-cookie-banner-space'))).toBe('');
  expect(await topAt('#s1-next')).toEqual({ onScreen: true, unobstructed: true });
  await page.locator('#s1-next').click();
  await expect(page.locator('#step-3')).toBeVisible();
});
