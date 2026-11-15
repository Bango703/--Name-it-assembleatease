// The Cases screen of the owner console (owner, 2026-11-13). In a real browser:
//   - the cards and tab counts are the server's, and a card opens exactly the
//     cases it counts;
//   - the list shows priority, status and age; the case opens beside it with
//     Overview, Communication and Timeline;
//   - the page does not scroll on a desktop window.
// /api/* is answered here with the server's own view rules (CASE_VIEWS).
import { test, expect } from '@playwright/test';
import { CASE_VIEWS, countCaseViews, summarizeOperationCases } from '../../api/owner/cases.js';

const SHOTS = process.env.HYBRID_SHOTS || '';
const row = (i, over) => ({
  id: `c0000000-0000-4000-8000-${String(i).padStart(12, '0')}`, case_ref: `AAE-CS-${i}`, ref: `AAE-CS-${i}`,
  status: 'open', severity: 'normal', case_type: 'support', type: 'support', typeLabel: 'Support Request',
  subject: `Case ${i}`, description: 'Customer asked about the appointment window.', updatedAt: '2026-11-12T15:00:00Z',
  created_at: '2026-11-10T15:00:00Z', customer: { name: `Customer ${i}`, email: `c${i}@example.test` }, ...over,
});
const ROWS = [
  row(1, { status: 'open', severity: 'critical', subject: 'An Easer tried to share a phone number' }),
  row(2, { status: 'open', severity: 'high' }),
  row(3, { status: 'in_progress', severity: 'normal' }),
  row(4, { status: 'waiting_customer', severity: 'low' }),
  row(5, { status: 'waiting_easer', severity: 'high', case_type: 'damage', type: 'damage', typeLabel: 'Damage' }),
  row(6, { status: 'resolved', resolved_at: '2026-11-11T15:00:00Z' }),
  row(7, { status: 'closed', closed_at: '2026-11-12T03:00:00Z' }),
];
const withLabels = r => ({ ...r, statusLabel: r.status.replace(/_/g, ' '), availableActions: [{ action: 'acknowledge', label: 'Acknowledge', requiresConfirmation: false }] });

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function openCases(page, requests) {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.clock.install({ time: new Date('2026-11-13T15:00:00Z') });
  await page.route(/^(?!http:\/\/127\.0\.0\.1)/, route => route.abort());
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/owner/session') return json(route, { token: 'e2e-session' });
    if (url.pathname === '/api/owner/cases') {
      const q = url.searchParams;
      if (q.get('caseId')) {
        const found = ROWS.find(r => r.id === q.get('caseId'));
        return json(route, { case: withLabels(found), events: [{ id: 'ev1', eventType: 'created', createdAt: '2026-11-10T15:00:00Z', summary: 'Case received' }] });
      }
      requests.push(Object.fromEntries(q.entries()));
      const type = q.get('caseType') || 'all', severity = q.get('severity') || 'all', view = q.get('view') || 'all', status = q.get('status') || 'all';
      const narrowed = ROWS.filter(r => (type === 'all' || r.case_type === type) && (severity === 'all' || r.severity === severity));
      const list = narrowed.filter(r => CASE_VIEWS[view](r) && (status === 'all' || r.status === status));
      return json(route, { summary: summarizeOperationCases(ROWS), views: countCaseViews(narrowed), resolution: { resolvedLast30Days: 2, avgHoursToResolve: 4.8 }, hiddenTestCases: 0, cases: list.map(withLabels) });
    }
    return json(route, {});
  });
  await page.goto('/owner/index.html');
  await page.fill('#login-pw', 'local-e2e-only');
  await page.click('#login-btn');
  await expect(page.locator('#login-btn')).toBeHidden();
  await page.locator('a[data-view="cases"]').first().click();
  await expect(page.locator('.topbar-title')).toHaveText('Cases');
}

test('cards and tabs are the server counts, and a card opens exactly its cases', async ({ page }) => {
  const requests = [];
  await openCases(page, requests);
  const views = countCaseViews(ROWS);
  await expect(page.locator('#cases-stat-active')).toHaveText(String(views.active));
  await expect(page.locator('#cases-stat-new')).toHaveText(String(views.new));
  await expect(page.locator('#cases-stat-priority')).toHaveText(String(views.high_priority));
  await expect(page.locator('#cases-stat-waiting')).toHaveText(String(views.waiting));
  await expect(page.locator('#cases-stat-resolved')).toHaveText(String(views.resolved));
  await expect(page.locator('#cases-stat-avg')).toHaveText('4.8 hrs');
  for (const key of Object.keys(views)) await expect(page.locator(`#cases-view-${key}`)).toHaveText(String(views[key]));
  await expect(page.locator('#cases-list .cases-row')).toHaveCount(views.active);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/console-cases.png` });

  // A card opens its view with every other filter cleared.
  await page.selectOption('#cases-type-filter', 'damage');
  await expect(page.locator('#cases-view-high_priority')).toHaveText('1');
  await page.locator('#cases-stats-row .kpi[data-case-view="high_priority"]').click();
  await expect(page.locator('#cases-list .cases-row')).toHaveCount(views.high_priority);
  expect(requests.at(-1)).toMatchObject({ view: 'high_priority', status: 'all', caseType: 'all', severity: 'all' });
  await expect(page.locator('#cases-tabs .tab.active')).toHaveAttribute('data-case-view', 'high_priority');
  // A tab keeps the type filter, and its count is its list.
  await page.selectOption('#cases-type-filter', 'damage');
  await page.locator('#cases-tabs [data-case-view="waiting"]').click();
  await expect(page.locator('#cases-list .cases-row')).toHaveCount(1);
  await expect(page.locator('#cases-view-waiting')).toHaveText('1');
});

test('the case opens beside the list with Overview, Communication and Timeline', async ({ page }) => {
  await openCases(page, []);
  const first = page.locator('#cases-list .cases-row').first();
  await expect(first).toHaveClass(/severity-bar-critical/);
  await first.click();
  const detail = page.locator('#cases-detail');
  await expect(detail.locator('h3')).toHaveText('An Easer tried to share a phone number');
  await expect(detail.locator('[data-case-pane="overview"]')).toBeVisible();
  await expect(detail.locator('#cases-update-form')).toBeVisible();
  await detail.locator('[data-case-tab="communication"]').click();
  await expect(detail.locator('[data-case-pane="overview"]')).toBeHidden();
  await expect(detail.locator('#cases-contact-form')).toBeVisible();
  await detail.locator('[data-case-tab="timeline"]').click();
  await expect(detail.locator('.cases-timeline')).toBeVisible();
  const list = await page.locator('#cases-view .cases-grid > .cases-panel').first().boundingBox();
  const box = await page.locator('#cases-view .cases-grid > .cases-panel').nth(1).boundingBox();
  expect(box.x).toBeGreaterThan(list.x + list.width - 1);
  const sizes = await page.evaluate(() => ({ h: document.scrollingElement.scrollHeight, vh: innerHeight, w: document.scrollingElement.scrollWidth, vw: innerWidth }));
  expect(sizes.w).toBeLessThanOrEqual(sizes.vw);
  expect(sizes.h).toBeLessThanOrEqual(sizes.vh + 1);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/console-cases-detail.png` });
});
