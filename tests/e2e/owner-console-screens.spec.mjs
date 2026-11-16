// Every owner screen on the console frame (owner, 2026-11-16: "go through all,
// make sure every area follows the same update"). Each test is one screen, in a
// real browser on a desktop window with full-length fixed data:
//   - the number cards are the lengths of the lists they open, and open them;
//   - tabs carry the same counts;
//   - screens with a list stay inside the window (the list scrolls, the page does not);
//   - list and record sit side by side where a screen has both.
// No request leaves this machine: /api/* is answered here.
import { test, expect } from '@playwright/test';

const NOW = new Date('2026-11-16T16:00:00Z');
const TODAY = '2026-11-16';
const SHOTS = process.env.HYBRID_SHOTS || '';
const u = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// ── Fixtures ──────────────────────────────────────────────────────────────
const booking = (n, over) => ({
  id: u(n), ref: `AAE-T${n}`, time: '10:00 AM', service: 'TV Mounting', service_city: 'Austin', service_zip: '78701',
  customer_phone: '5125550100', address: `${n} Main St`, created_at: `2026-11-1${n % 10}T12:00:00Z`, total_price: 20000, tax_amount: 1650, ...over,
});
const BOOKINGS = [
  booking(1, { status: 'pending', date: TODAY, time: '9:00 AM', customer_name: 'Ann Lee', customer_email: 'ann@example.test' }),
  booking(2, { status: 'confirmed', date: TODAY, time: '11:00 AM', customer_name: 'Bo Diaz', customer_email: 'bo@example.test', assembler_name: 'Pat Easer' }),
  booking(3, { status: 'completed', date: TODAY, time: '8:00 AM', customer_name: 'Cy Park', customer_email: 'cy@example.test' }),
  booking(4, { status: 'cancelled', date: TODAY, customer_name: 'Dee Fox', customer_email: 'dee@example.test' }),
  booking(5, { status: 'confirmed', date: '2026-11-18', customer_name: 'Bo Diaz', customer_email: 'bo@example.test' }),
  booking(6, { status: 'confirmed', date: TODAY, customer_name: 'Test Customer', customer_email: 'test@example.test', is_test_booking: true }),
];
const FINANCE = { summary: { platformGrossProfit: 10000 }, ledger: [], customerTotals: [{ key: 'email:bo@example.test', completedJobs: 2, paidCents: 90000 }] };

const LIVE = {
  businessDate: TODAY, summary: {},
  alerts: [{ severity: 'high', message: 'Furniture Assembly on Nov 18 has no Easer.', ref: 'AAE-L3', action: 'dispatch', bookingId: u(13) }],
  activeJobs: [
    { id: u(11), ref: 'AAE-L1', service: 'TV Mounting', _stage: 'en_route', _stage_date: TODAY, _stage_time: '9:00 AM', assembler_name: 'Pat Easer', customer_name: 'Ann Lee' },
    { id: u(12), ref: 'AAE-L2', service: 'Furniture Assembly', _stage: 'scheduled', _stage_date: TODAY, assembler_name: 'Sam Easer', customer_name: 'Bo Diaz' },
  ],
  todaySchedule: [{ id: u(11), ref: 'AAE-L1', service: 'TV Mounting', time: '9:00 AM', status: 'en_route', customer_name: 'Ann Lee', assembler_name: 'Pat Easer' }],
  onlineEasers: [
    { id: u(21), full_name: 'Pat Easer', tier: 'professional', status: 'working', booking_stage: 'en_route', booking_accepted: true },
    { id: u(22), full_name: 'Sam Easer', tier: 'starter', status: 'available' },
  ],
  unassigned: [{ id: u(13), ref: 'AAE-L3', service: 'Furniture Assembly', date: '2026-11-18', customer_name: 'Cy Park' }],
  needsManual: [{ id: u(14), ref: 'AAE-L4', service: 'Smart Home Setup', date: '2026-11-19', customer_name: 'Dee Fox', _dispatchState: 'needs_manual' }],
  awaitingDispatch: [{ id: u(15), ref: 'AAE-L5', service: 'TV Mounting', date: '2026-11-20', customer_name: 'Eve Ng', _dispatchState: 'active_offers', dispatch_offered_at: '2026-11-16T15:00:00Z' }],
  pendingPayment: [{ id: u(16), ref: 'AAE-L6', service: 'Office Assembly', date: '2026-11-21', customer_name: 'Fay Ito', created_at: '2026-11-16T10:00:00Z', payment_status: 'failed', stripe_payment_intent_id: 'pi_test' }],
  quoteNeedsPricing: [{ id: u(17), ref: 'AAE-L7', service: 'Custom Quote', customer_name: 'Gus Roy', created_at: '2026-11-15T10:00:00Z' }],
  offlineCount: 1, recentFailures: [], damageReports: [],
};

