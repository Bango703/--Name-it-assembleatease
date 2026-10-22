#!/usr/bin/env node
// Blog engine (owner, 2026-10-21: "same old shit, every last one of them").
// Distinct topics only, real catalog prices only, no claims we cannot back, a
// photo no other article uses, the same renderer as the hand-written articles,
// and publication through a pull request, never a commit to main.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const engine = await import('../api/_blog-engine.js');
const { renderBlogArticle } = await import('../scripts/lib/blog-article-page.mjs');
const { writeNextArticle } = await import('../api/cron/auto-blog.js');
const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

// ── The calendar: distinct questions, no city swaps ─────────────────────────
{
  const slugs = engine.BLOG_CALENDAR.map((t) => t.slug);
  assert.equal(new Set(slugs).size, slugs.length, 'every topic slug is unique');
  assert.ok(engine.BLOG_CALENDAR.length >= 30, 'at least 30 weeks of topics');
  const cities = /austin|houston|dallas|san-antonio|fort-worth|el-paso|corpus|lubbock|amarillo|waco|mcallen|odessa|midland/;
  for (const t of engine.BLOG_CALENDAR) {
    assert.doesNotMatch(t.slug, cities, `${t.slug} is not a city variant`);
    assert.doesNotMatch(`${t.slug} ${t.topic}`, /handyman/i);
    assert.ok(engine.SERVICES[t.service], `${t.slug} maps to a catalog service`);
    assert.ok(t.months.every((m) => m >= 1 && m <= 12));
  }
  for (let i = 0; i < engine.BLOG_CALENDAR.length; i += 1) {
    for (let j = i + 1; j < engine.BLOG_CALENDAR.length; j += 1) {
      const a = engine.BLOG_CALENDAR[i]; const b = engine.BLOG_CALENDAR[j];
      assert.ok(engine.titleOverlap(a.topic, b.topic) <= 0.5, `${a.slug} and ${b.slug} answer the same question`);
    }
  }
  const live = [...read('blog/index.html').matchAll(/<span class="guide-title"[^>]*>([^<]+)<\/span>/g)].map((m) => m[1]);
  assert.ok(live.length >= 17);
  const first = engine.pickNextTopic({ existingSlugs: [], existingTitles: live, now: new Date('2026-10-26T15:00:00Z') });
  assert.ok(first.months.includes(10), 'an in-season topic comes first');
  const dup = engine.pickNextTopic({ existingSlugs: [], existingTitles: ['Mounting a TV above a fireplace: height, heat and mantel clearance'], now: new Date('2026-10-26T15:00:00Z') });
  assert.notEqual(dup.slug, 'mounting-a-tv-above-a-fireplace', 'a near-duplicate of a live article is skipped');
  assert.equal(engine.pickNextTopic({ existingSlugs: engine.BLOG_CALENDAR.map((t) => t.slug) }), null);
}
console.log('PASS calendar: distinct topics, no city swaps, in season first, near-duplicates skipped');

// ── The writer's draft is checked before anything is built ──────────────────
const facts = engine.catalogFactsFor('Mounting & Hanging');
assert.ok(facts.fromPrice > 0 && facts.prices.includes(facts.fromPrice), 'catalog prices are given to the writer');
const prompt = engine.buildArticlePrompt(engine.BLOG_CALENDAR.find((t) => t.slug === 'mounting-a-tv-above-a-fireplace'), facts);
assert.match(prompt.user, new RegExp(`\\$${facts.fromPrice}`));
assert.match(prompt.system, /Pros bring their own tools/);
assert.match(prompt.system, /licensed electrician/);
assert.match(prompt.system, /Never use the word handyman/);

