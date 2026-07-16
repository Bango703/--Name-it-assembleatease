// Submits URLs to IndexNow (Bing, Yandex, and other participating engines) so
// new or changed pages get crawled in minutes instead of waiting weeks.
//
// Setup (already done in this repo):
//   - Key:      ca52d2a9ade455f278bf6a10b9e4e1aa
//   - Key file: /ca52d2a9ade455f278bf6a10b9e4e1aa.txt at the site root
//     (Vercel serves it; IndexNow fetches it to verify ownership).
//
// Usage:
//   node scripts/indexnow-submit.mjs                 # submit every sitemap URL
//   node scripts/indexnow-submit.mjs /furniture-assembly-dallas-tx /pricing
//     (submit only these paths/URLs — use after changing a few pages)
//   node scripts/indexnow-submit.mjs --dry-run       # print what would be sent
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOST = 'www.assembleatease.com';
const ORIGIN = `https://${HOST}`;
const KEY = 'ca52d2a9ade455f278bf6a10b9e4e1aa';
const KEY_LOCATION = `${ORIGIN}/${KEY}.txt`;
const ENDPOINT = 'https://api.indexnow.org/indexnow';
const MAX_URLS = 10000; // IndexNow per-request cap

function sitemapUrls() {
  const xml = readFileSync(join(ROOT, 'sitemap.xml'), 'utf8');
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
}

function normalize(arg) {
  const v = arg.trim();
  if (v.startsWith('http://') || v.startsWith('https://')) return v;
  return `${ORIGIN}/${v.replace(/^\/+/, '')}`;
}

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const explicit = args.filter((a) => a !== '--dry-run');

let urls = explicit.length ? explicit.map(normalize) : sitemapUrls();
// De-dupe and keep only our own host (IndexNow rejects mixed hosts).
urls = [...new Set(urls)].filter((u) => u.startsWith(ORIGIN));

if (!urls.length) {
  console.error('No URLs to submit.');
  process.exit(1);
}
if (urls.length > MAX_URLS) {
  console.error(`Too many URLs (${urls.length}); IndexNow accepts up to ${MAX_URLS} per request.`);
  process.exit(1);
}

const payload = { host: HOST, key: KEY, keyLocation: KEY_LOCATION, urlList: urls };

if (dryRun) {
  console.log(`DRY RUN — would submit ${urls.length} URLs to ${ENDPOINT}`);
  console.log(urls.slice(0, 5).map((u) => `  ${u}`).join('\n') + (urls.length > 5 ? `\n  … +${urls.length - 5} more` : ''));
  process.exit(0);
}

const res = await fetch(ENDPOINT, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
  body: JSON.stringify(payload),
});

// IndexNow returns 200 or 202 on success; 4xx on key/host problems.
const body = await res.text().catch(() => '');
if (res.status === 200 || res.status === 202) {
  console.log(`IndexNow accepted ${urls.length} URLs (HTTP ${res.status}). Bing will crawl them shortly.`);
} else {
  console.error(`IndexNow rejected the submission: HTTP ${res.status} ${body || ''}`.trim());
  console.error('Check that the key file is live at ' + KEY_LOCATION);
  process.exit(1);
}