const easer = (i, status) => ({
  id: u(100 + i), full_name: `Easer ${i}`, email: `e${i}@example.test`, phone: '5125550199', status,
  tier: status === 'active' ? 'starter' : null, application_status: status === 'pending' ? 'applied' : 'approved',
  created_at: '2026-10-01T12:00:00Z', completed_jobs: i, identity_verified: true,
  readiness: { requirementsVerified: true, offerStatus: 'ready', jobTextsEnabled: true },
});
const ASSEMBLERS = [...Array.from({ length: 22 }, (_, i) => easer(i, 'active')), easer(30, 'pending'), easer(31, 'pending'), easer(32, 'suspended')];

const WL_STATUS = i => (i < 15 ? 'pending' : i < 25 ? 'invited' : 'applied');
const WAITLIST = Array.from({ length: 30 }, (_, i) => ({
  id: 500 + i, name: `Lead ${i}`, email: `lead${i}@example.test`, phone: '5125550123', city: 'Austin', state: 'TX', zip: '78701',
  inDispatchArea: true, status: WL_STATUS(i), created_at: '2026-11-01T12:00:00Z',
}));

const call = (i) => ({
  reference: `call-${i}`, direction: 'inbound', from: `+1512555${String(1000 + i)}`, to: '+15125550000',
  status: i < 20 ? 'completed' : 'no-answer', firstObservedAt: '2026-11-15T15:00:00Z', lastObservedAt: '2026-11-15T15:05:00Z',
  reviewState: i < 10 ? 'reviewed' : 'unreviewed', reviewed: i < 10, requestState: i < 3 ? 'saved' : 'none_found',
  complete: true, terminalObserved: true, notificationState: 'delivered', durationSeconds: 60, revision: 1, events: [], cases: [],
});
const CALLS = Array.from({ length: 25 }, (_, i) => call(i));

const STAGE_OF = i => (i < 20 ? 'new' : i < 32 ? 'contacted' : i < 37 ? 'interested' : 'partner');
const PARTNERS = Array.from({ length: 40 }, (_, i) => ({
  id: u(600 + i), name: `Partner ${i}`, kind: 'apartment', city: 'Austin', stage: STAGE_OF(i), rank: i + 1,
  bookings: i >= 37 ? 2 : 0, completedJobs: 0, bookingRefs: [], bookingLink: 'https://www.assembleatease.com/book?partner=x',
  social: [], history: [], followUpOn: i < 3 ? '2026-11-14' : null, lastContactedOn: i >= 20 && i < 24 ? '2026-11-15' : null,
}));
const PARTNER_DATA = {
  tableMissing: false, seedAvailable: 0, seedImported: true, bookingCountsAvailable: true,
  stages: [{ id: 'new', label: 'New' }, { id: 'contacted', label: 'Contacted' }, { id: 'interested', label: 'Interested' }, { id: 'partner', label: 'Partner' }, { id: 'not_a_fit', label: 'Not a fit' }],
  kinds: [{ id: 'apartment', label: 'Apartment', template: 'A' }],
  partners: PARTNERS,
  summary: { weeklyTarget: 10, contactedThisWeek: PARTNERS.slice(20, 24).map(p => p.id), followUpDue: PARTNERS.slice(0, 3).map(p => p.id) },
};

