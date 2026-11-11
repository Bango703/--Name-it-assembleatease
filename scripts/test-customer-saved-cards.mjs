#!/usr/bin/env node
// Saved cards on the customer app account, honest card wording, and fine-print
// legal text (owner, 2026-11-10).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import handler, { bookingStillNeedsCard, cardView, CHECKOUT_SESSION_COMPONENTS } from '../api/customer/payment-methods.js';

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function res() {
  return {
    statusCode: 200, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function fakeStripe({ customers = [], cards = {}, intents = {} } = {}) {
  const calls = [];
  return {
    calls,
    customers: {
      list: async (q) => { calls.push(['customers.list', q]); return { data: customers.filter((c) => c.email === q.email).slice(0, q.limit) }; },
      create: async (q) => { calls.push(['customers.create', q]); const c = { id: 'cus_new', email: q.email }; customers.push(c); return c; },
    },
    paymentMethods: {
      list: async (q) => { calls.push(['paymentMethods.list', q]); return { data: cards[q.customer] || [] }; },
      retrieve: async (id) => Object.values(cards).flat().find((pm) => pm.id === id) || null,
      detach: async (id) => { calls.push(['detach', id]); return { id }; },
    },
    setupIntents: { create: async (q) => { calls.push(['setupIntents.create', q]); return { client_secret: 'seti_1_secret_x' }; } },
    customerSessions: { create: async (q) => { calls.push(['customerSessions.create', q]); return { client_secret: 'cuss_secret_1' }; } },
    paymentIntents: { retrieve: async (id) => intents[id] },
  };
}

function fakeDb(rows = []) {
  return {
    from: () => {
      const filters = [];
      const q = {
        select() { return q; },
        eq(col, val) { filters.push((r) => r[col] === val); return q; },
        not(col, op, val) { filters.push((r) => r[col] != null); return q; },
        then(resolve) { resolve({ data: rows.filter((r) => filters.every((f) => f(r))), error: null }); },
      };
      return q;
    },
  };
}

const card = (id, customer, last4 = '4242') => ({ id, customer, card: { brand: 'visa', last4, exp_month: 4, exp_year: 2029, number: 'never' } });
const user = { email: 'Ann@Example.test' };
const deps = (extra) => ({ rateLimit: async () => true, customerAccountUser: async () => user, ...extra });
const call = async (method, body, extra) => { const r = res(); await handler({ method, headers: {}, body, query: {} }, r, deps(extra)); return r; };

// Signed out: nothing.
{
  const r = res();
  await handler({ method: 'GET', headers: {}, query: {} }, r, { rateLimit: async () => true, customerAccountUser: async () => null, stripe: fakeStripe(), sb: fakeDb() });
  assert.equal(r.statusCode, 401);
}

// Listing: the cards of the Stripe customer every booking saves to (lower-case email, first match).
{
  const stripe = fakeStripe({ customers: [{ id: 'cus_ann', email: 'ann@example.test' }], cards: { cus_ann: [card('pm_a', 'cus_ann')] } });
  const r = await call('GET', null, { stripe, sb: fakeDb() });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body.cards, [{ id: 'pm_a', brand: 'visa', last4: '4242', exp_month: 4, exp_year: 2029 }]);
  assert.deepEqual(stripe.calls[0], ['customers.list', { email: 'ann@example.test', limit: 1 }]);
  assert.ok(!JSON.stringify(r.body).includes('never'), 'only brand, last four and expiry leave the server');
  assert.deepEqual((await call('GET', null, { stripe: fakeStripe(), sb: fakeDb() })).body, { cards: [] });
}

// Adding from Account: a SetupIntent the quote alerts ignore.
{
  const stripe = fakeStripe();
  const r = await call('POST', { action: 'add' }, { stripe, sb: fakeDb() });
  assert.equal(r.body.clientSecret, 'seti_1_secret_x');
  const setup = stripe.calls.find((c) => c[0] === 'setupIntents.create')[1];
  assert.equal(setup.usage, 'off_session');
  assert.equal(setup.metadata.source, 'customer_account');
  const { WATCHED_SOURCES } = await import('../api/_quote-orphans-core.js');
  assert.ok(!WATCHED_SOURCES.includes('customer_account'), 'an Account card is never mistaken for an abandoned quote');
  assert.match(read('api/assembler/stripe-webhook.js'), /if \(si\.metadata\?\.source !== 'quote_booking'\) break;/);
}

// Checkout: a customer session that shows every saved card and never removes or saves on its own.
{
  const stripe = fakeStripe({ customers: [{ id: 'cus_ann', email: 'ann@example.test' }] });
  const r = await call('POST', { action: 'checkout' }, { stripe, sb: fakeDb() });
  assert.deepEqual(r.body, { customerId: 'cus_ann', customerSessionClientSecret: 'cuss_secret_1' });
  const features = CHECKOUT_SESSION_COMPONENTS.mobile_payment_element.features;
  assert.deepEqual(features.payment_method_allow_redisplay_filters, ['always', 'limited', 'unspecified']);
  assert.equal(features.payment_method_remove, 'disabled', 'removal goes through DELETE, where the booking check runs');
  assert.equal(features.payment_method_save, 'disabled');
}

// Removing: only your own card, and never one a booking still needs.
{
  assert.equal(bookingStillNeedsCard({ status: 'confirmed', payment_status: 'card_saved' }), true);
  assert.equal(bookingStillNeedsCard({ status: 'pending', payment_status: 'pending' }), true);
  assert.equal(bookingStillNeedsCard({ status: 'completed', payment_status: 'failed' }), true, 'a completed job that is not paid still needs its card');
  assert.equal(bookingStillNeedsCard({ status: 'completed', payment_status: 'captured' }), false);
  assert.equal(bookingStillNeedsCard({ status: 'cancelled', payment_status: 'authorized' }), false);

  const customers = [{ id: 'cus_ann', email: 'ann@example.test' }];
  const cards = { cus_ann: [card('pm_a', 'cus_ann'), card('pm_old', 'cus_ann', '1111')], cus_bob: [card('pm_bob', 'cus_bob')] };

  let stripe = fakeStripe({ customers, cards });
  let r = await call('DELETE', { paymentMethodId: 'pm_bob' }, { stripe, sb: fakeDb() });
  assert.equal(r.statusCode, 404, "someone else's card");
  assert.ok(!stripe.calls.some((c) => c[0] === 'detach'));

  stripe = fakeStripe({ customers, cards });
  r = await call('DELETE', { paymentMethodId: 'pm_a' }, { stripe, sb: fakeDb([{ id: 'b1', status: 'confirmed', payment_status: 'card_saved', stripe_payment_method_id: 'pm_a' }]) });
  assert.equal(r.statusCode, 409);
  assert.match(r.body.error, /set for a booking that is not paid yet/);
  assert.ok(!stripe.calls.some((c) => c[0] === 'detach'));

  stripe = fakeStripe({ customers, cards, intents: { pi_1: { payment_method: 'pm_a' } } });
  r = await call('DELETE', { paymentMethodId: 'pm_a' }, { stripe, sb: fakeDb([{ id: 'b2', status: 'confirmed', payment_status: 'authorized', stripe_customer_id: 'cus_ann', stripe_payment_intent_id: 'pi_1' }]) });
  assert.equal(r.statusCode, 409, 'a held booking paid with this card keeps it');

  stripe = fakeStripe({ customers, cards });
  r = await call('DELETE', { paymentMethodId: 'pm_old' }, { stripe, sb: fakeDb([{ id: 'b3', status: 'completed', payment_status: 'captured', stripe_payment_method_id: 'pm_old' }]) });
  assert.equal(r.statusCode, 200);
  assert.ok(stripe.calls.some((c) => c[0] === 'detach' && c[1] === 'pm_old'));
  assert.equal(cardView(card('pm_x', 'c')).last4, '4242');
}
console.log('PASS saved cards: signed-in only, the booking customer\'s cards, removal blocked while a booking needs the card');

// One rule for which Stripe customer holds the cards.
{
  assert.match(read('api/_stripe-customer.js'), /stripe\.customers\.list\(\{ email: e, limit: 1 \}\)/);
  assert.match(read('api/booking/setup-intent.js'), /stripe\.customers\.list\(\{ email: normalizedEmail, limit: 1 \}\)/);
  assert.match(read('api/booking.js'), /stripe\.customers\.list\(\{ email, limit: 1 \}\)/);
}

// The app: saved cards at checkout, never on a tip, never blocking a booking.
{
  const pay = read('mobile/ios/Customer/Customer/CustomerPayments.swift');
  assert.match(pay, /configuration\.customer = \.init\(id: customer\.customerID, customerSessionClientSecret: customer\.sessionSecret\)/);
  assert.match(pay, /let saved = \(stripeAccount \?\? ""\)\.isEmpty \? customer : nil/, 'a tip is on the Easer\'s account: no saved cards');
  assert.match(pay, /if case \.failed = outcome, saved != nil \{[\s\S]*customer: nil\)/, 'reopens without saved cards rather than failing');
  const api = read('mobile/ios/Customer/Customer/CustomerAPI.swift');
  for (const piece of ['"/api/customer/payment-methods"', '"action": "add"', '"action": "checkout"', '"paymentMethodId": id', 'value.sessionSecret.hasPrefix("cuss_")']) assert.ok(api.includes(piece), piece);
  const booking = read('mobile/ios/Customer/Customer/CustomerBooking.swift');
  assert.match(booking, /if email == email\.lowercased\(\) \{ savedCards = await api\.checkoutCustomer\(\) \}/);
  assert.equal((booking.match(/customer: savedCards\)/g) || []).length, 2, 'both the hold and the save-for-later sheet');
  const views = read('mobile/ios/Customer/Customer/CustomerViews.swift');
  assert.match(views, /NavigationLink \{ PaymentMethodsView\(\) \} label: \{ accountRow\("creditcard", "Payment methods"\) \}/);
  assert.match(views, /Section\("Account settings"\)/);
  assert.match(views, /UIApplication\.openNotificationSettingsURLString/);
}
console.log('PASS app: saved cards offered at checkout and managed in Account; a tip never uses them');

