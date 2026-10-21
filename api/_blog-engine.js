// The blog engine: what to write next, what the writer is told, what an article
// must pass, which photo it gets, and how it reaches the site.
//
// Owner, 2026-10-21: "same old shit, every last one of them." The old pipeline
// was switched off, had published nothing since June 15, could not publish at
// all (it committed straight to main, which branch protection blocks), drew
// from 36 city-swapped topics ("TV mounting in Houston", "... in Dallas") that
// the anti-duplication rule forbids, used a small model with no catalog data,
// and gave every TV article the same stock photo.
//
// Now: one calendar of distinct topics (product, problem, season, buyer), the
// real catalog prices for the service, a FAQ, a photo no other article uses,
// the same renderer as the hand-written articles, and a pull request the owner
// merges so every guard in CI runs first.

import { getBookingCatalog } from './_pricing.js';
import { renderBlogArticle, guideCard } from '../scripts/lib/blog-article-page.mjs';

export const SITE = 'https://www.assembleatease.com';
export const BLOG_MODEL = process.env.BLOG_MODEL || 'claude-sonnet-5-5';

// Per catalog service: website photo slug, service page, booking link, label.
export const SERVICES = {
  'Furniture Assembly': { photo: 'furniture-assembly', page: '/furniture-assembly-austin-tx', book: '/book?service=Furniture+Assembly', cta: 'Book Furniture Assembly', tag: 'Furniture assembly', label: 'Furniture assembly service and pricing' },
  'Mounting & Hanging': { photo: 'tv-mounting', page: '/tv-mounting-austin-tx', book: '/book?service=Mounting+%26+Hanging', cta: 'Book TV Mounting', tag: 'TV mounting', label: 'TV mounting service and pricing' },
  'Smart Home': { photo: 'smart-home-installation', page: '/smart-home-installation-austin-tx', book: '/book?service=Smart+Home', cta: 'Book Smart Home Setup', tag: 'Smart home', label: 'Smart home setup service and pricing' },
  'Fitness Equipment': { photo: 'fitness-equipment-assembly', page: '/fitness-equipment-assembly-austin-tx', book: '/book?service=Fitness+Equipment', cta: 'Book Fitness Assembly', tag: 'Fitness equipment', label: 'Fitness equipment assembly and pricing' },
  'Office Assembly': { photo: 'office-furniture-assembly', page: '/office-furniture-assembly-austin-tx', book: '/book?service=Office+Assembly', cta: 'Book Office Assembly', tag: 'Office setup', label: 'Office furniture assembly and pricing' },
  'Outdoor & Playsets': { photo: 'playset-assembly', page: '/playset-assembly-austin-tx', book: '/book?service=Outdoor+%26+Playsets', cta: 'Book Outdoor Assembly', tag: 'Outdoor and playsets', label: 'Outdoor and playset assembly and pricing' },
};

/** blog/index.html group id for a service (matches renderIndex in cleanup-blog-pages.mjs). */
export function indexGroupId(service) {
  if (service === 'Mounting & Hanging') return 'tv-guides';
  if (service === 'Furniture Assembly') return 'furniture-guides';
  return 'home-guides';
}

