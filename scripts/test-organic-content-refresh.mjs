import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SERVICES, AUSTIN, buildBody, applyServiceGuideToPage } from './build-flagship-service-pages.mjs';
import { ALL_TEXAS_CITIES } from './lib/texas-cities.mjs';
import { refreshPostContent } from './cleanup-blog-pages.mjs';

// A narrow content refresh must not repeat the known full-generator drift:
// preserve pricing, public shell, links, images and third-party local evidence.
const targets = [
  ['furniture-assembly', 'austin'], ['tv-mounting', 'austin'],
  ['furniture-assembly', 'round-rock'], ['furniture-assembly', 'san-antonio'],
  ['playset-assembly', 'manor'], ['playset-assembly', 'buda'], ['playset-assembly', 'houston'],
  ['smart-home-installation', 'pearland'], ['smart-home-installation', 'san-angelo'],
];
const citiesByName = new Map(ALL_TEXAS_CITIES.map((city) => [city.name, city.slug]));
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const section = (html, name) => html.match(new RegExp(`<!-- ${name} -->[\\s\\S]*?(?=<!-- [A-Z ]+ -->)`))?.[0];
const ld = (html, type) => [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
  .map((match) => JSON.parse(match[1])).find((node) => node['@type'] === type);
const evidence = '<p class="fa-lead">Local homes: Existing reviewed evidence must survive a content refresh.</p>';
const citation = '<p class="fa-lead">Source: U.S. Census Bureau, existing reviewed citation.</p>';
for (const [prefix, slug] of targets) {
  const source = ALL_TEXAS_CITIES.find((city) => city.slug === slug);
  let nearby = source.nearby.filter((name) => citiesByName.has(name)).slice(0, 4);
  const linksAreNearby = nearby.length > 0;
  if (!linksAreNearby) nearby = ['Austin', 'San Antonio', 'Houston', 'Dallas', 'Fort Worth'].filter((name) => name !== source.name).slice(0, 4);
  const city = slug === 'austin' ? AUSTIN : { ...source, citySlug: slug, linksAreNearby, nearby: nearby.map((name) => ({ name, slug: citiesByName.get(name) })) };
  const cfg = SERVICES.find((service) => service.prefix === prefix);
  const path = `${prefix}-${slug}-tx.html`;
  const html = read(path);
  const fullBuild = buildBody(cfg, city);
  if (slug !== 'austin') {
    assert.ok(fullBuild.includes('Local homes:</strong>'), `${path}: full generator lost current local housing guidance`);
    assert.ok(fullBuild.includes('Source: U.S. Census Bureau'), `${path}: full generator lost housing attribution`);
  }
  if (html.includes(`Planning your ${source.name} appointment:`)) {
    assert.ok(fullBuild.includes(`Planning your ${source.name} appointment:`), `${path}: full generator lost existing local appointment context`);
  }
  assert.equal(applyServiceGuideToPage(html, cfg, city), html, `${path}: content is stale or refresh is not idempotent`);
  const fixture = html.replace('    <div class="fa-mini-facts">', `    ${evidence}\n    ${citation}\n    <div class="fa-mini-facts">`);
  const refreshed = applyServiceGuideToPage(fixture, cfg, city);
  assert.equal(refreshed.split(evidence).length - 1, 1, `${path}: existing local evidence lost or duplicated`);
  assert.equal(refreshed.split(citation).length - 1, 1, `${path}: existing evidence citation lost or duplicated`);
  for (const paragraph of html.match(/<p\b[^>]*>(?:(?!<\/p>)[\s\S])*?(?:Local homes:|Planning your [^<]+ appointment:|Source: U\.S\. Census Bureau)(?:(?!<\/p>)[\s\S])*?<\/p>/g) || []) {
    assert.equal(refreshed.split(paragraph).length - 1, 1, `${path}: current local planning/evidence/source changed or duplicated`);
  }
  assert.equal(applyServiceGuideToPage(refreshed, cfg, city), refreshed, `${path}: evidence duplicates on a second refresh`);
  for (const name of ['HERO', 'PRICING', 'HOW IT WORKS', 'LOCATION AND SERVICE LINKS']) {
    assert.equal(section(refreshed, name), section(html, name), `${path}: unrelated ${name} changed`);
  }
  assert.equal(refreshed.slice(refreshed.indexOf('<footer class="footer">')), html.slice(html.indexOf('<footer class="footer">')), `${path}: footer/scripts changed`);
  assert.deepEqual(ld(refreshed, 'Service'), ld(html, 'Service'), `${path}: financial/service schema changed`);
  for (const question of ld(refreshed, 'FAQPage').mainEntity) {
    assert.ok(refreshed.includes(question.name), `${path}: schema question is not visible`);
  }
  if (slug !== 'austin') assert.ok(refreshed.includes('Example completed project'), `${path}: example photos acquired an unsupported city claim`);
  assert.ok(refreshed.includes('tel:+19792325139'), `${path}: canonical public phone missing`);
}

for (const slug of ['why-hire-handyman-austin', 'tv-mounting-tips-austin']) {
  const html = read(`blog/${slug}.html`);
  const refreshed = refreshPostContent(html, slug);
  assert.equal(refreshed, html, `${slug}: article/source drift`);
  assert.equal(refreshed.slice(refreshed.indexOf('<footer class="footer">')), html.slice(html.indexOf('<footer class="footer">')), `${slug}: footer/scripts changed`);
  assert.ok(refreshed.includes('datetime="2026-10-07"'), `${slug}: visible date missing`);
  assert.ok(refreshed.includes('"dateModified":"2026-10-07"'), `${slug}: schema date missing`);
}

// These legacy scripts rewrite many pages at top level and point at the original
// checkout. Inspect their public-contact inputs without importing/executing them.
// A later rerun must not put a retired public number back into call links/schema.
const canonicalPhone = ld(read('about.html'), 'Organization').telephone;
for (const path of ['scripts/seo_new_pages.py', 'scripts/seo_p0_fixes.py']) {
  const source = read(path);
  assert.equal(source.match(/^PHONE\s*=\s*"([^"]+)"/m)?.[1], canonicalPhone, `${path}: public phone differs from canonical website`);
  assert.doesNotMatch(source, /(?:\+?1)?737[- .)]*290[- .]*6129/, `${path}: retired public phone would return`);
  for (const match of source.matchAll(/href="tel:([^"]+)"/g)) {
    assert.ok(match[1] === '{PHONE}' || match[1] === canonicalPhone, `${path}: call link bypasses canonical phone`);
  }
}
const legacyTemplate = read('scripts/seo_new_pages.py');
assert.equal((legacyTemplate.match(/href="tel:\{PHONE\}"[^>]*>\{PHONE_DISPLAY\}</g) || []).length, 2, 'Legacy CTA and footer must use the shared phone and display');
console.log('PASS: 9 service guides and 2 articles match their content sources; narrow refresh preserves pricing, links, examples, local evidence and public shell; legacy public generators retain the canonical phone.');