const giftCard = (i) => ({
  id: u(700 + i), kind: i % 2 ? 'move_in_pass' : 'gift_card', name: i % 2 ? 'Move-In Pass' : 'Gift card', last4: String(1000 + i).slice(-4),
  status: i < 9 ? 'active' : 'void', paidCents: 5000, balancePaidCents: 2500, balanceBonusCents: 0,
  recipientName: `Friend ${i}`, recipientEmail: `f${i}@example.test`, purchaserName: `Buyer ${i}`, purchaserEmail: `b${i}@example.test`,
  deliveredAt: i < 2 ? null : '2026-11-10T12:00:00Z', createdAt: '2026-11-09T12:00:00Z',
  priorityUntil: i >= 2 && i < 5 ? '2026-12-10T12:00:00Z' : null,
});
const GIFT = {
  enabled: true, configured: true, cards: Array.from({ length: 12 }, (_, i) => giftCard(i)),
  summary: { soldCount: 12, soldCents: 60000, giftCardCount: 6, moveInPassCount: 6, outstandingPaidCents: 22500, outstandingBonusCents: 0, redeemedCents: 22500, undelivered: 2, activePriority: 3, voided: 3 },
};

const LEAD_OUTCOME = i => (i < 8 ? 'open' : i < 17 ? 'booked' : 'not_converted');
const LEADS = Array.from({ length: 20 }, (_, i) => ({
  negotiation_id: `neg-${i}`, service: 'Furniture Assembly', city: 'Austin', state: 'TX', lead_status: 'new', lead_created_at: '2026-11-12T12:00:00Z',
  lead_price_cents: 1800, refunded_cents: 0, credited_cents: 0, owner_outcome: LEAD_OUTCOME(i),
  booking_id: LEAD_OUTCOME(i) === 'booked' ? u(800 + i) : null,
  booking: LEAD_OUTCOME(i) === 'booked' ? { id: u(800 + i), ref: `AAE-TT${i}`, status: 'completed' } : null,
  latest_message_preview: i === 0 ? 'Can you come Saturday?' : '', platformGrossCents: null,
}));
const THUMBTACK = {
  leads: LEADS, bookings: [], warnings: [],
  summary: { leads: 20, linkedJobs: 9, leadCostCents: 36000, refundsCents: 0, creditsCents: 0, netLeadCostCents: 36000, platformGrossCents: 81000, netAfterLeadCostCents: 45000 },
};

const REVIEWS = [
  ...Array.from({ length: 16 }, (_, i) => ({ id: u(900 + i), rating: i < 10 ? 5 : 4, approved: i < 12, customer_name: `Reviewer ${i}`, service: 'TV Mounting', created_at: '2026-11-10T12:00:00Z', body: i % 3 ? 'Quick and careful work.' : '' })),
  { id: u(950), rating: 5, approved: true, is_test: true, customer_name: 'Test', service: 'TV Mounting', created_at: '2026-11-10T12:00:00Z' },
  { id: u(951), rating: 3, approved: false, is_test: true, customer_name: 'Test', service: 'TV Mounting', created_at: '2026-11-10T12:00:00Z' },
];
const REVIEW_DATA = { reviews: REVIEWS, summary: { total: 16, average: 4.63, fiveStar: 10, hidden: 4, testExcluded: 2 } };

const PHOTO_STATE = i => (i < 5 ? 'available' : i < 8 ? 'collected' : 'on_website');
const PHOTOS = {
  photos: Array.from({ length: 9 }, (_, i) => ({ id: u(1000 + i), bookingRef: `AAE-P${i}`, service: 'TV Mounting', city: 'Austin', date: '2026-11-10', previewUrl: null, state: PHOTO_STATE(i), websiteService: PHOTO_STATE(i) === 'on_website' ? 'tv-mounting' : null, suggestedServices: ['tv-mounting'] })),
  counts: { available: 5, collected: 3, onWebsite: 1 },
  services: { 'tv-mounting': 'TV Mounting' }, checklist: ['Finished work'],
};

const conv = (i, over) => ({ kind: 'sms', conversationId: `sms-${i}`, customerName: `Texter ${i}`, phone: `+1512555020${i}`,
  lastMessage: { at: '2026-11-16T15:00:00Z', direction: 'SMS to you', body: `Message ${i}` }, needsReply: false, unreadForOwner: 0, ...over });
const CONVERSATIONS = [conv(1, { needsReply: true, unreadForOwner: 1 }), conv(2, { needsReply: true }), conv(3, { unreadForOwner: 2 }), conv(4), conv(5), conv(6)];

