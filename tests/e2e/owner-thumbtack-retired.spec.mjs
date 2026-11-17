// Thumbtack retired (owner, 2026-11-16: "don't remove the Thumbtack job, only
// remove the Thumbtack things"). In a real browser with fixed data:
//   - Create Booking offers no Thumbtack choice and sends an ordinary owner
//     booking: the customer's agreement to the Terms, the current legal
//     versions, no Thumbtack fields;
//   - recording a cash payment still works without the Thumbtack deposit field;
//   - the past Thumbtack job still opens and reads as a Thumbtack job.
// No request leaves this machine: /api/* is answered here.
import { test, expect } from '@playwright/test';

const NOW = new Date('2026-11-17T16:00:00Z');
const u = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const OWNER_BOOKING = {
  id: u(1), ref: 'AAE-OWNERCASH1', source: 'owner_manual', status: 'completed', date: '2026-11-15', time: '10:00 AM',
  service: 'Furniture Assembly', service_city: 'Austin', service_zip: '78701', customer_name: 'Ann Lee', customer_email: 'ann@example.test',
  customer_phone: '5125550101', address: '1 Main St, Austin, TX 78701', total_price: 16238, amount_charged: 16238, tax_amount: 1238,
  payment_status: 'pending', payment_collected: false, created_at: '2026-11-14T12:00:00Z',
};
const PAST_THUMBTACK = {
  id: u(2), ref: 'AAE-LP7HC5WZQS', source: 'owner_manual', external_platform: 'thumbtack', status: 'completed', date: '2026-10-26', time: '1:00 PM',
  service: 'Furniture Assembly', service_city: 'Austin', service_zip: '78701', customer_name: 'Past Thumbtack Customer', customer_email: 'past@example.test',
  customer_phone: '5125550102', address: '2 Main St, Austin, TX 78701', total_price: 16238, amount_charged: 16238, tax_amount: 1238,
  payment_status: 'captured', stripe_payment_intent_id: 'pi_test_past', payout_status: 'paid', assembler_name: 'Pat Easer',
  external_agreement_verified_at: '2026-10-25T15:00:00Z', created_at: '2026-10-25T12:00:00Z',
};

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function openBookings(page, sent) {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.clock.install({ time: NOW });
  await page.route(/^(?!http:\/\/127\.0\.0\.1)/, route => route.abort());
  await page.route('**/api/**', route => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (req.method() === 'POST' && sent[path] !== undefined) {
      sent[path] = req.postDataJSON();
      if (path === '/api/owner/create-booking') return json(route, { ok: true, booking: { id: u(9), ref: 'AAE-NEWOWNER1' } });
      return json(route, { ok: true });
    }
    if (path === '/api/owner/session') return json(route, { token: 'e2e-session' });
    if (path === '/api/booking/list') return json(route, { bookings: [OWNER_BOOKING, PAST_THUMBTACK], count: 2 });
    if (path === '/api/legal-config') return json(route, { customerTermsVersion: '2026-10-18', privacyNoticeVersion: '2026-10-18' });
    return json(route, {});
  });
  await page.goto('/owner/index.html');
  await page.fill('#login-pw', 'local-e2e-only');
  await page.click('#login-btn');
  await expect(page.locator('#login-btn')).toBeHidden();
  await page.locator('a[data-view="bookings"]').first().click();
  await expect(page.locator('.topbar-title')).toHaveText('Bookings');
}

test('Create Booking: no Thumbtack choice, and an ordinary owner booking is sent', async ({ page }) => {
  const sent = { '/api/owner/create-booking': null };
  await openBookings(page, sent);
  await page.click('#new-booking-btn');
  await expect(page.locator('#owner-create-booking-modal')).toBeVisible();
  await expect(page.locator('#ocb-payment-method option[value="thumbtack"]')).toHaveCount(0);
  await expect(page.locator('#ocb-customer-terms-row')).toBeVisible();
  await page.fill('#ocb-first', 'Ann');
  const service = 'King Bed Frame Assembly';
  await page.fill('#ocb-service', service);
  await page.fill('#ocb-address', '1 Main St, Austin, TX 78701');
  await page.fill('#ocb-date', '2026-11-20');
  await page.fill('#ocb-final', '150');
  // Without the customer's agreement the booking is refused, as before.
  await page.click('#ocb-submit');
  await expect(page.locator('#ocb-error')).toContainText('Confirm the customer agreed');
  await page.check('#ocb-customer-terms');
  await page.click('#ocb-submit');
  await expect.poll(() => sent['/api/owner/create-booking']).not.toBeNull();
  const body = sent['/api/owner/create-booking'];
  expect(body).toMatchObject({ firstName: 'Ann', service, finalPriceCents: 15000, customerTermsAcceptedByOwner: true, sendConfirmation: true, termsVersion: '2026-10-18', privacyNoticeVersion: '2026-10-18' });
  expect(body).not.toHaveProperty('externalPlatform');
  expect(body).not.toHaveProperty('externalAgreementVerified');
});

test('Recording a cash payment works without the Thumbtack deposit field', async ({ page }) => {
  const sent = { '/api/owner/mark-payment-collected': null };
  await openBookings(page, sent);
  await page.click('#tabs .tab[data-status="all"]');
  await page.locator('#bookings-list .bk-row', { hasText: 'Ann Lee' }).click();
  await page.click('#detail-panel [data-action="collect-payment"]');
  await expect(page.locator('#collection-method option[value="thumbtack"]')).toHaveCount(0);
  await expect(page.locator('#collection-reference')).toHaveCount(0);
  await page.selectOption('#collection-method', 'cash');
  await page.check('#collection-confirm-cb');
  await page.click('#reason-confirm');
  await expect.poll(() => sent['/api/owner/mark-payment-collected']).not.toBeNull();
  expect(sent['/api/owner/mark-payment-collected']).toMatchObject({ bookingId: u(1), paymentMethod: 'cash', confirmedAmountCents: 16238 });
  expect(sent['/api/owner/mark-payment-collected']).not.toHaveProperty('externalPaymentReference');
});

test('The past Thumbtack job still opens and reads as a Thumbtack job', async ({ page }) => {
  await openBookings(page, {});
  await page.click('#tabs .tab[data-status="all"]');
  await page.locator('#bookings-list .bk-row', { hasText: 'Past Thumbtack Customer' }).click();
  await expect(page.locator('#detail-panel')).toContainText('AAE-LP7HC5WZQS');
  const source = page.locator('#detail-panel .detail-field', { has: page.locator('label', { hasText: 'Lead Source' }) });
  await expect(source).toContainText('Thumbtack');
});
