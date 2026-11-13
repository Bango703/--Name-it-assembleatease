// The hybrid marketplace in the real owner dashboard (owner, 2026-11-13:
// "fully built and professionally ready, fully aligned with owner dash, full
// end to end test"). Each test drives the real page through one promise:
//   - a custom quote shows Easer prices inside the real quote window;
//   - the owner asks the Easers they choose, and sees who was reached;
//   - sending at an Easer's price sends no amount: the server prices it;
//   - a partner account opens, saves, and reports from the Partners panel.
// No request leaves this machine: /api/* is answered by a small in-memory
// server that keeps the same contract as api/owner/quote-offers.js,
// api/owner/quote-approve.js and api/owner/partners.js.
import { test, expect } from '@playwright/test';

const NOW = new Date('2026-11-13T15:00:00Z');
const QUOTE_ID = 'b0000000-0000-4000-8000-000000000001';
const SHOTS = process.env.HYBRID_SHOTS || '';

function quoteBooking(over = {}) {
  return {
    id: QUOTE_ID, ref: 'AAE-QUOTE-E2E', status: 'pending', payment_status: 'not_required', payment_method_type: 'card',
    service: 'Office Furniture Assembly', customer_name: 'Taylor Example', customer_email: 'taylor@example.test', customer_phone: '5125550100',
    address: '100 Congress Ave, Austin, TX 78701', service_city: 'Austin', service_zip: '78701',
    date: '2026-11-20', time: '10:00 AM – 12:00 PM', created_at: '2026-11-12T18:00:00Z',
    details: 'Two sit-stand desks and two office chairs. Boxes are on the ground floor. Call me at 512-555-0100.',
    total_price: 30000, tax_amount: 2286, is_test_booking: false, ...over,
  };
}

const ACCOUNT_BOOKING = quoteBooking({
  id: 'b0000000-0000-4000-8000-000000000002', ref: 'AAE-ACCT-E2E', status: 'confirmed', payment_status: 'authorized', payment_method_type: 'card',
  service: 'Furniture Assembly', customer_name: 'Jordan Tenant', promo_code: 'PLAKE234',
  _partner_account: { id: 'p0000000-0000-4000-8000-000000000001', name: 'Lakeline Property Group', code: 'PLAKE234' },
});

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