// Months are 1-12 (Central time); empty means any time. Seasons follow the
// catalog's own seasons in assets/js/booking-source-of-truth.js.
// Each topic is a different question a real customer asks. No city variants.
export const BLOG_CALENDAR = [
  { slug: 'ikea-malm-dresser-assembly-and-anchoring', service: 'Furniture Assembly', months: [], topic: 'IKEA MALM dresser assembly and anti-tip anchoring: what the job involves and how to prepare' },
  { slug: 'ikea-hemnes-bed-and-dresser-assembly', service: 'Furniture Assembly', months: [], topic: 'IKEA HEMNES bed and dresser assembly: time, parts and room preparation' },
  { slug: 'sectional-sofa-assembly-guide', service: 'Furniture Assembly', months: [], topic: 'Sectional sofa assembly: connectors, legs and getting large pieces into the room' },
  { slug: 'bunk-bed-and-loft-bed-assembly-safety', service: 'Furniture Assembly', months: [7, 8], topic: 'Bunk bed and loft bed assembly: guardrails, ladders and safety checks' },
  { slug: 'crib-and-nursery-furniture-assembly', service: 'Furniture Assembly', months: [], topic: 'Crib, changing table and nursery furniture assembly before the baby arrives' },
  { slug: 'standing-desk-assembly-guide', service: 'Office Assembly', months: [1, 8, 9], topic: 'Standing desk assembly: frames, motors, cable trays and height settings' },
  { slug: 'office-chair-and-filing-cabinet-assembly', service: 'Office Assembly', months: [], topic: 'Office chairs, filing cabinets and bookcases: assembling a home office in one visit' },
  { slug: 'treadmill-assembly-guide', service: 'Fitness Equipment', months: [1, 2], topic: 'Treadmill assembly: delivery, placement, power and the safety key' },
  { slug: 'exercise-bike-and-rower-assembly', service: 'Fitness Equipment', months: [1, 2], topic: 'Exercise bike and rowing machine assembly: setup, leveling and first-ride checks' },
  { slug: 'power-rack-and-home-gym-assembly', service: 'Fitness Equipment', months: [1, 2, 9], topic: 'Power rack and home gym assembly: floor, ceiling height and attachments' },
  { slug: 'mounting-a-tv-above-a-fireplace', service: 'Mounting & Hanging', months: [10, 11, 12], topic: 'Mounting a TV above a fireplace: viewing height, heat, mantel clearance and mount choice' },
  { slug: 'tv-mounting-on-brick-and-stone', service: 'Mounting & Hanging', months: [], topic: 'TV mounting on brick, stone and tile: what changes compared with drywall' },
  { slug: 'soundbar-mounting-under-a-tv', service: 'Mounting & Hanging', months: [9, 10, 11], topic: 'Mounting a soundbar under a wall-mounted TV: spacing, brackets and cable paths' },
  { slug: 'fixed-tilting-or-full-motion-tv-mount', service: 'Mounting & Hanging', months: [], topic: 'Fixed, tilting or full-motion TV mount: how to choose for your room' },
  { slug: 'hiding-tv-cables-options', service: 'Mounting & Hanging', months: [], topic: 'Hiding TV cables: surface covers, cord kits and when in-wall routing needs a different trade' },
  { slug: 'mirror-and-art-hanging-guide', service: 'Mounting & Hanging', months: [], topic: 'Hanging large mirrors, art and floating shelves level and secure' },
  { slug: 'video-doorbell-installation-guide', service: 'Smart Home', months: [10, 11, 12], topic: 'Video doorbell installation: battery or replacing an existing doorbell, Wi-Fi and app setup' },
  { slug: 'smart-lock-installation-guide', service: 'Smart Home', months: [], topic: 'Smart lock installation: checking your door, deadbolt replacement and app setup' },
  { slug: 'smart-thermostat-installation-and-c-wire', service: 'Smart Home', months: [5, 6, 10], topic: 'Smart thermostat installation: compatibility, the C-wire question and first setup' },
  { slug: 'home-security-camera-placement', service: 'Smart Home', months: [11, 12], topic: 'Where to place indoor and outdoor security cameras, and what setup involves' },
  { slug: 'mesh-wifi-setup-for-a-whole-home', service: 'Smart Home', months: [8, 9], topic: 'Mesh Wi-Fi setup: node placement for a whole home and when an extender is enough' },
  { slug: 'backyard-playset-assembly-guide', service: 'Outdoor & Playsets', months: [3, 4, 5, 11, 12], topic: 'Backyard playset and swing set assembly: site, level ground and how long it takes' },
  { slug: 'gazebo-and-pergola-kit-assembly', service: 'Outdoor & Playsets', months: [3, 4, 5], topic: 'Gazebo and pergola kit assembly: footprint, anchoring and weather timing' },
  { slug: 'trampoline-assembly-and-safety-net', service: 'Outdoor & Playsets', months: [3, 4, 11, 12], topic: 'Trampoline assembly: springs, safety net and choosing a level spot' },
  { slug: 'patio-furniture-assembly-guide', service: 'Outdoor & Playsets', months: [3, 4, 5, 6], topic: 'Patio furniture assembly: sets, umbrellas and storing hardware for next season' },
  { slug: 'how-long-does-furniture-assembly-take', service: 'Furniture Assembly', months: [], topic: 'How long furniture assembly takes, item by item, and what makes it run longer' },
  { slug: 'missing-or-damaged-parts-before-assembly', service: 'Furniture Assembly', months: [], topic: 'Missing or damaged parts: what to check when the boxes arrive and what to do next' },
  { slug: 'move-in-week-setup-plan', service: 'Furniture Assembly', months: [5, 6, 7, 8], topic: 'Move-in week setup plan: what to assemble, mount and connect first' },
  { slug: 'back-to-school-desk-and-bed-setup', service: 'Furniture Assembly', months: [7, 8], topic: 'Back to school: desks, shelving and bed setup for students' },
  { slug: 'holiday-gift-assembly-planning', service: 'Outdoor & Playsets', months: [11, 12], topic: 'Holiday gifts that need assembly: playsets, trampolines and furniture, and how to time it' },
  { slug: 'new-year-home-gym-setup', service: 'Fitness Equipment', months: [12, 1, 2], topic: 'Setting up a home gym for the new year: space, flooring and equipment order' },
  { slug: 'game-day-tv-and-sound-setup', service: 'Mounting & Hanging', months: [8, 9, 10, 11], topic: 'Game day ready: TV placement, soundbar and streaming setup before the season' },
  { slug: 'furniture-assembly-for-property-managers', service: 'Furniture Assembly', months: [], topic: 'Furniture assembly for property managers: furnished units, turnovers and scheduling' },
  { slug: 'office-move-furniture-assembly-for-small-businesses', service: 'Office Assembly', months: [], topic: 'Office moves for small businesses: workstations, chairs and a weekend schedule' },
  { slug: 'what-to-prepare-before-your-assembly-appointment', service: 'Furniture Assembly', months: [], topic: 'What to prepare before an assembly appointment so the visit goes quickly' },
  { slug: 'whole-room-setup-in-one-visit', service: 'Furniture Assembly', months: [], topic: 'Setting up a whole room in one visit: bed, dresser, nightstands, TV and lighting' },
];

