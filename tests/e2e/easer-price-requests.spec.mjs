// The Easer's side of the hybrid marketplace, on a phone (owner, 2026-11-13).
// Drives the real /assembler/price-requests page: the request shows the work
// and never the customer; the Easer sends, updates and withdraws a price; a
// closed request says so. Sign-in is a local stand-in for Supabase and /api/*
// is answered here, with the contract of api/assembler/price-requests.js.
import { test, expect, devices } from '@playwright/test';

const { defaultBrowserType, ...iphone } = devices['iPhone 13'];
test.use(iphone);
const SHOTS = process.env.HYBRID_SHOTS || '';
const EASER_ID = 'e0000000-0000-4000-8000-000000000001';

// Stand-in for the Supabase browser client: a signed-in Easer.
const SUPABASE_STUB = `
window.supabase = { createClient: function () {
  var session = { access_token: 'e2e-token', expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: '${EASER_ID}' } };
  var profile = { id: '${EASER_ID}', role: 'assembler', full_name: 'Alex Example', status: 'active', tier: 'starter', identity_verified: true };
  function query() { var q = { select: function () { return q; }, eq: function () { return q; }, single: async function () { return { data: profile, error: null }; }, maybeSingle: async function () { return { data: profile, error: null }; } }; return q; }
  return {
    auth: {
      getSession: async function () { return { data: { session: session }, error: null }; },
      refreshSession: async function () { return { data: { session: session }, error: null }; },
      onAuthStateChange: function () { return { data: { subscription: { unsubscribe: function () {} } } }; },
      signOut: async function () { return { error: null }; },
    },
    from: function () { return query(); },
  };
} };`;

function request(over = {}) {
  return {
    offerId: 'o1', ref: 'AAE-QUOTE-E2E', service: 'Office Furniture Assembly', city: 'Austin', zip: '78701',
    date: '2026-11-20', time: '10:00 AM – 12:00 PM',
    details: 'Two sit-stand desks and two office chairs. Boxes are on the ground floor.',
    items: [{ name: 'Sit-stand desk', quantity: 2 }, { name: 'Office chair', quantity: 2 }],
    respondBy: '2026-11-14T15:00:00Z', status: 'open', canRespond: true, yourOffer: null, ...over,
  };
}

async function openPage(page, state) {
  await page.clock.install({ time: new Date('2026-11-13T15:00:00Z') });
  // The real Supabase script carries an integrity hash, so a substitute file
  // would be refused. The stand-in client is installed before any script runs
  // and the real script is blocked with every other request off this machine.
  await page.addInitScript(SUPABASE_STUB);
  await page.route(/^(?!http:\/\/127\.0\.0\.1)/, route => route.abort());
  await page.route('**/api/**', async route => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.pathname !== '/api/assembler/price-requests') return route.fulfill({ contentType: 'application/json', body: '{}' });
    expect(req.headers().authorization).toBe('Bearer e2e-token');
    if (req.method() === 'GET') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ enabled: true, requests: state.requests }) });
    const body = JSON.parse(req.postData() || '{}');
    state.posts.push(body);
    const r = state.requests.find(x => x.offerId === body.offerId);
    if (state.closeOnNext) { r.status = 'closed'; return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'This price request is closed.' }) }); }
    if (body.action === 'withdraw') { r.status = 'withdrawn'; r.canRespond = false; }
    else { r.status = 'sent'; r.yourOffer = { earningsCents: Math.round(Number(body.earningsDollars) * 100), hours: Number(body.hours), crewSize: Number(body.crewSize), note: body.note || null }; }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
  await page.goto('/assembler/price-requests.html');
}

test('an Easer sees the work, not the customer, and sends a price', async ({ page }) => {
  const state = { requests: [request()], posts: [] };
  await openPage(page, state);
  const card = page.locator('.pr-card');
  await expect(card).toContainText('Office Furniture Assembly');
  await expect(card).toContainText('Austin 78701');
  await expect(card).toContainText('Sit-stand desk x2');
  await expect(card).toContainText('Enter your price by');
  for (const hidden of ['Taylor', '100 Congress', '555', '$463']) await expect(page.locator('body')).not.toContainText(hidden);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/easer-1-request.png`, fullPage: true });

  await card.getByLabel('Total job earnings, including helpers').fill('300');
  await card.getByLabel('Hours on site').fill('3.5');
  await card.getByLabel('Crew').selectOption('1');
  await card.getByLabel(/Note for AssembleAtEase/).fill('Both desks and chairs in one visit.');
  await card.getByRole('button', { name: 'Send price' }).click();
  await expect(card).toContainText('Price sent: total job earnings $300');
  expect(state.posts[0]).toMatchObject({ action: 'submit', offerId: 'o1', earningsDollars: '300', hours: '3.5', crewSize: '1' });
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/easer-2-sent.png`, fullPage: true });

  // Change it, then withdraw.
  await card.getByLabel('Total job earnings, including helpers').fill('280');
  await card.getByRole('button', { name: 'Update price' }).click();
  await expect(card).toContainText('total job earnings $280');
  await card.getByRole('button', { name: 'Withdraw' }).click();
  await expect(card).toContainText('You withdrew your price.');
  await expect(card.getByRole('button', { name: /Send price|Update price/ })).toHaveCount(0);
});

test('a request that closes while the Easer is typing says so', async ({ page }) => {
  const state = { requests: [request()], posts: [], closeOnNext: true };
  await openPage(page, state);
  const card = page.locator('.pr-card');
  await card.getByLabel('Total job earnings, including helpers').fill('300');
  await card.getByLabel('Hours on site').fill('3');
  await card.getByRole('button', { name: 'Send price' }).click();
  await expect(card.locator('.pr-error')).toHaveText('This price request is closed.');
});

test('chosen, closed and empty states read plainly', async ({ page }) => {
  const state = { requests: [request({ status: 'chosen', canRespond: false, yourOffer: { earningsCents: 30000, hours: 3.5, crewSize: 1 } }), request({ offerId: 'o2', ref: 'AAE-OLD', status: 'missed', canRespond: false })], posts: [] };
  await openPage(page, state);
  await expect(page.locator('.pr-card').first()).toContainText('Price selected.');
  await expect(page.locator('.pr-card').nth(1)).toContainText('Closed. No price was sent.');
  await expect(page.locator('form.pr-form')).toHaveCount(0);
  state.requests = [];
  await page.reload();
  await expect(page.locator('.e-empty')).toContainText('No price requests right now.');
});
