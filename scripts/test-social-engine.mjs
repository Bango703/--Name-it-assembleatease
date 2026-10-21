#!/usr/bin/env node
// Facebook engine (owner, 2026-10-21): one post a day, never the same article
// twice in 60 days, a weekly mix of real offers and services, and no post that
// claims something untrue. The bad captions below are real posts that went out.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.BUFFER_API_KEY = 'test-key';
process.env.BUFFER_FACEBOOK_CHANNEL_ID = 'facebook-test';
const originalFetch = globalThis.fetch;
globalThis.fetch = () => { throw new Error('test attempted a network request'); };

const { findClaimViolations, hasPostText } = await import('../api/_social-claims.js');
const campaigns = await import('../api/_social-campaigns.js');
const { publishContentKit } = await import('../api/_social-publisher.js');
const { postedWithinDailyCap, selectArticleForChannel } = await import('../api/_social-automation.js');

// ── Claims that went out, and must not again ────────────────────────────────
const shipped = {
  'job count': "A PAX wardrobe that goes together wrong can take hours to fix. We've assembled hundreds of these IKEA units the right way, the first time.",
  'security and wiring': 'Faulty wiring, incompatible devices, or a DIY install that needs redoing can cost way more. Our Austin team handles the full smart home installation process: security systems, smart locks, lighting, climate control.',
  'outdoor power': 'Between the right mount, weatherproof wiring, proper power setup, and professional installation, costs add up fast.',
  'electrical outdoor': 'Rushing into an outdoor TV project without understanding the full scope (foundation work, weatherproofing, electrical, mount type) is how budgets blow up.',
  'invented detail': 'Our Austin team handles bed frame assembly with the care it deserves: proper alignment, verified torque, clean finish.',
  'per item': 'In Austin, professional IKEA assembly starts at $69 per item, which beats the stress of stripped screws.',
  'scare': 'A cheap TV mount installation might save you 50 bucks today, but it can cost you thousands in wall repair, fire risk, or a TV crash.',
  'weather': "Austin's heat and humidity also affect how mounts age over time.",
  'insured': 'Professional Furniture Assembly, TV Mounting and Home Services in Austin, TX. Fast, reliable, and insured.',
  'handyman tag': 'Read the guide. #AustinHomes #FurnitureAssembly #LocalHandyman',
};
for (const [label, text] of Object.entries(shipped)) {
  assert.ok(findClaimViolations(text).length > 0, `blocked: ${label}`);
}
const fine = [
  'A TV wall mount that is done right stays put. We find the studs, set the height you choose and tidy the cords. Read the full guide: https://www.assembleatease.com/blog/tv-wall-mount-installation-cost-austin',
  'Wayfair furniture looks great in the photos until assembly day. Read what to check before you start: https://www.assembleatease.com/blog/wayfair-furniture-assembly-austin #FurnitureAssembly',
];
for (const text of fine) assert.deepEqual(findClaimViolations(text), [], text.slice(0, 40));
assert.equal(hasPostText(''), false);
assert.equal(hasPostText('https://www.assembleatease.com/blog/x #TVMounting'), false, 'a link and hashtags are not a post');
console.log('PASS claim guard: every false claim that shipped is blocked; honest posts pass');

// ── The guard runs where every post goes out ────────────────────────────────
{
  const blocked = await publishContentKit({ title: 'x', url: 'https://www.assembleatease.com/blog/ikea-pax-wardrobe-assembly', kit: { facebook: shipped['job count'] + ' Read more.' }, channels: ['facebook'], dryRun: true });
  assert.equal(blocked.facebook.status, 'blocked');
  assert.match(blocked.facebook.reason, /job, customer or unit count/);
  const empty = await publishContentKit({ title: 'x', url: 'https://www.assembleatease.com/blog/x', kit: { facebook: ' ' }, channels: ['facebook'], dryRun: true });
  assert.equal(empty.facebook.status, 'blocked', 'a post with no words is never sent');
  const ok = await publishContentKit({ title: 'x', url: 'https://www.assembleatease.com/blog/x', kit: { facebook: fine[0] }, channels: ['facebook'], dryRun: true });
  assert.equal(ok.facebook.status, 'dry_run');
}
console.log('PASS publishContentKit blocks a bad or empty post before Buffer');

