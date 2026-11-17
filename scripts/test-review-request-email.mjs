#!/usr/bin/env node
// The review request email: how it looks and what each tap does.
//
// WHAT WAS WRONG (owner, 2026-11-17, "why does my review email look like this").
// From Oct 23 the request was a hand-built bare page: no logo header, no card,
// two inline text links in a paragraph, and the house footer stapled under it
// with a line calling the email "transactional" right beside its marketing
// Unsubscribe block. Every other AssembleAtEase email had the shared frame; this
// one looked like it came from somewhere else. Separately, the automatic sender
// never selected customer_name, so every automatic request would have opened
// "Hi there" and used the impersonal subject.
//
// What it is now: a fragment inside the shared frame, the job named (service,
// day, pro), one question, and five tappable stars that open /review with that
// rating chosen. See docs/incidents/2026-11-17-review-email-look.md.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

process.env.UNSUBSCRIBE_SECRET = process.env.UNSUBSCRIBE_SECRET || 'test-secret-for-review-email';
const { buildReviewEmail, ratingUrl, finishedOn, GOOGLE_REVIEW_URL } = await import('../api/_review-email.js');
const { ensureEmailShell } = await import('../api/_email.js');
const { broadcastFooter } = await import('../api/_broadcast.js');

const read = rel => readFile(new URL(`../${rel}`, import.meta.url), 'utf8').then(s => s.replace(/\r\n/g, '\n'));
const count = (s, re) => (s.match(re) || []).length;

const booking = {
  id: 'b1', ref: 'AAE-TEST1', service: 'Mounting & Hanging', customer_name: 'pamela smith',
  customer_email: 'customer@example.com', completed_at: '2026-11-11T20:30:00Z',
};
const url = 'https://www.assembleatease.com/review?ref=AAE-TEST1&email=customer%40example.com&token=t';

// ── 1. The first request names the job and asks one question ───────────────
{
  const { subject, html, preheader } = buildReviewEmail(1, booking, url, { proFirst: 'Phil' });
  assert.equal(subject, 'How did it go, Pamela?');
  assert.equal(preheader, 'Tap a star to rate your Mounting & Hanging job.');
  assert.doesNotMatch(html, /<!DOCTYPE|<html|<body/i, 'a fragment, so sendEmail gives it the shared frame');
  assert.match(html, /Mounting &amp; Hanging &middot; Wed, Nov 11/, 'the service and the day it was finished');
  assert.match(html, />How did Phil do\?</);
  assert.match(html, /Hi Pamela, thanks for booking with AssembleAtEase\. Tap a star to rate the job\./);
  console.log('PASS the request names the job, the day and the pro');
}