// The in-memory server. State lives here so each step sees the last one.
function hybridServer() {
  const state = {
    booking: quoteBooking(),
    offers: [],
    eligible: [
      { id: 'e1', name: 'Alex Example', rating: 4.9, completedJobs: 12, city: 'Austin' },
      { id: 'e2', name: 'Sam Example', rating: 4.7, completedJobs: 5, city: 'Round Rock' },
    ],
    approveBodies: [],
    partner: null,
  };
  const priced = earnings => {
    const subtotal = Math.ceil(earnings * 100 / 70);
    const tax = Math.round(subtotal * 0.0825);
    return { subtotalCents: subtotal, taxCents: tax, totalCents: subtotal + tax, platformFeeCents: subtotal - earnings };
  };
  const offersPayload = () => ({
    enabled: true, migrationNeeded: false,
    suggestedScope: 'Two sit-stand desks and two office chairs. Boxes are on the ground floor. Call me at [removed].',
    workDescription: state.workDescription || null,
    askableEasers: state.eligible.filter(e => !state.offers.some(o => o.easer.id === e.id)),
    askRoom: 8 - state.offers.length,
    askMessage: null,
    offers: state.offers.map(o => ({ ...o, customerQuote: o.earningsCents ? priced(o.earningsCents) : null })),
  });
  return {
    state,
    async handle(route) {
      const req = route.request();
      const url = new URL(req.url());
      const body = req.method() === 'POST' ? JSON.parse(req.postData() || '{}') : {};
      if (url.pathname === '/api/owner/session') return json(route, { token: 'e2e-session' });
      if (url.pathname === '/api/owner/live-ops') return json(route, { businessDate: '2026-11-13', summary: {}, alerts: [] });
      if (url.pathname === '/api/owner/voice-calls') return json(route, { enabled: true, reviewStateAvailable: true, unreviewed: 0, calls: [] });
      if (url.pathname === '/api/booking/list') {
        // Same summary api/booking/list.js attaches (summarizeQuoteOffers).
        const rows = [{ ...state.booking }, ACCOUNT_BOOKING, ...(state.extraBookings || [])];
        if (state.offers.length) rows[0]._quote_offers = {
          asked: state.offers.length,
          priced: state.offers.filter(o => ['submitted', 'selected'].includes(o.status)).length,
          waiting: state.offers.filter(o => o.status === 'invited' && o.open).length,
          selected: state.offers.some(o => o.status === 'selected'),
        };
        return json(route, { bookings: rows, count: rows.length });
      }
      if (url.pathname === '/api/owner/quote-offers') {
        if (req.method() === 'GET') return json(route, offersPayload());
        if (body.action === 'invite') {
          const chosen = state.eligible.filter(e => !body.easerIds || body.easerIds.includes(e.id));
          if (!chosen.length) return json(route, { error: 'Choose at least one Easer to ask.' }, 400);
          state.workDescription = state.workDescription || body.scope;
          state.offers = state.offers.concat(chosen.map(e => ({ id: 'o-' + e.id, status: 'invited', open: true, easer: e, earningsCents: null, hours: null, crewSize: null,
            note: null, respondBy: '2026-11-14T15:00:00Z', updatedAt: '2026-11-13T15:00:00Z' })));
          state.inviteBody = body;
          return json(route, { ok: true, invited: chosen.length, notified: chosen.length, respondBy: '2026-11-14T15:00:00Z' });
        }
        if (body.action === 'close') { state.offers.forEach(o => { if (o.open) { o.status = 'closed'; o.open = false; } }); return json(route, { ok: true }); }
      }
      if (url.pathname === '/api/owner/quote-approve') {
        state.approveBodies.push(body);
        const offer = state.offers.find(o => o.id === body.quoteOfferId);
        if (!offer || offer.updatedAt !== body.offerUpdatedAt) return json(route, { error: 'That Easer offer is no longer available. Refresh the offers and choose again.' }, 409);
        const q = priced(offer.earningsCents);
        state.offers.forEach(o => { o.status = o === offer ? 'selected' : 'not_selected'; o.open = false; });
        state.booking = { ...state.booking, payment_status: 'quote_pending_approval', quote_amount_cents: q.totalCents, quote_sent_at: NOW.toISOString(), quote_expires_at: '2026-11-20T15:00:00Z' };
        return json(route, { ok: true, approvalPending: true, amount: q.totalCents, easerEarningsCents: offer.earningsCents, platformFeeCents: q.platformFeeCents, warnings: [] });
      }
      if (url.pathname === '/api/owner/partners') return json(route, partnersPayload(state, body, req.method()));
      return json(route, {});
    },
  };
}

function partnersPayload(state, body, method) {
  const base = {
    id: 'p0000000-0000-4000-8000-000000000001', refCode: 'demo12', source: 'manual', name: 'Lakeline Property Group', kind: 'property_manager',
    city: 'Austin', social: [], history: [], stage: 'interested', bookingLink: 'https://www.assembleatease.com/book?utm_campaign=demo12',
    bookings: 0, completedJobs: 0, bookingRefs: [], updatedAt: '2026-11-13T15:00:00Z',
  };
  if (method === 'POST' && body.action === 'account') {
    state.partner = { status: body.status, code: (state.partner && state.partner.code) || 'PLAKE234', discountPct: Number(body.discountPct),
      preferredEaserIds: body.preferredEaserIds || [], startedAt: NOW.toISOString(),
      link: 'https://www.assembleatease.com/book?promo=PLAKE234&utm_source=partner&utm_medium=account&utm_campaign=demo12' };
    state.lastAccountBody = body;
    return { partner: { ...base, stage: 'partner', account: state.partner } };
  }
  const account = state.partner ? { ...state.partner, report: { jobs: 2, completed: 1, open: 1, cancelled: 0, chargedCents: 21542, taxCents: 1642, platformFeeCents: 5970, easerPayCents: 13930, refundedCents: 0, processingFeeCents: 655, netEstimateCents: 5315, unpaidCompleted: 0, estimatedFeeJobs: 0 } } : null;
  return {
    stages: [{ id: 'to_contact', label: 'To contact' }, { id: 'contacted', label: 'Contacted' }, { id: 'interested', label: 'Interested' }, { id: 'partner', label: 'Partner' }, { id: 'not_a_fit', label: 'Not a fit' }],
    kinds: [{ id: 'property_manager', label: 'Property manager', template: 'A' }],
    partners: [{ ...base, stage: state.partner ? 'partner' : 'interested', account }],
    summary: { contactedThisWeek: [], followUpDue: [], weeklyTarget: 10 }, bookingCountsAvailable: true, seedImported: 0, seedAvailable: 0, tableMissing: false,
    accounts: { enabled: true, columnsReady: true, reportsAvailable: true, maxDiscountPct: 20, easers: [{ id: 'e1', name: 'Alex Example', city: 'Austin', rating: 4.9 }, { id: 'e2', name: 'Sam Example', city: 'Round Rock', rating: 4.7 }] },
  };
}

