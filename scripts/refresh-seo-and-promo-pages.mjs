import { readFileSync, readdirSync, writeFileSync } from 'node:fs';

const CITY_NAMES = {
  austin: 'Austin',
  'bee-cave': 'Bee Cave',
  buda: 'Buda',
  'cedar-park': 'Cedar Park',
  georgetown: 'Georgetown',
  hutto: 'Hutto',
  kyle: 'Kyle',
  lakeway: 'Lakeway',
  leander: 'Leander',
  manor: 'Manor',
  pflugerville: 'Pflugerville',
  'round-rock': 'Round Rock',
};

const SERVICE_DESCRIPTIONS = {
  'furniture-assembly': (city) =>
    `Furniture assembly in ${city}, TX for beds, dressers, desks, tables, and IKEA builds. Upfront pricing, service-call fee, and taxes are shown before checkout.`,
  'tv-mounting': (city) =>
    `TV mounting in ${city}, TX for TVs, shelves, mirrors, and wall installs with upfront pricing shown before checkout.`,
  'smart-home-installation': (city) =>
    `Smart home installation in ${city}, TX for locks, cameras, thermostats, and doorbells with upfront pricing before checkout.`,
  'fitness-equipment-assembly': (city) =>
    `Fitness equipment assembly in ${city}, TX for treadmills, bikes, benches, and home gyms with upfront pricing before checkout.`,
  'office-furniture-assembly': (city) =>
    `Office furniture assembly in ${city}, TX for desks, chairs, and workstations with upfront pricing before checkout.`,
  'playset-assembly': (city) =>
    `Playset assembly in ${city}, TX for trampolines, swing sets, pergolas, and gazebos with upfront pricing before checkout.`,
};

const EXACT_FILE_DESCRIPTIONS = {
  'ikea-assembly-austin-tx.html':
    'IKEA furniture assembly in Austin, TX for beds, dressers, desks, shelving, and wardrobes with upfront pricing before checkout.',
  'gazebo-assembly-austin-tx.html':
    'Gazebo assembly in Austin, TX for backyard kits, pergolas, and outdoor structures with upfront pricing before checkout.',
  'trampoline-assembly-austin-tx.html':
    'Trampoline assembly in Austin, TX for round, rectangular, and backyard trampoline setups with upfront pricing before checkout.',
};

const PROMO_SCRIPT = '<script src="/assets/js/site-promo.js" defer></script>';
const files = readdirSync('.').filter((name) => name.endsWith('.html'));

function updateOrInsertMeta(html, description) {
  let next = html.replace(
    /<meta name="description" content="[^"]*"\s*\/?>/i,
    `<meta name="description" content="${description}"/>`,
  );
  next = next.replace(
    /<meta property="og:description" content="[^"]*"\s*\/?>/i,
    `<meta property="og:description" content="${description}"/>`,
  );

  if (/<meta name="twitter:description"/i.test(next)) {
    next = next.replace(
      /<meta name="twitter:description" content="[^"]*"\s*\/?>/i,
      `<meta name="twitter:description" content="${description}"/>`,
    );
  } else {
    next = next.replace(
      /(<meta name="twitter:title"[^>]*>\s*)/i,
      `$1<meta name="twitter:description" content="${description}"/>\n`,
    );
  }
  return next;
}

function ensurePromoScript(html) {
  if (html.includes('/assets/js/site-promo.js')) return html;
  return html.replace('</head>', `${PROMO_SCRIPT}\n</head>`);
}

function resolveMetaDescription(file) {
  if (EXACT_FILE_DESCRIPTIONS[file]) return EXACT_FILE_DESCRIPTIONS[file];
  for (const [serviceSlug, builder] of Object.entries(SERVICE_DESCRIPTIONS)) {
    if (!file.startsWith(`${serviceSlug}-`) || !file.endsWith('-tx.html')) continue;
    const citySlug = file.slice(serviceSlug.length + 1, -'-tx.html'.length);
    const cityName = CITY_NAMES[citySlug];
    if (!cityName) return null;
    return builder(cityName);
  }
  return null;
}

for (const file of files) {
  const description = resolveMetaDescription(file);
  if (!description) continue;

  let html = readFileSync(file, 'utf8');
  const updated = ensurePromoScript(updateOrInsertMeta(html, description));
  if (updated !== html) writeFileSync(file, updated);
}

console.log('Refreshed SEO descriptions and promo script tags on service pages.');