const para = 'Measure the wall, find the studs, confirm the mount fits the screen, and keep the cords near the outlet that already exists before the visit starts so nothing waits on a missing part.';
function draft(overrides = {}) {
  const base = {
    title: 'Mounting a TV above a fireplace: what to check first',
    description: 'How to judge viewing height, heat and mantel clearance before mounting a TV above a fireplace, and what the visit includes.',
    metaDescription: 'Mounting a TV above a fireplace: viewing height, heat, mantel clearance, mount choice and what the visit includes, with current starting prices.',
    quickAnswer: `Check heat, height and the wall first. Standard TV mounting starts from $${facts.fromPrice}, and same-day service is not guaranteed.`,
    paragraphs: [para, para],
    sections: Array.from({ length: 6 }, (_, i) => ({ title: `Section ${i + 1} on planning`, paragraphs: [para, para, para], bullets: i < 2 ? ['Screen size', 'Wall type', 'Mount model'] : [] })),
    faq: Array.from({ length: 4 }, (_, i) => ({ q: `Question ${i + 1} about the fireplace wall?`, a: para })),
  };
  return JSON.stringify({ ...base, ...overrides });
}
{
  const ok = engine.validateArticleData(draft(), { allowedPrices: facts.prices });
  assert.equal(ok.ok, true, ok.reason);
  assert.ok(ok.article.wordCount >= 850);
  const bad = (o, why) => {
    const r = engine.validateArticleData(draft(o), { allowedPrices: facts.prices });
    assert.equal(r.ok, false, `rejected: ${why}`);
    return r.reason;
  };
  assert.match(bad({ quickAnswer: 'Mounting starts at $49 for most walls and screens today.' }, 'invented price'), /not in the catalog: \$49/);
  assert.match(bad({ quickAnswer: 'Our Austin team mounts TVs above fireplaces every week of the year.' }, 'city'), /names a city/);
  assert.match(bad({ quickAnswer: 'A good handyman checks the wall before mounting anything heavy.' }, 'handyman'), /handyman/);
  assert.match(bad({ quickAnswer: 'We are fully insured and every install is checked twice before we leave.' }, 'insurance'), /licence or insurance/);
  assert.match(bad({ quickAnswer: 'Every mount is guaranteed to hold for the life of the TV in your home.' }, 'guarantee'), /guarantee/);
  assert.match(bad({ quickAnswer: 'We provide the mount and the anchors, so you only need the TV itself.' }, 'hardware'), /supply hardware/);
  assert.match(bad({ quickAnswer: 'A loose mount can cost you thousands in repairs if the TV comes down.' }, 'scare'), /scare/);
  assert.match(bad({ faq: [{ q: 'One?', a: para }] }, 'thin FAQ'), /FAQ has 1/);
  assert.match(engine.validateArticleData('not json at all').reason, /valid JSON/);
}
console.log('PASS drafts: real catalog prices only; cities, handyman, insurance, guarantees, hardware and scare copy refused');

// ── One photo per article ───────────────────────────────────────────────────
{
  const used = ['/images/real-tv-mount-console.jpg', 'https://www.assembleatease.com/images/real-tv-dawg-days.jpg'];
  const site = engine.pickArticleImage({ service: 'Mounting & Hanging', usedImages: used });
  assert.equal(site.image, '/images/real-tv-setup-console.jpg', 'the first photo no article uses');
  assert.equal(site.reused, false);
  const job = engine.pickArticleImage({ service: 'Mounting & Hanging', usedImages: used, jobPhotos: [{ url: 'https://x.supabase.co/storage/v1/object/public/job-photos/tv/1.jpg', alt: 'TV mounted over a console' }] });
  assert.equal(job.source, 'job-photo', 'a published job photo comes first');
  const all = ['/images/real-tv-mount-console.jpg', '/images/real-tv-dawg-days.jpg', '/images/real-tv-setup-console.jpg', '/images/work-tv-mounting.jpg', '/images/service-tv-mounting.jpg'];
  assert.equal(engine.pickArticleImage({ service: 'Mounting & Hanging', usedImages: all }).reused, true, 'out of photos is flagged, never hidden');
}
console.log('PASS photos: job photos first, never one another article uses, reuse flagged');