async function openDashboard(page, server) {
  await page.clock.install({ time: NOW });
  await page.route(/^(?!http:\/\/127\.0\.0\.1)/, route => route.abort());
  await page.route('**/api/**', route => server.handle(route));
  await page.goto('/owner/index.html');
  await page.fill('#login-pw', 'local-e2e-only');
  await page.click('#login-btn');
  await expect(page.locator('#login-btn')).toBeHidden();
}

async function shot(page, name) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/hybrid-${name}.png`, fullPage: false });
}

test('custom quote: ask chosen Easers, receive a price, send one server-priced quote', async ({ page }) => {
  const server = hybridServer();
  await openDashboard(page, server);
  await page.locator('a[data-view="bookings"]').first().click();
  await page.locator('#bookings-list').getByText('AAE-QUOTE-E2E').first().click();
  await page.getByRole('button', { name: /Send Quote for Customer Approval/ }).first().click();
  const modal = page.locator('#quote-modal');
  await expect(modal).toHaveClass(/open/);
  await expect(modal.locator('#qm-offers')).toBeVisible();
  await shot(page, '1-quote-window');

  // The work description starts from the request with contact details removed.
  await expect(modal.locator('#qo-scope')).toHaveValue(/\[removed\]/);
  await expect(modal.locator('#qo-scope')).not.toHaveValue(/555-0100/);
  await expect(modal.getByRole('button', { name: 'Ask 2 Easers' })).toBeVisible();

  // The owner chooses who to ask: untick Sam, ask Alex only.
  await modal.getByLabel(/Sam Example/).uncheck();
  await expect(modal.getByRole('button', { name: 'Ask 1 Easer' })).toBeVisible();
  await modal.getByRole('button', { name: 'Ask 1 Easer' }).click();
  await expect(page.locator('#toast-container, .toast').last()).toContainText(/Asked 1 Easer/);
  expect(server.state.inviteBody.easerIds).toEqual(['e1']);
  await expect(modal.locator('.qo-offer')).toHaveCount(1);
  await expect(modal.locator('.qo-offer')).toContainText('Alex Example');
  await expect(modal.locator('.qo-desc')).toContainText('Easers see:');
  await shot(page, '2-asked');
  // Sam can still be asked later.
  await modal.getByRole('button', { name: 'Ask more Easers' }).click();
  await expect(modal.getByLabel(/Sam Example/)).toBeChecked();
  await expect(modal.getByRole('button', { name: 'Ask 1 Easer' })).toBeVisible();

  // Alex answers (what api/assembler/price-requests.js records).
  Object.assign(server.state.offers[0], { status: 'submitted', earningsCents: 30000, hours: 3.5, crewSize: 1, note: 'Both desks and chairs in one visit.', updatedAt: '2026-11-13T16:00:00Z' });
  await modal.getByRole('button', { name: /Refresh/ }).click();
  // The bookings list says a price is in, without opening the quote.
  await page.evaluate(() => window.loadBookings && window.loadBookings(true)).catch(() => {});
  const send = modal.getByRole('button', { name: /Send quote at \$463\.94/ });
  await expect(send).toBeVisible();
  await expect(modal).toContainText('Alex earns $300.00');
  await expect(modal).toContainText('Customer pays $463.94');
  await shot(page, '3-price-in');

  await send.click();
  await expect(modal).not.toHaveClass(/open/);
  await expect(page.locator('#bookings-list')).toContainText('Easer prices: Quote priced from an Easer');
  const sent = server.state.approveBodies.at(-1);
  expect(sent.quoteOfferId).toBe('o-e1');
  expect(sent.finalPriceCents).toBeUndefined(); // the browser never sends an amount
  expect(server.state.offers[0].status).toBe('selected');
});

test('partner account: open with pricing and preferred Easer, then see the report', async ({ page }) => {
  const server = hybridServer();
  await openDashboard(page, server);
  await page.locator('[data-view="partners"]').first().click();
  await page.locator('#partners-view').getByText('Lakeline Property Group').first().click();
  const section = page.locator('#partners-detail');
  await expect(section.getByRole('heading', { name: 'Account', exact: true })).toBeVisible();
  await section.locator('#partners-acct-pct').fill('10');
  await section.getByLabel(/Alex Example/).check();
  await shot(page, '4-partner-before');
  await section.getByRole('button', { name: 'Open account' }).click();
  await expect(section).toContainText('PLAKE234');
  expect(server.state.lastAccountBody).toMatchObject({ action: 'account', status: 'active', discountPct: '10', preferredEaserIds: ['e1'] });
  await expect(section.locator('.partners-stat').first()).toContainText('Jobs2');
  await expect(section.locator('.partners-stat.is-strong')).toContainText('$53.15');
  await expect(section.locator('#partners-report-month')).toHaveValue('');
  await shot(page, '5-partner-account');
});

test('bookings list and booking view show Easer prices and partner accounts', async ({ page }) => {
  const server = hybridServer();
  server.state.offers = [
    { id: 'o-e1', status: 'submitted', open: true, easer: { id: 'e1', name: 'Alex Example', rating: 4.9, completedJobs: 12, city: 'Austin' }, earningsCents: 30000, hours: 3.5, crewSize: 1, note: null, respondBy: '2026-11-14T15:00:00Z', updatedAt: '2026-11-13T16:00:00Z' },
    { id: 'o-e2', status: 'invited', open: true, easer: { id: 'e2', name: 'Sam Example', rating: 4.7, completedJobs: 5, city: 'Round Rock' }, earningsCents: null, hours: null, crewSize: null, note: null, respondBy: '2026-11-14T15:00:00Z', updatedAt: '2026-11-13T15:00:00Z' },
  ];
  await openDashboard(page, server);
  await page.locator('a[data-view="bookings"]').first().click();
  const list = page.locator('#bookings-list');
  await expect(list).toContainText('Easer prices: 1 price in, 1 waiting');
  await expect(list).toContainText('Partner: Lakeline Property Group');
  await list.getByText('AAE-QUOTE-E2E').first().click();
  await expect(page.getByText('1 price in, 1 waiting').last()).toBeVisible();
  await shot(page, '6-booking-view');
  await page.getByRole('button', { name: 'Open prices' }).click();
  await expect(page.locator('#quote-modal')).toHaveClass(/open/);
  await expect(page.locator('#quote-modal .qo-offer')).toHaveCount(2);
  await page.locator('#qm-cancel').click();
  await list.getByText('AAE-ACCT-E2E').first().click();
  await expect(page.getByText('Lakeline Property Group').last()).toBeVisible();
});

test('a typed work description stays with its own quote', async ({ page }) => {
  const server = hybridServer();
  server.state.extraBookings = [quoteBooking({ id: 'b0000000-0000-4000-8000-000000000003', ref: 'AAE-QUOTE-TWO', customer_name: 'Riley Example', details: 'One treadmill.' })];
  await openDashboard(page, server);
  await page.locator('a[data-view="bookings"]').first().click();
  const list = page.locator('#bookings-list');
  await list.getByText('AAE-QUOTE-E2E').first().click();
  await page.getByRole('button', { name: /Send Quote for Customer Approval/ }).first().click();
  await page.locator('#qo-scope').fill('Typed for the first quote only.');
  await page.locator('#qm-cancel').click();
  await list.getByText('AAE-QUOTE-TWO').first().click();
  await page.getByRole('button', { name: /Send Quote for Customer Approval/ }).first().click();
  await expect(page.locator('#qo-scope')).not.toHaveValue(/first quote only/);
});