const API = {
  '/api/owner/session': { token: 'e2e-session' },
  '/api/booking/list': { bookings: BOOKINGS, count: BOOKINGS.length },
  '/api/owner/financial-dashboard': FINANCE,
  '/api/owner/live-ops': LIVE,
  '/api/assembler/list': { assemblers: ASSEMBLERS, stats: { pending: 2 }, services: [] },
  '/api/owner/waitlist': { entries: WAITLIST, stats: { pending: 15 } },
  '/api/owner/partners': PARTNER_DATA,
  '/api/owner/gift-cards': GIFT,
  '/api/owner/thumbtack': THUMBTACK,
  '/api/owner/reviews': REVIEW_DATA,
  '/api/owner/website-photos': PHOTOS,
  '/api/owner/messages': { conversations: CONVERSATIONS, needsReply: ['sms:sms-1', 'sms:sms-2'], smsAvailable: true },
  '/api/owner/promo': { settings: {}, performance: { redemptions: 2, totalDiscountCents: 5000, totalRevenueCents: 40000, recentBookings: [] }, publicPromo: null },
  '/api/owner/social-automation': { snapshot: { channels: [] } },
  '/api/owner/site-chat': { conversations: [], summary: {}, hours: 48 },
};

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function openView(page, view) {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.clock.install({ time: NOW });
  await page.route(/^(?!http:\/\/127\.0\.0\.1)/, route => route.abort());
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/owner/voice-calls') {
      const ref = url.searchParams.get('reference');
      if (ref) return json(route, { call: CALLS.find(c => c.reference === ref) });
      return json(route, { enabled: true, reviewStateAvailable: true, unreviewed: 15, calls: CALLS, nextCursor: null, warning: 'Caller ID is unverified.', scope: 'Last 30 days.' });
    }
    return json(route, API[url.pathname] || {});
  });
  await page.goto('/owner/index.html');
  await page.fill('#login-pw', 'local-e2e-only');
  await page.click('#login-btn');
  await expect(page.locator('#login-btn')).toBeHidden();
  if (view !== 'liveops') await page.locator(`a[data-view="${view}"]`).first().click();
}

// The values of the number cards in a row, in order.
async function cardValues(page, row) {
  return page.locator(`${row} .kpi .kpi-value`).allTextContents();
}
async function staysInWindow(page) {
  const s = await page.evaluate(() => ({ h: document.scrollingElement.scrollHeight, vh: innerHeight, w: document.scrollingElement.scrollWidth, vw: innerWidth }));
  expect(s.w).toBeLessThanOrEqual(s.vw);
  expect(s.h).toBeLessThanOrEqual(s.vh + 1);
}
async function besideEachOther(page, left, right) {
  const a = await page.locator(left).boundingBox();
  const b = await page.locator(right).boundingBox();
  expect(b.x).toBeGreaterThan(a.x + a.width - 1);
  expect(Math.abs(b.y - a.y)).toBeLessThan(4);
}
const shot = (page, name) => (SHOTS ? page.screenshot({ path: `${SHOTS}/console-${name}.png` }) : null);

test('Live Ops: five cards, each the length of a list on the page; Need an Easer opens its tab', async ({ page }) => {
  await openView(page, 'liveops');
  await expect(page.locator('#ops-summary .kpi')).toHaveCount(5);
  expect(await cardValues(page, '#ops-summary')).toEqual(['1', '2', '1', '2', '1']);
  await expect(page.locator('#ops-alerts-bar tbody tr')).toHaveCount(1);
  await expect(page.locator('#ops-active tbody tr')).toHaveCount(2);
  await expect(page.locator('#ops-today tbody tr')).toHaveCount(1);
  // Bookings needing action: tabs with counts; All is every group together.
  const tab = key => page.locator(`#ops-action-tabs [data-ops-tab="${key}"] .tab-count`);
  await expect(tab('all')).toHaveText('5');
  await expect(tab('easer')).toHaveText('2');
  await expect(tab('offers')).toHaveText('1');
  await expect(tab('payment')).toHaveText('2');
  await expect(tab('recon')).toHaveText('0');
  await expect(page.locator('#ops-unassigned tbody tr')).toHaveCount(5);
  await shot(page, 'liveops');
  await page.click('#ops-summary [data-kpi="easer"]');
  await expect(page.locator('#ops-action-tabs .tab.active')).toHaveAttribute('data-ops-tab', 'easer');
  await expect(page.locator('#ops-unassigned tbody tr')).toHaveCount(2);
  await page.click('#ops-action-tabs [data-ops-tab="payment"]');
  await expect(page.locator('#ops-unassigned tbody tr')).toHaveCount(2);
});

