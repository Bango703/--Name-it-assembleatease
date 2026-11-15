#!/usr/bin/env node
// Social images (owner, 2026-11-15: Live Ops showed "Invalid post: Google
// Business Profiles does not support .webp files"). Every image the automatic
// posts can choose is a JPG or PNG that exists in images/, and the publisher
// never sends a .webp to Google Business Profile.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { serviceImageUrl } from '../api/_review-social.js';
import { extractImageUrl, imageForArticle } from '../api/_blog-articles.js';

const root = new URL('../', import.meta.url);
const read = p => readFileSync(new URL(p, root), 'utf8').replace(/\r\n/g, '\n');
const local = url => String(url).replace(/^https:\/\/www\.assembleatease\.com\//, '').replace(/^\/+/, '').split(/[?#]/)[0];
const checked = new Set();
function ok(url, from) {
  const path = local(url);
  assert.match(path, /\.(jpe?g|png)$/i, `${from}: ${path} must be JPG or PNG`);
  assert.ok(existsSync(new URL(path, root)), `${from}: ${path} exists`);
  checked.add(path);
}

// Campaign posts (service, offer, AssembleCash).
const campaigns = read('api/_social-campaigns.js');
for (const m of campaigns.matchAll(/image: '([^']+)'/g)) ok('images/' + m[1], 'campaign');
for (const m of campaigns.matchAll(/\/images\/([^`'"${}]+)`/g)) ok('images/' + m[1], 'campaign');
// Review posts, one per service and the fallback.
for (const s of ['TV Mounting', 'Smart Home', 'Fitness Equipment', 'Office Assembly', 'Outdoor & Playsets', 'Furniture Assembly', 'Something else']) ok(serviceImageUrl(s), 'review post');
// Blog posts: every blog page, through the same extractor the publisher uses.
for (const name of readdirSync(new URL('blog/', root)).filter(n => n.endsWith('.html') && n !== 'index.html')) {
  ok(extractImageUrl(new URL('blog/' + name, root), { slug: name.replace(/\.html$/, ''), title: name }), 'blog ' + name);
}
for (const slug of ['smart-lock', 'tv-mount', 'ikea-bed', 'garage-shelving', 'treadmill', 'playset', 'office-desk', 'other']) ok(imageForArticle({ slug }), 'article default');

// The publisher's last guard: no .webp to Google.
const publisher = read('api/_social-publisher.js');
assert.ok(publisher.includes("const webpForGoogle = channel.key === 'googleBusiness' && /\\.webp(\\?|#|$)/i.test(String(imageUrl || ''));"), 'the publisher detects a .webp bound for Google');
assert.ok(publisher.includes('if (imageUrl && !webpForGoogle && shouldAttachImageForChannel(channel)) {'), 'and leaves the image off rather than failing the post');
console.log(`PASS social images: ${checked.size} images, all JPG or PNG and present; no .webp reaches Google Business Profile.`);
