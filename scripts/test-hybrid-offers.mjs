#!/usr/bin/env node
// The hybrid marketplace (owner, 2026-11-12): private Easer price offers on
// custom quotes, partner accounts, and preferred Easers in dispatch.
// Holds: the Easer earns exactly what they asked (fee on top, tax added); an
// Easer never sees the customer, their contact details or the price; every
// Easer read and write is scoped to that Easer; the owner sends one quote,
// priced on the server; account codes price on the server and only when on;
// dispatch offers preferred Easers first and falls back; and the migration
// lists the same values as the code.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.PRIVATE_EASER_OFFERS_ENABLED = 'true';
process.env.COMMERCIAL_ACCOUNTS_ENABLED = 'true';

const read = p => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

const offers = await import('../api/booking/_quote-offers.js');
const partners = await import('../api/_partners.js');
const { selectOfferRecipients } = await import('../api/booking/_dispatch-internal.js');
const { resolveBookingPromotion, applyPromotionToPricing } = await import('../api/_promotions.js');
const { computeBookingSplit, SALES_TAX_RATE } = await import('../api/_source-of-truth.js');

let passed = 0;
const ok = (name, fn) => { fn(); passed++; };

// ── 1. Easer price → customer quote ──────────────────────────────────────────
ok('every Easer price is paid in full, with the fee on top and tax added', () => {
  for (let earnings = offers.QUOTE_OFFER_MIN_EARNINGS_CENTS; earnings <= 300000; earnings += 137) {
    const q = offers.customerQuoteForEarnings(earnings);
    assert.equal(q.feePct, 30);
    assert.equal(q.taxCents, Math.round(q.subtotalCents * SALES_TAX_RATE));
    assert.equal(q.totalCents, q.subtotalCents + q.taxCents);
    const split = computeBookingSplit(q.totalCents, false, { taxCents: q.taxCents });
    assert.ok(split.assemblerDueCents >= earnings, `Easer short-paid at ${earnings}`);
    assert.ok(split.assemblerDueCents - earnings <= 1, `subtotal not minimal at ${earnings}`);
    assert.equal(split.assemblerDueCents, q.easerEarningsCents);
    assert.equal(split.platformFeeCents, q.platformFeeCents);
  }
  const q = offers.customerQuoteForEarnings(35000);
  assert.deepEqual([q.subtotalCents, q.taxCents, q.totalCents, q.easerEarningsCents], [50000, 4125, 54125, 35000]);
});

ok('submissions are bounded', () => {
  assert.equal(offers.validateOfferSubmission({ earningsDollars: '19', hours: 2, crewSize: 1 }).ok, false);
  assert.equal(offers.validateOfferSubmission({ earningsDollars: '200', hours: 0, crewSize: 1 }).ok, false);
  assert.equal(offers.validateOfferSubmission({ earningsDollars: '200', hours: 3, crewSize: 5 }).ok, false);
  const good = offers.validateOfferSubmission({ earningsDollars: '245.50', hours: '3', crewSize: '2', note: ' bring a ladder ' });
  assert.equal(good.ok, true);
  assert.deepEqual(good.value, { earningsCents: 24550, hours: 3, crewSize: 2, note: 'bring a ladder' });
});

// ── 2. What an Easer sees ────────────────────────────────────────────────────
ok('contact details are removed from the job description', () => {
  const text = offers.scrubContactDetails('Call me at (512) 555-0199 or 512.555.0100, email jo@x.com, see www.x.com, IG @jo_builds. Gate code 4411.');
  assert.ok(!/555|jo@x|www\.|@jo_/.test(text), text);
  assert.ok(!text.includes('4411'));
});