// ── Campaign posts are built from what is true today ────────────────────────
const off = { promo_enabled: false, promo_code: 'WELCOME25', promo_label: '10% off your first booking', promo_discount_type: 'percent', promo_discount_pct: 0 };
const on = { promo_enabled: true, promo_code: 'WELCOME10', promo_title: 'New Customer Offer', promo_label: '10% off your first booking', promo_discount_type: 'percent', promo_discount_pct: 10, first_booking_only: true };
assert.equal(campaigns.offerPost({ promoSettings: off }), null, 'no offer post while the offer is switched off');
assert.equal(campaigns.offerPost({ promoSettings: null }), null, 'no offer post when settings cannot be read');
{
  const offer = campaigns.offerPost({ promoSettings: on });
  assert.match(offer.url, /\/book\?promo=WELCOME10&utm_source=facebook/, 'the link applies the code');
  assert.match(offer.text, /code WELCOME10/);
  assert.match(offer.text, /10% off your first booking/);
  assert.deepEqual(findClaimViolations(offer.text), []);
}
const offerDay = [...Array(7).keys()].map((i) => new Date(Date.UTC(2026, 9, 21 + i))).find((d) => campaigns.FACEBOOK_ROTATION[campaigns.dayNumber(d) % 7] === 'offer');
assert.equal(campaigns.facebookSlotKind({ now: offerDay, promoSettings: off }), 'service', 'an offer day with no offer becomes a service day');
assert.equal(campaigns.facebookSlotKind({ now: offerDay, promoSettings: on }), 'offer');
assert.equal(campaigns.FACEBOOK_ROTATION.filter((k) => k === 'blog').length, 3, 'blog tips are three days in seven');
{
  const seen = new Set();
  for (let i = 0; i < 14; i += 1) {
    const now = new Date(Date.UTC(2026, 9, 21 + i));
    const post = campaigns.servicePost({ now });
    assert.ok(post, `service post on day ${i}`);
    const service = decodeURIComponent(new URL(post.url).searchParams.get('service'));
    assert.match(post.text, new RegExp(`from \\$${campaigns.fromPrice(service)}\\.`), 'the price is the catalog starting price');
    assert.match(post.imageUrl, /\/images\/real-/, 'a real job photo');
    assert.deepEqual(findClaimViolations(post.text), [], post.text);
    assert.ok(hasPostText(post.text));
    seen.add(service);
  }
  assert.ok(seen.size >= 6, 'every service gets its turn within two weeks');
  const cash = campaigns.assembleCashPost();
  assert.match(cash.text, /5% back in AssembleCash/);
  assert.match(cash.text, /not cash/);
  assert.deepEqual(findClaimViolations(cash.text), []);
}
console.log('PASS campaign posts: real prices and photos, an offer only while it works, AssembleCash as credit');

// ── No repeats, one post a day ──────────────────────────────────────────────
{
  const now = Date.now();
  const inventory = ['a', 'b'].map((slug) => ({ slug, url: `https://www.assembleatease.com/blog/${slug}` }));
  const usage = { byChannel: new Map([['facebook', new Map([[inventory[0].url, now - 10 * 864e5]])]]), global: new Map() };
  assert.equal(selectArticleForChannel({ channel: { key: 'facebook' }, inventory, usage, reservedSlugs: new Set() }).slug, 'b');
  usage.byChannel.get('facebook').set(inventory[1].url, now - 20 * 864e5);
  assert.equal(selectArticleForChannel({ channel: { key: 'facebook' }, inventory, usage, reservedSlugs: new Set() }), null,
    'every article used inside 60 days: nothing, never the oldest again');
  usage.byChannel.get('facebook').set(inventory[1].url, now - 61 * 864e5);
  assert.equal(selectArticleForChannel({ channel: { key: 'facebook' }, inventory, usage, reservedSlugs: new Set() }).slug, 'b');

  assert.equal(postedWithinDailyCap({ dailyMax: 1, lastSentAt: new Date(now - 3 * 36e5).toISOString() }, now), true);
  assert.equal(postedWithinDailyCap({ dailyMax: 1, lastSentAt: new Date(now - 21 * 36e5).toISOString() }, now), false);
  assert.equal(postedWithinDailyCap({ dailyMax: 0, lastSentAt: new Date(now).toISOString() }, now), false, 'channels without a cap are unaffected');
}
console.log('PASS no article twice inside 60 days; Facebook waits 20 hours after a post');

