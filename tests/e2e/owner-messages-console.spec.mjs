// Messages in the owner console (owner, 2026-11-15: "messages doesn't click,
// nothing to click but shows the red alert"). The conversation opened below a
// long list, out of sight. Now the list sits on the left and the conversation
// opens beside it, with the chosen row marked.
import { test, expect } from '@playwright/test';

const conv = (i, over = {}) => ({
  kind: 'sms', conversationId: `sms-${i}`, customerName: `Texter ${i}`, phone: `+1512555010${i}`,
  lastMessage: { at: '2026-11-15T15:00:00Z', direction: 'SMS to you', body: `Message number ${i}` },
  needsReply: true, unreadForOwner: 1, ...over,
});
const CONVERSATIONS = Array.from({ length: 9 }, (_, i) => conv(i + 1));

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

test('a conversation opens beside the list, in view, with its row marked', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.clock.install({ time: new Date('2026-11-15T16:00:00Z') });
  await page.route(/^(?!http:\/\/127\.0\.0\.1)/, route => route.abort());
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/owner/session') return json(route, { token: 'e2e-session' });
    if (url.pathname === '/api/owner/messages') {
      return json(route, { conversations: CONVERSATIONS, needsReply: CONVERSATIONS.map(c => 'sms:' + c.conversationId), smsAvailable: true });
    }
    if (url.pathname === '/api/owner/sms-messages') {
      const id = url.searchParams.get('conversationId');
      const c = CONVERSATIONS.find(x => x.conversationId === id);
      return json(route, { conversation: { customer_name: c.customerName, phone: c.phone }, messages: [{ direction: 'inbound', body: c.lastMessage.body, occurred_at: '2026-11-15T15:00:00Z' }], replyEligibility: { consentRecorded: true } });
    }
    return json(route, {});
  });
  await page.goto('/owner/index.html');
  await page.fill('#login-pw', 'local-e2e-only');
  await page.click('#login-btn');
  await expect(page.locator('#login-btn')).toBeHidden();
  await page.locator('a[data-view="messages"]').first().click();
  await expect(page.locator('#inbox-list .inbox-row')).toHaveCount(9);
  await expect(page.locator('#sms-placeholder')).toBeVisible();
  await expect(page.locator('#sms-panel')).toBeHidden();

  // The last conversation in the list: before, its thread opened off-screen.
  await page.locator('#inbox-list .inbox-row').nth(8).click();
  await expect(page.locator('#sms-panel')).toBeVisible();
  await expect(page.locator('#sms-placeholder')).toBeHidden();
  await expect(page.locator('#sms-thread-title')).toHaveText('Texter 9');
  await expect(page.locator('#sms-thread-body')).toContainText('Message number 9');
  await expect(page.locator('#inbox-list .inbox-row').nth(8)).toHaveClass(/active/);
  const list = await page.locator('#inbox-list').boundingBox();
  const panel = await page.locator('#sms-panel').boundingBox();
  expect(panel.x).toBeGreaterThan(list.x + list.width - 1);
  // The open conversation is on screen without scrolling.
  expect(panel.y).toBeLessThan(900);
  expect(panel.y + 40).toBeLessThan(900);
});