function monthOf(now) {
  return Number(new Intl.DateTimeFormat('en-US', { month: 'numeric', timeZone: 'America/Chicago' }).format(now));
}

const STOP = new Set('a an and the of for to in on with your what how when is are be or by it its that this from at as into before after you does do'.split(' '));
function words(text) {
  return new Set(String(text || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)));
}

/** Jaccard overlap of meaningful words; above 0.5 two titles answer the same question. */
export function titleOverlap(a, b) {
  const x = words(a); const y = words(b);
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both += 1;
  return both / (x.size + y.size - both);
}

/** The next topic: unused, not a near-duplicate of a live article, in season first. */
export function pickNextTopic({ existingSlugs = [], existingTitles = [], now = new Date(), calendar = BLOG_CALENDAR } = {}) {
  const month = monthOf(now);
  const fresh = calendar.filter((t) => !existingSlugs.includes(t.slug)
    && !existingTitles.some((title) => titleOverlap(title, t.topic) > 0.5));
  return fresh.find((t) => t.months.includes(month)) || fresh.find((t) => !t.months.length) || fresh[0] || null;
}

/** Catalog facts the writer may use: item names and real prices for the service. */
export function catalogFactsFor(service, catalog = getBookingCatalog()) {
  const items = [];
  for (const group of catalog?.subcategories?.[service] || []) {
    for (const item of group.items || []) {
      if (item.customQuote || !(item.price > 0)) continue;
      items.push({ name: item.name, price: item.price, addon: !!item.addon });
    }
  }
  const bookable = items.filter((i) => !i.addon);
  const fromPrice = bookable.length ? Math.min(...bookable.map((i) => i.price)) : null;
  return { service, fromPrice, items: items.slice(0, 30), prices: [...new Set(items.map((i) => i.price))] };
}

