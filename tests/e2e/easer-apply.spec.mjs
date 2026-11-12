// The Easer application, end to end in a real browser on a phone-size screen
// (owner, 2026-11-12: the page was redesigned to flow; the form must still
// work exactly as before). Server answers are fixed test data; nothing leaves
// this machine.
import { test, expect, devices } from '@playwright/test';

// iPhone 13 screen on Chromium (CI installs Chromium only).
const { defaultBrowserType, ...iphone } = devices['iPhone 13'];
test.use(iphone);

async function openApply(page, posts) {
  await page.route(/^(?!http:\/\/127\.0\.0\.1)/, (route) => route.abort());
  await page.route('**/api/assembler/application-fee-status**', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ applicationFee: { amountCents: 0, standardAmountCents: 3000, currency: 'usd', amountDisplay: '$0.00', standardAmountDisplay: '$30.00', waiverAvailable: true, finalDecisionAtSubmission: true }, market: { active: true, code: 'EASER_MARKET_ACTIVE', waitlistEndpoint: null } }),
  }));
  await page.route('**/api/assembler/apply', async (route) => {
    posts.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, feeWaived: true }) });
  });
  await page.route('**/api/**', (route) => route.fallback());
  await page.goto('/assembler/apply.html');
  // The floating "Install app" pill is removed by #438; until then it covers the
  // bottom of the screen on Easer pages.
  await page.addStyleTag({ content: '#aae-install-pill{display:none!important}' });
  await expect(page.locator('#submit-btn')).toHaveText('Submit Application');
}

test('On a phone, the form starts near the top and the steps are not boxed', async ({ page }) => {
  await openApply(page, []);
  await expect(page.locator('.hero-photo')).toBeHidden();
  await expect(page.locator('.easer-value-preview')).toBeVisible();
  // The last note is not covered by the form (it was cut off on phones).
  const lastNoteBottom = await page.locator('.easer-value-item').last().evaluate((el) => el.getBoundingClientRect().bottom);
  const panelTop = await page.locator('#application-panel').evaluate((el) => el.getBoundingClientRect().top);
  expect(lastNoteBottom).toBeLessThanOrEqual(panelTop);
  const formTop = await page.locator('#application-panel').evaluate((el) => el.getBoundingClientRect().top + window.scrollY);
  expect(formTop).toBeLessThan(844 * 1.1);
  const box = await page.locator('#apply-form > .section').nth(1).evaluate((el) => {
    const cs = getComputedStyle(el);
    return { left: cs.borderLeftWidth, radius: cs.borderTopLeftRadius, bg: cs.backgroundColor };
  });
  expect(box).toEqual({ left: '0px', radius: '0px', bg: 'rgba(0, 0, 0, 0)' });
  await expect(page.locator('a.agreement-link')).toHaveAttribute('href', '/assembler/contractor-agreement');
  // Yes/No answers: the circle sits beside the answer, not above it.
  const radio = await page.locator('input[name="transport"][value="yes"]').evaluate((input) => getComputedStyle(input.closest('label')).display);
  expect(radio).toBe('flex');
});

test('An applicant can fill in and submit the whole application', async ({ page }) => {
  const posts = [];
  await openApply(page, posts);
  await page.fill('#full-name', 'Test Applicant');
  await page.fill('#email', 'applicant@example.test');
  await page.fill('#phone', '5125550123');
  await page.fill('#years', '4');
  await page.fill('#city', 'Austin');
  await page.selectOption('#state', 'TX');
  await page.fill('#zip', '78745');
  await page.locator('input[type="checkbox"][value="Furniture Assembly"]').check({ force: true });
  await page.locator('input[type="checkbox"][value="TV & Display Mounting"]').check({ force: true });
  // The tools question is hidden on purpose; the form then records tools as yes.
  await page.locator('input[name="transport"][value="yes"]').check({ force: true });
  await page.locator('input[name="competing"][value="no"]').check({ force: true });
  await page.locator('#contractor-agree').check();
  await page.locator('#conduct').check();
  await page.locator('#submit-btn').click();

  await expect(page.locator('#success-state')).toBeVisible();
  await expect(page.locator('#success-msg')).toContainText('submitted with no application fee');
  expect(posts).toHaveLength(1);
  const body = posts[0];
  expect(body).toMatchObject({
    fullName: 'Test Applicant', email: 'applicant@example.test', city: 'Austin', state: 'TX', zip: '78745',
    hasTools: true, hasTransport: true, yearsExperience: 4, codeOfConduct: true, contractorAgreementSigned: true,
  });
  expect(body.servicesOffered).toEqual(expect.arrayContaining(['Furniture Assembly', 'TV & Display Mounting']));
});

test('Submitting without the agreements is refused before anything is sent', async ({ page }) => {
  const posts = [];
  await openApply(page, posts);
  await page.fill('#full-name', 'Test Applicant');
  await page.fill('#email', 'applicant@example.test');
  await page.fill('#phone', '5125550123');
  await page.fill('#years', '4');
  await page.fill('#city', 'Austin');
  await page.fill('#zip', '78745');
  await page.locator('input[type="checkbox"][value="Furniture Assembly"]').check({ force: true });
  await page.locator('input[name="transport"][value="yes"]').check({ force: true });
  await page.locator('input[name="competing"][value="no"]').check({ force: true });
  await page.locator('#submit-btn').click();
  await expect(page.locator('#contractor-error')).not.toBeEmpty();
  expect(posts).toHaveLength(0);
});