ok('a price request never carries the customer or the price', () => {
  const booking = { id: 'b1', ref: 'AAE-1', service: 'Custom', customer_name: 'Jo Smith', customer_email: 'jo@x.com', customer_phone: '5125550199',
    address: '1 Main St, Austin TX 78701', service_city: 'Austin', service_zip: '78701', date: '2026-12-01', time: '10:00 AM – 12:00 PM',
    details: 'Text 512-555-0199', total_price: 99999, quote_amount_cents: 88888 };
  const view = offers.quoteRequestForEaser({ id: 'o1', status: 'invited', respond_by: new Date(Date.now() + 3600e3).toISOString() }, booking,
    [{ label: 'Outdoor', items: [{ name: 'Gazebo', quantity: 1, isAddOn: false }, { name: 'Gazebo', quantity: 1, isAddOn: true, addOnName: 'Anchoring' }] }]);
  const json = JSON.stringify(view);
  for (const leak of ['Jo Smith', 'jo@x.com', '5125550199', '555-0199', '1 Main St', '99999', '88888']) assert.ok(!json.includes(leak), `leaked ${leak}`);
  assert.deepEqual(view.items.map(i => i.name), ['Gazebo', 'Gazebo: Anchoring']);
  assert.equal(view.status, 'open');
});

ok('offer status for the Easer follows the window', () => {
  const past = new Date(Date.now() - 1000).toISOString();
  const future = new Date(Date.now() + 1000 * 60).toISOString();
  assert.equal(offers.offerStatusForEaser({ status: 'invited', respond_by: past }), 'missed');
  assert.equal(offers.offerStatusForEaser({ status: 'submitted', respond_by: future }), 'sent');
  assert.equal(offers.offerStatusForEaser({ status: 'selected', respond_by: past }), 'chosen');
  assert.equal(offers.offerOpenForEaser({ status: 'invited', respond_by: past }), false);
});

// ── 3. Endpoints: scoping and server pricing ─────────────────────────────────
ok('every Easer read and write of an offer is scoped to that Easer', () => {
  const src = read('api/assembler/price-requests.js');
  assert.match(src, /requireActiveApprovedEaser\(req\)/);
  const offerQueries = src.match(/from\('quote_price_offers'\)[\s\S]*?;/g) || [];
  assert.ok(offerQueries.length >= 2);
  offerQueries.forEach(q => assert.match(q, /\.eq\('easer_id', easerId\)/, 'unscoped offer query: ' + q.slice(0, 80)));
  assert.doesNotMatch(src, /req\.body\??\.easerId|req\.body\??\.easer_id/);
  assert.doesNotMatch(src, /customer_(name|email|phone)|address/);
});

