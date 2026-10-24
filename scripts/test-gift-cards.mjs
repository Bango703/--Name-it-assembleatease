#!/usr/bin/env node
// Gift cards and the Move-In Pass, stage 1 (owner, 2026-10-24): buying, the
// emailed code, balance checks and the owner's view. Locks the money rules:
// the server sets the price, paid value never expires, only the disclosed
// bonus does, issuing is idempotent, nothing is sold before a code can be
// spent, and the Stripe webhook (a critical module) is not involved.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const SECRET = 'x'.repeat(40);
const ENV = { GIFT_CARD_CODE_SECRET: SECRET, STRIPE_SECRET_KEY: 'sk_test_fake', GIFT_CARDS_ENABLED: 'true', CRON_SECRET: 'cron' };

const gc = await import('../api/_gift-cards.js');
const { createGiftCardCheckoutHandler } = await import('../api/gift-cards/checkout.js');
const { createGiftCardConfirmHandler } = await import('../api/gift-cards/confirm.js');
const { createGiftCardBalanceHandler } = await import('../api/gift-cards/balance.js');
const { createOwnerGiftCardsHandler } = await import('../api/owner/gift-cards.js');
const { createGiftCardReconcileHandler } = await import('../api/cron/gift-cards-reconcile.js');

function mockRes() {
  return {
    statusCode: 200, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

// ── Codes ────────────────────────────────────────────────────────────────
{
  const a = gc.codeForSession('cs_test_abc123', { GIFT_CARD_CODE_SECRET: SECRET });
  const b = gc.codeForSession('cs_test_abc123', { GIFT_CARD_CODE_SECRET: SECRET });
  const c = gc.codeForSession('cs_test_other99', { GIFT_CARD_CODE_SECRET: SECRET });
  assert.equal(a, b, 'the same purchase always rebuilds the same code, so a failed email can be resent');
  assert.notEqual(a, c);
  assert.match(a, /^AAEG-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/, 'no 0/O/1/I in a code people type');
  assert.equal(gc.hashCode(a.toLowerCase().replace(/-/g, ' ')), gc.hashCode(a), 'case, spaces and dashes do not matter when typed');
  assert.equal(gc.codeLast4(a), a.slice(-4));
  assert.equal(gc.hashCode('not a code'), null);
  assert.throws(() => gc.codeForSession('cs_test_abc123', { GIFT_CARD_CODE_SECRET: 'short' }), /GIFT_CARD_CODE_SECRET/);
}

// ── Nothing is sold before a code can be spent ──────────────────────────
assert.equal(gc.GIFT_CARD_REDEMPTION_READY, false, 'stage 1 ships with redemption off');
assert.equal(gc.isGiftCardsEnabled(ENV), false, 'GIFT_CARDS_ENABLED alone cannot open sales before checkout accepts codes');
{
  const handler = createGiftCardCheckoutHandler({ env: ENV, limit: async () => true, stripeFactory: () => { throw new Error('Stripe must not be called'); } });
  const res = mockRes();
  await handler({ method: 'POST', headers: {}, body: { kind: 'gift_card', amountDollars: 50, purchaserEmail: 'a@b.com' } }, res);
  assert.equal(res.statusCode, 409, 'a purchase is refused while sales are off');
  const get = mockRes();
  await handler({ method: 'GET', headers: {} }, get);
  assert.equal(get.body.enabled, false);
  assert.deepEqual(get.body.moveInPass, { paidCents: 4900, bonusCents: 1100, bonusDays: 30, priorityDays: 30 });
}

// ── The server sets the price ───────────────────────────────────────────
assert.equal(gc.expectedPaidCents('move_in_pass', 1), 4900, 'the Move-In Pass is $49 whatever the browser says');
assert.equal(gc.expectedPaidCents('gift_card', 5000), 5000);
assert.equal(gc.expectedPaidCents('gift_card', 2400), null, 'below $25 is refused');
assert.equal(gc.expectedPaidCents('gift_card', 50100), null, 'above $500 is refused');
assert.equal(gc.expectedPaidCents('gift_card', 5050), null, 'whole dollars only');
assert.equal(gc.expectedPaidCents('discount', 5000), null);
{
  const ok = gc.validatePurchase({ kind: 'gift_card', amountDollars: '75', purchaserEmail: ' Buyer@Example.com ', purchaserName: 'jane doe', forSomeoneElse: true, recipientEmail: 'friend@example.com', recipientName: 'sam', message: 'Welcome home\n\n\n\nEnjoy' });
  assert.equal(ok.ok, true);
  assert.equal(ok.purchase.paidCents, 7500);
  assert.equal(ok.purchase.purchaserEmail, 'buyer@example.com');
  assert.equal(ok.purchase.recipientEmail, 'friend@example.com');
  assert.equal(ok.purchase.message, 'Welcome home\n\nEnjoy');
  const self = gc.validatePurchase({ kind: 'move_in_pass', amountDollars: 1, purchaserEmail: 'me@example.com', message: 'ignored' });
  assert.equal(self.purchase.paidCents, 4900);
  assert.equal(self.purchase.recipientEmail, 'me@example.com', 'buying for yourself sends the code to you');
  assert.equal(self.purchase.message, '');
  assert.equal(gc.validatePurchase({ kind: 'gift_card', amountDollars: 10, purchaserEmail: 'a@b.com' }).ok, false);
  assert.equal(gc.validatePurchase({ kind: 'gift_card', amountDollars: 50, purchaserEmail: 'nope' }).ok, false);
  assert.equal(gc.validatePurchase({ kind: 'gift_card', amountDollars: 50, purchaserEmail: 'a@b.com', forSomeoneElse: true }).ok, false, 'a gift needs a recipient email');
  assert.equal(gc.validatePurchase({ kind: 'gift_card', amountDollars: 50, purchaserEmail: 'a@b.com', forSomeoneElse: true, recipientEmail: 'c@d.com', message: 'x'.repeat(900) }).purchase.message.length, 400);

  const params = gc.checkoutSessionParams(ok.purchase);
  assert.equal(params.mode, 'payment');
  assert.equal(params.line_items.length, 1, 'one line: no tax and no fee is added to a gift card');
  assert.equal(params.line_items[0].price_data.unit_amount, 7500);
  assert.equal(params.metadata.aae_product, gc.GIFT_CARD_PRODUCT);
  assert.equal(params.metadata.paid_cents, '7500');
  assert.equal(params.allow_promotion_codes, false, 'a discount cannot be stacked onto stored value');
  assert.match(params.success_url, /\/gift-cards\?purchase=success&session_id=\{CHECKOUT_SESSION_ID\}$/);
  for (const v of Object.values(params.metadata)) assert.ok(String(v).length <= 500, 'Stripe metadata values stay under 500 characters');
}

// ── A paid session becomes exactly one card ─────────────────────────────
const NOW_S = Math.floor(Date.UTC(2026, 9, 24, 15) / 1000);
function session(overrides = {}) {
  return {
    id: 'cs_test_pass000001', status: 'complete', payment_status: 'paid', currency: 'usd', amount_total: 4900, created: NOW_S,
    customer_details: { email: 'buyer@example.com' }, payment_intent: 'pi_test_1',
    metadata: { aae_product: 'stored_value', kind: 'move_in_pass', paid_cents: '4900', purchaser_name: 'Jane Doe', recipient_email: 'buyer@example.com', recipient_name: 'Jane Doe', message: '' },
    ...overrides,
  };
}
{
  assert.equal(gc.cardFromSession(session({ payment_status: 'unpaid' }), ENV).reason, 'unpaid');
  assert.equal(gc.cardFromSession(session({ amount_total: 100 }), ENV).reason, 'amount_mismatch', 'a session that charged the wrong amount issues nothing');
  assert.equal(gc.cardFromSession(session({ metadata: {} }), ENV).reason, 'not_gift_card');
  const built = gc.cardFromSession(session(), ENV);
  assert.equal(built.ok, true);
  assert.equal(built.row.paid_cents, 4900);
  assert.equal(built.row.bonus_cents, 1100);
  assert.equal(built.row.bonus_expires_at, new Date((NOW_S + 30 * 86400) * 1000).toISOString(), 'the bonus expires 30 days after purchase');
  assert.equal(built.row.priority_until, built.row.bonus_expires_at);
  assert.equal(built.row.code_hash, gc.hashCode(built.code));
  assert.ok(!JSON.stringify(built.row).includes(built.code), 'the plain code is never stored');
  const giftBuilt = gc.cardFromSession(session({ id: 'cs_test_gift000001', amount_total: 10000, metadata: { aae_product: 'stored_value', kind: 'gift_card', paid_cents: '10000', recipient_email: 'friend@example.com' } }), ENV);
  assert.equal(giftBuilt.row.bonus_cents, 0);
  assert.equal(giftBuilt.row.bonus_expires_at, null, 'a gift card has nothing that expires');
}

// Minimal Supabase stand-in for the two tables, with the unique rules the migration enforces.
function fakeSb() {
  const db = { gift_cards: [], gift_card_ledger: [] };
  let seq = 0;
  function query(table) {
    const filters = [];
    let op = 'select', payload = null;
    const api = {
      select() { return api; },
      eq(k, v) { filters.push((r) => r[k] === v); return api; },
      is(k, v) { filters.push((r) => (r[k] ?? null) === v); return api; },
      in(k, vs) { filters.push((r) => vs.includes(r[k])); return api; },
      or(expr) {
        const [, stale] = expr.match(/lt\.(.+)$/) || [];
        filters.push((r) => r.delivery_claimed_at == null || (stale && r.delivery_claimed_at < stale));
        return api;
      },
      order() { return api; },
      limit() { return api; },
      insert(row) {
        if (table === 'gift_cards' && db.gift_cards.some((r) => r.stripe_checkout_session_id === row.stripe_checkout_session_id)) return Promise.resolve({ error: { code: '23505' } });
        if (table === 'gift_card_ledger' && row.entry_type === 'issue' && db.gift_card_ledger.some((r) => r.gift_card_id === row.gift_card_id && r.entry_type === 'issue')) return Promise.resolve({ error: { code: '23505' } });
        db[table].push({ id: `id-${++seq}`, status: 'active', delivered_at: null, delivery_claimed_at: null, created_at: new Date().toISOString(), ...row });
        return Promise.resolve({ error: null });
      },
      update(values) { op = 'update'; payload = values; return api; },
      maybeSingle() { const rows = db[table].filter((r) => filters.every((f) => f(r))); return Promise.resolve({ data: rows[0] || null, error: null }); },
      then(resolve, reject) {
        const rows = db[table].filter((r) => filters.every((f) => f(r)));
        if (op === 'update') rows.forEach((r) => Object.assign(r, payload));
        return Promise.resolve({ data: rows.map((r) => ({ ...r })), error: null }).then(resolve, reject);
      },
    };
    return api;
  }
  return {
    db,
    from: query,
    async rpc(name, args) {
      const balanceOf = (card) => {
        const rows = db.gift_card_ledger.filter((l) => l.gift_card_id === card.id);
        const paid = card.status !== 'active' ? 0 : Math.max(0, rows.reduce((s, l) => s + (l.paid_delta_cents || 0), 0));
        const bonusLive = card.status === 'active' && !(card.bonus_expires_at && new Date(card.bonus_expires_at) <= new Date());
        const bonus = bonusLive ? Math.max(0, rows.reduce((s, l) => s + (l.bonus_delta_cents || 0), 0)) : 0;
        return { gift_card_id: card.id, paid_cents: paid, bonus_cents: bonus };
      };
      if (name === 'gift_card_balances_v1') return { data: db.gift_cards.map(balanceOf), error: null };
      if (name === 'gift_card_balance_v1') { const card = db.gift_cards.find((c) => c.id === args.p_gift_card_id); return { data: card ? [balanceOf(card)] : [], error: null }; }
      throw new Error(`unexpected rpc ${name}`);
    },
  };
}

{
  const sb = fakeSb();
  const sent = [];
  const send = async (msg) => { sent.push(msg); return { ok: true }; };
  const deliver = (s, card, code) => gc.deliverCard(s, card, code, { send });
  const first = await gc.issueFromCheckoutSession(sb, session(), { env: ENV, deliver });
  const again = await gc.issueFromCheckoutSession(sb, session(), { env: ENV, deliver });
  assert.equal(first.ok && again.ok, true);
  assert.equal(sb.db.gift_cards.length, 1, 'the success page and the cron together still make one card');
  assert.equal(sb.db.gift_card_ledger.length, 1, 'one issue entry, so value is never doubled');
  assert.equal(sent.length, 1, 'the code is emailed once');
  assert.equal(sent[0].meta.notificationKey, `gift-card-delivery:${sb.db.gift_cards[0].id}`);
  assert.ok(sb.db.gift_cards[0].delivered_at, 'delivery is recorded only after the email was accepted');
  const code = gc.codeForSession('cs_test_pass000001', ENV);
  assert.ok(sent[0].html.includes(code), 'the email carries the code');

  const balance = await gc.lookupBalance(sb, code.toLowerCase());
  assert.equal(balance.ok, true);
  assert.equal(balance.card.balanceCents, 6000, '$49 paid plus the $11 bonus');
  assert.equal(balance.card.paidCents, 4900);
  assert.ok(!('recipientEmail' in balance.card) && !('purchaserEmail' in balance.card), 'a balance check shows no names or emails');
  assert.equal((await gc.lookupBalance(sb, 'AAEG-AAAA-BBBB-CCCC')).status, 404);
  assert.equal((await gc.lookupBalance(sb, 'hello')).status, 400);

  // A failed email is retried, never marked delivered.
  const sb2 = fakeSb();
  const failing = async () => ({ ok: false, error: 'provider down' });
  const r = await gc.issueFromCheckoutSession(sb2, session({ id: 'cs_test_fail000001' }), { env: ENV, deliver: (s, card, c) => gc.deliverCard(s, card, c, { send: failing }) });
  assert.equal(r.delivery.ok, false);
  assert.equal(sb2.db.gift_cards[0].delivered_at, null);
  assert.equal(sb2.db.gift_cards[0].delivery_claimed_at, null, 'the claim is released so the cron can try again');
  assert.equal(sb2.db.gift_cards[0].delivery_error, 'provider down');

  // Owner view: what is owed is the ledger, not the price.
  const balances = await gc.readBalances(sb);
  const owner = gc.summarizeForOwner(sb.db.gift_cards, balances);
  assert.equal(owner.summary.soldCents, 4900);
  assert.equal(owner.summary.outstandingPaidCents, 4900);
  assert.equal(owner.summary.outstandingBonusCents, 1100);
  assert.equal(owner.summary.moveInPassCount, 1);
  assert.equal(owner.summary.undelivered, 0);

  // Void: nothing left can be used.
  const voided = await gc.voidCard(sb, sb.db.gift_cards[0], 'test');
  assert.equal(voided.voidedCents, 6000);
  assert.equal((await gc.lookupBalance(sb, code)).card.balanceCents, 0);
  assert.equal((await gc.voidCard(sb, { ...sb.db.gift_cards[0], status: 'active' }, 'again')).alreadyVoid, true);
}

// ── Emails: business voice, plain facts, disclosed expiry ───────────────
{
  const built = gc.cardFromSession(session(), ENV);
  const card = { ...built.row, id: 'c1' };
  const pass = gc.buildRecipientEmail(card, built.code);
  assert.equal(pass.subject, 'Your Move-In Pass is ready');
  assert.match(pass.html, /\$60 credit/);
  assert.match(pass.html, /\$49 of the credit never expires\. The \$11 bonus expires/, 'the bonus expiry is disclosed with the code');
  assert.match(pass.html, /Priority booking<\/strong> until November 23, 2026/);
  const giftCard = { ...card, kind: 'gift_card', paid_cents: 10000, bonus_cents: 0, bonus_expires_at: null, priority_until: null, recipient_email: 'friend@example.com', recipient_name: 'Sam Lee', message: 'Welcome <home>' };
  const gift = gc.buildRecipientEmail(giftCard, built.code);
  assert.equal(gift.subject, 'Jane Doe sent you an AssembleAtEase gift card');
  assert.match(gift.html, /Hi Sam,/);
  assert.match(gift.html, /Welcome &lt;home&gt;/, 'the gift message is escaped');
  assert.match(gift.html, /The credit never expires\./);
  const receipt = gc.buildPurchaserReceipt(giftCard);
  assert.ok(!receipt.html.includes(built.code), 'the buyer receipt for a gift does not carry the code');
  for (const html of [pass.html, gift.html, receipt.html]) {
    assert.doesNotMatch(html, /Travis|\bI will\b|\bI would\b|\bI\b'm/, 'business voice, not the founder');
    assert.doesNotMatch(html, /Stripe|PaymentIntent|ledger|checkout session|stored value|metadata/i, 'no payment mechanics in front of a customer');
    assert.match(html, /The AssembleAtEase Team/);
  }
}

// ── Routes ──────────────────────────────────────────────────────────────
{
  const confirm = createGiftCardConfirmHandler({
    env: ENV,
    getSb: () => ({}),
    stripeFactory: () => ({ checkout: { sessions: { retrieve: async () => session() } } }),
    issue: async () => ({ ok: true, card: { kind: 'move_in_pass', paid_cents: 4900, bonus_cents: 1100, code_last4: 'ABCD', recipient_email: 'buyer@example.com' }, delivery: { ok: true } }),
  });
  const res = mockRes();
  await confirm({ method: 'POST', body: { sessionId: 'cs_test_pass000001' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.amount, '$60');
  assert.equal(res.body.sentTo, 'b****@example.com', 'the success page masks the address');
  assert.ok(!('code' in res.body), 'the code travels by email only');
  const bad = mockRes();
  await confirm({ method: 'POST', body: { sessionId: 'javascript:alert(1)' } }, bad);
  assert.equal(bad.statusCode, 400);

  const notOurs = createGiftCardConfirmHandler({ env: ENV, getSb: () => ({}), stripeFactory: () => ({ checkout: { sessions: { retrieve: async () => session({ metadata: { kind: 'x' } }) } } }) });
  const no = mockRes();
  await notOurs({ method: 'POST', body: { sessionId: 'cs_test_pass000001' } }, no);
  assert.equal(no.statusCode, 404, 'a booking or other Checkout session cannot be turned into a card');

  const balance = createGiftCardBalanceHandler({ getSb: () => ({}), limit: async () => false });
  const limited = mockRes();
  await balance({ method: 'POST', headers: {}, body: { code: 'AAEG-AAAA-BBBB-CCCC' } }, limited);
  assert.equal(limited.statusCode, 429, 'balance checks are rate limited');

  const owner = createOwnerGiftCardsHandler({ getSb: () => ({}), verify: () => false });
  const denied = mockRes();
  await owner({ method: 'GET' }, denied);
  assert.equal(denied.statusCode, 401, 'the owner list needs the owner');

  const cron = createGiftCardReconcileHandler({ env: ENV, log: async () => {} });
  const unauth = mockRes();
  await cron({ headers: {} }, unauth);
  assert.equal(unauth.statusCode, 401);
}

// Reconcile: a paid session nobody confirmed gets its card; a fully refunded unused card is voided.
{
  const sb = fakeSb();
  const sent = [];
  const send = async (m) => { sent.push(m); return { ok: true }; };
  const fakeStripe = {
    checkout: { sessions: { list: async () => ({ data: [session(), session({ id: 'cs_test_other01', metadata: { aae_product: 'something_else' } })], has_more: false }) } },
    refunds: { list: async () => ({ data: [{ payment_intent: 'pi_test_1', status: 'succeeded' }], has_more: false }) },
    disputes: { list: async () => ({ data: [], has_more: false }) },
    paymentIntents: { retrieve: async () => ({ latest_charge: { amount: 4900, amount_refunded: 4900 } }) },
  };
  const cron = createGiftCardReconcileHandler({
    env: ENV, getSb: () => sb, stripeFactory: () => fakeStripe, log: async () => {},
    deliver: (s, card, code) => gc.deliverCard(s, card, code, { send }),
    issue: (s, sess, opts) => gc.issueFromCheckoutSession(s, sess, { ...opts, deliver: (s2, card, code) => gc.deliverCard(s2, card, code, { send }) }),
    alert: async () => { throw new Error('a fully refunded unused card is voided, not escalated'); },
  });
  const res = mockRes();
  await cron({ headers: { authorization: 'Bearer cron' } }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.issued, 1, 'only our paid session is issued');
  assert.equal(res.body.voided, 1);
  assert.equal(sb.db.gift_cards[0].status, 'void');
  assert.equal(sent.length, 1);
}

// ── Structure ───────────────────────────────────────────────────────────
{
  const sql = read('api/migrations/119_gift_cards.sql');
  assert.match(sql, /stripe_checkout_session_id\s+TEXT NOT NULL UNIQUE/, 'one card per Checkout session');
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS gift_card_ledger_one_issue/);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY[\s\S]*REVOKE ALL ON public\.gift_cards FROM PUBLIC, anon, authenticated/);
  assert.match(sql, /WHEN gc\.bonus_expires_at IS NOT NULL AND gc\.bonus_expires_at <= NOW\(\) THEN 0/, 'only the bonus expires');
  assert.doesNotMatch(sql, /^\s+paid_\w*expir\w*\s/m, 'paid value has no expiry column');
  assert.match(sql, /v_bonus_take := LEAST\(v_bonus, v_want\)/, 'the bonus is spent before paid value');
  assert.match(sql, /code_hash\s+TEXT NOT NULL UNIQUE/);
  assert.doesNotMatch(sql, /\bcode\s+TEXT/, 'no column holds the plain code');

  const webhook = read('api/assembler/stripe-webhook.js');
  assert.doesNotMatch(webhook, /gift_card|_gift-cards/, 'the critical Stripe webhook is untouched; gift cards reconcile by reading Stripe');

  const vercel = JSON.parse(read('vercel.json'));
  assert.ok(vercel.crons.some((c) => c.path === '/api/cron/gift-cards-reconcile'), 'the reconcile cron is scheduled');

  const page = read('gift-cards.html');
  assert.match(page, /<meta name="robots" content="noindex, follow"\/>/, 'the page stays out of search while nothing is on sale');
  assert.match(page, /<script src="\/assets\/js\/gift-cards\.js" defer><\/script>/);
  assert.match(page, /the \$49 you pay never expires; the \$11 bonus and priority booking last 30 days from purchase/);
  const pageJs = read('assets/js/gift-cards.js');
  for (const text of [page, pageJs]) assert.doesNotMatch(text, /Stripe|PaymentIntent|ledger|stored value|metadata/i, 'customer surfaces use customer words');
  const sitemap = read('sitemap.xml');
  assert.doesNotMatch(sitemap, /\/gift-cards</, 'not in the sitemap while noindex');

  const club = read('setup-club.html');
  assert.match(club, /\$60 of setup credit for \$49/, 'the Setup Club page describes the same Move-In Pass');
  assert.doesNotMatch(club, /\$25 setup credit|Member-only bundle access/);

  const ownerHtml = read('owner/index.html');
  assert.match(ownerHtml, /data-view="giftcards"/);
  assert.match(ownerHtml, /\$giftCardsView/);
}

console.log('gift cards stage 1: all checks passed');
