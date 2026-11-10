// The live owner dashboard, checked every night against real data. It only
// reads: it signs in, opens views and compares what two places on screen say
// about the same thing. It never clicks a button that changes anything.
// Runs only when OWNER_PASSWORD is set (GitHub secret); see
// .github/workflows/owner-dashboard-live.yml.
import { test, expect } from '@playwright/test';
import { checkDashboardAgrees } from './checks.mjs';

const password = process.env.OWNER_PASSWORD || '';
test.skip(!password, 'OWNER_PASSWORD is not set');

async function signIn(page) {
  // Analytics and error reporting stay off for this robot visit.
  await page.route(/googletagmanager|google-analytics|sentry-cdn|ingest\.us\.sentry\.io|clarity\.ms/, (route) => route.abort());
  await page.goto('/owner');
  await page.fill('#login-pw', password);
  await page.click('#login-btn');
  await expect.poll(() => page.evaluate(() => document.getElementById('login-gate')?.style.display === 'none' || !document.getElementById('login-btn')?.offsetParent), { message: 'signed in', timeout: 15_000 }).toBe(true);
}

test('Live dashboard: every number agrees with its source, and everything loaded', async ({ page }) => {
  await signIn(page);
  await checkDashboardAgrees(page);
});
