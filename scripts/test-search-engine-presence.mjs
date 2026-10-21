#!/usr/bin/env node
// Bing feeds Yahoo, DuckDuckGo, Ecosia, ChatGPT search and Copilot. Owner,
// 2026-10-20: be strong on every engine, not only Google. This holds two things:
//   1. Every sitemap page passes the checks Bing Site Scan reports (title <= 70,
//      description <= 160, structured data present).
//   2. Changed pages reach Bing through IndexNow after every production deploy.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fitTitle, TITLE_MAX } from './lib/seo-title.mjs';
import { urlForFile, urlsForChangedFiles, lastmodChanges, sitemapUrlsFromXml, ORIGIN } from './lib/indexnow-urls.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const decode = (s) => s.replace(/&amp;/g, '&').replace(/&(?:mdash|ndash|rsquo|lsquo|quot|#\d+);/g, 'x').trim();

// ── Title rule ──────────────────────────────────────────────────────────────
assert.equal(fitTitle('TV Mounting in Austin, TX — From $89'), 'TV Mounting in Austin, TX — From $89 | AssembleAtEase');
assert.equal(fitTitle('Smart Home Installation in College Station, TX — From $69'), 'Smart Home Installation in College Station, TX — From $69',
  'the brand suffix is dropped when it would pass 70 characters');
assert.equal(fitTitle('Furniture Assembly & TV Mounting Jobs in Allen, TX', ' | Become an Easer').endsWith(' | Become an Easer'), true);
for (const rel of ['scripts/generate-location-pages.js', 'scripts/build-flagship-service-pages.mjs', 'scripts/generate-easer-recruit-pages.js', 'scripts/lib/blog-article-page.mjs']) {
  assert.match(read(rel), /fitTitle\(/, `${rel} builds titles through fitTitle`);
}
console.log('PASS titles: one rule in scripts/lib/seo-title.mjs, used by every generator');

// ── Every sitemap page passes Bing Site Scan's head checks ──────────────────
const sitemap = read('sitemap.xml');
const problems = [];
for (const url of sitemapUrlsFromXml(sitemap)) {
  const path = url.replace(ORIGIN, '').replace(/^\//, '');
  const rel = path === '' ? 'index.html' : existsSync(join(ROOT, `${path}.html`)) ? `${path}.html` : `${path}/index.html`;
  if (!existsSync(join(ROOT, rel))) { problems.push(`${url}: no file`); continue; }
  const html = read(rel);
  const head = html.split(/<body/i)[0];
  const title = decode((head.match(/<title>([^<]*)<\/title>/i) || [])[1] || '');
  const desc = decode((head.match(/<meta\s+name="description"\s+content="([^"]*)"/i) || [])[1] || '');
  if (!title || title.length > TITLE_MAX) problems.push(`${rel}: title is ${title.length} characters (max ${TITLE_MAX})`);
  if (!desc || desc.length > 160) problems.push(`${rel}: description is ${desc.length} characters (max 160)`);
  if (!/application\/ld\+json/.test(html)) problems.push(`${rel}: no structured data`);
}
assert.deepEqual(problems, [], `Bing Site Scan issues:\n${problems.join('\n')}`);
console.log('PASS every sitemap page: title <= 70, description <= 160, structured data present');

// ── IndexNow: which URLs a change sends ─────────────────────────────────────
assert.equal(urlForFile('index.html'), `${ORIGIN}/`);
assert.equal(urlForFile('blog/index.html'), `${ORIGIN}/blog`);
assert.equal(urlForFile('pricing.html'), `${ORIGIN}/pricing`);
assert.equal(urlForFile('assets/css/marketing.css'), null);
{
  const now = [`${ORIGIN}/pricing`, `${ORIGIN}/blog`, `${ORIGIN}/new-page`];
  const before = [`${ORIGIN}/pricing`, `${ORIGIN}/blog`, `${ORIGIN}/old-page`];
  const urls = urlsForChangedFiles(['pricing.html', 'owner/index.html', 'track.html', 'api/booking.js'], now, before);
  assert.deepEqual(urls, [`${ORIGIN}/new-page`, `${ORIGIN}/old-page`, `${ORIGIN}/pricing`],
    'changed public pages, added and removed pages; never private pages or code');
  const xml = (m) => `<urlset><url><loc>${ORIGIN}/pricing</loc><lastmod>${m}</lastmod></url><url><loc>${ORIGIN}/blog</loc><lastmod>2026-01-01</lastmod></url></urlset>`;
  assert.deepEqual(lastmodChanges(xml('2026-10-20'), xml('2026-07-16')), [`${ORIGIN}/pricing`], 'a sitemap lastmod bump counts as a change');
}
const key = 'ca52d2a9ade455f278bf6a10b9e4e1aa';
assert.equal(read(`${key}.txt`).trim(), key, 'the IndexNow key file is served at the site root');
const submit = read('scripts/indexnow-submit.mjs');
assert.match(submit, new RegExp(`const KEY = '${key}'`));
assert.match(submit, /--changed-from/);
const workflow = read('.github/workflows/indexnow.yml');
assert.match(workflow, /^\s+deployment_status:/m, 'runs after each deploy');
assert.match(workflow, /environment == 'Production'/, 'only for Production');
assert.match(workflow, /state == 'success'/, 'only once the deploy is live');
assert.match(workflow, /--changed-from/, 'submits only what changed');
console.log('PASS IndexNow: changed public pages are sent after every successful Production deploy');