// ── Same renderer as the hand-written articles; index and sitemap ───────────
const topic = engine.BLOG_CALENDAR.find((t) => t.slug === 'tv-mounting-on-brick-and-stone');
const article = engine.validateArticleData(draft(), { allowedPrices: facts.prices }).article;
{
  const built = engine.buildEngineArticle({ topic, article, image: { image: '/images/real-tv-setup-console.jpg', alt: 'TV mounted over a console' }, today: '2026-10-26' });
  assert.equal(built.html, renderBlogArticle(built.post, built.content, { related: built.post.relatedLinks, defaultModified: '2026-10-26' }), 'the data file reproduces the page');
  assert.match(built.html, /<link rel="canonical" href="https:\/\/www\.assembleatease\.com\/blog\/tv-mounting-on-brick-and-stone"\/>/);
  assert.match(built.html, /"@type":"FAQPage"/);
  assert.match(built.html, /<h2 id="faq">Frequently asked questions<\/h2>/);
  assert.match(built.html, /"@type":"BlogPosting"/);
  assert.match(built.html, /href="\/book\?service=Mounting\+%26\+Hanging"/);
  const title = built.html.match(/<title>([^<]*)<\/title>/)[1];
  assert.ok(title.length <= 70, `title fits (${title.length})`);
  const index = engine.addToBlogIndex(read('blog/index.html'), { card: built.card, groupId: engine.indexGroupId(topic.service), title: article.title, url: 'https://www.assembleatease.com/blog/tv-mounting-on-brick-and-stone' });
  assert.match(index, /href="\/blog\/tv-mounting-on-brick-and-stone" class="guide-card"/);
  assert.ok(index.includes('"url":"https://www.assembleatease.com/blog/tv-mounting-on-brick-and-stone"'), 'listed in the CollectionPage schema');
  const sitemap = engine.addToSitemap(read('sitemap.xml'), { url: 'https://www.assembleatease.com/blog/tv-mounting-on-brick-and-stone', today: '2026-10-26' });
  assert.match(sitemap, /<loc>https:\/\/www\.assembleatease\.com\/blog\/tv-mounting-on-brick-and-stone<\/loc><lastmod>2026-10-26<\/lastmod>/);
  assert.equal(engine.addToSitemap(sitemap, { url: 'https://www.assembleatease.com/blog/tv-mounting-on-brick-and-stone', today: '2026-10-27' }), sitemap, 'added once');
  const cleanup = read('scripts/cleanup-blog-pages.mjs');
  assert.match(cleanup, /const engineDataDir = join\(blogDir, 'data'\);/, 'a full regeneration keeps engine articles');
  assert.match(cleanup, /import \{ renderBlogArticle, guideCard,/);
}
console.log('PASS rendering: shared renderer, FAQ schema, booking link, index card, schema list and sitemap');

// ── End to end: a pull request, never main ──────────────────────────────────
{
  const calls = [];
  const enc = (s) => Buffer.from(s).toString('base64');
  const fetchImpl = async (url, init = {}) => {
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, method, body });
    const path = url.replace(/^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+/, '');
    const json = (data, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(data) });
    if (method === 'GET' && path.startsWith('/contents/blog?')) return json([{ name: 'index.html' }, { name: 'tv-mounting-tips-austin.html' }]);
    if (method === 'GET' && path.startsWith('/contents/blog/index.html')) return json({ content: enc(read('blog/index.html')), sha: 'idx' });
    if (method === 'GET' && path.startsWith('/contents/sitemap.xml')) return json({ content: enc(read('sitemap.xml')), sha: 'map' });
    if (method === 'GET' && path.startsWith('/pulls?')) return json([]);
    if (method === 'GET' && path === '/git/ref/heads/main') return json({ object: { sha: 'abc123' } });
    if (method === 'POST' && path === '/git/refs') return json({ ref: body.ref }, 201);
    if (method === 'PUT' && path.startsWith('/contents/')) return json({ content: {} }, 201);
    if (method === 'POST' && path === '/pulls') return json({ number: 501, html_url: 'https://github.com/x/y/pull/501' }, 201);
    return json({ message: `unexpected ${method} ${path}` }, 500);
  };
  const drafts = [draft({ quickAnswer: 'Mounting starts at $49 for most walls and screens today.' }), draft()];
  const anthropic = { messages: { create: async () => ({ content: [{ text: drafts.shift() }] }) } };
  const result = await writeNextArticle({ token: 't', anthropic, fetchImpl, jobPhotos: [], notify: false, now: new Date('2026-10-26T15:00:00Z') });
  assert.equal(result.ok, true, result.reason);
  assert.equal(drafts.length, 0, 'a rejected draft is rewritten once');
  assert.equal(result.pullRequest, 'https://github.com/x/y/pull/501');
  const puts = calls.filter((c) => c.method === 'PUT');
  assert.deepEqual(puts.map((c) => c.url.split('/contents/')[1]).sort(), ['blog/data/' + result.slug + '.json', 'blog/' + result.slug + '.html', 'blog/index.html', 'sitemap.xml'].sort());
  assert.ok(puts.every((c) => c.body.branch === `blog/${result.slug}`), 'every file goes to the article branch');
  assert.ok(!calls.some((c) => c.body?.branch === 'main'), 'nothing is ever written to main');
  const pr = calls.find((c) => c.method === 'POST' && c.url.endsWith('/pulls'));
  assert.equal(pr.body.base, 'main');
  assert.match(pr.body.body, /every price checked against the catalog/);
  const data = JSON.parse(Buffer.from(puts.find((c) => c.url.includes('/blog/data/')).body.content, 'base64').toString());
  assert.equal(data.post.slug, result.slug);
  assert.ok(data.content.faq.length >= 4);

  const failing = { messages: { create: async () => ({ content: [{ text: draft({ quickAnswer: 'A good handyman does this in an hour for any wall at all.' }) }] }) } };
  calls.length = 0;
  const refused = await writeNextArticle({ token: 't', anthropic: failing, fetchImpl, jobPhotos: [], notify: false });
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /failed its checks twice/);
  assert.ok(!calls.some((c) => c.method !== 'GET'), 'a refused draft opens nothing');
}
console.log('PASS end to end: rejected draft rewritten once, files on the article branch, pull request opened, never main');