// ── Blind posting: no Buffer queue/history means no post ─────────────────────
{
  const { runSocialQueueTopUp } = await import('../api/_social-automation.js');
  // fetch throws (set at the top), so the Buffer snapshot falls back with an error.
  const result = await runSocialQueueTopUp({ dryRun: true });
  assert.equal(result.success, false, 'an unreadable Buffer queue stops the run');
  assert.equal(result.posts.length, 0, 'nothing is queued blind');
  assert.match(result.error, /could not be read, so nothing was posted/);
  const cron = readFileSync(new URL('../api/cron/auto-social.js', import.meta.url), 'utf8');
  assert.match(cron, /if \(result\.success === false\) \{\s*await logCron\('auto-social', \{ status: 'error', records: 0, error: result\.error/, 'the owner sees the reason in the cron log');
}
console.log('PASS Buffer unreadable: nothing posted, reason logged');

// ── Buffer history is read in pages of at most 100 ──────────────────────────
// 2026-10-21 20:00 UTC: the snapshot asked for 250 posts in one request, Buffer
// answered "Maximum 100 items per request", and nothing was posted.
{
  const { getSocialAutomationSnapshot } = await import('../api/_social-publisher.js');
  process.env.BUFFER_ORGANIZATION_ID = 'org-test';
  const sent = Array.from({ length: 250 }, (_, i) => ({ id: `p${i}`, channelId: 'facebook-test', status: 'sent', createdAt: new Date(Date.now() - i * 3600e3).toISOString(), text: `post ${i}` }));
  let firsts = [];
  const fakeBuffer = (failAfterPage) => async (_url, init) => {
    const { query, variables } = JSON.parse(init.body);
    const json = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
    const first = variables.first ?? variables.scheduledFirst;
    if (first > 100) return json({ errors: [{ message: `Pagination limit exceeded. Maximum 100 items per request. You requested ${first}.` }] });
    if (/SocialAutomationSnapshot/.test(query)) return json({ data: { channels: [{ id: 'facebook-test', name: 'AssembleAtEase', isQueuePaused: false, postingSchedule: [] }], scheduled: { edges: [] } } });
    firsts.push(first);
    const start = variables.after ? Number(variables.after) : 0;
    if (failAfterPage && start >= failAfterPage * first) return json({ errors: [{ message: 'Buffer unavailable' }] });
    const slice = sent.slice(start, start + first);
    const end = start + slice.length;
    return json({ data: { posts: { edges: slice.map((node) => ({ node })), pageInfo: { hasNextPage: end < sent.length, endCursor: String(end) } } } });
  };

  globalThis.fetch = fakeBuffer(0);
  const snap = await getSocialAutomationSnapshot();
  assert.equal(snap.error, undefined, `the snapshot reads: ${snap.error || ''}`);
  assert.ok(firsts.every((n) => n <= 100), 'no request asks Buffer for more than 100');
  assert.equal(firsts.length, 3, '250 posts take three pages');
  assert.equal(snap.recentPosts.length, 250, 'the repeat check sees the whole history');
  assert.equal(new Set(snap.recentPosts.map((p) => p.id)).size, 250, 'no page is read twice');

  firsts = [];
  globalThis.fetch = fakeBuffer(1);
  const partial = await getSocialAutomationSnapshot();
  assert.ok(partial.error, 'a failed later page fails the snapshot, so nothing posts on half a history');

  globalThis.fetch = () => { throw new Error('test attempted a network request'); };
  delete process.env.BUFFER_ORGANIZATION_ID;
}
console.log('PASS Buffer history: read 100 at a time to the end; a missing page posts nothing');

globalThis.fetch = originalFetch;
console.log('\nSocial engine tests passed.');
