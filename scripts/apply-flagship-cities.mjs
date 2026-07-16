// Transforms existing Texas city/service pages to the flagship layout, reusing
// the SAME template + builders as the Austin flagship pages
// (build-flagship-service-pages.mjs). It preserves each page's per-city <head>
// SEO (title, canonical, meta, breadcrumb schema) and only swaps the visible
// body, the flagship CSS, the Service schema, and the FAQPage schema.
//
// The city roster + neighbors are read from the canonical CITIES list in
// scripts/generate-location-pages.js (parsed, not imported, so that generator's
// side effects never run). ONE source of truth for which cities exist.
//
// Usage:
//   node scripts/apply-flagship-cities.mjs            # all cities except Austin
//   node scripts/apply-flagship-cities.mjs dallas houston   # only these
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SERVICES, applyFlagshipToPage, assertVisibleStartPrice } from './build-flagship-service-pages.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Parse the canonical city roster out of the generator without running it (the
// file executes on import). The roster is two literals — CITIES (detailed) plus
// STATEWIDE_MARKETS — merged with CITIES.push(...). Evaluate that whole trusted
// data block and return the merged list.
function loadCities() {
  const src = readFileSync(join(ROOT, 'scripts', 'generate-location-pages.js'), 'utf8');
  const start = src.indexOf('const CITIES = [');
  const marker = 'CITIES.push(...STATEWIDE_MARKETS);';
  const end = src.indexOf(marker, start);
  if (start === -1 || end === -1) throw new Error('Could not locate the CITIES roster in generate-location-pages.js');
  const block = src.slice(start, end + marker.length);
  // eslint-disable-next-line no-new-func
  return new Function(`${block}\nreturn CITIES;`)();
}

const CITIES = loadCities();
const slugByName = new Map(CITIES.map((c) => [c.name, c.slug]));

// Major metros used to top up the nearby links when a city's real neighbors are
// not in the roster (e.g. far-west/panhandle/border cities). Keeps every page's
// internal linking useful and never leaves the section empty. All are cities we
// serve statewide, so the links are truthful.
const METRO_TOPUP = [
  ['austin', 'Austin'], ['san-antonio', 'San Antonio'], ['houston', 'Houston'],
  ['dallas', 'Dallas'], ['fort-worth', 'Fort Worth'],
];

// Resolve a city's neighbor names to {slug,name}, keeping only neighbors that
// actually have generated pages (so nearby links never 404). Top up to 4 with
// major metros (excluding the city itself and any already listed).
function nearbyFor(city) {
  const out = (city.nearby || [])
    .map((name) => ({ name, slug: slugByName.get(name) }))
    .filter((n) => n.slug)
    .slice(0, 4);
  const have = new Set([city.slug, ...out.map((n) => n.slug)]);
  for (const [slug, name] of METRO_TOPUP) {
    if (out.length >= 4) break;
    if (!have.has(slug)) { out.push({ slug, name }); have.add(slug); }
  }
  return out;
}

const requested = new Set(process.argv.slice(2).map((s) => s.toLowerCase()));
// Austin is owned by build-flagship-service-pages.mjs; never transform it here.
const targets = CITIES.filter((c) => c.slug !== 'austin' && (!requested.size || requested.has(c.slug)));

if (!targets.length) {
  throw new Error(requested.size ? `No matching cities for: ${[...requested].join(', ')}` : 'No cities to process.');
}

for (const cfg of SERVICES) assertVisibleStartPrice(cfg);

let built = 0;
let missing = 0;
for (const city of targets) {
  const ctx = { name: city.name, citySlug: city.slug, nearby: nearbyFor(city) };
  for (const cfg of SERVICES) {
    const file = join(ROOT, `${cfg.prefix}-${city.slug}-tx.html`);
    if (!existsSync(file)) { missing += 1; console.warn(`  skip (missing): ${cfg.prefix}-${city.slug}-tx.html`); continue; }
    const html = applyFlagshipToPage(readFileSync(file, 'utf8'), cfg, ctx, { replaceFaqSchema: true });
    writeFileSync(file, html);
    built += 1;
  }
}
console.log(`Done: ${built} pages across ${targets.length} cities${missing ? ` (${missing} missing files skipped)` : ''}.`);
