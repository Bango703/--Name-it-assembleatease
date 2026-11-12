// "Download on the App Store" is for website visitors only: a page the app
// opens inside itself (tagged ?aae_app=1) never asks to download the app.
import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route(/^(?!http:\/\/127\.0\.0\.1)/, (route) => route.abort());
});

test('A website visitor sees the App Store badge in the footer', async ({ page }) => {
  await page.goto('/index.html');
  await expect(page.locator('footer .footer-app')).toBeVisible();
});

test('A page opened inside the app shows no App Store badge', async ({ page }) => {
  await page.goto('/index.html?aae_app=1');
  await expect(page.locator('footer .footer-app')).toBeHidden();
  await page.goto('/become-an-easer.html?aae_app=1');
  await expect(page.locator('.app-store-promo').first()).toBeHidden();
});
