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

ok('the Easer page gets one stage per request, decided on the server', () => {
  const now = Date.parse('2026-11-13T15:00:00Z');
  const future = '2026-11-14T15:00:00Z';
  const past = '2026-11-13T14:00:00Z';
  const me = 'e1';
  const pending = { id: 'b1', status: 'pending', payment_status: 'not_required' };
  const stage = (offer, booking, jobOffer) => offers.easerRequestStage({ easer_id: me, respond_by: future, ...offer }, booking, now, jobOffer);
  assert.equal(stage({ status: 'invited' }, pending), 'open');
  assert.equal(stage({ status: 'invited', respond_by: past }, pending), 'missed');
  assert.equal(stage({ status: 'submitted' }, pending), 'sent');
  assert.equal(stage({ status: 'submitted', respond_by: past }, pending), 'in_review');
  // The write path refuses once a quote is sent or a hold exists; the stage agrees.
  assert.equal(stage({ status: 'submitted' }, { ...pending, stripe_payment_intent_id: 'pi_1' }), 'in_review');
  assert.equal(stage({ status: 'invited' }, { ...pending, quote_approved_at: past }), 'missed');
  assert.equal(stage({ status: 'not_selected' }, pending), 'not_chosen');
  assert.equal(stage({ status: 'withdrawn' }, pending), 'withdrawn');
  assert.equal(stage({ status: 'closed' }, pending), 'closed');
  const sentQuote = { ...pending, payment_status: 'quote_pending_approval', selected_quote_offer_id: 'o1', quote_expires_at: future };
  assert.equal(stage({ status: 'selected' }, sentQuote), 'with_customer');
  assert.equal(stage({ status: 'selected' }, { ...sentQuote, quote_expires_at: past }), 'closed');
  assert.equal(stage({ status: 'selected' }, { ...sentQuote, status: 'declined' }), 'closed');
  const approved = { ...sentQuote, status: 'confirmed', payment_status: 'authorized', quote_approved_at: past };
  assert.equal(stage({ status: 'selected' }, approved), 'customer_approved');
  assert.equal(stage({ status: 'selected' }, approved, { offer_status: 'sent', expires_at: future }), 'job_offered');
  assert.equal(stage({ status: 'selected' }, approved, { offer_status: 'sent', expires_at: past }), 'offer_ended');
  assert.equal(stage({ status: 'selected' }, approved, { offer_status: 'declined', expires_at: future }), 'offer_ended');
  assert.equal(stage({ status: 'selected' }, { ...approved, assembler_id: me }), 'job_yours');
  assert.equal(stage({ status: 'selected' }, { ...approved, assembler_id: 'e2' }), 'job_taken');

  // The view: the job link only when the job is this Easer's to open, the
  // area by ZIP only, and the catalog's custom-quote placeholder left out.
  const groups = [{ items: [{ name: 'Custom Quote: describe your project in the notes', quantity: 1 }, { name: 'Sit-stand desk', quantity: 2 }] }];
  const offered = offers.quoteRequestForEaser({ id: 'o1', easer_id: me, status: 'selected', respond_by: future }, { ...approved, service_zip: '78701' }, groups, { offer_status: 'sent', expires_at: future }, now);
  assert.equal(offered.stage, 'job_offered');
  assert.equal(offered.jobId, 'b1');
  assert.equal(offered.jobOfferExpiresAt, future);
  assert.equal(offered.areaMapUrl, 'https://www.google.com/maps/search/?api=1&query=78701');
  assert.deepEqual(offered.items, [{ name: 'Sit-stand desk', quantity: 2 }]);
  const waiting = offers.quoteRequestForEaser({ id: 'o1', easer_id: me, status: 'selected', respond_by: future }, approved, [], null, now);
  assert.equal(waiting.jobId, null);
  const open = offers.quoteRequestForEaser({ id: 'o2', easer_id: me, status: 'invited', respond_by: future }, pending, [], null, now);
  assert.equal(open.canRespond, true);
  assert.equal(open.stage, 'open');

  // The page renders the server's stage and never decides one itself.
  const page = read('assembler/price-requests.html');
  assert.match(page, /switch \(r\.stage\)/);
  assert.doesNotMatch(page, /r\.status ===/);
  assert.doesNotMatch(page, /window\.confirm|[^.]\bconfirm\(/);
  // Only promises the platform keeps: no notice is sent when a price is chosen,
  // and payout can be Zelle, PayPal or check, not only a bank.
  assert.doesNotMatch(page, /let you know if your price|paid to your bank/i);
  // The Easer's dispatch offer is read for this Easer only.
  assert.match(read('api/assembler/price-requests.js'), /from\('dispatch_offers'\)[\s\S]*?\.eq\('easer_id', easerId\)/);
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

// ── 7. The owner chooses who to ask; the server re-checks ───────────────────
const invites = await import('../api/booking/_quote-offer-invites.js');
ok('only askable Easers the owner ticked are asked, and never more than the room left', () => {
  const askable = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.deepEqual(invites.chooseEasersToAsk(askable, ['b']).chosen.map(e => e.id), ['b']);
  assert.deepEqual(invites.chooseEasersToAsk(askable, null, 2).chosen.map(e => e.id), ['a', 'b'], 'no ticks asks everyone up to the room');
  assert.ok(invites.chooseEasersToAsk(askable, ['z']).message, 'a tick for someone not askable is refused');
  assert.ok(invites.chooseEasersToAsk(askable, ['a', 'z']).message, 'one bad tick refuses the whole request');
  assert.ok(invites.chooseEasersToAsk(askable, ['a', 'b', 'c'], 2).message, 'more ticks than room is refused, not silently cut');
  assert.deepEqual(invites.chooseEasersToAsk(askable, []).chosen, []);
});

ok('the owner sees an Easer by name, rating and area, never contact details', () => {
  const view = invites.askableEaserView({ id: 'e1', full_name: 'Alex Example', rating: '4.9', completed_jobs: 12, tier: 'pro', city: 'Austin', email: 'alex@x.test', phone: '5125550100', zip: '78701' });
  assert.deepEqual(Object.keys(view).sort(), ['city', 'completedJobs', 'id', 'name', 'rating', 'tier']);
  assert.equal(view.rating, 4.9);
});

ok('the owner endpoint validates the ticked Easers before asking', () => {
  const src = read('api/owner/quote-offers.js');
  assert.match(src, /rawIds\.length > 8/);
  assert.match(src, /inviteEasersForQuote\(sb, booking, \{ easerIds: rawIds \?\? null \}\)/);
  assert.match(src, /askableEasers: askable\.easers\.map\(askableEaserView\)/);
});

ok('the bookings list summary counts prices in and requests still waiting', () => {
  const now = Date.parse('2026-11-13T15:00:00Z');
  const later = '2026-11-14T15:00:00Z', earlier = '2026-11-12T15:00:00Z';
  const sum = offers.summarizeQuoteOffers([
    { status: 'submitted', respond_by: later }, { status: 'invited', respond_by: later },
    { status: 'invited', respond_by: earlier }, { status: 'withdrawn', respond_by: later },
  ], now);
  assert.deepEqual(sum, { asked: 4, priced: 1, waiting: 1, selected: false });
  assert.equal(offers.summarizeQuoteOffers([{ status: 'selected', respond_by: earlier }], now).selected, true);
  const list = read('api/booking/list.js');
  assert.match(list, /booking\._quote_offers = summarizeQuoteOffers/);
  assert.match(list, /booking\._partner_account = \{ id: partner\.id, name: partner\.name, code: partner\.account_code \}/);
});

ok('a partner account offers local Easers first and never a demo account', () => {
  assert.equal(partners.partnerMarket({ address: '901 S MoPac Expy Suite 300, Austin, TX 78746' }), 'central_texas');
  assert.equal(partners.partnerMarket({ address: 'Austin' }), null);
  const view = partners.easerRosterView([{ id: '1', full_name: 'Thomas', city: 'WHITEHOUSE', zip: '78701', rating: '4.8', email: 'x@y.test', phone: '5125550100' }]);
  assert.deepEqual(view, [{ id: '1', name: 'Thomas', city: 'Whitehouse', rating: 4.8, market: 'central_texas' }]);
  const src = read('api/owner/partners.js');
  assert.match(src, /const demoIds = await loadDemoEaserIds\(sb\);\n\s+return easerRosterView\(\(data \|\| \[\]\)\.filter\(e => !demoIds\.has\(e\.id\)\)\);/);
  assert.match(read('owner/assets/partners.js'), /Other areas \(/);
});

ok('both features are off unless switched on', () => {
  assert.equal(offers.privateEaserOffersEnabled({}), false);
  assert.equal(partners.commercialAccountsEnabled({}), false);
});

console.log(`PASS hybrid marketplace: ${passed} checks. Easer price paid in full with the fee on top; no customer details or price reach an Easer; Easer access scoped; one server-priced quote; preferred Easers first then normal matching; account pricing on the server and only when on; migration 129 matches.`);