export function buildArticlePrompt(topic, facts) {
  const itemLines = facts.items.map((i) => `- ${i.name}: $${i.price}${i.addon ? ' (add-on to a booked item)' : ''}`).join('\n');
  const system = `You write practical guides for AssembleAtEase, a home-setup service in Texas: furniture assembly, TV and wall mounting, smart home device setup, fitness equipment, office furniture, and outdoor and playset assembly. Customers book online and pay once the job is done.

Write for someone about to do this job or book it. Be specific: steps, what to measure or check, what to have ready, what changes the time or the price, and what is outside the job. Plain, confident and calm. No fear openings ("can cost you thousands"), no hype, no filler, no rhetorical questions.

Facts you must respect:
- Pros bring their own tools. They do not supply mounts, brackets, anchors, hardware or parts; the customer provides the product and what came with it.
- No electrical work: no new outlets, no hardwiring, no moving circuits. If it comes up, say a licensed electrician handles that.
- Never claim job counts, years of experience, insurance, licences, guarantees, same-day availability, local staff or customer results.
- Prices: use only the catalog prices given, exactly, and only for the item named. Say "from $X" only with the lowest bookable price given. Never say "per item" unless the item line says per.
- Service area is Texas; the address is confirmed when booking. Do not name any city.
- Never use the word handyman. No emojis.

Return ONLY minified JSON, no markdown, with exactly these keys:
{"title": string, 40-65 characters, a clear statement or question a person would search,
 "description": one sentence, 110-155 characters, what the reader will learn,
 "metaDescription": one sentence, 120-160 characters, for search results,
 "quickAnswer": two or three sentences that answer the topic directly,
 "paragraphs": [two short opening paragraphs],
 "sections": [5 to 7 objects {"title": string, "paragraphs": [1 to 3 strings], "bullets": [0 to 7 strings]}; at least two sections have bullets; one section covers pricing using the catalog prices],
 "faq": [4 to 6 objects {"q": a real question, "a": a direct answer of one to three sentences}]}
The whole article (all strings together) is 900 to 1500 words.`;
  const user = `Topic: ${topic.topic}
Service: ${facts.service}
Lowest bookable price for this service: ${facts.fromPrice ? `$${facts.fromPrice}` : 'none, quote only'}
Catalog items and prices for this service:
${itemLines || '- none listed'}`;
  return { system, user };
}