test('Today: cards and tabs are the same filters, and the rows match', async ({ page }) => {
  await openView(page, 'today');
  await expect(page.locator('.topbar-title')).toHaveText('Today\'s Schedule');
  await expect(page.locator('#today-count')).toHaveText('3');
  await expect(page.locator('#today-pending')).toHaveText('1');
  await expect(page.locator('#today-confirmed')).toHaveText('1');
  await expect(page.locator('#today-done')).toHaveText('1');
  await expect(page.locator('#today-list .today-job-card')).toHaveCount(3);
  await expect(page.locator('#today-list')).not.toContainText('Test Customer');
  // Ordered by the clock (the text order put 11:00 AM above 8:00 AM).
  await expect(page.locator('#today-list .today-job-card td:first-child strong')).toHaveText(['8:00 AM', '9:00 AM', '11:00 AM']);
  await staysInWindow(page);
  await shot(page, 'today');
  await page.click('#today-stats-row [data-kpi="pending"]');
  await expect(page.locator('#today-tabs .tab.active')).toHaveAttribute('data-today-tab', 'pending');
  await expect(page.locator('#today-list .today-job-card')).toHaveCount(1);
  await expect(page.locator('#today-list')).toContainText('Ann Lee');
});

test('Messages: cards for all, waiting and unread open their tabs', async ({ page }) => {
  await openView(page, 'messages');
  expect(await cardValues(page, '#inbox-kpis')).toEqual(['6', '2', '2']);
  await expect(page.locator('#inbox-list .inbox-row')).toHaveCount(6);
  await shot(page, 'messages');
  await page.click('#inbox-kpis [data-kpi="reply"]');
  await expect(page.locator('#inbox-tabs .tab.active')).toHaveAttribute('data-inbox-tab', 'reply');
  await expect(page.locator('#inbox-list .inbox-row')).toHaveCount(2);
  await page.click('#inbox-tabs [data-inbox-tab="unread"]');
  await expect(page.locator('#inbox-list .inbox-row')).toHaveCount(2);
  await staysInWindow(page);
});

test('Phone Calls: cards over the loaded calls, list beside the call, page holds still', async ({ page }) => {
  await openView(page, 'voice-calls');
  expect(await cardValues(page, '#voice-calls-kpis')).toEqual(['25', '15', '5', '3']);
  await expect(page.locator('#voice-calls-list .voice-call-row')).toHaveCount(25);
  await expect(page.locator('#voice-calls-detail')).toContainText('Caller ID is unverified');
  await besideEachOther(page, '#voice-calls-list', '#voice-calls-detail');
  await staysInWindow(page);
  await shot(page, 'calls');
  await page.click('#voice-calls-kpis [data-kpi="missed"]');
  await expect(page.locator('#voice-calls-list .voice-call-row')).toHaveCount(5);
  await page.click('#voice-calls-tabs [data-voice-tab="request"]');
  await expect(page.locator('#voice-calls-list .voice-call-row')).toHaveCount(3);
});

test('Easers: one card per status, each equal to its tab; a 25-person roster scrolls inside', async ({ page }) => {
  await openView(page, 'assemblers');
  expect(await cardValues(page, '#asm-stats-row')).toEqual(['22', '2', '1', '0', '0']);
  // A status with nobody in it has no tab, so its card does not open.
  await expect(page.locator('#asm-stats-row div.kpi.is-static')).toHaveCount(2);
  await expect(page.locator('#asm-tbody tr')).toHaveCount(22);
  await expect(page.locator('#asm-tabs [data-tier="active"] .tab-count')).toHaveText('22');
  await staysInWindow(page);
  await shot(page, 'easers');
  await page.click('#asm-stats-row [data-kpi="pending"]');
  await expect(page.locator('#asm-tabs .tab.active')).toHaveAttribute('data-tier', 'pending');
  await expect(page.locator('#asm-tbody tr')).toHaveCount(2);
  await page.click('#asm-stats-row [data-kpi="suspended"]');
  await expect(page.locator('#asm-tbody tr')).toHaveCount(1);
});

