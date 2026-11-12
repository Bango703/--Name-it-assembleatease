#!/usr/bin/env node
// Apple's Smart App Banner on every public page (owner, 2026-11-11: "must look
// professional"). On an iPhone in Safari the page shows Apple's own banner with
// Get or Open; nothing changes anywhere else. Customer pages offer the
// customer app, Easer pages the Easer app (api/_app-store.js).
//
//   node scripts/app-banner-sync.mjs           write the tags
//   node scripts/app-banner-sync.mjs --check   fail if any page is out of date
//
// Files are read and written byte for byte (latin1), so pages holding bytes that
// are not valid UTF-8 come back unchanged apart from the tag.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { APP_STORE } from '../api/_app-store.js';
import { classifyPage, listHtmlPages } from './lib/page-governance.mjs';
import { ROOT } from './lib/site-governance.mjs';

const CUSTOMER_TYPES = new Set([
  'home', 'booking', 'pricing', 'business', 'policy', 'prelaunch', 'support',
  'core_marketing', 'blog_index', 'blog_article', 'flagship_service', 'city_service',
]);
const EASER_TYPES = new Set(['assembler_public', 'assembler_portal', 'recruit_hub', 'recruit_city', 'auth']);
// The contractor agreement is a protected document (CLAUDE.md, Article 10).
const NEVER = new Set(['assembler/contractor-agreement.html']);

export function bannerAppFor(pagePath) {
  if (NEVER.has(pagePath)) return null;
  const type = classifyPage(pagePath);
  if (CUSTOMER_TYPES.has(type)) return 'customer';
  if (EASER_TYPES.has(type)) return 'easer';
  return null;
}

export function bannerTag(app) {
  return `<meta name="apple-itunes-app" content="app-id=${APP_STORE[app].id}">`;
}

const EXISTING = /[ \t]*<meta name="apple-itunes-app"[^>]*>\r?\n?/i;
const VIEWPORT = /<meta name="viewport"[^>]*>/i;

export function withBanner(html, app) {
  let next = html.replace(EXISTING, '');
  if (!app) return next;
  const nl = next.includes('\r\n') ? '\r\n' : '\n';
  const viewport = next.match(VIEWPORT);
  if (viewport) {
    const lineStart = next.lastIndexOf('\n', viewport.index) + 1;
    const indent = next.slice(lineStart, viewport.index).match(/^[ \t]*/)[0];
    const at = viewport.index + viewport[0].length;
    return `${next.slice(0, at)}${nl}${indent}${bannerTag(app)}${next.slice(at)}`;
  }
  const head = next.match(/<head[^>]*>/i);
  if (!head) return next;
  const at = head.index + head[0].length;
  return `${next.slice(0, at)}${nl}${bannerTag(app)}${next.slice(at)}`;
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('app-banner-sync.mjs')) {
  const check = process.argv.includes('--check');
  const stale = [];
  for (const pagePath of listHtmlPages()) {
    const file = join(ROOT, pagePath);
    const html = readFileSync(file, 'latin1');
    const next = withBanner(html, bannerAppFor(pagePath));
    if (next === html) continue;
    stale.push(pagePath);
    if (!check) writeFileSync(file, next, 'latin1');
  }
  if (check && stale.length) {
    console.error(`Smart App Banner out of date on ${stale.length} page(s); run npm run governance:apps:\n${stale.slice(0, 20).join('\n')}`);
    process.exit(1);
  }
  console.log(check ? 'Smart App Banners are current.' : `Smart App Banner written on ${stale.length} page(s).`);
}
