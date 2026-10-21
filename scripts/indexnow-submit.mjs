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
//   node scripts/indexnow-submit.mjs --changed-from <sha> [--changed-to <sha>]
//     (submit only sitemap pages whose files changed between two commits; the
//     IndexNow workflow runs this after every production deploy)
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sitemapUrlsFromXml, urlsForChangedFiles, lastmodChanges } from './lib/indexnow-urls.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOST = 'www.assembleatease.com';
const ORIGIN = `https://${HOST}`;
const KEY = 'ca52d2a9ade455f278bf6a10b9e4e1aa';
const KEY_LOCATION = `${ORIGIN}/${KEY}.txt`;
const ENDPOINT = 'https://api.indexnow.org/indexnow';
const MAX_URLS = 10000; // IndexNow per-request cap

function sitemapUrls() {
  return sitemapUrlsFromXml(readFileSync(join(ROOT, 'sitemap.xml'), 'utf8'));
}

function git(...gitArgs) {
  return execFileSync('git', gitArgs, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function changedUrls(from, to) {
  const files = git('diff', '--name-only', '--no-renames', `${from}..${to}`).split(/\r?\n/).filter(Boolean);
  let beforeXml = '';
  try { beforeXml = git('show', `${from}:sitemap.xml`); } catch { beforeXml = ''; }
  const nowXml = git('show', `${to}:sitemap.xml`);
  const urls = urlsForChangedFiles(files, sitemapUrlsFromXml(nowXml), sitemapUrlsFromXml(beforeXml));
  return [...new Set([...urls, ...lastmodChanges(nowXml, beforeXml)])].sort();
}

function flagValue(name) {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1] || null;
}

function normalize(arg) {
  const v = arg.trim();
  if (v.startsWith('http://') || v.startsWith('https://')) return v;
  return `${ORIGIN}/${v.replace(/^\/+/, '')}`;
}

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const changedFrom = flagValue('--changed-from');
const changedTo = flagValue('--changed-to') || 'HEAD';
const explicit = args.filter((a, i) => a !== '--dry-run' && !a.startsWith('--changed-') && !String(args[i - 1] || '').startsWith('--changed-'));

let urls = changedFrom ? changedUrls(changedFrom, changedTo) : explicit.length ? explicit.map(normalize) : sitemapUrls();
if (changedFrom && !urls.length) {
  console.log(`No public pages changed between ${changedFrom} and ${changedTo}; nothing to submit.`);
  process.exit(0);
}
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
