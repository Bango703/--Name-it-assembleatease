#!/usr/bin/env node
// A customer can answer a quote three ways (owner, 2026-10-29): approve with a
// card hold, ask for a change, or decline with a reason. Before this the page
// had only Approve; a customer who did not want the quote left, it expired in
// 7 days, and the owner never learned why.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { buildApprovalPage, QUOTE_DECLINE_REASONS } from '../api/owner/quote-approve.js';

const read = rel => readFile(new URL(`../${rel}`, import.meta.url), 'utf8').then(s => s.replace(/\r\n/g, '\n'));

// ── The page offers all three ───────────────────────────────────────────────
{
  const booking = { ref: 'AAE-SM4SLTAPFA', service: 'Smart Home', customer_name: 'Tyler Finn', date: '2026-11-02', time: '2:00 PM – 4:00 PM', quote_amount_cents: 65000, quote_subtotal_cents: 60046, quote_tax_cents: 4954 };
  const page = buildApprovalPage({ booking, token: 't0k', publishableKey: 'pk_test' });
  assert.match(page, /id="approve"[^>]*>Approve quote and hold \$650\.00</, 'Approve stays the main action');
  assert.match(page, /id="show-change">Request a change</);
  assert.match(page, /id="show-decline">Decline this quote</);
  for (const [key, label] of Object.entries(QUOTE_DECLINE_REASONS)) {
    assert.ok(page.includes(`value="${key}"> ${label}</label>`), `decline reason offered: ${label}`);
  }
  assert.deepEqual(Object.keys(QUOTE_DECLINE_REASONS), ['price', 'timing', 'hired_someone', 'not_needed', 'other']);
  const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  assert.equal(scripts.length, 1, 'one inline script: scripts/test-quote-no-card.mjs runs it whole');
  new vm.Script(scripts[0]); // parses
  assert.match(scripts[0], /action:'request_change',note/);
  assert.match(scripts[0], /action:'decline',reason:picked\.value,note:/);
  assert.match(scripts[0], /Nothing was charged\./);
  console.log('PASS quote page: approve, request a change, decline with five reasons');
}

// ── The server: one handler, safe states, the reason saved and sent ─────────
{
  const src = await read('api/owner/quote-approve.js');
  assert.match(src, /if \(req\.body\?\.token && \['decline', 'request_change'\]\.includes\(req\.body\?\.action\)\) return respondToQuote\(req, res\);/,
    'answers are routed before the approve flow');
  const fn = src.slice(src.indexOf('async function respondToQuote'), src.indexOf('async function prepareQuote'));
  assert.match(fn, /rateLimit\(ip, 'booking'\)/);
  assert.match(fn, /\['quote_pending_approval', 'quote_authorization_pending'\]\.includes/, 'only an open quote can be answered');
  assert.match(fn, /if \(booking\.stripe_payment_intent_id\) \{\n\s+return res\.status\(409\)/, 'a started card approval is never declined from the page');
  assert.match(fn, /decline_reason: `Customer declined the quote: \$\{said\}`/, 'the reason is saved on the booking');
  assert.match(fn, /quote_token_hash: null,/, 'the link stops working');
  assert.match(fn, /\.eq\('quote_token_hash', tokenHash\)\n\s+\.is\('stripe_payment_intent_id', null\)/, 'compare-and-set on the exact quote');
  assert.match(fn, /eventType: 'quote_declined'/);
  assert.match(fn, /subject: `Quote declined \(\$\{reasonLabel\}\) — \$\{booking\.ref\}`/, 'the owner is emailed the reason');
  assert.match(fn, /from\('messages'\)\.insert\(\{[\s\S]{0,200}sender: 'customer',[\s\S]{0,120}recipient_type: 'owner',/, 'a change request lands in the owner inbox');
  assert.match(fn, /eventType: 'quote_change_requested'/);
  assert.match(fn, /subject: `Quote change requested — \$\{booking\.ref\}`/);
  assert.doesNotMatch(fn, /status: 'declined'[\s\S]{0,40}request_change/, 'a change request never closes the quote');
  console.log('PASS server: open quotes only, card holds untouched, reason saved, owner told');
}

// ── The owner sees the reason ───────────────────────────────────────────────
{
  const dash = await read('owner/index.html');
  const helperSrc = dash.slice(dash.indexOf('function customerQuoteDecline(b) {'), dash.indexOf('function quoteLane(b) {'));
  const ctx = {};
  vm.runInNewContext(`${helperSrc}; this.f = customerQuoteDecline;`, ctx);
  assert.deepEqual({ ...ctx.f({ status: 'declined', decline_reason: 'Customer declined the quote: Price is too high — found $450 elsewhere' }) },
    { reason: 'Price is too high', note: 'found $450 elsewhere' });
  assert.deepEqual({ ...ctx.f({ status: 'declined', decline_reason: 'Customer declined the quote: The time does not work' }) }, { reason: 'The time does not work', note: '' });
  assert.equal(ctx.f({ status: 'declined', decline_reason: 'Quote expired without customer approval' }), null, 'an expired quote is not a customer decline');
  assert.match(dash, /'<span class="c-flag-bad">Declined: ' \+ esc\(customerQuoteDecline\(b\)\.reason\)/, 'the card shows the reason');
  assert.match(dash, /label = customerQuoteDecline\(b\) \? 'Quote declined' : 'Declined'/);
  assert.match(dash, /field\('Decline Reason', esc\(b\.decline_reason\)/, 'the detail shows the full reason and note');
  console.log('PASS dashboard: card, badge and detail show the decline reason');
}

console.log('\nQuote decline and change request tests passed.');
