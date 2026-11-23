#!/usr/bin/env node
// Owner decline reasons (owner, 2026-11-23): "when we decline a quote it doesnt
// give us a option to why and based on why it will give a different email
// response. like for example the quote with jeff. he said he found someone else."
// Then, the same day: "it dont look simple right" — ten reasons in a dropdown
// became six rows to tap.
//
// Every decline used to send "We're sorry. We can't take this one." Locks:
//   1. the owner must choose a reason, and the dashboard list is the server list;
//   2. each reason sends its own email, and duplicate / test sends none;
//   3. a customer who hired someone else is thanked, not apologised to;
//   4. no email carries internal language, and the owner's note is escaped.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { OWNER_DECLINE_REASONS, ownerDeclineReason, declineReasonText, declineEmail } from '../api/booking/_decline-reasons.js';
import { findCustomerLanguageViolations, findJustifyingCopy } from '../api/_customer-language.js';

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const unescape = (t) => t.replace(/&#39;/g, "'").replace(/&amp;/g, '&');

// ── 1. The dashboard list is the server list ───────────────────────────────
{
  assert.ok(Object.keys(OWNER_DECLINE_REASONS).length <= 6, 'six reasons at most: the owner asked for simple');
  const dash = read('owner/index.html');
  const start = dash.indexOf('<div id="decline-reason"');
  assert.ok(start > 0, 'the decline box has a reason list');
  const list = dash.slice(start, dash.indexOf('</div>', start));
  const rows = [...list.matchAll(/<label class="decline-option"><input type="radio" name="decline-reason" value="([a-z_]+)" data-sends="([a-z]+)"> ([^<]+?)(?: <span class="decline-no-email">No email<\/span>)?<\/label>/g)]
    .map(([row, value, sends, label]) => ({ value, sends, label: unescape(label), tagged: row.includes('decline-no-email') }));
  assert.deepEqual(rows.map(o => o.value), Object.keys(OWNER_DECLINE_REASONS), 'one row per server reason, in the same order, no extras');
  for (const o of rows) {
    const r = OWNER_DECLINE_REASONS[o.value];
    assert.equal(o.label, r.label, `${o.value}: the dashboard label is the saved label`);
    assert.equal(o.sends, r.email ? 'email' : 'none', `${o.value}: the dashboard knows whether an email is sent`);
    assert.equal(o.tagged, !r.email, `${o.value}: only a reason that sends nothing is marked "No email"`);
  }
  assert.doesNotMatch(list, /checked/, 'no reason is preselected');
  assert.doesNotMatch(dash, /<select id="decline-reason"|decline-reason-hint/, 'the dropdown and hint line are gone');

  // The box resets, a choice is required, the code is posted, and a reason
  // that sends nothing takes no note.
  assert.match(dash, /declineReasonList\.querySelectorAll\('input\[name="decline-reason"\]'\)\.forEach\(function\(input\)\{ input\.checked = false; \}\);/);
  assert.match(dash, /if \(!declinePicked\) \{ toast\('Choose why this request is being declined', 'error'\); return; \}/);
  assert.match(dash, /actionBody\.reasonCode = declinePicked\.value;/);
  assert.match(dash, /if \(reason && !declineSendsNoEmail\) actionBody\.note = reason;/);
  assert.match(dash, /\$reasonText\.style\.display = noEmail \? 'none' : '';/);
  assert.match(dash, /'Request declined\. No email was sent\.'/);
  assert.match(dash, /textContent = 'Why are you declining\?';/);
}
console.log('PASS dashboard: six rows, a required choice, the same list as the server');

// ── 2. The server refuses a decline without a reason ───────────────────────
{
  const src = read('api/booking/decline.js');
  const refuse = src.indexOf("code: 'DECLINE_REASON_REQUIRED'");
  assert.ok(refuse > 0 && refuse < src.indexOf('getSupabase()'), 'no reason: refused before anything is read or written');
  assert.match(src, /decline_reason: reason \|\| null/);
  assert.match(src, /const reason = declineReasonText\(reasonCode, note\);/);
  assert.match(src, /const email = declineEmail\(\{/);
  assert.match(src, /if \(email\) \{/, 'a reason without an email sends nothing');
  assert.match(src, /notificationDelivered = sent\?\.ok === true;/, 'delivery is reported from the send result');
  assert.match(src, /notificationDelivered: email \? notificationDelivered : null/);
  assert.match(src, /isQuote: isOpenCustomQuote\(booking\)/, 'a sent quote is still called a quote');

  process.env.OWNER_PASSWORD = 'decline-test';
  delete process.env.VERCEL_ENV;
  const { default: handler } = await import('../api/booking/decline.js');
  const call = async (body) => {
    let status = 0; let payload = null;
    const res = { status(code) { status = code; return this; }, json(data) { payload = data; return this; } };
    await handler({ method: 'POST', headers: { 'x-owner-password': 'decline-test' }, body, socket: {} }, res);
    return { status, payload };
  };
  let r = await call({ bookingId: 'b1' });
  assert.equal(r.status, 400);
  assert.equal(r.payload.code, 'DECLINE_REASON_REQUIRED');
  r = await call({ bookingId: 'b1', reasonCode: 'made_up' });
  assert.equal(r.payload.code, 'DECLINE_REASON_REQUIRED', 'an unknown reason is no reason');
}
console.log('PASS server: no reason or an unknown reason is refused');

// ── 3. Each reason sends its own email ──────────────────────────────────────
const base = { firstName: 'Jeff', service: 'Outdoor & Playsets', ref: 'AAE-9BOAMQQDNS', isQuote: true, hasCard: false };
const mail = (code, extra = {}) => declineEmail({ ...base, code, ...extra });
const all = (e) => `${e.subject}\n${e.headline}\n${e.bodyHtml}`;

{
  // Jeff: he hired someone else. Thanked, not apologised to, nothing about a card.
  const e = mail('hired_someone');
  assert.equal(e.subject, 'Your quote request is closed — AAE-9BOAMQQDNS');
  assert.equal(e.headline, 'Thanks for letting us know, Jeff.');
  assert.equal(e.status, 'CLOSED');
  assert.match(e.bodyHtml, /We've closed your quote request for <strong>Outdoor &amp; Playsets<\/strong>\./);
  assert.match(e.bodyHtml, />Book a service<\/a>/);
  assert.doesNotMatch(all(e), /sorry|can't take|unable/i, 'the customer chose someone else; we did not fail them');
  assert.doesNotMatch(e.bodyHtml, /card/i, 'a quote sent without a card says nothing about one');
  assert.match(mail('hired_someone', { hasCard: true }).bodyHtml, /Nothing was charged to your card\./);
  assert.match(mail('hired_someone', { isQuote: false }).subject, /^Your booking request is closed — /);
  assert.deepEqual(mail('not_needed'), e, 'no longer needed reads the same');
}
{
  const e = mail('price');
  assert.equal(e.headline, 'Thanks for letting us know, Jeff.');
  assert.match(e.bodyHtml, /reply to this email and we'll send a new quote/);
  assert.doesNotMatch(all(e), /sorry/i);
}
{
  const e = mail('no_response');
  assert.equal(e.headline, "We've closed your quote request, Jeff.");
  assert.match(e.bodyHtml, /reply to this email and we'll pick it back up/);
  assert.doesNotMatch(all(e), /didn't hear|did not respond|didn't respond|no response/i, 'states the outcome, not a complaint');
}
{
  // We cannot take it: the owner-approved copy of 2026-10-23, unchanged.
  const e = mail('cant_do');
  assert.equal(e.headline, "We're sorry, Jeff. We can't take this one.");
  assert.equal(e.subject, 'Your Quote Request — AAE-9BOAMQQDNS');
  assert.equal(e.status, 'UNABLE TO FULFIL');
  assert.match(e.bodyHtml, /Thank you for your understanding\./);
  assert.match(e.bodyHtml, />Book again<\/a>/);
  assert.doesNotMatch(e.bodyHtml, /Reason/, 'no reason box when the owner wrote nothing');
  const noted = mail('cant_do', { note: 'We are fully booked that week. <script>x</script>' });
  assert.match(noted.bodyHtml, />Reason<\/p>/, "the owner's note is the reason");
  assert.match(noted.bodyHtml, /We are fully booked that week\. &lt;script&gt;x&lt;\/script&gt;/, 'the note is escaped');
}
{
  const noted = mail('hired_someone', { note: 'Good luck with the playset.' });
  assert.match(noted.bodyHtml, /A note from our team/);
  assert.match(noted.bodyHtml, /Good luck with the playset\./);
  assert.equal(mail('duplicate'), null, 'a duplicate or test request sends nothing');
  assert.equal(mail('nope'), null);
  assert.equal(declineReasonText('hired_someone', ''), 'Customer found someone else');
  assert.equal(declineReasonText('hired_someone', ' Told us by text. '), 'Customer found someone else — Told us by text.');
  assert.equal(declineReasonText('nope', 'x'), null);
  assert.equal(ownerDeclineReason('__proto__'), null, 'only own keys are reasons');
}
console.log('PASS emails: one per reason, Jeff is thanked, duplicate or test sends nothing');

// ── 4. No email carries internal language ─────────────────────────────────
for (const code of Object.keys(OWNER_DECLINE_REASONS)) {
  for (const isQuote of [true, false]) {
    for (const hasCard of [true, false]) {
      for (const note of ['', 'We are fully booked that week.']) {
        const e = mail(code, { isQuote, hasCard, note });
        if (!e) continue;
        const text = all(e);
        assert.deepEqual(findCustomerLanguageViolations(text), [], `${code}: no internal terms`);
        assert.deepEqual(findJustifyingCopy(text), [], `${code}: no justifying copy`);
        assert.doesNotMatch(text, /\b(declined?|status|pending|stripe|authori[sz])/i, `${code}: no workflow words`);
      }
    }
  }
}
console.log('PASS language: every decline email passes the customer-language rules');

console.log('\nOwner decline reason tests passed.');
