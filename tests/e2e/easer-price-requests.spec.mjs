// The Easer's side of the hybrid marketplace, on a phone (owner, 2026-11-13).
// Drives the real /assembler/price-requests page: the request shows the work,
// the area and the steps, never the customer; a sent price collapses into a
// summary the Easer can change or withdraw; every later stage reads plainly
// and links to the job when it is theirs to accept. Sign-in is a local
// stand-in for Supabase and /api/* is answered here, with the contract of
// api/assembler/price-requests.js.
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
    respondBy: '2026-11-14T15:00:00Z', invitedAt: '2026-11-13T14:00:00Z',
    areaMapUrl: 'https://www.google.com/maps/search/?api=1&query=78701',
    status: 'open', stage: 'open', canRespond: true, yourOffer: null, jobId: null, ...over,
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
    if (state.closeOnNext) {
      Object.assign(r, { status: 'closed', stage: 'closed', canRespond: false });
      return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'This price request is closed.', code: 'PRICE_REQUEST_CLOSED' }) });
    }
    if (body.action === 'withdraw') Object.assign(r, { status: 'withdrawn', stage: 'withdrawn', canRespond: false });
    else {
      Object.assign(r, { status: 'sent', stage: 'sent' });
      r.yourOffer = { earningsCents: Math.round(Number(body.earningsDollars) * 100), hours: Number(body.hours), crewSize: Number(body.crewSize), note: body.note || null, submittedAt: '2026-11-13T15:00:00Z' };
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
  await page.goto('/assembler/price-requests.html');
}

test('an Easer sees the work, the area and the steps, then sends a price that collapses into a summary', async ({ page }) => {
  const state = { requests: [request()], posts: [] };
  await openPage(page, state);
  const card = page.locator('.pr-card');
  await expect(card.locator('.pr-badge')).toHaveText('Needs your price');
  await expect(card).toContainText('Office Furniture Assembly');
  await expect(card).toContainText('Austin 78701');
  await expect(card).toContainText('Exact address after you accept the job');
  await expect(card.getByRole('link', { name: 'View area' })).toHaveAttribute('href', /maps\/search\/\?api=1&query=78701/);
  await expect(card).toContainText('Sit-stand desk x2');
  await expect(card).toContainText('Send by');
  await expect(card.locator('.pr-step')).toHaveCount(5);
  await expect(card.locator('.pr-step.current')).toContainText('You send your price');
  for (const hidden of ['Taylor', '100 Congress', '555', '$463']) await expect(page.locator('body')).not.toContainText(hidden);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/easer-1-request.png`, fullPage: true });

  await card.getByLabel(/What you want to be paid/).fill('300');
  await card.getByLabel('Hours on site').fill('3.5');
  await card.getByLabel('Who is coming').selectOption('1');
  await card.getByLabel(/Note for AssembleAtEase/).fill('Both desks and chairs in one visit.');
  await card.getByRole('button', { name: 'Send price' }).click();

  // The form is gone; the price reads as a summary with the next step lit.
  await expect(card.locator('form.pr-form')).toHaveCount(0);
  expect(state.posts[0]).toEqual({ action: 'submit', offerId: 'o1', earningsDollars: '300', hours: '3.5', crewSize: '1', note: 'Both desks and chairs in one visit.' });
  await expect(card.locator('.pr-flash')).toHaveText('Price sent.');
  await expect(card.locator('.pr-badge')).toHaveText('Price sent');
  await expect(card.locator('.pr-mine-amount')).toHaveText('$300');
  await expect(card.locator('.pr-mine-meta')).toHaveText('3.5 hours · Just you');
  await expect(card.locator('.pr-step.done')).toHaveCount(1);
  await expect(card.locator('.pr-step.current')).toContainText('We send the customer one quote');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/easer-2-sent.png`, fullPage: true });

  // Change it: the form comes back with the sent values, Cancel keeps the price.
  await card.getByRole('button', { name: 'Change price' }).click();
  await expect(card.getByLabel(/What you want to be paid/)).toHaveValue('300');
  await card.getByRole('button', { name: 'Cancel' }).click();
  await expect(card.locator('.pr-mine-amount')).toHaveText('$300');
  await card.getByRole('button', { name: 'Change price' }).click();
  await card.getByLabel(/What you want to be paid/).fill('280');
  await card.getByRole('button', { name: 'Save new price' }).click();
  await expect(card.locator('.pr-flash')).toHaveText('New price sent.');
  await expect(card.locator('.pr-mine-amount')).toHaveText('$280');

  // Withdraw asks on the card, not in a browser dialog.
  await card.getByRole('button', { name: 'Withdraw', exact: true }).click();
  await expect(card.locator('.pr-confirm')).toContainText('Withdraw your price for this job?');
  await card.getByRole('button', { name: 'Keep it' }).click();
  await expect(card.locator('.pr-confirm')).toHaveCount(0);
  await card.getByRole('button', { name: 'Withdraw', exact: true }).click();
  await card.getByRole('button', { name: 'Withdraw price' }).click();
  await expect(page.locator('.pr-card.compact')).toContainText('You withdrew your price.');
  await expect(page.locator('form.pr-form')).toHaveCount(0);
  expect(state.posts.map(p => p.action)).toEqual(['submit', 'submit', 'withdraw']);
});

