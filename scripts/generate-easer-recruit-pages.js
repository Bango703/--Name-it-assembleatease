#!/usr/bin/env node
// scripts/generate-easer-recruit-pages.js
// Generates the Easer recruitment engine: one hub page (/become-an-easer) + a localized
// recruitment page per Texas city (/easer-jobs-<slug>-tx), and registers them in sitemap.xml.
//
// Design guardrails (from the board/panel review):
//  - Anti-doorway: every city page carries genuinely localized content (metro nearby list,
//    served-vs-expanding status, honest demand framing). Value/benefit copy stays
//    location-neutral (city name only in title/meta/JSON-LD/eyebrow/H1/service-area/FAQ).
//  - Honest JobPosting: employmentType CONTRACTOR, paid per completed job, volume varies —
//    NO fabricated salary. Only truthful because the platform genuinely takes bookings in
//    these cities and needs the supply to honor its statewide customer promise.
//  - Tools-only: pros bring their own TOOLS; we never claim to supply hardware/parts.
//  - Reuses the ONE city list (scripts/lib/texas-cities.mjs) + governed nav/footer/consent.
//  - Every number on the page comes from its source: the Easer share from
//    getPlatformFeePct, the service fee from SERVICE_CALL_ZONES, the pay examples
//    from the booking catalog (assets/js/booking-source-of-truth.js). Change a
//    price and the pages change with the next run.
//  - Layout (owner, 2026-11-12: "smooth, rather than a bunch of block sections"):
//    open sections that alternate density, one photo on the hub, rows and a
//    timeline instead of stacked bordered cards, each fact said once.
//
// Run: node scripts/generate-easer-recruit-pages.js
// Then: node scripts/public-footer-sync.mjs && node scripts/app-banner-sync.mjs

import { writeFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';
import { buildPublicCookieConsentBlock } from './lib/public-consent.mjs';
import { buildPublicFooterBlock } from './lib/public-footer.mjs';
import { buildPublicNavBlock } from './lib/public-nav.mjs';
import { ALL_TEXAS_CITIES, isIndexedEaserJobsPage } from './lib/texas-cities.mjs';
import { fitTitle } from './lib/seo-title.mjs';
import { getPlatformFeePct, SERVICE_CALL_ZONES } from '../api/_source-of-truth.js';
import { APP_STORE, APP_STORE_BADGE_SVG, APPLE_TRADEMARK_CREDIT } from '../api/_app-store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const TODAY = '2026-11-12';
// No validThrough: the role has no expiration date, and a baked-in date on a static
// page silently expires every posting (Google drops them). Google: omit it when the
// posting does not expire.
const ORIGIN = 'https://www.assembleatease.com';

// The cities we actively dispatch in today (mirrors SERVED in assets/js/aae-location.js).
// Served -> "actively booking"; everything else -> honest "expanding / be first in line".
const SERVED_SLUGS = new Set([
  'austin', 'round-rock', 'cedar-park', 'georgetown', 'pflugerville', 'kyle',
  'buda', 'lakeway', 'bee-cave', 'manor', 'leander', 'hutto',
]);

// The four priority hubs (owner direction 2026-10-27) and their recruiting pages.
const HUBS = [
  { name: 'Austin', slug: 'austin' },
  { name: 'Houston', slug: 'houston' },
  { name: 'San Antonio', slug: 'san-antonio' },
  { name: 'Dallas-Fort Worth', slug: 'dallas' },
];

function esc(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function safeJson(obj) {
  return JSON.stringify(obj).replace(/<\//g, '<\\/');
}
function dollars(cents) {
  return cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;
}

// ── Pay, from the sources of truth ──
const EASER_SHARE_PCT = 100 - getPlatformFeePct(false);
const SERVICE_FEE_CENTS = SERVICE_CALL_ZONES.austin_core.fee;

function loadCatalog() {
  const context = { window: {} };
  vm.createContext(context);
  vm.runInContext(readFileSync(join(ROOT, 'assets/js/booking-source-of-truth.js'), 'utf8'), context);
  const items = [];
  JSON.stringify(context.window.AAE_BOOKING_SOURCE, (key, value) => {
    if (value && typeof value === 'object' && typeof value.name === 'string' && typeof value.price === 'number') items.push(value);
    return value;
  });
  return items;
}
const CATALOG = loadCatalog();
const PAY_EXAMPLES = [
  { label: 'TV mount, 56" to 65"', item: 'TV 56"–65" (standard wall)' },
  { label: 'Treadmill assembly', item: 'Treadmill assembly' },
  { label: 'Backyard swing set', item: 'Swing set / backyard playset assembly' },
].map(({ label, item }) => {
  const found = CATALOG.find((entry) => entry.name === item);
  if (!found) throw new Error(`Pay example item not in the catalog: ${item}`);
  const jobCents = Math.round(found.price * 100) + SERVICE_FEE_CENTS;
  return { label, jobCents, earnCents: Math.round(jobCents * EASER_SHARE_PCT / 100) };
});

// ── Shared, LOCATION-NEUTRAL recruitment content (one source, never per-city duplicated) ──
const ICONS = {
  calendar: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M8 3v4M16 3v4M3 10h18"/></svg>',
  tag: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8.5" r="1.5"/></svg>',
  bank: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 10l9-6 9 6M5 10v8M10 10v8M14 10v8M19 10v8M3 21h18"/></svg>',
};
const WHY = [
  { icon: 'calendar', t: 'Choose your jobs', d: 'Offers come to your phone. Take the ones that fit your week. No shifts, quotas or minimum hours.' },
  { icon: 'tag', t: 'Know the pay first', d: 'Every offer shows what you earn before you accept. Tips are 100% yours.' },
  { icon: 'bank', t: 'Get paid after each job', d: 'Earnings go to your bank through Stripe once the job is confirmed. Instant payout is available when your bank supports it.' },
];
const STEPS = [
  { t: 'Apply', d: 'A few minutes online. Have your own tools, reliable transportation and a smartphone.' },
  { t: 'Verify and sign', d: 'Confirm your identity and sign the independent-contractor agreement.' },
  { t: 'Get approved', d: 'We review your application and turn on job offers for your area.' },
  { t: 'Take jobs, get paid', d: 'Accept offers near you, do careful work, and get paid after each completed job.' },
];

function sharedFaqs() {
  const [first] = PAY_EXAMPLES;
  return [
    { q: 'Is this a job or independent contractor work?', a: 'Independent-contractor work. You set your own schedule, use your own tools, and are paid per completed job. You sign an independent-contractor agreement during onboarding.' },
    { q: 'How much do I earn?', a: `You keep ${EASER_SHARE_PCT}% of each job&rsquo;s price before tax, plus 100% of tips. A ${esc(first.label)} pays you ${dollars(first.earnCents)}. Earnings depend on how many jobs you take; there are no guaranteed hours.` },
    { q: 'How and when do I get paid?', a: 'After the job is completed and confirmed, your earnings go to your bank through Stripe once your payout setup is done. Instant payout is available when your bank supports it.' },
    { q: 'Is there an application fee?', a: 'No application fee while your area is still adding Easers. Any fee for your area is shown before you apply.' },
    { q: 'Do I need insurance?', a: 'You keep any insurance the law requires for your work, and car insurance if you drive to jobs. General liability insurance is strongly recommended. AssembleAtEase does not provide insurance for contractors.' },
    { q: 'Do I bring parts or mounts?', a: 'No. You bring your own tools. Customers supply their own furniture, mounts and hardware.' },
    { q: 'Is there an app?', a: 'Yes. On iPhone, work your jobs in the Easer by AssembleAtEase app. On Android or a computer, use the Easer dashboard on the website.' },
  ];
}

function heroStatus(city, served) {
  return served
    ? `We&rsquo;re actively booking jobs in ${esc(city.name)} right now.`
    : `We&rsquo;re expanding in ${esc(city.name)}. Get approved now to be first in line as jobs open up.`;
}
function volumeFaqAnswer(city, served) {
  return served
    ? `${city.name} is an active service area, so approved pros are matched to nearby jobs as customers book them. Job volume is demand-driven and varies week to week. There are no guaranteed hours because every assignment is a completed job you choose to accept.`
    : `We accept customer bookings across ${city.name} and confirm a local pro for each one, so the opportunity is real, but ${city.name} is a newer market and volume is still growing. Getting approved now puts you in position to accept jobs as demand grows. Volume is demand-driven with no guaranteed hours.`;
}

function jobPostingSchema(city, served, titleOverride) {
  const desc =
    `<p>AssembleAtEase is looking for skilled, reliable independent assembly and mounting pros ("Easers") in ${esc(city.name)}, Texas.</p>` +
    `<p>This is independent-contractor work, not employment. You set your own schedule, bring your own tools, and are <strong>paid per completed job</strong>: you keep ${EASER_SHARE_PCT}% of each job&rsquo;s price before tax, plus 100% of tips. Job volume is demand-driven and varies; there are no guaranteed hours or salary.</p>` +
    `<p>Typical work: furniture assembly, TV mounting, smart-home device installation, fitness-equipment assembly, and office and outdoor assembly in customers&rsquo; homes and offices.</p>` +
    `<p><strong>Requirements:</strong> your own tools, reliable transportation, a smartphone, identity verification, and a signed independent-contractor agreement. Approval is required before receiving jobs.</p>`;
  const schema = {
    '@context': 'https://schema.org/',
    '@type': 'JobPosting',
    // Per-city title: identical titles across 54 pages were collapsed to one posting.
    title: titleOverride || `Furniture Assembly & TV Mounting Contractor in ${city.name}, TX`,
    description: desc,
    datePosted: TODAY,
    employmentType: 'CONTRACTOR',
    hiringOrganization: {
      '@type': 'Organization',
      name: 'AssembleAtEase LLC',
      sameAs: ORIGIN,
      logo: `${ORIGIN}/images/logo.jpg`,
    },
    jobLocation: {
      '@type': 'Place',
      address: {
        '@type': 'PostalAddress',
        addressLocality: city.name,
        addressRegion: 'TX',
        addressCountry: 'US',
        ...(city.zip ? { postalCode: city.zip } : {}),
      },
    },
    // jobLocationType/applicantLocationRequirements are for remote (TELECOMMUTE) roles only.
    directApply: true,
    industry: 'Home Services',
    // baseSalary intentionally omitted: pay is per completed job and demand-driven.
  };
  return safeJson(schema);
}

function breadcrumbSchema(city) {
  return safeJson({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: `${ORIGIN}/` },
      { '@type': 'ListItem', position: 2, name: 'Become an Easer', item: `${ORIGIN}/become-an-easer` },
      { '@type': 'ListItem', position: 3, name: `Easer jobs in ${city.name}`, item: `${ORIGIN}/easer-jobs-${city.slug}-tx` },
    ],
  });
}

function headBlock({ title, metaDesc, url, jsonLd, indexed = true, preloadImage = '' }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<title>${esc(title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="description" content="${esc(metaDesc)}"/>
<link rel="canonical" href="${esc(url)}"/>
<meta name="robots" content="${indexed ? 'index, follow' : 'noindex, follow'}"/>
<meta property="og:type" content="website"/>
<meta property="og:title" content="${esc(title)}"/>
<meta property="og:description" content="${esc(metaDesc)}"/>
<meta property="og:url" content="${esc(url)}"/>
<meta property="og:site_name" content="AssembleAtEase"/>
<meta property="og:image" content="${ORIGIN}/images/logo.jpg"/>
<meta name="twitter:card" content="summary"/>
<meta name="twitter:title" content="${esc(title)}"/>
<meta name="twitter:description" content="${esc(metaDesc)}"/>
<meta name="twitter:image" content="${ORIGIN}/images/logo.jpg"/>
${jsonLd.map((s) => `<script type="application/ld+json">${s}</script>`).join('\n')}
<link rel="icon" href="/favicon.ico" sizes="any"/><link rel="icon" type="image/svg+xml" href="/images/favicon.svg"/>
<link rel="apple-touch-icon" href="/images/apple-touch-icon.png" />
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=DM+Sans:wght@300;400;500;600&display=swap" rel="preload" as="style" onload="this.onload=null;this.rel='stylesheet'"/>
<noscript><link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=DM+Sans:wght@300;400;500;600&display=swap" rel="stylesheet"/></noscript>
${preloadImage ? `<link rel="preload" as="image" href="${preloadImage}"/>\n` : ''}<link rel="stylesheet" href="/assets/css/marketing.css"/><link rel="stylesheet" href="/assets/css/marketing-desktop.css" media="(min-width:900px)"/>
<style>
.rec-hero{background:linear-gradient(160deg,#001f2b 0%,#0d3a4a 55%,#0f5c82 100%);color:#fff;padding:3rem 1.25rem 3.25rem}
.rec-hero-in{max-width:1080px;margin:0 auto;display:grid;gap:2rem;align-items:center}
.rec-eyebrow{display:inline-block;font-size:0.72rem;font-weight:800;letter-spacing:0.14em;text-transform:uppercase;color:#8fe8ff;margin-bottom:0.9rem}
.rec-h1{font-family:var(--font-display);font-size:clamp(2.1rem,6vw,3.3rem);line-height:1.04;margin:0 0 1rem}
.rec-lead{font-size:1.04rem;color:rgba(255,255,255,0.84);line-height:1.65;margin:0 0 1.4rem;max-width:34rem}
.rec-facts{display:flex;flex-wrap:wrap;gap:0.5rem 1.25rem;margin:0 0 1.6rem;padding:0;list-style:none;font-size:0.9rem;color:rgba(255,255,255,0.9)}
.rec-facts li{display:flex;align-items:center;gap:0.45rem}
.rec-facts li::before{content:'';width:7px;height:7px;border-radius:50%;background:var(--cyan)}
.rec-cta{display:inline-flex;align-items:center;justify-content:center;gap:8px;background:var(--cyan);color:#001f2b;padding:1rem 2rem;border-radius:999px;font-size:1rem;font-weight:800;text-decoration:none;transition:transform .18s,background .18s}
@media (hover:hover){.rec-cta:hover{background:#33ccff;transform:translateY(-1px)}}
.rec-hero-links{margin-top:1rem;font-size:0.88rem;color:rgba(255,255,255,0.75)}
.rec-hero-links a{color:#8fe8ff;text-decoration:none;font-weight:600}
.rec-hero-photo{margin:0;border-radius:24px;overflow:hidden;box-shadow:0 24px 60px rgba(0,0,0,0.35)}
.rec-hero-photo img{display:block;width:100%;height:auto;aspect-ratio:4/3;object-fit:cover}
@media (min-width:900px){.rec-hero{padding:4.5rem 2rem}.rec-hero-in.has-photo{grid-template-columns:1.1fr 0.9fr;gap:3.5rem}}
.rec-band{padding:3.5rem 1.25rem}
.rec-band.soft{background:linear-gradient(180deg,#f4fbff 0%,#fff 100%)}
.rec-in{max-width:880px;margin:0 auto}
.rec-band h2{font-family:var(--font-display);font-size:clamp(1.6rem,4vw,2.25rem);color:var(--ink);margin:0 0 0.5rem;line-height:1.15}
.rec-kicker{font-size:0.98rem;color:var(--muted);line-height:1.6;margin:0 0 1.75rem;max-width:36rem}
.rec-pay{list-style:none;margin:0;padding:0;border-top:1px solid var(--border)}
.rec-pay li{display:flex;align-items:baseline;justify-content:space-between;gap:1rem;padding:1.1rem 0;border-bottom:1px solid var(--border)}
.rec-pay .job{font-weight:600;color:var(--ink);font-size:1rem}
.rec-pay .job span{display:block;font-weight:400;font-size:0.84rem;color:var(--muted);margin-top:2px}
.rec-pay .earn{font-family:var(--font-display);font-size:1.6rem;color:var(--cyan-dark);white-space:nowrap}
.rec-pay .earn small{display:block;font-family:var(--font-body);font-size:0.72rem;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:var(--muted);text-align:right}
.rec-note{font-size:0.84rem;color:var(--muted);line-height:1.6;margin:1rem 0 0}
.rec-why{display:grid;gap:1.75rem;margin:0;padding:0;list-style:none}
@media (min-width:760px){.rec-why{grid-template-columns:repeat(3,1fr);gap:2rem}}
.rec-why li{display:flex;gap:1rem;align-items:flex-start}
@media (min-width:760px){.rec-why li{flex-direction:column}}
.rec-icon{flex:0 0 auto;width:44px;height:44px;border-radius:14px;background:rgba(0,191,255,0.12);display:flex;align-items:center;justify-content:center}
.rec-icon svg{width:22px;height:22px;fill:none;stroke:var(--cyan-dark);stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.rec-why h3,.rec-steps h3{font-size:1.02rem;color:var(--ink);margin:0 0 0.3rem}
.rec-why p,.rec-steps p{font-size:0.92rem;color:var(--muted);line-height:1.6;margin:0}
.rec-steps{list-style:none;margin:0;padding:0;counter-reset:step}
.rec-steps li{position:relative;padding:0 0 1.75rem 3.25rem;counter-increment:step}
.rec-steps li::before{content:counter(step);position:absolute;left:0;top:0;width:34px;height:34px;border-radius:50%;background:var(--cyan);color:#001f2b;font-weight:800;display:flex;align-items:center;justify-content:center;font-size:0.95rem}
.rec-steps li::after{content:'';position:absolute;left:16px;top:38px;bottom:4px;width:2px;background:rgba(0,191,255,0.25)}
.rec-steps li:last-child{padding-bottom:0}
.rec-steps li:last-child::after{display:none}
.rec-hubs{display:flex;flex-wrap:wrap;gap:0.6rem;margin:0 0 1.25rem;padding:0;list-style:none}
.rec-hubs a{display:inline-flex;align-items:center;gap:6px;padding:0.65rem 1.1rem;border-radius:999px;background:rgba(0,191,255,0.1);color:var(--cyan-dark);font-weight:700;font-size:0.92rem;text-decoration:none}
@media (hover:hover){.rec-hubs a:hover{background:rgba(0,191,255,0.18)}}
.rec-more summary{cursor:pointer;color:var(--ink-soft);font-weight:600;font-size:0.92rem;list-style:none}
.rec-more summary::-webkit-details-marker{display:none}
.rec-more summary::after{content:' +';color:var(--cyan-dark)}
.rec-more[open] summary::after{content:' \\2212'}
.rec-citylist{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:0.45rem 1rem;margin-top:1rem}
.rec-citylist a{color:var(--cyan-dark);text-decoration:none;font-size:0.88rem}
.rec-faq details{border-bottom:1px solid var(--border)}
.rec-faq details:first-child{border-top:1px solid var(--border)}
.rec-faq summary{cursor:pointer;list-style:none;padding:1.1rem 2rem 1.1rem 0;position:relative;font-weight:600;color:var(--ink);font-size:0.98rem}
.rec-faq summary::-webkit-details-marker{display:none}
.rec-faq summary::after{content:'+';position:absolute;right:0.25rem;top:1rem;font-size:1.3rem;color:var(--cyan-dark);font-weight:400}
.rec-faq details[open] summary::after{content:'\\2212'}
.rec-faq p{margin:0 0 1.1rem;color:var(--muted);line-height:1.7;font-size:0.93rem}
.rec-final{background:#001f2b;color:#fff;text-align:center;padding:3.75rem 1.25rem}
.rec-final h2{font-family:var(--font-display);font-size:clamp(1.7rem,4vw,2.4rem);margin:0 0 0.75rem;color:#fff}
.rec-final p{color:rgba(255,255,255,0.8);max-width:32rem;margin:0 auto 1.6rem;line-height:1.65}
.rec-app{margin-top:2rem}
.rec-app p{font-size:0.88rem;margin:0 auto 0.75rem}
.rec-app img{display:block;margin:0 auto;width:120px;height:40px}
.rec-app .rec-credit{font-size:0.66rem;opacity:0.65;margin:1rem auto 0;max-width:28rem}
</style>
<!-- First page of the visit wins, so the city page that brought someone here
     is what the application records. Loaded on the RECRUITMENT page, not just
     the form: capture that runs only on /assembler/apply records that path for
     everyone, which is the same as recording nothing. -->
<script src="/assets/js/attribution.js"></script>
</head>
<body>
${buildPublicNavBlock({ variant: 'core', includeSkipNav: true })}<main id="main-content">`;
}

function heroBlock({ eyebrow, h1, lead, applyHref, photo }) {
  return `<section class="rec-hero">
  <div class="rec-hero-in${photo ? ' has-photo' : ''}">
    <div>
      <div class="rec-eyebrow">${eyebrow}</div>
      <h1 class="rec-h1">${h1}</h1>
      <p class="rec-lead">${lead}</p>
      <ul class="rec-facts">
        <li>Keep ${EASER_SHARE_PCT}% plus tips</li>
        <li>Choose your own jobs</li>
        <li>No application fee while your area is adding Easers</li>
      </ul>
      <a href="${applyHref}" class="rec-cta">Apply in a few minutes &rarr;</a>
      <p class="rec-hero-links">Already an Easer? <a href="/auth/login">Log in</a></p>
    </div>${photo ? `
    <figure class="rec-hero-photo"><img src="${photo.src}" alt="${esc(photo.alt)}" width="${photo.width}" height="${photo.height}" fetchpriority="high"/></figure>` : ''}
  </div>
</section>`;
}

function payBlock() {
  return `<section class="rec-band">
  <div class="rec-in">
    <h2>What a job pays you</h2>
    <p class="rec-kicker">Real prices from our booking menu. You see the pay on every offer before you accept.</p>
    <ul class="rec-pay">
      ${PAY_EXAMPLES.map((ex) => `<li><div class="job">${esc(ex.label)}</div><div class="earn"><small>You earn</small>${dollars(ex.earnCents)}</div></li>`).join('\n      ')}
    </ul>
    <p class="rec-note">You keep ${EASER_SHARE_PCT}% of the job price before tax, including the ${dollars(SERVICE_FEE_CENTS)} service fee. Tips are 100% yours.</p>
  </div>
</section>`;
}

function whyBlock() {
  return `<section class="rec-band soft">
  <div class="rec-in">
    <h2>Why pros work with us</h2>
    <p class="rec-kicker">Independent work on your terms, with the job and the pay clear up front.</p>
    <ul class="rec-why">
      ${WHY.map((w) => `<li><span class="rec-icon">${ICONS[w.icon]}</span><div><h3>${esc(w.t)}</h3><p>${esc(w.d)}</p></div></li>`).join('\n      ')}
    </ul>
  </div>
</section>`;
}

function stepsBlock() {
  return `<section class="rec-band">
  <div class="rec-in">
    <h2>How it works</h2>
    <p class="rec-kicker">From application to your first job.</p>
    <ol class="rec-steps">
      ${STEPS.map((s) => `<li><h3>${esc(s.t)}</h3><p>${esc(s.d)}</p></li>`).join('\n      ')}
    </ol>
  </div>
</section>`;
}

function faqBlock(items, { soft = true } = {}) {
  return `<section class="rec-band${soft ? ' soft' : ''}">
  <div class="rec-in">
    <h2>Questions from pros</h2>
    <div class="rec-faq">
      ${items.map((f) => `<details><summary>${f.q}</summary><p>${f.a}</p></details>`).join('\n      ')}
    </div>
  </div>
</section>`;
}

function finalBlock({ text, applyHref }) {
  return `<section class="rec-final">
  <h2>Ready to earn on your schedule?</h2>
  <p>${text}</p>
  <a href="${applyHref}" class="rec-cta">Apply to become an Easer &rarr;</a>
  <div class="rec-app app-store-promo">
    <p>Already approved? Work your jobs in the Easer app.</p>
    <a href="${APP_STORE.easer.url}" target="_blank" rel="noopener" aria-label="Download the ${esc(APP_STORE.easer.name)} app on the App Store"><img src="${APP_STORE_BADGE_SVG}" alt="Download on the App Store" width="120" height="40" loading="lazy"/></a>
    <p class="rec-credit">${APPLE_TRADEMARK_CREDIT}</p>
  </div>
</section>`;
}

function footerBlock() {
  return `</main>
${buildPublicFooterBlock({
  variant: 'service_support',
  tagline: 'Professional furniture assembly, TV mounting, smart home setup, office assembly, and outdoor assembly with online booking across Texas.',
})}
${buildPublicCookieConsentBlock()}
</body>
</html>`;
}

// ── CITY RECRUITMENT PAGE ──
function buildCityPage(city) {
  const served = SERVED_SLUGS.has(city.slug);
  const url = `${ORIGIN}/easer-jobs-${city.slug}-tx`;
  const title = fitTitle(`Furniture Assembly & TV Mounting Jobs in ${city.name}, TX`, ' | Become an Easer');
  const metaDesc = `Earn as an independent assembly and TV-mounting pro in ${city.name}, TX. Set your own schedule, bring your own tools, and keep ${EASER_SHARE_PCT}% of every job plus tips.`;
  const applyHref = `/assembler/apply?city=${encodeURIComponent(city.name)}`;
  const nearby = (city.nearby || []).slice(0, 4);

  const faqs = [
    ...sharedFaqs(),
    { q: `How many jobs will I get in ${esc(city.name)}?`, a: volumeFaqAnswer(city, served) },
  ];

  const nearbyLinks = nearby
    .map((n) => {
      const c = ALL_TEXAS_CITIES.find((x) => x.name === n);
      return c ? `<li><a href="/easer-jobs-${c.slug}-tx">${esc(c.name)}</a></li>` : '';
    })
    .filter(Boolean)
    .join('\n        ');

  return `${headBlock({ title, metaDesc, url, jsonLd: [jobPostingSchema(city, served), breadcrumbSchema(city)], indexed: isIndexedEaserJobsPage(city.slug) })}

${heroBlock({
  eyebrow: `${esc(city.name)}, TX`,
  h1: 'Get paid to assemble and mount',
  lead: `${heroStatus(city, served)} Join AssembleAtEase as an independent pro and take the jobs that fit your schedule.`,
  applyHref,
})}

${payBlock()}

${whyBlock()}

${stepsBlock()}

<section class="rec-band soft">
  <div class="rec-in">
    <h2>Working in ${esc(city.name)} and nearby</h2>
    <p class="rec-kicker">Approved pros are matched to jobs across the ${esc(city.name)} area${nearby.length ? ' and neighboring communities' : ''}.</p>
    ${nearbyLinks ? `<ul class="rec-hubs">\n        ${nearbyLinks}\n      </ul>` : ''}
  </div>
</section>

${faqBlock(faqs, { soft: false })}

${finalBlock({ text: `Apply in a few minutes. Get approved, and start accepting nearby jobs in ${esc(city.name)}.`, applyHref })}

${footerBlock()}`;
}

// ── HUB PAGE (/become-an-easer) ──
function buildHubPage() {
  const url = `${ORIGIN}/become-an-easer`;
  const title = 'Become an Easer: Assembly & Handyman Jobs in Texas';
  const metaDesc = `Earn as an independent furniture assembly, TV mounting and home-setup pro across Texas. Choose your jobs, bring your tools, keep ${EASER_SHARE_PCT}% plus tips.`;
  const applyHref = '/assembler/apply';
  // A real on-site job photo used on no other page (no-duplicate-photo rule).
  const photo = { src: '/images/real-outdoor-patio-gray.jpg', width: 680, height: 510, alt: 'Outdoor patio set assembled by an AssembleAtEase pro' };

  const faqs = [
    ...sharedFaqs(),
    { q: 'Which Texas cities can I work in?', a: 'Customers book across Texas. We are adding Easers first in Austin, Houston, San Antonio and Dallas-Fort Worth, and approve pros statewide. Pick your city below to apply.' },
  ];

  const cityLinks = [...ALL_TEXAS_CITIES]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((c) => `<a href="/easer-jobs-${c.slug}-tx">${esc(c.name)}</a>`)
    .join('\n        ');

  const hubJobPosting = jobPostingSchema({ name: 'Texas', slug: 'texas' }, true, 'Independent Furniture Assembly & TV Mounting Contractor (Easer) - Texas').replace('"addressLocality":"Texas"', '"addressLocality":"Austin"');

  return `${headBlock({ title, metaDesc, url, jsonLd: [hubJobPosting], preloadImage: photo.src })}

${heroBlock({
  eyebrow: 'Now hiring pros across Texas',
  h1: 'Earn money doing what you&rsquo;re good at',
  lead: 'Independent assembly and mounting work on your schedule. Bring your own tools, take the jobs you want, and get paid after every one.',
  applyHref,
  photo,
})}

${payBlock()}

${whyBlock()}

${stepsBlock()}

<section class="rec-band soft">
  <div class="rec-in">
    <h2>Where you can work</h2>
    <p class="rec-kicker">Customers book across Texas. These four areas need Easers most.</p>
    <ul class="rec-hubs">
      ${HUBS.map((h) => `<li><a href="/easer-jobs-${h.slug}-tx">${esc(h.name)}</a></li>`).join('\n      ')}
    </ul>
    <details class="rec-more">
      <summary>See every Texas city</summary>
      <div class="rec-citylist">
        ${cityLinks}
      </div>
    </details>
  </div>
</section>

${faqBlock(faqs, { soft: false })}

${finalBlock({ text: 'Apply in a few minutes. Get approved, and start accepting nearby assembly and mounting jobs.', applyHref })}

${footerBlock()}`;
}

// ── GENERATE ──
const written = [];
const sitemapEntries = [];

// Hub
writeFileSync(join(ROOT, 'become-an-easer.html'), buildHubPage(), 'utf8');
written.push('become-an-easer.html');
sitemapEntries.push(`  <url><loc>${ORIGIN}/become-an-easer</loc><lastmod>${TODAY}</lastmod><priority>0.7</priority></url>`);

// City pages
for (const city of ALL_TEXAS_CITIES) {
  const file = `easer-jobs-${city.slug}-tx.html`;
  writeFileSync(join(ROOT, file), buildCityPage(city), 'utf8');
  written.push(file);
  // Recruitment reach stays statewide; search engines get the cities in the
  // shared indexing policy (scripts/lib/texas-cities.mjs).
  if (isIndexedEaserJobsPage(city.slug)) {
    sitemapEntries.push(`  <url><loc>${ORIGIN}/easer-jobs-${city.slug}-tx</loc><lastmod>${TODAY}</lastmod><priority>0.6</priority></url>`);
  }
}

// Sitemap: strip any prior recruitment entries, then insert fresh before </urlset>.
const sitemapPath = join(ROOT, 'sitemap.xml');
let sitemap = readFileSync(sitemapPath, 'utf8');
sitemap = sitemap.replace(/\s*<url><loc>https:\/\/www\.assembleatease\.com\/(become-an-easer|easer-jobs-[a-z-]+-tx)<\/loc>[^<]*<lastmod>[^<]*<\/lastmod>[^<]*<priority>[^<]*<\/priority><\/url>/g, '');
sitemap = sitemap.replace('</urlset>', `${sitemapEntries.join('\n')}\n</urlset>`);
writeFileSync(sitemapPath, sitemap, 'utf8');

console.log(`Generated ${written.length} recruitment pages (1 hub + ${written.length - 1} cities).`);
console.log(`sitemap.xml updated (+${sitemapEntries.length} entries).`);