const FORBIDDEN = [
  [/\bhandyman\b/i, 'uses the word handyman'],
  [/\b(?:we|our team|our pros?|easers?)\s+(?:are|is)\s+(?:fully\s+)?(?:licensed|insured|bonded)\b|\blicensed and insured\b|\bfully insured\b/i, 'claims a licence or insurance'],
  // "not guaranteed" is the honest wording; only a promise is refused.
  [/(?<!\bnot\s)(?<!\bno\s)(?<!\bisn't\s)\bguarantee(?:d|s)?\b/i, 'makes a guarantee'],
  [/\b(?:we|our team|the pro|your pro|easers?)\s+(?:will\s+)?(?:supply|supplies|provide|provides|bring|brings)\s+(?:the\s+|a\s+)?(?:mounts?|brackets?|anchors?|hardware|parts)\b/i, 'says we supply hardware'],
  [/\b(?:we recently|we have (?:helped|served|completed)|our customers (?:say|tell)|(?:dozens|hundreds|thousands) of (?:customers|jobs|homes|installs)|years of experience|same-day (?:is )?available|our local team)\b/i, 'claims experience, volume or availability'],
  [/\bcosts? (?:you )?(?:thousands|hundreds)\b|\bfire (?:risk|hazard)\b/i, 'uses scare copy'],
  [/\b(?:Austin|Houston|Dallas|San Antonio|Fort Worth|El Paso|Plano|Arlington|Round Rock|Georgetown)\b/, 'names a city'],
  [/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, 'contains an emoji'],
];

const cleanText = (v) => String(v || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

/**
 * Parse and check the writer's JSON. Returns { ok, reason?, article } where
 * article = { title, description, metaDescription, quickAnswer, paragraphs, sections, faq, wordCount }.
 */
export function validateArticleData(raw, { allowedPrices = [] } = {}) {
  let data;
  try {
    const text = String(raw || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    data = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  } catch (_) {
    return { ok: false, reason: 'Writer did not return valid JSON.' };
  }
  const article = {
    title: cleanText(data.title),
    description: cleanText(data.description),
    metaDescription: cleanText(data.metaDescription),
    quickAnswer: cleanText(data.quickAnswer),
    paragraphs: (Array.isArray(data.paragraphs) ? data.paragraphs : []).map(cleanText).filter(Boolean),
    sections: (Array.isArray(data.sections) ? data.sections : []).map((s) => ({
      title: cleanText(s?.title),
      paragraphs: (Array.isArray(s?.paragraphs) ? s.paragraphs : []).map(cleanText).filter(Boolean),
      bullets: (Array.isArray(s?.bullets) ? s.bullets : []).map(cleanText).filter(Boolean),
    })).filter((s) => s.title && s.paragraphs.length),
    faq: (Array.isArray(data.faq) ? data.faq : []).map((f) => ({ q: cleanText(f?.q), a: cleanText(f?.a) })).filter((f) => f.q && f.a),
  };
  const all = [article.title, article.description, article.metaDescription, article.quickAnswer, ...article.paragraphs,
    ...article.sections.flatMap((s) => [s.title, ...s.paragraphs, ...s.bullets]), ...article.faq.flatMap((f) => [f.q, f.a])].join(' ');
  article.wordCount = all.split(/\s+/).filter(Boolean).length;
  const fail = (reason) => ({ ok: false, reason, article });

  if (article.title.length < 35 || article.title.length > 70) return fail(`Title is ${article.title.length} characters.`);
  if (article.description.length < 90 || article.description.length > 165) return fail(`Description is ${article.description.length} characters.`);
  if (article.metaDescription.length < 110 || article.metaDescription.length > 165) return fail(`Meta description is ${article.metaDescription.length} characters.`);
  if (!article.quickAnswer || article.paragraphs.length < 1) return fail('Missing quick answer or opening.');
  if (article.sections.length < 5) return fail(`Only ${article.sections.length} sections.`);
  if (article.sections.filter((s) => s.bullets.length).length < 2) return fail('Fewer than two checklists.');
  if (article.faq.length < 4) return fail(`FAQ has ${article.faq.length} questions.`);
  if (article.wordCount < 850) return fail(`Too thin (${article.wordCount} words).`);
  if (article.wordCount > 2000) return fail(`Too long (${article.wordCount} words).`);
  for (const [re, why] of FORBIDDEN) if (re.test(all)) return fail(`Content ${why} ("${all.match(re)[0]}").`);
  const allowed = new Set(allowedPrices.map(Number));
  const unknown = [...all.matchAll(/\$\s?(\d{1,4})(?:\.\d{2})?/g)].map((m) => Number(m[1])).filter((p) => !allowed.has(p));
  if (unknown.length) return fail(`Price not in the catalog: $${unknown[0]}.`);
  return { ok: true, article };
}

// Real and service photos per catalog service, most authentic first.
const STATIC_PHOTOS = {
  'Furniture Assembly': ['/images/real-furniture-dresser-wood.jpg', '/images/real-furniture-dresser-white-1200.webp', '/images/real-furniture-bed-paneled-400.webp', '/images/service-furniture-assembly.jpg'],
  'Mounting & Hanging': ['/images/real-tv-mount-console.jpg', '/images/real-tv-dawg-days.jpg', '/images/real-tv-setup-console.jpg', '/images/work-tv-mounting.jpg', '/images/service-tv-mounting.jpg'],
  'Smart Home': ['/images/real-smarthome-doorbell-adt.jpg', '/images/real-smarthome-doorbell-vivint-1024.webp', '/images/work-smart-home.jpg', '/images/service-smart-home.jpg'],
  'Fitness Equipment': ['/images/real-fitness-home-gym.jpg', '/images/work-fitness-equipment.jpg', '/images/service-fitness-equipment.jpg'],
  'Office Assembly': ['/images/real-office-home-ldesk.jpg', '/images/real-office-workstations.jpg', '/images/real-office-cabinets.jpg', '/images/service-office-assembly.jpg', '/images/work-office-assembly.jpg'],
  'Outdoor & Playsets': ['/images/real-outdoor-gazebo-356.webp', '/images/real-outdoor-patio-gray.jpg', '/images/real-outdoor-covered-patio.jpg', '/images/work-outdoor-playset.jpg', '/images/service-outdoor-playsets.jpg'],
};

const photoKey = (u) => String(u || '').replace(/^https?:\/\/[^/]+/, '').replace(/-(?:\d{3,4})\.webp$|\.(?:jpg|jpeg|png|webp)$/i, '');

/** A photo no live article uses: published job photos first, then unused site photos. */
export function pickArticleImage({ service, usedImages = [], jobPhotos = [] }) {
  const used = new Set(usedImages.map(photoKey));
  const label = (SERVICES[service]?.tag || 'Home setup').toLowerCase();
  const job = jobPhotos.find((p) => p.url && !used.has(photoKey(p.url)));
  if (job) return { image: job.url, alt: job.alt || `Completed ${label} job`, source: 'job-photo', reused: false };
  const pool = STATIC_PHOTOS[service] || [];
  const free = pool.find((p) => !used.has(photoKey(p)));
  if (free) return { image: free, alt: `Completed ${label} job`, source: 'site-photo', reused: false };
  return { image: pool[0] || '/images/people-service-calm.jpg', alt: `Completed ${label} job`, source: 'site-photo', reused: true };
}

/** The live article closest to a topic, as a related link (the third one every article shows). */
export function relatedArticleFor(indexHtml, topic) {
  const cards = [...String(indexHtml || '').matchAll(/<a href="(\/blog\/[a-z0-9-]+)" class="guide-card">[\s\S]*?<span class="guide-title"[^>]*>([^<]+)<\/span>/g)]
    .map((m) => ({ href: m[1], label: m[2].replace(/&amp;/g, '&') }))
    .filter((c) => c.href !== `/blog/${topic.slug}`);
  if (!cards.length) return null;
  const scored = cards.map((c) => ({ ...c, score: titleOverlap(c.label, topic.topic) }));
  scored.sort((a, b) => b.score - a.score);
  return { href: scored[0].href, label: scored[0].label };
}

/** Everything a new article needs: its data file, rendered page and index card. */
export function buildEngineArticle({ topic, article, image, today, related = [] }) {
  const svc = SERVICES[topic.service];
  const post = {
    slug: topic.slug,
    title: article.title,
    tag: svc.tag,
    image: image.image,
    alt: image.alt,
    serviceUrl: svc.book,
    cta: svc.cta,
    description: article.description,
    metaDescription: article.metaDescription,
    paragraphs: article.paragraphs.slice(0, 2),
    relatedLinks: [{ href: svc.page, label: svc.label }, { href: '/pricing', label: 'Complete service pricing' }, ...related].slice(0, 3),
  };
  const content = {
    published: today,
    modified: today,
    quickAnswer: article.quickAnswer,
    sections: article.sections,
    faq: article.faq,
  };
  const html = renderBlogArticle(post, content, { related: post.relatedLinks, defaultModified: today });
  return { post, content, html, card: guideCard(post) };
}

/** Add a card to the right group of blog/index.html and the article to its CollectionPage schema. */
export function addToBlogIndex(indexHtml, { card, groupId, title, url }) {
  const grid = new RegExp(`(<section class="guide-group" id="${groupId}"[\\s\\S]*?<div class="guides-grid">)`);
  const withCard = indexHtml.replace(grid, (m) => `${m}\n${card}`);
  if (withCard === indexHtml) throw new Error(`Group ${groupId} not found in blog/index.html`);
  let found = false;
  const updated = withCard.replace(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g, (full, json) => {
    try {
      const data = JSON.parse(json);
      const nodes = Array.isArray(data['@graph']) ? data['@graph'] : [data];
      const page = nodes.find((n) => n?.['@type'] === 'CollectionPage');
      const list = page?.mainEntity?.itemListElement;
      if (!Array.isArray(list)) return full;
      found = true;
      if (!list.some((item) => item?.url === url)) list.push({ '@type': 'ListItem', position: list.length + 1, name: title, url });
      list.forEach((item, i) => { item.position = i + 1; });
      return `<script type="application/ld+json">${JSON.stringify(data)}</script>`;
    } catch (_) {
      return full;
    }
  });
  if (!found) throw new Error('CollectionPage schema not found in blog/index.html');
  return updated;
}

export function addToSitemap(sitemap, { url, today }) {
  if (sitemap.includes(`<loc>${url}</loc>`)) return sitemap;
  const entry = `  <url><loc>${url}</loc><lastmod>${today}</lastmod><priority>0.6</priority></url>`;
  return sitemap
    .replace(/(<loc>https:\/\/www\.assembleatease\.com\/blog<\/loc>\s*<lastmod>)[^<]+/, `$1${today}`)
    .replace(/\s*<\/urlset>\s*$/, `\n${entry}\n</urlset>\n`);
}

// ── GitHub: read main, publish through a pull request ────────────────────────

const REPO = () => process.env.BLOG_REPO || 'Bango703/--Name-it-assembleatease';

async function gh(token, path, { method = 'GET', body, fetchImpl = globalThis.fetch } = {}) {
  const res = await fetchImpl(`https://api.github.com/repos/${REPO()}${path}`, {
    method,
    headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) {}
  if (!res.ok) throw new Error(`GitHub ${method} ${path} failed (${res.status}): ${String(json?.message || text).slice(0, 200)}`);
  return json;
}

export async function readRepoFile(token, path, opts = {}) {
  const data = await gh(token, `/contents/${path}?ref=main`, opts);
  return { content: Buffer.from(data.content, 'base64').toString('utf8'), sha: data.sha };
}

export async function listRepoDir(token, path, opts = {}) {
  try {
    const data = await gh(token, `/contents/${path}?ref=main`, opts);
    return Array.isArray(data) ? data : [];
  } catch (error) {
    if (/\(404\)/.test(error.message)) return [];
    throw error;
  }
}

/** Open (or find) the article's pull request. files: [{ path, content, sha? }]. */
export async function openBlogPullRequest({ token, slug, title, body, files, fetchImpl = globalThis.fetch }) {
  const opts = { fetchImpl };
  const branch = `blog/${slug}`;
  const open = await gh(token, `/pulls?state=open&head=${encodeURIComponent(REPO().split('/')[0])}:${encodeURIComponent(branch)}`, opts);
  if (Array.isArray(open) && open.length) return { branch, number: open[0].number, url: open[0].html_url, existing: true };
  const main = await gh(token, '/git/ref/heads/main', opts);
  await gh(token, '/git/refs', { ...opts, method: 'POST', body: { ref: `refs/heads/${branch}`, sha: main.object.sha } });
  for (const file of files) {
    await gh(token, `/contents/${file.path}`, {
      ...opts,
      method: 'PUT',
      body: { message: `Blog: ${title} (${file.path})`, content: Buffer.from(file.content).toString('base64'), branch, ...(file.sha ? { sha: file.sha } : {}) },
    });
  }
  const pr = await gh(token, '/pulls', { ...opts, method: 'POST', body: { title: `Blog: ${title}`, head: branch, base: 'main', body } });
  return { branch, number: pr.number, url: pr.html_url, existing: false };
}
