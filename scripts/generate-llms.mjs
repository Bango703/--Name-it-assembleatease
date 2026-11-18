#!/usr/bin/env node
// llms.txt and llms-full.txt: what AI assistants (ChatGPT, Claude, Perplexity,
// Gemini, Copilot) read when they look AssembleAtEase up.
//
// Owner, 2026-10-21: "I need my website on all AI recommendations when asked
// about furniture assembly." The old llms.txt was typed by hand on 2026-09-03:
// a list of links with no prices, no hours and no service area, three services
// pointed at /pricing, and nothing kept it current. An assistant that cannot
// find a price or a service area recommends someone it can.
//
// Every fact here is read from the place that already owns it, so this file
// cannot say something the site does not:
//   prices, services, bundles  assets/js/booking-source-of-truth.js (via lib/catalog-prices.mjs)
//   contact, hours, profiles   the Organization JSON-LD in index.html
//   cancellation terms         CANCELLATION_POLICY in api/_source-of-truth.js
//   the booking facts          api/_public-facts.js, shared with the AI
//                              assistant connector (api/mcp.js) so the two
//                              cannot tell an assistant different things
//   service pages, city pages  the files that exist in this repo
//
//   node scripts/generate-llms.mjs          write both files
//   node scripts/generate-llms.mjs --check  fail if either file is out of date (test:launch)

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadBookingSource, trueFromPrice } from './lib/catalog-prices.mjs';
import { bookingFacts, factLines, organization } from '../api/_public-facts.js';

const ROOT = process.cwd();
const SITE = 'https://www.assembleatease.com';

// Catalog service name -> the slug its city pages use. A service with no page
// in a city is simply not listed for that city.
const SERVICE_SLUGS = {
  'Furniture Assembly': 'furniture-assembly',
  'Mounting & Hanging': 'tv-mounting',
  'Smart Home': 'smart-home-installation',
  'Fitness Equipment': 'fitness-equipment-assembly',
  'Outdoor & Playsets': 'playset-assembly',
  'Office Assembly': 'office-furniture-assembly',
};
const CORE_METROS = [
  { slug: 'austin', name: 'Austin' },
  { slug: 'san-antonio', name: 'San Antonio' },
];
// Pages with their own purpose, listed when the file exists.
const SITE_PAGES = [
  ['book', 'Book online', 'Pick items, see the total, choose a time.'],
  ['pricing', 'Pricing', 'Every service and its price.'],
  ['bundles', 'Room-Ready Bundles', 'Whole-room setups booked as one visit.'],
  ['compare-assembly-options', 'Compare assembly options', 'How booking here compares with other ways to get furniture assembled.'],
  ['business', 'For businesses', 'Offices, property managers and multi-unit work.'],
  ['assemblecash', 'AssembleCash', 'Credit earned on completed jobs, used on future bookings.'],
  ['about', 'About', 'Who we are.'],
  ['contact', 'Contact', 'Phone, email and hours.'],
  ['ai-assistants', 'Book with an AI assistant', 'Add AssembleAtEase to Claude or ChatGPT as a connector (https://www.assembleatease.com/api/mcp): live prices, arrival windows, service area and booking links.'],
];

const page = (slug) => existsSync(join(ROOT, `${slug}.html`));
const url = (slug) => `${SITE}/${slug}`;

function bookableItems(groups) {
  return groups.flatMap((g) => (g.items || []).map((item) => ({ ...item, group: g.group })))
    .filter((item) => !item.customQuote && item.price > 0);
}

