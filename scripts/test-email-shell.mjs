import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildStatusEmail, ensureEmailShell, isFullEmailDocument } from '../api/_email.js';

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

// ── The opt-out line goes to people who can actually opt out ───────────────
assert.match(ensureEmailShell(fragment, 'customer'), /opt out/,
  'customers must be told how to opt out of non-essential email');
assert.doesNotMatch(ensureEmailShell(fragment, 'owner'), /opt out/,
  'the owner cannot unsubscribe from his own operational alerts — do not offer it');

// ── sendEmail is the enforcement point, not each caller ────────────────────
const emailSrc = await read('api/_email.js');
assert.match(emailSrc, /html: ensureEmailShell\(html, recipientType\)/,
  'sendEmail must frame the html it sends — per-caller discipline is what failed');

// ── One frame, not two copies of it ────────────────────────────────────────
// buildStatusEmail and the fragment shell must share a header and footer, or
// they drift and the same company sends two different-looking emails.
assert.equal(emailSrc.match(/Professional Assembly &amp; Handyman Services/g).length, 1,
  'the footer must be defined once and reused, never duplicated per template');
assert.equal(emailSrc.match(/width="44" height="44"/g).length, 1,
  'the header must be defined once and reused, never duplicated per template');

console.log('email shell tests: PASS');
