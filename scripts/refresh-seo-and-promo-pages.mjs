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
    `Furniture assembly in ${city}, TX for beds, dressers, desks, tables, and IKEA builds. Clean, careful setup with fast local follow-up.`,
  'tv-mounting': (city) =>
    `TV mounting in ${city}, TX for TVs, shelves, mirrors, and wall installs. Clean, level work with fast local confirmation.`,
  'smart-home-installation': (city) =>
    `Smart home installation in ${city}, TX for locks, cameras, thermostats, and doorbells. Installed, connected, and tested before we leave.`,
  'fitness-equipment-assembly': (city) =>
    `Fitness equipment assembly in ${city}, TX for treadmills, bikes, benches, and home gyms. Solid assembly, leveling, and cleanup included.`,
  'office-furniture-assembly': (city) =>
    `Office furniture assembly in ${city}, TX for desks, chairs, and workstations. Home-office and commercial setups built square and ready to use.`,
  'playset-assembly': (city) =>
    `Playset assembly in ${city}, TX for trampolines, swing sets, pergolas, and gazebos. Backyard builds assembled safely and checked before we go.`,
};

// Orphan one-off pages (ikea/gazebo/trampoline) were removed and 301-redirected
// to their canonical service pages in vercel.json. Nothing to regenerate here.
const EXACT_FILE_DESCRIPTIONS = {};

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
