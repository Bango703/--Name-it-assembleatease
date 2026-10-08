#!/usr/bin/env node
// Customer reviews shared to the business's Facebook and Google Business pages.
//
// A review can only be posted to Google or Facebook by the customer's own
// account (and the FTC reviews rule forbids posting one for them). So the
// review page copies the text for the customer to paste, and, only with the
// customer's opt-in, the business queues the review as its own post in Buffer.
// This holds the rules shut: no consent, no share; only clean 5-star text;
// first name and last initial only; never a private completion photo; a
// failed share never touches the saved review.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildReviewShare, reviewerDisplayName, serviceImageUrl, shareReviewToSocials } from '../api/_review-social.js';

const good = {
  consent: true,
  rating: 5,
  body: 'Showed up on time, built the whole bedroom set and cleaned up after.',
  customerName: 'maria  de la cruz',
  service: 'Furniture Assembly',
};

// Consent and rating gates
assert.equal(buildReviewShare({ ...good, consent: false }).reason, 'no_consent');
assert.equal(buildReviewShare({ ...good, consent: 'true' }).reason, 'no_consent', 'consent must be the boolean true, not a string');
assert.equal(buildReviewShare({ ...good, consent: undefined }).reason, 'no_consent');
assert.equal(buildReviewShare({ ...good, rating: 4 }).reason, 'not_five_star');
assert.equal(buildReviewShare({ ...good, body: 'Great!' }).reason, 'too_short');
assert.equal(buildReviewShare({ ...good, body: 'x'.repeat(601) }).reason, 'too_long');

// Nothing private or unsafe goes out
for (const body of [
  'Great job, call me at 512-555-0199 anytime you need a reference.',
  'Great job, email me at maria@example.com for a reference any time.',
  'Great job, see my photos at https://example.com/photos of the room.',
  'Great job on booking AAE-XK4P2Q9R, everything was assembled perfectly.',
]) assert.equal(buildReviewShare({ ...good, body }).reason, 'contains_contact_or_link', body);
assert.equal(buildReviewShare({ ...good, body: 'Holy shit they were fast and careful with everything.' }).reason, 'language');

// Name: first name and last initial only
assert.equal(reviewerDisplayName('maria  de la cruz'), 'Maria C.');
assert.equal(reviewerDisplayName('JOHN'), 'John');
assert.equal(reviewerDisplayName(''), 'A verified customer');

// The post
const post = buildReviewShare(good);
assert.equal(post.share, true);
assert.match(post.kit.facebook, /Maria C\., Furniture Assembly customer/);
assert.doesNotMatch(post.kit.facebook, /de la cruz/i, 'full last name must never be posted');
assert.match(post.kit.facebook, /https:\/\/www\.assembleatease\.com\/book/);
assert.match(post.kit.googleBusiness, /Showed up on time/);
assert.ok(post.imageUrl.startsWith('https://www.assembleatease.com/images/'), 'public service photo only');
assert.doesNotMatch(post.imageUrl, /completion|evidence|storage|supabase/i, 'job completion photos stay private');
assert.match(serviceImageUrl('TV Mounting'), /real-tv-mount-console/);
assert.match(serviceImageUrl('Smart Home Setup'), /doorbell/);

// Publishing: right channels, not labeled AI, failures contained
{
  let call;
  const result = await shareReviewToSocials(good, { publish: async (args) => { call = args; return { facebook: { status: 'queued' }, googleBusiness: { status: 'queued' } }; } });
  assert.equal(result.shared, true);
  assert.deepEqual(call.channels, ['facebook', 'googleBusiness']);
  assert.equal(call.aiAssisted, false, 'a customer review is not AI-written');
  assert.equal(call.source, 'assembleatease-customer-review');
}
{
  let called = false;
  const result = await shareReviewToSocials({ ...good, consent: false }, { publish: async () => { called = true; return {}; } });
  assert.equal(called, false, 'no consent means Buffer is never called');
  assert.equal(result.shared, false);
}
{
  const result = await shareReviewToSocials(good, { publish: async () => { throw new Error('Buffer down'); } });
  assert.equal(result.shared, false);
  assert.equal(result.reason, 'error');
}
{
  const result = await shareReviewToSocials(good, { publish: () => new Promise(() => {}), timeoutMs: 20 });
  assert.equal(result.reason, 'error', 'a hung Buffer call must not hold the review response');
}

// Wiring: consent is opt-in on the page, and the share runs only after the review saves
const api = readFileSync('api/review.js', 'utf8');
assert.match(api, /payload\.share_consent === true/);
assert.ok(api.indexOf('shareReviewToSocials({') > api.indexOf('insertReviewWithRetry(sb, reviewRow'), 'share must run after the review is saved');
assert.doesNotMatch(api.slice(api.indexOf('shareReviewToSocials({')), /return res\.status\(5\d\d\)[^\n]*share/, 'a share failure must not fail the review');
const page = readFileSync('review.html', 'utf8');
assert.match(page, /<input type="checkbox" id="r-share" style="[^"]*"\/>/, 'consent checkbox present and unchecked by default');
assert.doesNotMatch(page, /id="r-share"[^>]*checked/, 'consent must not be pre-checked');
assert.match(page, /share_consent: !!\(document\.getElementById\('r-share'\)/);
assert.match(page, /id="facebook-review-link" href="https:\/\/www\.facebook\.com\/61572042722009\/reviews"/);

console.log('PASS review social share: opt-in only, clean 5-star text, first name + initial, public photo, failures contained.');