test('a request that closes while the Easer is typing says so and shows the closed state', async ({ page }) => {
  const state = { requests: [request()], posts: [], closeOnNext: true };
  await openPage(page, state);
  const card = page.locator('.pr-card');
  await card.getByLabel(/What you want to be paid/).fill('300');
  await card.getByLabel('Hours on site').fill('3');
  await card.getByRole('button', { name: 'Send price' }).click();
  await expect(page.locator('#page-alert')).toContainText('This price request is closed.');
  await expect(page.locator('.pr-card.compact')).toContainText('This request is closed.');
  await expect(page.locator('form.pr-form')).toHaveCount(0);
});

test('every later stage reads plainly and the job opens from the request', async ({ page }) => {
  const mine = { earningsCents: 30000, hours: 3.5, crewSize: 2, submittedAt: '2026-11-13T14:30:00Z' };
  const state = {
    posts: [],
    requests: [
      request({ offerId: 'o1', ref: 'AAE-CHOSEN', stage: 'with_customer', status: 'chosen', canRespond: false, yourOffer: mine, quoteExpiresAt: '2026-11-16T15:00:00Z' }),
      request({ offerId: 'o2', ref: 'AAE-OFFERED', stage: 'job_offered', status: 'chosen', canRespond: false, yourOffer: mine, jobId: 'b2', jobOfferExpiresAt: '2026-11-13T15:20:00Z' }),
      request({ offerId: 'o3', ref: 'AAE-MINE', stage: 'job_yours', status: 'chosen', canRespond: false, yourOffer: mine, jobId: 'b3' }),
      request({ offerId: 'o4', ref: 'AAE-REVIEW', stage: 'in_review', status: 'sent', canRespond: false, yourOffer: mine }),
      request({ offerId: 'o5', ref: 'AAE-LOST', stage: 'not_chosen', status: 'closed', canRespond: false, yourOffer: mine }),
      request({ offerId: 'o6', ref: 'AAE-OLD', stage: 'missed', status: 'missed', canRespond: false }),
    ],
  };
  await openPage(page, state);
  const byRef = ref => page.locator('.pr-card', { hasText: ref });

  // The job to accept is listed first, with a deadline and a link to it.
  await expect(page.locator('.pr-section').first()).toHaveText('Needs you');
  await expect(page.locator('.pr-card').first()).toContainText('AAE-OFFERED');
  await expect(byRef('AAE-OFFERED').locator('.pr-badge')).toHaveText('Job offered to you');
  await expect(byRef('AAE-OFFERED')).toContainText('Accept by');
  await expect(byRef('AAE-OFFERED').getByRole('link', { name: 'Open the job' })).toHaveAttribute('href', '/assembler/my-assignments?offer=b2');

  await expect(byRef('AAE-CHOSEN')).toContainText('Your price was chosen. The customer has the quote now.');
  await expect(byRef('AAE-CHOSEN')).toContainText('The customer has until');
  await expect(byRef('AAE-CHOSEN').locator('.pr-step.done')).toHaveCount(2);
  await expect(byRef('AAE-MINE')).toContainText('The job is yours.');
  await expect(byRef('AAE-MINE')).toContainText('The full address is in the job');
  await expect(byRef('AAE-MINE').getByRole('link', { name: 'Open the job' })).toHaveAttribute('href', '/assembler/my-assignments?job=b3');
  await expect(byRef('AAE-REVIEW')).toContainText('Prices are closed.');
  await expect(byRef('AAE-REVIEW').locator('.pr-mine-meta')).toHaveText('3.5 hours · Crew of 2');
  await expect(page.locator('form.pr-form')).toHaveCount(0);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/easer-3-stages.png`, fullPage: true });

  // Closed requests fold away under Earlier requests.
  const earlier = page.locator('details.pr-earlier');
  await expect(earlier.locator('summary')).toHaveText('Earlier requests (2)');
  await earlier.locator('summary').click();
  await expect(byRef('AAE-LOST')).toContainText('Another price was chosen for this job.');
  await expect(byRef('AAE-OLD')).toContainText('Closed. No price was sent.');

  state.requests = [];
  await page.reload();
  await expect(page.locator('.e-empty')).toContainText('No price requests right now.');
});