// "Your card is saved" was shown before any card was entered.
{
  assert.match(read('api/booking/_checkout.js'), /\[CHECKOUT_PLAN\.SAVE_CARD\]: \{ button: 'Book now', note: 'Nothing is charged today\. You pay after the job is done\.' \}/);
  for (const f of ['api/booking/_checkout.js', 'api/booking/_customer-status.js', 'book.html']) {
    assert.doesNotMatch(read(f), /Your card is saved|Card saved securely|card is saved securely/, f);
  }
  const booking = read('api/booking.js');
  const customerHtml = booking.slice(booking.indexOf('const customerHtml'));
  assert.doesNotMatch(customerHtml.slice(0, 20000), /card is saved securely/i, 'the customer confirmation email');
}
console.log('PASS wording: no screen or email says a card is saved when the customer has not seen one');

// Fine print: legal pages and the agreement under the book button.
{
  for (const [file, k] of [['terms.html', 'terms'], ['privacy.html', 'privacy']]) {
    const page = read(file);
    assert.ok(page.includes(`.${k}-inner p{font-size:0.82rem;`), `${file} body text`);
    assert.ok(page.includes(`.${k}-inner h2{font-family:var(--font-display);font-size:1.05rem;`), `${file} headings`);
    assert.ok(page.includes('.page-title{font-family:var(--font-display);font-size:clamp(1.5rem,3vw,2rem);'), `${file} title`);
  }
  assert.match(read('book.html'), /<p id="s5-ack-notice" style="font-size:0\.7rem;/);
  assert.match(read('mobile/ios/Customer/Customer/CustomerBooking.swift'), /Button\("Privacy"\) \{ openURL\(Site\.page\("\/privacy"\)\) \}\n\s*\}\n\s*\}\n\s*\.font\(\.caption2\)/);
  // Still agreed by booking, with the links visible.
  assert.match(read('book.html'), /By submitting this booking, you agree to the current <a href="\/terms"/);
}
console.log('PASS fine print: Terms, Privacy and the booking agreement at fine-print size, links kept');

console.log('\nCustomer saved cards tests passed.');