test('Easer Waitlist: cards are the tabs, thirty people scroll inside the card', async ({ page }) => {
  await openView(page, 'waitlist');
  expect(await cardValues(page, '#wl-stats-row')).toEqual(['30', '15', '10', '5']);
  await expect(page.locator('#wl-tbody tr')).toHaveCount(30);
  await shot(page, 'waitlist');
  await staysInWindow(page);
  await page.click('#wl-stats-row [data-kpi="invited"]');
  await expect(page.locator('#wl-tabs .tab.active')).toHaveAttribute('data-wl-status', 'invited');
  await expect(page.locator('#wl-tbody tr')).toHaveCount(10);
  await page.click('#wl-add-toggle');
  await expect(page.locator('#wl-add-panel')).toBeVisible();
  await expect(page.locator('#wl-add-panel .v2-field')).toHaveCount(7);
});

test('Customers: repeat card opens the repeat list; the average opens Financials', async ({ page }) => {
  await openView(page, 'customers');
  await expect(page.locator('#cust-total')).toHaveText('4');
  await expect(page.locator('#cust-repeat')).toHaveText('1');
  await expect(page.locator('#cust-tbody tr')).toHaveCount(4);
  await shot(page, 'customers');
  await staysInWindow(page);
  await page.click('#cust-stats-row [data-kpi="repeat"]');
  await expect(page.locator('#cust-tabs .tab.active')).toHaveAttribute('data-cust-tab', 'repeat');
  await expect(page.locator('#cust-tbody tr')).toHaveCount(1);
  await expect(page.locator('#cust-tbody')).toContainText('bo@example.test');
  // The search changes the cards and the list together.
  await page.click('#cust-tabs [data-cust-tab="all"]');
  await page.fill('#cust-search', 'ann');
  await expect(page.locator('#cust-total')).toHaveText('1');
  await expect(page.locator('#cust-tbody tr')).toHaveCount(1);
  await page.click('#cust-stats-row [data-kpi="ltv"]');
  await expect(page.locator('.topbar-title')).toHaveText('Financials');
});

test('Partners: cards open due and this week; stages are tabs; list beside the partner', async ({ page }) => {
  await openView(page, 'partners');
  expect(await cardValues(page, '#partners-kpis')).toEqual(['40', '4 / 10', '3', '6']);
  await expect(page.locator('#partners-stages .tab[data-partner-stage-filter="contacted"] .tab-count')).toHaveText('12');
  await expect(page.locator('#partners-list .partners-row')).toHaveCount(40);
  await besideEachOther(page, '.partners-listwrap', '#partners-detail');
  await staysInWindow(page);
  await shot(page, 'partners');
  await page.click('#partners-kpis [data-kpi="due"]');
  await expect(page.locator('#partners-list .partners-row')).toHaveCount(3);
  await page.click('#partners-kpis [data-kpi="week"]');
  await expect(page.locator('#partners-list .partners-row')).toHaveCount(4);
  await page.click('#partners-kpis [data-kpi="all"]');
  await expect(page.locator('#partners-list .partners-row')).toHaveCount(40);
});

test('Gift Cards: emails not sent and priority open their rows', async ({ page }) => {
  await openView(page, 'giftcards');
  expect(await cardValues(page, '#giftcards-kpis')).toEqual(['$600.00', '$225.00', '$0.00', '$225.00', '2', '3']);
  await expect(page.locator('#giftcards-body tbody tr')).toHaveCount(12);
  await shot(page, 'giftcards');
  await staysInWindow(page);
  await page.click('#giftcards-kpis [data-kpi="unsent"]');
  await expect(page.locator('#giftcards-tabs .tab.active')).toHaveAttribute('data-gc-tab', 'unsent');
  await expect(page.locator('#giftcards-body tbody tr')).toHaveCount(2);
  await page.click('#giftcards-kpis [data-kpi="priority"]');
  await expect(page.locator('#giftcards-body tbody tr')).toHaveCount(3);
  await page.click('#giftcards-tabs [data-gc-tab="void"]');
  await expect(page.locator('#giftcards-body tbody tr')).toHaveCount(3);
});

