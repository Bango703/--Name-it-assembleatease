#!/usr/bin/env node
// Applies the search indexing policy (scripts/lib/texas-cities.mjs) to the
// committed city pages without regenerating them: the generators are older
// than the enriched pages on disk, so a regeneration would drop content.
//   - city x service and Easer-jobs pages outside the policy get
//     `noindex, follow` and leave sitemap.xml
//   - every city page title follows fitTitle (scripts/lib/seo-title.mjs)
// Idempotent. Run: node scripts/apply-search-index-policy.mjs [--check]
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { searchIndexPolicyFor } from './lib/search-index-policy.mjs';
import { fitTitle } from './lib/seo-title.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'https://www.assembleatease.com';
const CHECK = process.argv.includes('--check');
const NOINDEX = '<meta name="robots" content="noindex, follow"/>';

// Location pages carry no robots tag when indexed; Easer pages declare
// `index, follow`, as their generator writes them.
function withRobots(html, { kind, indexed }) {
  const robots = /<meta name="robots" content="[^"]*"\/>\n/;
  const indexedRobots = kind === 'easer_jobs' ? '<meta name="robots" content="index, follow"/>\n' : '';
  const wanted = indexed ? indexedRobots : `${NOINDEX}\n`;
  if (robots.test(html)) return html.replace(robots, wanted);
  return wanted ? html.replace(/(<meta name="viewport"[^>]*\/>\n)/, `$1${wanted}`) : html;
}

function withFittedTitle(html, suffix) {
  const current = html.match(/<title>([^<]*)<\/title>/)?.[1];
  if (!current) return html;
  const decoded = current.replace(/&amp;/g, '&');
  const base = decoded.endsWith(suffix) ? decoded.slice(0, -suffix.length) : decoded;
  const fitted = fitTitle(base, suffix).replace(/&/g, '&amp;');
  if (fitted === current) return html;
  return html
    .replace(`<title>${current}</title>`, `<title>${fitted}</title>`)
    .replace(`<meta property="og:title" content="${current}"/>`, `<meta property="og:title" content="${fitted}"/>`)
    .replace(`<meta name="twitter:title" content="${current}"/>`, `<meta name="twitter:title" content="${fitted}"/>`);
}

const changed = [];
const excludedUrls = new Set();
const indexedUrls = new Map(); // url -> sitemap priority, as the generators write it
for (const file of readdirSync(ROOT).filter((name) => name.endsWith('.html')).sort()) {
  const policy = searchIndexPolicyFor(file);
  if (!policy) continue;
  const url = `${ORIGIN}/${file.replace(/\.html$/, '')}`;
  if (policy.indexed) indexedUrls.set(url, policy.kind === 'easer_jobs' ? '0.6' : '0.8');
  else excludedUrls.add(url);
  const path = join(ROOT, file);
  const before = readFileSync(path, 'utf8');
  const eol = before.includes('\r\n') ? '\r\n' : '\n';
  const lf = before.replace(/\r\n/g, '\n');
  const after = withFittedTitle(withRobots(lf, policy), policy.suffix);
  if (after !== lf) {
    changed.push(file);
    if (!CHECK) writeFileSync(path, eol === '\r\n' ? after.replace(/\n/g, '\r\n') : after, 'utf8');
  }
}

const sitemapPath = join(ROOT, 'sitemap.xml');
const sitemap = readFileSync(sitemapPath, 'utf8');
let filtered = sitemap.replace(/[ \t]*<url><loc>([^<]+)<\/loc>[\s\S]*?<\/url>\r?\n?/g,
  (entry, loc) => (excludedUrls.has(loc) ? '' : entry));
// A page brought back into the policy rejoins the sitemap, dated today.
const listed = new Set([...filtered.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]));
const today = new Date().toISOString().slice(0, 10);
const added = [...indexedUrls].filter(([url]) => !listed.has(url))
  .map(([url, priority]) => `  <url><loc>${url}</loc><lastmod>${today}</lastmod><priority>${priority}</priority></url>`);
if (added.length) filtered = filtered.replace('</urlset>', `${added.join('\n')}\n</urlset>`);
if (filtered !== sitemap) {
  changed.push('sitemap.xml');
  if (!CHECK) writeFileSync(sitemapPath, filtered, 'utf8');
}

if (CHECK && changed.length) {
  console.error(`Search index policy is not applied to ${changed.length} file(s):\n${changed.slice(0, 20).join('\n')}`);
  console.error('Run: node scripts/apply-search-index-policy.mjs');
  process.exit(1);
}
console.log(CHECK
  ? 'Search index policy: every city page and sitemap.xml already match.'
  : `Search index policy applied: ${changed.length} file(s) updated, ${excludedUrls.size} city pages kept out of search.`);