// ── 2. Each star opens /review with that rating chosen ─────────────────────
{
  const { html } = buildReviewEmail(1, booking, url, { proFirst: 'Phil' });
  for (let n = 1; n <= 5; n += 1) {
    assert.equal(count(html, new RegExp(`href="${ratingUrl(url, n).replace(/[.?*+^$()[\]{}|\\]/g, '\\$&')}"`, 'g')), 1,
      `exactly one link for ${n} star(s)`);
  }
  assert.equal(count(html, /&#9733;/g), 5, 'five stars');
  assert.match(html, />Poor</);
  assert.match(html, />Excellent</);
  assert.equal(ratingUrl('https://x.test/review', 4), 'https://x.test/review?rating=4');
  assert.equal(ratingUrl('https://x.test/review?ref=A', 4), 'https://x.test/review?ref=A&rating=4');
  // The stars only work because the page reads ?rating= and selects it.
  const page = await read('review.html');
  assert.match(page, /parseInt\(p\.get\('rating'\), 10\)/, 'review.html reads the rating from the link');
  assert.match(page, /if \(ratingParam >= 1 && ratingParam <= 5\) selectRating\(ratingParam\)/,
    'review.html selects the tapped rating');
  console.log('PASS every star opens the review page with its rating chosen');
}

// ── 3. Same offer to everyone, nothing that reads like an advert ───────────
{
  const { html } = buildReviewEmail(1, booking, url, { proFirst: 'Phil' });
  assert.match(html, new RegExp(`href="${GOOGLE_REVIEW_URL.replace(/[.?/]/g, '\\$&')}"[^>]*>Review us on Google`),
    'Google is offered to every customer, before any rating');
  assert.match(html, /href="[^"]+"[^>]*>Open the review page</);
  assert.doesNotMatch(html, /<img|\$10|discount|thank-you offer|% off/i, 'no photo and no offer in the email');
  assert.match(html, /If anything is not right, reply to this email and we will take care of it\./);
  assert.match(html, /Did your pro offer to work with you directly, outside AssembleAtEase\? Reply to this email and tell us\./);
  assert.match(html, /The AssembleAtEase Team/);
  console.log('PASS Google offered to everyone; no photo, no offer; both reply lines kept');
}

// ── 4. Fallbacks: no pro name, no customer name, no completion time ─────────
{
  const bare = { ...booking, customer_name: '', completed_at: null };
  const { subject, html } = buildReviewEmail(1, bare, url, {});
  assert.equal(subject, 'How did your Mounting & Hanging go?');
  assert.match(html, />How did it go\?</);
  assert.match(html, /Hi there, thanks for booking/);
  assert.match(html, /Mounting &amp; Hanging<\/p>/, 'no dangling separator without a date');
  assert.equal(finishedOn({ completed_at: 'not a date' }), '');
  const second = buildReviewEmail(2, booking, url, { proFirst: 'Phil' });
  assert.equal(second.subject, 'Quick follow-up on your Mounting & Hanging job');
  assert.match(second.html, /Hi Pamela, following up once on your Mounting &amp; Hanging job\. Tap a star to rate it\./);
  assert.match(second.html, /rating=5/);
  console.log('PASS fallbacks read naturally and the follow-up keeps the stars');
}

// ── 5. Framed like every other email, with one opt-out ─────────────────────
{
  const { html, preheader } = buildReviewEmail(1, booking, url, { proFirst: 'Phil' });
  const sent = ensureEmailShell(`${html}${broadcastFooter(booking.customer_email)}`, 'customer', preheader);
  assert.match(sent, /<img src="https:\/\/www\.assembleatease\.com\/images\/logo\.jpg" alt="AssembleAtEase" width="44"/,
    'the shared logo header');
  assert.equal(count(sent, /\/api\/unsubscribe\?e=/g), 1, 'one unsubscribe link');
  assert.doesNotMatch(sent, /This is a transactional email/,
    'a marketing email is not also called transactional under its own Unsubscribe');
  assert.equal(count(sent, /Serving customers across Texas/g), 1, 'the service area once, in the footer');
  assert.match(sent, /Tap a star to rate your Mounting &amp; Hanging job\./, 'the inbox preview line');
  // Booking mail without its own Unsubscribe still gets the footer opt-out line.
  assert.match(ensureEmailShell('<p>Your booking is confirmed.</p>', 'customer'), /This is a transactional email/);
  console.log('PASS framed by the shared shell with exactly one opt-out');
}

// ── 6. Both senders use it the same way ────────────────────────────────────
{
  const cron = await read('api/cron/review-request.js');
  const manual = await read('api/review-request.js');
  const cols = cron.match(/const COLS_BASE = '([^']+)'/);
  assert.ok(cols, 'the cron declares the columns it reads');
  for (const column of ['customer_name', 'service', 'completed_at', 'assembler_name', 'customer_email']) {
    assert.ok(cols[1].split(',').map(s => s.trim()).includes(column),
      `the automatic sender must select ${column}; without customer_name every request opened "Hi there"`);
  }
  assert.doesNotMatch(cron, /html\.replace\('<\/body>'/, 'a fragment has no </body>; appending is the only safe join');
  assert.match(cron, /html: `\$\{html\}\$\{broadcastFooter\(b\.customer_email\)\}`/);
  for (const [name, src] of [['cron', cron], ['manual', manual]]) {
    assert.match(src, /const \{ subject, html, preheader \} = buildReviewEmail\(/, `${name} takes the preheader`);
    assert.match(src, /\n\s+preheader,\n/, `${name} passes the preheader to sendEmail`);
  }
  console.log('PASS the automatic and manual senders read the name and pass the preview line');
}

console.log('Review request email checks passed.');
