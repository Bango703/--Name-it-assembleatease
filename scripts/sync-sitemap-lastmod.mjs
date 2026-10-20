#!/usr/bin/env node
// Sets every <lastmod> in sitemap.xml to the date the page's file last changed
// in git, so the sitemap says when each page really changed.
//
// Why (2026-10-20): the location generator keeps whatever lastmod a URL already
// had, so 306 pages still said 2026-07-16 although the city pages were last
// rewritten on 2026-09-29. Google only trusts lastmod that is consistently
// accurate; a stale date is worse than none.
//
// Usage: node scripts/sync-sitemap-lastmod.mjs [--check]
//   --check  report pages whose lastmod is older than their last change; exit 1 if any
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const SITE = 'https://www.assembleatease.com/';
const check = process.argv.includes('--check');

export function fileForUrl(loc) {
  const path = loc.replace(SITE, '').replace(/^\/+/, '');
  if (path === '') return 'index.html';
  if (path.endsWith('/')) return `${path}index.html`;
  if (path.endsWith('.html')) return path;
  if (existsSync(`${path}.html`)) return `${path}.html`;
  if (existsSync(`${path}/index.html`)) return `${path}/index.html`;
  return null;
}

function lastChanged(file) {
  try {
    return execFileSync('git', ['log', '-1', '--format=%cs', '--', file], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

const xml = readFileSync('sitemap.xml', 'utf8');
let changed = 0;
const stale = [];
const unmapped = [];
const updated = xml.replace(/<url>([\s\S]*?)<\/url>/g, (entry, inner) => {
  const loc = inner.match(/<loc>([^<]+)<\/loc>/)?.[1];
  const file = loc && fileForUrl(loc);
  const date = file && lastChanged(file);
  if (!date) { unmapped.push(loc); return entry; }
  const current = inner.match(/<lastmod>([^<]+)<\/lastmod>/)?.[1] || null;
  if (current === date) return entry;
  if (!current || current < date) stale.push(`${loc} ${current || 'none'} -> ${date}`);
  changed++;
  return current
    ? entry.replace(`<lastmod>${current}</lastmod>`, `<lastmod>${date}</lastmod>`)
    : entry.replace(`</loc>`, `</loc><lastmod>${date}</lastmod>`);
});

if (check) {
  if (stale.length) {
    console.error(`${stale.length} sitemap lastmod value(s) are older than the page's last change:`);
    stale.slice(0, 20).forEach(line => console.error('  ' + line));
    process.exit(1);
  }
  console.log('Sitemap lastmod values are current.');
} else {
  writeFileSync('sitemap.xml', updated);
  console.log(`Updated ${changed} lastmod value(s); ${unmapped.length} URL(s) without a matching file.`);
  unmapped.forEach(loc => console.log('  no file: ' + loc));
}
