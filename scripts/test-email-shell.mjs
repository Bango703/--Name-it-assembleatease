import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildStatusEmail, ensureEmailShell, isFullEmailDocument, htmlToText, derivePreheader } from '../api/_email.js';

const read = rel => readFile(new URL(`../${rel}`, import.meta.url), 'utf8');

// Every email leaves the platform inside the same frame. 33 sender files were
// passing bare <p> fragments straight to Resend — no logo, no footer, no opt-out
// line — because sendEmail forwarded `html` untouched. The pro who got
// "Job confirmed — AAE-DVSNHXE4OO" received two naked paragraphs.
const fragment = '<p>Your job <strong>AAE-TEST</strong> is <strong>confirmed</strong>.</p>';

// ── A fragment is framed, and keeps every word it was given ────────────────
const wrapped = ensureEmailShell(fragment, 'easer');
assert.ok(wrapped.startsWith('<!DOCTYPE'), 'a fragment must come back as a full document');
assert.ok(wrapped.includes(fragment), 'wrapping must never alter the caller\'s content');
assert.match(wrapped, /alt="AssembleAtEase"/, 'the framed email carries the logo');
assert.match(wrapped, />AssembleAtEase</, 'the wordmark is text, so a blocked image cannot erase the brand');
assert.match(wrapped, /assembleatease\.com/, 'the framed email carries the footer');

// ── A caller that built its own document is left alone ─────────────────────
const fullDoc = buildStatusEmail({
  customerName: 'Mary', ref: 'AAE-TEST', status: 'Confirmed',
  statusColor: '#166534', statusBg: '#dcfce7',
  headline: 'Your booking is confirmed', bodyHtml: '<p>Body</p>',
});
assert.ok(isFullEmailDocument(fullDoc), 'buildStatusEmail returns a full document');
assert.equal(ensureEmailShell(fullDoc, 'customer'), fullDoc,
  'an email that already has a shell must pass through byte-for-byte');

// ── A bespoke full document still owes the reader a footer ────────────────
// Six hand-rolled customer/Easer emails shipped with no phone number, no
// contact address and no opt-out, because pass-through passed the footer
// through too. Their layout is theirs; the footer is the house's.
const bespoke = '<!DOCTYPE html><html><head></head><body><div>Your code is 123456.</div></body></html>';
const framed = ensureEmailShell(bespoke, 'customer');
assert.match(framed, /232-5139/, 'an external full document must still carry the contact footer');
assert.ok(framed.indexOf('232-5139') < framed.lastIndexOf('</body>'),
  'the footer belongs inside the document, not trailing after </body>');
assert.equal(ensureEmailShell(bespoke, 'owner'), bespoke,
  'the owner keeps byte-for-byte pass-through; these are operator alerts');
assert.match(framed, /opt out/, 'and the opt-out line travels with it');

// ── The opt-out line goes to people who can actually opt out ───────────────
assert.match(ensureEmailShell(fragment, 'customer'), /opt out/,
  'customers must be told how to opt out of non-essential email');
assert.doesNotMatch(ensureEmailShell(fragment, 'owner'), /opt out/,
  'the owner cannot unsubscribe from his own operational alerts — do not offer it');

// ── sendEmail is the enforcement point, not each caller ────────────────────
const emailSrc = await read('api/_email.js');
// Assert the behaviour, not the identifier. Pinning the exact variable name
// broke this test the moment a CAN-SPAM footer had to be appended before
// framing, which was a correct change failing on a cosmetic assertion.
assert.match(emailSrc, /html: ensureEmailShell\(\w+, recipientType, meta\.preheader\)/,
  'sendEmail must frame the html it sends — per-caller discipline is what failed');
assert.match(emailSrc, /text: htmlToText\(\w+\)/,
  'every email needs a text/plain alternative; HTML-only mail scores worse and reads badly on watches and screen readers');

// ── The inbox preview line ─────────────────────────────────────────────────
// Without a preheader, Gmail previews whatever text comes first — which, now
// that every email carries a logo, is the logo's alt text.
assert.match(wrapped, /display:none;max-height:0/, 'the framed email carries a hidden preheader');
assert.ok(wrapped.indexOf('Your job') < wrapped.indexOf('alt="AssembleAtEase"'),
  'the preview line must come before the logo, or the client previews the alt text instead');
assert.equal(derivePreheader('<p>First line here.</p><p>Second line.</p>'), 'First line here.',
  'the preview line is the first real sentence of the email');
assert.ok(derivePreheader('<p>' + 'x'.repeat(400) + '</p>').length <= 140,
  'the preview line must stay short enough for the inbox to show it');
assert.equal(ensureEmailShell(fragment, 'easer', '').includes('display:none;max-height:0'), false,
  'an explicit empty preheader means the caller wants none');

// ── The text alternative carries the same facts ────────────────────────────
const text = htmlToText('<p>Job <strong>AAE-1</strong> is confirmed.</p><p><a href="https://example.com/x">Open My Assignments</a></p>');
assert.match(text, /Job AAE-1 is confirmed\./, 'the text part keeps the sentence');
assert.match(text, /Open My Assignments \(https:\/\/example\.com\/x\)/,
  'a link must survive as label plus URL — a text reader cannot click markup');
assert.doesNotMatch(text, /<[a-z]/i, 'no markup may leak into the text part');
assert.equal(htmlToText('<style>p{color:red}</style><p>Body &amp; more</p>'), 'Body & more',
  'style blocks are dropped and entities are decoded');

// ── One frame, not two copies of it ────────────────────────────────────────
// buildStatusEmail and the fragment shell must share a header and footer, or
// they drift and the same company sends two different-looking emails.
assert.equal(emailSrc.match(/Professional Assembly &amp; Handyman Services/g).length, 1,
  'the footer must be defined once and reused, never duplicated per template');
assert.equal(emailSrc.match(/width="44" height="44"/g).length, 1,
  'the header must be defined once and reused, never duplicated per template');

console.log('email shell tests: PASS');
