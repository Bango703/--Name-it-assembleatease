import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const locations = readFileSync(new URL('../locations.html', import.meta.url), 'utf8');
const sitemap = readFileSync(new URL('../sitemap.xml', import.meta.url), 'utf8');
const hubs = [
  ['Austin', 'austin'],
  ['Houston', 'houston'],
  ['San Antonio', 'san-antonio'],
  ['Dallas', 'dallas'],
];

assert.match(locations, /<title>Texas Service Areas: Austin, Houston, San Antonio &amp; Dallas<\/title>/);
assert.match(locations, /<link rel="canonical" href="https:\/\/www\.assembleatease\.com\/locations"\s*\/>/);
assert.doesNotMatch(locations, /<meta\s+name="robots"[^>]*\bnoindex\b/i);
assert.match(sitemap, /<loc>https:\/\/www\.assembleatease\.com\/locations<\/loc><lastmod>2026-10-27<\/lastmod>/);
assert.match(locations, /Online booking remains open across Texas/);
assert.match(locations, /an eligible local Easer is confirmed before the visit is assigned/);

const hubLinks = locations.match(/<p class="city-tier">Major Texas booking hubs<\/p>[\s\S]*?<\/div>/)?.[0];
assert.ok(hubLinks, 'The four metro links must appear in the visible major-hub section.');
const pageSchema = [...locations.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
  .map((match) => JSON.parse(match[1]))
  .find((schema) => schema['@type'] === 'CollectionPage');
assert.ok(pageSchema, 'Locations page must retain its CollectionPage structured data.');
const servedCities = pageSchema.mainEntity.areaServed
  .filter((area) => area['@type'] === 'City')
  .map((area) => area.name);

for (const [city, slug] of hubs) {
  const route = `/furniture-assembly-${slug}-tx`;
  assert.ok(hubLinks.includes(`href="${route}"`), `${city} must have a visible primary hub link.`);
  assert.ok(sitemap.includes(`<loc>https://www.assembleatease.com${route}</loc>`), `${city} furniture page must remain in the sitemap.`);
  assert.ok(servedCities.includes(city), `${city} must be represented in locations structured data.`);

  const page = readFileSync(new URL(`../furniture-assembly-${slug}-tx.html`, import.meta.url), 'utf8');
  assert.match(page, new RegExp(`<link rel="canonical" href="https:\\/\\/www\\.assembleatease\\.com${route}"\\s*\\/>`), `${city} page must keep its self canonical.`);
  assert.match(page, new RegExp(`<h1[^>]*>[\\s\\S]*?Furniture Assembly in ${city}`), `${city} page must retain its city-specific service heading.`);
  assert.match(page, /href="\/book\?service=Furniture\+Assembly"/, `${city} page must keep its existing booking path.`);
}

console.log('Texas hub alignment passed: Austin, Houston, San Antonio, and Dallas are visible, indexable, linked, and keep their existing booking paths.');