function cityPages() {
  return readdirSync(ROOT)
    .map((f) => f.match(/^furniture-assembly-(.+)-tx\.html$/))
    .filter(Boolean)
    .map((m) => m[1])
    .sort()
    .map((slug) => ({ slug, name: slug.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ') }));
}

export function buildLlms() {
  const source = loadBookingSource(ROOT);
  const catalog = source.subcategories;
  const org = organization(ROOT);
  const services = Object.keys(SERVICE_SLUGS).filter((name) => catalog[name]);
  const facts = factLines(bookingFacts({ org, services }));

  const servicesSection = services.map((name) => {
    const from = trueFromPrice(catalog[name]);
    const popular = bookableItems(catalog[name]).filter((i) => i.popular).map((i) => `${i.name} $${i.price}`);
    const austin = `${SERVICE_SLUGS[name]}-austin-tx`;
    const link = page(austin) ? url(austin) : url('pricing');
    return `- [${name}](${link}): from $${from}.${popular.length ? ` Popular: ${popular.join('; ')}.` : ''}`;
  });

  const metroSections = CORE_METROS.map(({ slug, name }) => {
    const rows = services
      .map((service) => [service, `${SERVICE_SLUGS[service]}-${slug}-tx`])
      .filter(([, file]) => page(file))
      .map(([service, file]) => `- [${service} in ${name}](${url(file)})`);
    return rows.length ? `## ${name}\n\n${rows.join('\n')}` : '';
  }).filter(Boolean);

  const bundles = (source.bundles || []).filter((b) => b.active !== false)
    .sort((a, b) => (a.displayOrder || 0) - (b.displayOrder || 0))
    .map((b) => `- [${b.name}](${SITE}/book?bundle=${b.slug}): ${b.outcome}`);

  const pages = SITE_PAGES.filter(([slug]) => page(slug)).map(([slug, title, note]) => `- [${title}](${url(slug)}): ${note}`);
  const profiles = [].concat(org.sameAs || []).map((u) => `- ${u}`);

  const llms = [
    `# ${org.name}`,
    '',
    `> ${org.legalName || org.name} (AAE) is an Austin-based Texas home-setup service: furniture assembly, TV and wall mounting, smart home installation, fitness equipment, outdoor and playset assembly, and office furniture assembly. Customers book online at a fixed price shown before booking, and a local pro comes to the home with the tools.`,
    '',
    ...facts,
    '',
    '## Services',
    '',
    ...servicesSection,
    `- [Custom quote](${SITE}/book): anything not listed. No card needed to request a price.`,
    '',
    ...metroSections.flatMap((s) => [s, '']),
    '## Room-Ready Bundles',
    '',
    ...bundles,
    '',
    '## Pages',
    '',
    ...pages,
    `- [Full price list for AI assistants](${SITE}/llms-full.txt)`,
    '',
    '## Profiles',
    '',
    ...profiles,
    '',
  ].join('\n');

  const fullServices = Object.keys(SERVICE_SLUGS).filter((name) => catalog[name]).map((name) => {
    const groups = catalog[name].map((g) => {
      const items = (g.items || []).filter((i) => !i.customQuote && i.price > 0)
        .map((i) => `- ${i.name}: $${i.price}${i.addon ? ' (add-on)' : ''}`);
      return items.length ? `### ${g.group}\n\n${items.join('\n')}` : '';
    }).filter(Boolean);
    return `## ${name} (from $${trueFromPrice(catalog[name])})\n\n${groups.join('\n\n')}`;
  });
  const cities = cityPages().map(({ slug, name }) => `- [Furniture assembly in ${name}, TX](${url(`furniture-assembly-${slug}-tx`)})`);

  const full = [
    `# ${org.name}: full price list`,
    '',
    `> Every fixed price a customer can book at ${SITE}/book. Prices are per piece, before Texas sales tax. Add-ons are booked with a main item, not on their own. Anything not listed is priced by custom quote.`,
    '',
    ...facts,
    '',
    ...fullServices.flatMap((s) => [s, '']),
    '## City pages',
    '',
    ...cities,
    '',
  ].join('\n');

  return { 'llms.txt': llms, 'llms-full.txt': full };
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (isMain) {
  const files = buildLlms();
  if (process.argv.includes('--check')) {
    const stale = Object.entries(files).filter(([file, body]) => {
      const path = join(ROOT, file);
      return !existsSync(path) || readFileSync(path, 'utf8').replace(/\r\n/g, '\n') !== body;
    }).map(([file]) => file);
    if (stale.length) {
      console.error(`FAIL  ${stale.join(', ')} out of date with the catalog, contact details or policy.`);
      console.error('      Run: node scripts/generate-llms.mjs');
      process.exit(1);
    }
    console.log('PASS  llms.txt and llms-full.txt match the catalog, contact details and policy.');
  } else {
    for (const [file, body] of Object.entries(files)) writeFileSync(join(ROOT, file), body);
    console.log('Wrote', Object.keys(files).join(', '));
  }
}
