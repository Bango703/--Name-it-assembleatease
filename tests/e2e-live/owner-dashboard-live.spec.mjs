// The live owner dashboard, checked every night against real data. It only
// reads: it signs in, opens views and compares what two places on screen say
// about the same thing. It never clicks a button that changes anything.
// Runs only when OWNER_PASSWORD is set (GitHub secret); see
// .github/workflows/owner-dashboard-live.yml.
import { test, expect } from '@playwright/test';
import { checkDashboardAgrees } from './checks.mjs';

const password = process.env.OWNER_PASSWORD || '';
test.skip(!password, 'OWNER_PASSWORD is not set');

// Reasons a sign-in can be refused, by the server's status code. Only the code
// and this fixed text reach the (public) log.
const SIGN_IN_REFUSED = {
  401: 'the OWNER_PASSWORD secret does not match the owner password in Vercel',
  429: 'too many sign-in attempts from this address; try again later',
  503: 'owner sign-in is not configured on the server (rate limiter or session secret)',
};

async function signIn(page) {
  // Analytics and error reporting stay off for this robot visit.
  await page.route(/googletagmanager|google-analytics|sentry-cdn|ingest\.us\.sentry\.io|clarity\.ms/, (route) => route.abort());
  const opened = await page.goto('/owner');
  if (!opened || !opened.ok()) throw new Error(`The owner page did not open: HTTP ${opened ? opened.status() : 'no response'}`);
  if (!(await page.locator('#login-pw').count())) throw new Error('The owner page opened without its sign-in form (a bot check may have answered instead)');
  const answered = page.waitForResponse((r) => r.url().includes('/api/owner/session') && r.request().method() === 'POST', { timeout: 20_000 });
  await page.fill('#login-pw', password);
  await page.click('#login-btn');
  const status = (await answered).status();
  if (status !== 200) throw new Error(`Sign-in refused: HTTP ${status}${SIGN_IN_REFUSED[status] ? ` (${SIGN_IN_REFUSED[status]})` : ''}`);
  await expect.poll(() => page.evaluate(() => document.getElementById('login-gate')?.style.display === 'none'), { message: 'dashboard opened after sign-in', timeout: 15_000 }).toBe(true);
}

test('Live dashboard: every number agrees with its source, and everything loaded', async ({ page }) => {
  await signIn(page);
  await checkDashboardAgrees(page);
});