ok('the owner endpoints check the owner, and a quote from an offer is priced on the server', () => {
  assert.match(read('api/owner/quote-offers.js'), /if \(!verifyOwner\(req\)\) return res\.status\(401\)/);
  const qa = read('api/owner/quote-approve.js');
  assert.match(qa, /priceCents = offerQuote\.totalCents;/);
  assert.match(qa, /const subtotalCents = offerQuote \? offerQuote\.subtotalCents/);
  assert.match(qa, /!quoteOfferId && \(!Number\.isInteger\(priceCents\)/);
  // The owner panel sends no amount with an offer.
  const panel = read('owner/index.html');
  assert.match(panel, /body: JSON\.stringify\(\{ bookingId: id, quoteOfferId: offerId, offerUpdatedAt: offerUpdatedAt, date: quoteDate, time: quoteTime \}\)/);
});

// ── 4. Dispatch: preferred Easers first, then normal matching ────────────────
ok('preferred Easers get the offer first and normal matching takes over', () => {
  const scored = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
  assert.deepEqual(selectOfferRecipients(scored, ['c']).map(e => e.id), ['c']);
  assert.deepEqual(selectOfferRecipients(scored, ['x']).map(e => e.id), ['a', 'b', 'c']);
  assert.deepEqual(selectOfferRecipients(scored, null).map(e => e.id), ['a', 'b', 'c']);
  assert.deepEqual(selectOfferRecipients(scored, ['d', 'b']).map(e => e.id), ['b', 'd']);
  const src = read('api/booking/_dispatch-internal.js');
  assert.match(src, /const top = selectOfferRecipients\(scored, booking\.preferred_easer_ids\);/);
  assert.match(src, /const found = await findEligibleEasers\(sb, booking, \{ excludeEaserId \}\);/);
  assert.match(read('api/booking/_quote-offer-invites.js'), /await findEligibleEasers\(sb, booking\)/);
});

// ── 5. Partner accounts ──────────────────────────────────────────────────────
ok('account settings are bounded and opening one makes a code', () => {
  assert.match(partners.newAccountCode(), partners.ACCOUNT_CODE);
  assert.ok(partners.validateAccountUpdate({}, { status: 'active', discountPct: 25 }).error);
  assert.ok(partners.validateAccountUpdate({}, { status: 'open' }).error);
  assert.ok(partners.validateAccountUpdate({}, { status: 'active', preferredEaserIds: ['nope'] }).error);
  const { patch } = partners.validateAccountUpdate({ stage: 'interested', history: [] }, { status: 'active', discountPct: 10, preferredEaserIds: ['11111111-1111-4111-8111-111111111111'] });
  assert.equal(patch.account_status, 'active');
  assert.equal(patch.account_discount_pct, 10);
  assert.match(patch.account_code, partners.ACCOUNT_CODE);
  assert.equal(patch.stage, 'partner');
  assert.ok(patch.account_started_at);
});

ok('the account report counts verified collection', () => {
  const r = partners.summarizeAccountBookings([
    { status: 'completed', payment_status: 'captured', total_price: 54125, amount_charged: 54125, tax_amount: 4125, easer_fee_pct_snapshot: 30, created_at: '2026-11-01' },
    { status: 'confirmed', total_price: 10000, tax_amount: 762, created_at: '2026-11-02' },
    { status: 'cancelled', total_price: 10000, tax_amount: 762, created_at: '2026-11-03' },
    { status: 'completed', total_price: 10000, is_test_booking: true },
  ]);
  assert.deepEqual([r.jobs, r.completed, r.open, r.cancelled], [3, 1, 1, 1]);
  assert.deepEqual([r.chargedCents, r.taxCents, r.platformFeeCents, r.easerPayCents], [54125, 4125, 15000, 35000]);
});

ok('unpaid completions, zero charges, refunds and monthly boundaries stay honest', () => {
  const row = { id: 'paid', ref: 'DEMO-PAID', status: 'completed', payment_status: 'captured',
    created_at: '2026-11-02T12:00:00Z', total_price: 10825, amount_charged: 10825,
    tax_amount: 825, assembler_due: 7000, stripe_fee: 344 };
  const report = partners.summarizeAccountBookings([
    row,
    { ...row, id: 'unpaid', payment_status: 'capture_failed', amount_charged: null },
    { ...row, id: 'zero', amount_charged: 0, assembler_due: 0, tax_amount: 0, stripe_fee: 0 },
    { ...row, id: 'refunded', payment_status: 'refunded', refund_amount: 10825 },
    { ...row, id: 'lastmonth', created_at: '2026-11-01T01:00:00Z' },
  ], { month: '2026-11' });
  assert.equal(report.jobs, 4);
  assert.equal(report.bookings.length, report.jobs);
  assert.equal(report.unpaidCompleted, 1);
  assert.equal(report.chargedCents, 21650);
  assert.equal(report.refundedCents, 10825);
  assert.equal(report.taxCents, 825);
  assert.equal(report.easerPayCents, 14000, 'refunds do not silently erase the Easer liability');
  assert.equal(report.netEstimateCents, -4688);
});

ok('expired and closed jobs cannot display an editable price form', () => {
  const offer = { status: 'submitted', respond_by: '2020-01-01T00:00:00Z' };
  assert.equal(offers.quoteRequestForEaser(offer, { status: 'pending' }).canRespond, false);
  assert.equal(offers.quoteRequestForEaser({ ...offer, respond_by: '2099-01-01T00:00:00Z' }, { status: 'cancelled' }).canRespond, false);
  assert.equal(offers.validateOfferSubmission({ earningsDollars: 50, hours: 2, crewSize: '2people' }).ok, false);
  assert.equal(offers.validateOfferSubmission({ earningsDollars: 50, hours: 2.1, crewSize: 1 }).ok, false);
  assert.equal(offers.quoteRequestForEaser(offer, { details: 'Jane lives at the pink house. Gate code 1234.' }).details, '');
});

function stubSb(account) {
  return { from(table) {
    assert.equal(table, 'partner_leads');
    const q = { select() { return q; }, eq() { return q; }, async maybeSingle() { return { data: account, error: null }; } };
    return q;
  } };
}
const pricing = { hasPricedBaseItem: true, discountedItemSubtotalCents: 20000, serviceCallFeeCents: 500, sameDayFeeCents: 0 };

// An account code prices on the server and tags the booking.
{
  const account = { id: 'acct-1', name: 'Lakeline Apartments', account_status: 'active', account_discount_pct: 10, account_preferred_easer_ids: ['e1'] };
  const promo = await resolveBookingPromotion({ promoCode: 'pabc2345', email: 'x@y.com', pricing, sb: stubSb(account), promoSettings: { promoEnabled: false } });
  assert.equal(promo.applied, true);
  assert.equal(promo.discountCents, 2000);
  assert.equal(promo.commercialAccountId, 'acct-1');
  assert.deepEqual(promo.preferredEaserIds, ['e1']);
  const priced = applyPromotionToPricing(pricing, promo);
  assert.equal(priced.taxableSubtotalCents, 18500);
  const paused = await resolveBookingPromotion({ promoCode: 'PABC2345', email: 'x@y.com', pricing, sb: stubSb({ ...account, account_status: 'paused' }), promoSettings: { promoEnabled: false } });
  assert.equal(paused.applied, false);
  const quote = await resolveBookingPromotion({ promoCode: 'PABC2345', email: 'x@y.com', pricing, sb: stubSb(account), isQuoteRequest: true, promoSettings: { promoEnabled: false } });
  assert.equal(quote.applied, false);
  process.env.COMMERCIAL_ACCOUNTS_ENABLED = 'false';
  const off = await resolveBookingPromotion({ promoCode: 'PABC2345', email: 'x@y.com', pricing, sb: stubSb(account), promoSettings: { promoEnabled: false } });
  assert.equal(off.applied, false);
  process.env.COMMERCIAL_ACCOUNTS_ENABLED = 'true';
  passed++;
}

ok('a booking is tagged with an account only from a server-resolved account code', () => {
  const src = read('api/booking.js');
  assert.match(src, /\.\.\.\(promo\.applied && promo\.commercialAccountId \? \{\n\s+commercial_partner_id: promo\.commercialAccountId,/);
  assert.doesNotMatch(src, /req\.body[^\n]*commercial/i);
});

// ── 6. The migration lists what the code uses ────────────────────────────────
ok('migration 129 matches the code', () => {
  const sql = read('api/migrations/129_hybrid_offers_and_accounts.sql');
  const list = name => (sql.match(new RegExp(name + "[\\s\\S]*?CHECK \\(status IN \\(([^)]*)\\)")) || [])[1];
  const statuses = list('quote_price_offers_status_check').split(',').map(s => s.trim().replace(/'/g, ''));
  assert.deepEqual(statuses.sort(), [...offers.QUOTE_OFFER_STATUSES].sort());
  assert.match(sql, new RegExp(`account_status IN \\('${partners.ACCOUNT_STATUSES.join("', '")}'\\)`));
  assert.match(sql, new RegExp(`account_discount_pct <= ${partners.ACCOUNT_MAX_DISCOUNT_PCT}\\)`));
  assert.match(sql, /account_code ~ '\^P\[A-Z0-9\]\{7\}\$'/);
  assert.equal(partners.ACCOUNT_CODE.source, '^P[A-Z0-9]{7}$');
  assert.match(sql, new RegExp(`earnings_cents BETWEEN ${offers.QUOTE_OFFER_MIN_EARNINGS_CENTS} AND ${offers.QUOTE_OFFER_MAX_EARNINGS_CENTS}`));
  assert.match(sql, new RegExp(`crew_size BETWEEN 1 AND ${offers.QUOTE_OFFER_MAX_CREW}`));
});

ok('both features are off unless switched on', () => {
  assert.equal(offers.privateEaserOffersEnabled({}), false);
  assert.equal(partners.commercialAccountsEnabled({}), false);
});

console.log(`PASS hybrid marketplace: ${passed} checks. Easer price paid in full with the fee on top; no customer details or price reach an Easer; Easer access scoped; one server-priced quote; preferred Easers first then normal matching; account pricing on the server and only when on; migration 129 matches.`);
