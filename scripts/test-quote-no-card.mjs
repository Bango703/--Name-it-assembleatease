#!/usr/bin/env node
// Custom quote without a card (owner, 2026-10-21). 12 of 15 people who reached
// the last step of a quote left at a card form shown before any price. Now:
// the quote is sent with no card, a started quote is saved as a lead, the owner
// prices it, and the customer adds a card on the approval page after seeing the
// price. Instant bookings and scheduled bookings keep their card exactly as before.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const { isLikelySpamQuote, MIN_HUMAN_FILL_MS } = await import('../api/booking/_quote-spam.js');
const { isQuoteAwaitingPrice, quoteNeedsCardAtApproval } = await import('../api/booking/_quote-state.js');
const { createQuoteLeadHandler, normalizeQuoteLead, QUOTE_LEAD_SOURCE } = await import('../api/booking/quote-lead.js');
const { createQuoteLeadAlert, buildQuoteLeadEmail } = await import('../api/cron/quote-lead-alert.js');
const { buildApprovalPage } = await import('../api/owner/quote-approve.js');

// ── Customer: the quote step asks for no card ───────────────────────────────
const book = read('book.html');
{
  const start = book.indexOf('  if (isQuoteFlow) {\n    document.getElementById(\'s5-banner\')');
  assert.ok(start > 0, 'the quote branch of step 5 exists');
  const branch = book.slice(start, book.indexOf('\n    return;\n  }', start));
  assert.match(branch, /getElementById\('s5-payment-section'\)\.style\.display = 'none'/, 'the card form is hidden');
  assert.match(branch, /getElementById\('s5-cancel-note'\)\.style\.display = 'none'/, 'no cancellation-fee box on a quote');
  assert.match(branch, /No card needed/);
  assert.match(branch, /Send Quote Request/);
  assert.match(branch, /captureQuoteLead\(\);/, 'the started quote is saved as a lead');
  assert.doesNotMatch(branch, /setup-intent|initStripe|confirmCardSetup/, 'no Stripe card setup on the quote step');
  assert.ok(book.indexOf('captureQuoteLead();') < book.indexOf("var siResp = await fetch('/api/booking/setup-intent'"), 'the quote branch returns before any card setup');
  assert.match(book, /if \(!submitBtn \|\| BOOK\.isEmergingMarket\) return;\n  if \(BOOK\._isQuoteFlow\) \{\n    submitBtn\.disabled = false;/, 'the submit button does not wait for a card');
  assert.match(book, /if \(!BOOK\._isQuoteFlow && \(!BOOK\._stripe \|\| !BOOK\._cardEl\)\)/);
  assert.match(book, /if \(!BOOK\._isQuoteFlow && !usesKlarna && !BOOK\._cardComplete\)/);
  assert.match(book, /if \(BOOK\._scheduledAuthorization && BOOK\._setupIntentSecret\) \{/, 'card setup stays for scheduled bookings only');
  assert.match(book, /setupIntentId: BOOK\._scheduledAuthorization \? savedSetupIntentId : null,\n        formStartedAt: BOOK\._formStartedAt \|\| null,/);
  assert.match(book, /fetch\('\/api\/booking\/quote-lead', \{/);
  assert.match(book, /company: \(document\.getElementById\('bk-company'\) \|\| \{\}\)\.value \|\| ''/, 'the decoy field rides along');
  assert.match(book, /document\.getElementById\('s5-cancel-note'\)\.style\.display = '';/, 'every other path still shows the cancellation terms');
  assert.doesNotMatch(book, /your card is saved securely, but no payment has been taken/, 'the quote confirmation claims no saved card');
  assert.match(book, /You approve and add a card<\/strong> - nothing is charged until the work is done\./);
}
console.log('PASS customer: quote step has no card, no Stripe setup, saves the lead; other paths unchanged');

// ── Spam: what stands where the card used to ────────────────────────────────
{
  const now = Date.now();
  assert.equal(isLikelySpamQuote({ formStartedAt: now - 90000, details: 'Office desks for a small team', name: 'Lindsay Phillips', now }), false, 'a real person passes');
  assert.equal(isLikelySpamQuote({ details: 'no timing signal sent', now }), false, 'a missing signal never blocks');
  assert.equal(isLikelySpamQuote({ company: 'Acme', now }), true, 'the decoy field');
  assert.equal(isLikelySpamQuote({ formStartedAt: now - (MIN_HUMAN_FILL_MS - 1000), now }), true, 'faster than a person can fill the form');
  assert.equal(isLikelySpamQuote({ details: 'see http://a.example and www.b.example', now }), true, 'link spam');
  assert.equal(isLikelySpamQuote({ details: 'the product is at https://ikea.com/x', now }), false, 'one product link is normal');
  assert.equal(isLikelySpamQuote({ name: 'cheap www.spam.example', now }), true);
  const booking = read('api/booking.js');
  assert.match(booking, /if \(quoteRequested && !setupIntentId\) \{\n    if \(isLikelySpamQuote\(\{ company, formStartedAt, details, name, now: Date\.now\(\) \}\)\)/, 'the server checks every cardless quote');
  assert.match(booking, /rateLimitKey\(`\$\{ip\}:\$\{String\(email \|\| ''\)\.trim\(\)\.toLowerCase\(\)\}`, 'quote_request'\)/, 'per address and email');
  assert.match(read('api/_ratelimit.js'), /quote_request: buildLimiter\('rl:quote_request', 3, '3600 s'\)/);
}
console.log('PASS spam: decoy, timing, link and rate checks; a real person is never blocked');

// ── Server: a quote is accepted without a card; a card is still verified ───
{
  const booking = read('api/booking.js');
  assert.match(booking, /if \(scheduledAuthorization \|\| \(quoteRequested && setupIntentId\)\) \{\n    if \(!setupIntentId \|\| !process\.env\.STRIPE_SECRET_KEY\) \{/, 'scheduled bookings still require a saved card; a quote does not');
  assert.match(booking, /payment_status: scheduledAuthorization \? 'card_saved' : \(shouldAuthorizeNow \? 'pending' : 'not_required'\),/);
  assert.match(booking, /payment_method_type: quoteRequested \|\| scheduledAuthorization\n      \? BOOKING_PAYMENT_METHOD\.CARD/, 'a quote is saved with payment type card');
  assert.match(booking, /if \(quoteRequested\) await markQuoteLeadConverted\(sb, email\);/, 'sending the quote converts the lead');
  assert.match(booking, /'You approve the price and add a card then\. Nothing is charged until the work is done\.'/, 'the email says what is true');
}
console.log('PASS server: a cardless quote is saved and converts its lead; scheduled bookings still need a card');

// ── One rule for "a quote waiting for a price" (server and owner dashboard) ─
{
  const owner = read('owner/index.html');
  const fnSrc = owner.match(/function isQuoteAwaitingCard\(b\) \{[\s\S]*?\n  \}/)[0];
  const isQuoteAwaitingCard = new Function(`${fnSrc}; return isQuoteAwaitingCard;`)();
  const cases = [
    { status: 'pending', payment_status: 'not_required', payment_method_type: 'card' },
    { status: 'pending', payment_status: 'not_required', payment_method_type: null },
    { status: 'pending', payment_status: 'pending', payment_method_type: 'card' },
    { status: 'confirmed', payment_status: 'not_required', payment_method_type: 'card' },
    { status: 'pending', payment_status: 'card_saved', payment_method_type: 'card' },
  ];
  const expectedNoCard = [true, false, false, false, false];
  cases.forEach((b, i) => assert.equal(isQuoteAwaitingCard(b), expectedNoCard[i], `owner rule, case ${i}`));
  const expectedPrice = [true, false, false, false, true];
  cases.forEach((b, i) => assert.equal(isQuoteAwaitingPrice(b), expectedPrice[i], `server rule, case ${i}`));
  cases.forEach((b, i) => { if (b.payment_status === 'not_required') assert.equal(isQuoteAwaitingCard(b), isQuoteAwaitingPrice(b), `rules agree, case ${i}`); });
  assert.match(owner, /if \(pay === 'card_saved' \|\| isQuoteAwaitingCard\(b\) \|\|/, 'cardless quotes land in the Quote Request lane');
  assert.match(owner, /quote_no_card: \['py-not-required', 'Card at Approval'\]/);
  assert.match(owner, /if \(isQuoteAwaitingCard\(booking\)\) return 'Quote request: the customer adds a card when they approve the price';/);
  assert.equal(quoteNeedsCardAtApproval({}), true);
  assert.equal(quoteNeedsCardAtApproval({ stripe_payment_method_id: 'pm_1' }), false);
}
console.log('PASS one rule: server and owner dashboard agree on a quote waiting for a price');

// ── Owner prices it; the customer adds the card after seeing the price ─────
{
  const approve = read('api/owner/quote-approve.js');
  assert.match(approve, /if \(!isQuoteAwaitingPrice\(booking\) && String\(booking\.payment_status \|\| ''\) !== 'quote_pending_approval'\)/, 'pricing accepts a cardless quote');
  assert.match(approve, /if \(booking\.payment_status === 'card_saved' && \(!booking\.stripe_customer_id \|\| !booking\.stripe_payment_method_id\)\)/, 'a quote sent with a card must still have it');
  assert.match(approve, /\.\.\.\(cardAtApproval \? \{ payment_method_types: \['card'\] \} : \{ payment_method: booking\.stripe_payment_method_id \}\),/, 'the hold is created without a saved card when needed');
  assert.match(approve, /capture_method: 'manual',/, 'still a hold, never a charge');
  assert.match(approve, /idempotencyKey: `quote-approval-customer-\$\{booking\.id\}`/);
  assert.match(approve, /stripe_customer_id: customerId/);
  assert.match(approve, /stripe_payment_method_id: intentCardId/, 'the card entered on approval is saved for capture and re-authorization');
  assert.match(approve, /\.eq\('payment_status', 'quote_authorization_pending'\)\n    \.eq\('stripe_payment_intent_id', pi\.id\)/, 'finalize keeps its compare-and-set');
  const booking = { customer_name: 'Lindsay Phillips', ref: 'AAE-Q1', service: 'Office Assembly', quote_subtotal_cents: 40000, quote_tax_cents: 3300, quote_amount_cents: 43300 };
  const withCard = buildApprovalPage({ booking, token: 't', publishableKey: 'pk_test_x', needsCard: true });
  const saved = buildApprovalPage({ booking, token: 't', publishableKey: 'pk_test_x', needsCard: false });
  assert.match(withCard, /<div id="card"/, 'a card field when no card is saved');
  assert.match(withCard, /id="approve" disabled/, 'approve waits for a complete card');
  assert.match(withCard, /confirmCardPayment\(d\.clientSecret,\{payment_method:\{card\}\}\)/);
  assert.doesNotMatch(saved, /<div id="card"/, 'a saved card is not asked for again');
  for (const page of [withCard, saved]) {
    new Function(page.match(/<script>([\s\S]*)<\/script>/)[1]);
    assert.match(page, /Approve quote and hold \$433\.00/);
    assert.doesNotMatch(page.replace(/<script[\s\S]*<\/script>/g, ''), /\bauthori[sz]ed?\b|\bcaptured?\b/i, 'no payment jargon in front of the customer');
  }
}
console.log('PASS approval: price first, then the card; same hold, finalize saves the card');

// ── The lead: saved when the quote step opens, alerted if never sent ───────
{
  const writes = [];
  const fakeSb = (open = []) => ({ from: (t) => {
    const q = { _t: t, select: () => q, eq: () => q, gte: () => q, limit: async () => ({ data: open }), insert: async (row) => { writes.push(['insert', t, row]); return {}; }, update: (row) => ({ eq: async () => { writes.push(['update', t, row]); return {}; } }) };
    return q;
  } });
  const res = () => { const r = { code: 0, body: null }; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
  const req = (body) => ({ method: 'POST', headers: { 'x-forwarded-for': '1.2.3.4' }, body });
  const good = { name: 'Lindsay Phillips', email: 'Lindsay@Example.com', phone: '(512) 555-0100', zip: '78701', city: 'Austin', services: ['Office Assembly'], details: 'Six desks', formStartedAt: Date.now() - 120000 };
  let r = res(); await createQuoteLeadHandler({ getSb: () => fakeSb(), limit: async () => true })(req(good), r);
  assert.equal(r.code, 200);
  assert.equal(writes.length, 1);
  assert.equal(writes[0][1], 'market_requests');
  assert.equal(writes[0][2].source, QUOTE_LEAD_SOURCE);
  assert.equal(writes[0][2].market_type, 'active', 'allowed by the table constraint');
  assert.equal(writes[0][2].status, 'new', 'allowed by the table constraint');
  assert.equal(writes[0][2].customer_email, 'lindsay@example.com');
  writes.length = 0;
  r = res(); await createQuoteLeadHandler({ getSb: () => fakeSb([{ id: 9 }]), limit: async () => true })(req(good), r);
  assert.deepEqual(writes.map((w) => w[0]), ['update'], 'the same person the same day updates one lead');
  writes.length = 0;
  for (const bad of [{ ...good, company: 'bot' }, { ...good, formStartedAt: Date.now() - 1000 }, { ...good, email: 'nope' }, { ...good, zip: '' }]) {
    r = res(); await createQuoteLeadHandler({ getSb: () => fakeSb(), limit: async () => true })(req(bad), r);
    assert.equal(r.code, 200, 'never an error to the page');
  }
  r = res(); await createQuoteLeadHandler({ getSb: () => fakeSb(), limit: async () => false })(req(good), r);
  assert.equal(writes.length, 0, 'bots, bad input and rate limits store nothing');
  assert.equal(normalizeQuoteLead({ phone: '512-555-0100' }).phone !== undefined, true);

  // Daily alert: leads older than two hours, once each, recorded after the email.
  const leadRows = [{ id: 1, customer_name: 'Lindsay Phillips', customer_email: 'l@example.com', requested_service: 'Office Assembly', details: 'Six desks', city: 'Austin', zip_code: '78701' }, { id: 2, customer_name: 'Told Before', customer_email: 't@example.com' }];
  const alertSb = { from: (t) => {
    const q = { select: () => q, eq: () => q, lt: () => q, order: () => q, in: async () => ({ data: [{ reason_detail: '2' }] }), limit: async () => ({ data: leadRows, error: null }) };
    return q;
  } };
  const sent = []; const recorded = [];
  process.env.CRON_SECRET = 'cron';
  r = res();
  await createQuoteLeadAlert({ getSb: () => alertSb, send: async (m) => { sent.push(m); return { ok: true }; }, log: async () => {}, record: async (sb, rows) => { recorded.push(...rows); return { ok: true }; } })({ headers: { authorization: 'Bearer cron' } }, r);
  assert.equal(r.body.alerted, 1, 'only the lead not already alerted');
  assert.match(sent[0].subject, /1 quote started and not sent/);
  assert.match(sent[0].html, /Lindsay Phillips/);
  assert.equal(recorded[0].reason_detail, '1');
  assert.equal(recorded[0].method, 'CRON', 'rows carry the fields operational_events requires');
  recorded.length = 0;
  await createQuoteLeadAlert({ getSb: () => alertSb, send: async () => ({ ok: false }), log: async () => {}, record: async (sb, rows) => { recorded.push(...rows); return { ok: true }; } })({ headers: { authorization: 'Bearer cron' } }, res());
  assert.equal(recorded.length, 0, 'a failed email is not marked as told, so it is retried tomorrow');
  assert.match(buildQuoteLeadEmail([leadRows[0]]), /Reply with a price or a question/);
  assert.match(read('vercel.json'), /"path": "\/api\/cron\/quote-lead-alert",\s*"schedule": "30 12 \* \* \*"/);
}
console.log('PASS leads: saved on the quote step, one per person per day, alerted once after two hours');