test('Thumbtack: leads list beside the lead being tracked; Jobs booked equals its rows', async ({ page }) => {
  await openView(page, 'thumbtack');
  const values = await cardValues(page, '#thumbtack-summary');
  expect(values.slice(0, 3)).toEqual(['20', '8', '9']);
  await expect(page.locator('#thumbtack-leads .v2-item')).toHaveCount(20);
  await expect(page.locator('#thumbtack-detail [data-refund]')).toBeVisible();
  await expect(page.locator('#thumbtack-detail')).toContainText('Can you come Saturday?');
  await besideEachOther(page, '#thumbtack-leads', '#thumbtack-detail');
  await staysInWindow(page);
  await shot(page, 'thumbtack');
  await page.click('#thumbtack-summary [data-kpi="booked"]');
  await expect(page.locator('#thumbtack-leads .v2-item')).toHaveCount(9);
  await page.locator('#thumbtack-leads .v2-item').nth(2).click();
  await expect(page.locator('#thumbtack-leads .v2-item').nth(2)).toHaveAttribute('aria-pressed', 'true');
});

test('Reviews: counted reviews only, test bookings under their own tab', async ({ page }) => {
  await openView(page, 'reviews');
  expect(await cardValues(page, '#reviews-stats-row')).toEqual(['16', '4.6 / 5', '10', '4']);
  await expect(page.locator('#reviews-list > .v2-item')).toHaveCount(16);
  await shot(page, 'reviews');
  await expect(page.locator('#reviews-tabs [data-review-tab="test"] .tab-count')).toHaveText('2');
  await staysInWindow(page);
  await page.click('#reviews-stats-row [data-kpi="hidden"]');
  await expect(page.locator('#reviews-list > .v2-item')).toHaveCount(4);
  await page.click('#reviews-stats-row [data-kpi="five"]');
  await expect(page.locator('#reviews-list > .v2-item')).toHaveCount(10);
  await page.click('#reviews-tabs [data-review-tab="test"]');
  await expect(page.locator('#reviews-list > .v2-item')).toHaveCount(2);
});

test('Website Photos: cards are the three photo lists', async ({ page }) => {
  await openView(page, 'website-photos');
  expect(await cardValues(page, '#website-photos-view')).toEqual(['5', '3', '1']);
  await expect(page.locator('.wp-card')).toHaveCount(5);
  await shot(page, 'photos');
  await page.click('#website-photos-view [data-kpi="collected"]');
  await expect(page.locator('.wp-tabs .tab.active')).toHaveAttribute('data-wp-tab', 'collected');
  await expect(page.locator('.wp-card')).toHaveCount(3);
  await staysInWindow(page);
});

test('Marketing and AI Intelligence: one row of number cards, titled cards, no repeated page title', async ({ page }) => {
  await openView(page, 'marketing');
  await expect(page.locator('#marketing-stats-row .kpi')).toHaveCount(8);
  await expect(page.locator('#mk-redemptions')).toHaveText('2');
  await expect(page.locator('#marketing-view h2')).toHaveCount(0);
  await expect(page.locator('#marketing-view .v2-card-head h3')).toHaveText(['Social automation', 'Promo Control', 'Live promo settings', 'Recent redemptions']);
  await shot(page, 'marketing');
  await page.locator('a[data-view="intelligence"]').first().click();
  await expect(page.locator('#intel-stats-row .kpi')).toHaveCount(4);
  await shot(page, 'intelligence');
  await expect(page.locator('#intelligence-view .v2-card-head h3')).toHaveText(['Platform analysis', 'Active alerts', 'Ask the AI', 'Website Chat Inbox']);
  await page.click('#intel-stats-row [data-kpi="payouts"]');
  await expect(page.locator('.topbar-title')).toHaveText('Financials');
});

test('No owner screen keeps the old number strip', async ({ page }) => {
  await openView(page, 'liveops');
  // Every screen draws number cards (kpi), never the old stat strip or c-stats.
  const old = await page.evaluate(() => Array.from(document.querySelectorAll('.content > [id$="-view"] .stats-row > .stat:not(.kpi), .content > [id$="-view"] .c-stats'))
    .map(n => n.closest('[id$="-view"]').id));
  expect([...new Set(old)].filter(id => id !== 'analytics-view')).toEqual([]);
});