// ── Schedule and switch ─────────────────────────────────────────────────────
{
  const vercel = read('vercel.json');
  assert.match(vercel, /"api\/cron\/auto-blog\.js": \{\s*"includeFiles": "\{business-artifacts\/page-governance\/site-governance\.json,assets\/js\/booking-source-of-truth\.js\}"/, 'the function ships the files it reads at runtime');
  assert.match(vercel, /"path": "\/api\/cron\/auto-blog",\s*"schedule": "0 14 \* \* 1"/, 'weekly, Monday 9 AM Central');
  const handler = read('api/cron/auto-blog.js');
  assert.match(handler, /AUTO_BLOG_PUBLISH_ENABLED/);
  assert.doesNotMatch(handler, /branch: 'main'/);
}
console.log('PASS weekly schedule; off until AUTO_BLOG_PUBLISH_ENABLED');

// ── Every blog page carries the live offer and a price-first close ──────────
// Owner, 2026-10-22: the offer bar ran on every public page except the blog,
// so readers never saw the live discount, and each article closed with a
// paragraph about "assignment". The offer bar is in the shared layout now.
{
  const { readdirSync: listDir, readFileSync: readText } = await import('node:fs');
  const pages = listDir(new URL('../blog/', import.meta.url)).filter((f) => f.endsWith('.html'));
  const missing = pages.filter((f) => !readText(new URL(`../blog/${f}`, import.meta.url), 'utf8').includes('/assets/js/site-promo.js'));
  assert.deepEqual(missing, [], `blog pages without the offer bar: ${missing.join(', ')}`);
  const layout = readText(new URL('../scripts/lib/blog-article-page.mjs', import.meta.url), 'utf8');
  assert.match(layout, /See your exact price before you book\./);
  assert.doesNotMatch(layout, /checked before assignment/);
}
console.log('PASS every blog page shows the live offer and closes on the price');
