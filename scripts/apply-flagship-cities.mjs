// Transforms existing Texas city/service pages to the flagship layout, reusing
// the SAME template + builders as the Austin flagship pages
// (build-flagship-service-pages.mjs). It preserves each page's per-city <head>
// SEO (title, canonical, meta, breadcrumb schema) and only swaps the visible
// body, the flagship CSS, the Service schema, and the FAQPage schema.
//
// Usage: node scripts/apply-flagship-cities.mjs <citySlug> [<citySlug> ...]
// The city roster + neighbors mirror scripts/generate-location-pages.js.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SERVICES, applyFlagshipToPage, assertVisibleStartPrice } from './build-flagship-service-pages.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// name + neighbors per city (neighbors resolved to real generated slugs so the
// nearby-links never 404). Matches the CITIES data in generate-location-pages.js.
const CITY_DATA = {
  dallas: { name: 'Dallas', nearby: [['irving', 'Irving'], ['garland', 'Garland'], ['plano', 'Plano'], ['fort-worth', 'Fort Worth']] },
};

function cityContext(slug) {
  const data = CITY_DATA[slug];
  if (!data) throw new Error(`No city data for "${slug}". Add it to CITY_DATA.`);
  return {
    name: data.name,
    citySlug: slug,
    nearby: data.nearby.map(([s, n]) => ({ slug: s, name: n })),
  };
}

const slugs = process.argv.slice(2);
if (!slugs.length) throw new Error('Pass at least one city slug, e.g. node scripts/apply-flagship-cities.mjs dallas');

for (const cfg of SERVICES) assertVisibleStartPrice(cfg);

let built = 0;
for (const slug of slugs) {
  const city = cityContext(slug);
  for (const cfg of SERVICES) {
    const file = join(ROOT, `${cfg.prefix}-${slug}-tx.html`);
    if (!existsSync(file)) {
      console.warn(`  skip (missing): ${cfg.prefix}-${slug}-tx.html`);
      continue;
    }
    const html = applyFlagshipToPage(readFileSync(file, 'utf8'), cfg, city, { replaceFaqSchema: true });
    writeFileSync(file, html);
    built += 1;
    console.log(`  built ${cfg.prefix}-${slug}-tx.html`);
  }
}
console.log(`Done: ${built} pages across ${slugs.length} city(ies).`);
