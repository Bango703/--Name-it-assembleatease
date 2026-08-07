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
//
// Run: node scripts/generate-easer-recruit-pages.js

import { writeFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { buildPublicCookieConsentBlock } from './lib/public-consent.mjs';
import { buildPublicFooterBlock } from './lib/public-footer.mjs';
import { buildPublicNavBlock } from './lib/public-nav.mjs';
import { ALL_TEXAS_CITIES } from './lib/texas-cities.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const TODAY = '2026-08-06';
const VALID_THROUGH = '2026-11-06'; // ~90 days; regenerate to refresh JobPosting freshness
const ORIGIN = 'https://www.assembleatease.com';

// The cities we actively dispatch in today (mirrors SERVED in assets/js/aae-location.js).
// Served -> "actively booking"; everything else -> honest "expanding / be first in line".
const SERVED_SLUGS = new Set([
  'austin', 'round-rock', 'cedar-park', 'georgetown', 'pflugerville', 'kyle',
  'buda', 'lakeway', 'bee-cave', 'manor', 'leander', 'hutto',
]);

function esc(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function safeJson(obj) {
  return JSON.stringify(obj).replace(/<\//g, '<\\/');
}

// ── Shared, LOCATION-NEUTRAL recruitment content (one source, never per-city duplicated) ──
const WHY = [
  { t: 'Set your own schedule', d: 'Accept the jobs that fit your week. There are no shifts, no quotas, and no minimum hours — you decide what you take.' },
  { t: 'Keep the majority of every job', d: 'You earn 70% of the job price on every completed assignment. Pricing is shown up front, so you always know the pay before you accept.' },
  { t: 'Jobs come to you', d: 'Approved pros get matched to nearby assignments automatically and are notified to accept — no bidding wars, no chasing leads.' },
  { t: 'Paid after completed work', d: 'Payment is released after the job is finished and confirmed. Payouts go to your bank once payout setup is complete — clear status the whole way.' },
];
const REQUIREMENTS = [
  { t: 'Your own tools', d: 'You bring the drills, bits, and hand tools to do the work. Customers supply their own furniture, mounts, and hardware.' },
  { t: 'Reliable transportation', d: 'A dependable way to get to appointments across your area with your tools.' },
  { t: 'A smartphone', d: 'You accept jobs, message customers, and confirm completion from your phone.' },
  { t: 'Pass onboarding', d: 'Verify your identity and sign the independent-contractor agreement. Approval is required before you receive jobs.' },
];
const STEPS = [
  { n: '1', t: 'Apply online', d: 'Tell us about your assembly and mounting experience. It takes a few minutes.' },
  { n: '2', t: 'Verify & agree', d: 'Complete identity verification and sign the independent-contractor agreement.' },
  { n: '3', t: 'Get approved', d: 'Once reviewed and approved, your account is set to receive job offers.' },
  { n: '4', t: 'Accept jobs & get paid', d: 'Accept nearby assignments, complete the work, and get paid after each job is confirmed.' },
];

function heroStatus(city, served) {
  return served
    ? `We&rsquo;re actively booking jobs in ${esc(city.name)} right now.`
    : `We&rsquo;re expanding in ${esc(city.name)} &mdash; get approved now to be first in line as jobs open up.`;
}
function volumeFaqAnswer(city, served) {
  return served
    ? `${city.name} is an active service area, so approved pros are matched to nearby jobs as customers book them. Job volume is demand-driven and varies week to week — there are no guaranteed hours because every assignment is a completed job you choose to accept.`
    : `We accept customer bookings across ${city.name} and confirm a local pro for each one, so the opportunity is real — but ${city.name} is a newer market and volume is still growing. Getting approved now means you&rsquo;re in position to accept jobs as demand ramps up. Volume is demand-driven with no guaranteed hours.`;
}

function jobPostingSchema(city, served) {
  const desc =
    `<p>AssembleAtEase is looking for skilled, reliable independent assembly and mounting pros ("Easers") in ${esc(city.name)}, Texas.</p>` +
    `<p>This is independent-contractor work, not employment. You set your own schedule, bring your own tools, and are <strong>paid per completed job</strong> — you keep 70% of each job&rsquo;s price. Job volume is demand-driven and varies; there are no guaranteed hours or salary.</p>` +
    `<p>Typical work: furniture assembly, TV mounting, smart-home device installation, fitness-equipment assembly, and office and outdoor assembly in customers&rsquo; homes and offices.</p>` +
    `<p><strong>Requirements:</strong> your own tools, reliable transportation, a smartphone, identity verification, and a signed independent-contractor agreement. Approval is required before receiving jobs.</p>`;
  const schema = {
    '@context': 'https://schema.org/',
    '@type': 'JobPosting',
    title: 'Independent Furniture Assembly & TV Mounting Contractor (Easer)',
    description: desc,
    datePosted: TODAY,
    validThrough: VALID_THROUGH,
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
      },
    },
    applicantLocationRequirements: { '@type': 'Country', name: 'US' },
    jobLocationType: 'On-site',
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

function headBlock({ title, metaDesc, url, jsonLd }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<title>${esc(title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="description" content="${esc(metaDesc)}"/>
<link rel="canonical" href="${esc(url)}"/>
<meta name="robots" content="index, follow"/>
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
<link rel="stylesheet" href="/assets/css/marketing.css"/><link rel="stylesheet" href="/assets/css/marketing-desktop.css" media="(min-width:900px)"/>
<style>
.rec-hero{background:linear-gradient(135deg,#001f2b 0%,#0d3a4a 60%,#0f5c82 100%);padding:3.5rem 1.25rem;text-align:center;color:#fff}
.rec-hero-inner{max-width:720px;margin:0 auto}
.rec-eyebrow{display:inline-block;background:rgba(0,191,255,0.14);border:1px solid rgba(0,191,255,0.32);border-radius:999px;padding:0.32rem 1rem;font-size:0.72rem;font-weight:800;letter-spacing:0.12em;text-transform:uppercase;color:#8fe8ff;margin-bottom:1rem}
.rec-h1{font-family:var(--font-display);font-size:clamp(2rem,5vw,3rem);line-height:1.05;margin:0 0 0.9rem}
.rec-status{font-size:1.02rem;color:#8fe8ff;font-weight:600;margin:0 0 0.6rem}
.rec-lead{font-size:1rem;color:rgba(255,255,255,0.82);line-height:1.7;max-width:560px;margin:0 auto 1.6rem}
.rec-cta{display:inline-flex;align-items:center;gap:8px;background:#00BFFF;color:#001f2b;padding:0.95rem 2rem;border-radius:8px;font-size:1rem;font-weight:800;text-decoration:none;transition:all .18s}
.rec-cta:hover{background:#33ccff;transform:translateY(-1px)}
.rec-cta.dark{background:#001f2b;color:#fff}
.rec-section{max-width:1040px;margin:0 auto;padding:3rem 1.25rem}
.rec-section h2{font-family:var(--font-display);font-size:clamp(1.5rem,3vw,2.1rem);color:var(--ink);text-align:center;margin:0 0 0.5rem}
.rec-section .rec-sub{text-align:center;color:var(--muted);max-width:560px;margin:0 auto 2rem;line-height:1.6}
.rec-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:1rem}
.rec-card{background:var(--white);border:1.5px solid var(--border);border-radius:18px;padding:1.5rem}
.rec-card .rec-num{width:34px;height:34px;border-radius:9px;background:var(--cyan-light);color:var(--cyan-dark);display:flex;align-items:center;justify-content:center;font-weight:800;margin-bottom:0.8rem}
.rec-card h3{font-size:1rem;color:var(--ink);margin:0 0 0.4rem}
.rec-card p{font-size:0.9rem;color:var(--muted);line-height:1.65;margin:0}
.rec-earn{background:linear-gradient(135deg,#f4fbff,#e6f7ff);border:1px solid rgba(0,191,255,0.22);border-radius:22px;padding:2rem;text-align:center}
.rec-earn strong{font-size:1.15rem;color:var(--ink)}
.rec-area{background:var(--bg-soft,#f6fafb);border-radius:20px;padding:2rem;text-align:center}
.rec-chips{display:flex;flex-wrap:wrap;gap:0.5rem;justify-content:center;margin-top:1rem}
.rec-chip{background:var(--white);border:1px solid var(--border);border-radius:999px;padding:0.3rem 0.85rem;font-size:0.8rem;font-weight:500;color:var(--ink-soft)}
.rec-faq{max-width:720px;margin:0 auto}
.rec-faq-item{background:var(--white);border:1.5px solid var(--border);border-radius:14px;overflow:hidden;margin-bottom:0.6rem}
.rec-faq-item button{width:100%;display:flex;align-items:center;justify-content:space-between;padding:1rem 1.25rem;background:none;border:none;cursor:pointer;font-family:var(--font-body);font-size:0.92rem;font-weight:600;color:var(--ink);text-align:left}
.rec-faq-item .rec-faq-a{display:none;padding:0 1.25rem 1rem;font-size:0.88rem;color:var(--muted);line-height:1.7}
.rec-final{background:#001f2b;color:#fff;text-align:center;padding:3.5rem 1.25rem}
.rec-final h2{font-family:var(--font-display);font-size:clamp(1.6rem,3vw,2.3rem);margin:0 0 0.8rem;color:#fff}
.rec-final p{color:rgba(255,255,255,0.8);max-width:520px;margin:0 auto 1.6rem;line-height:1.7}
.rec-citylist{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:0.4rem 1rem;max-width:960px;margin:1.5rem auto 0}
.rec-citylist a{color:var(--cyan-dark);text-decoration:none;font-size:0.875rem;font-weight:500}
.rec-citylist a:hover{text-decoration:underline}
</style>
</head>
<body>
${buildPublicNavBlock({ variant: 'core', includeSkipNav: true })}<main id="main-content">`;
}

function faqBlock(items) {
  return `<section class="rec-section"><h2>Questions from pros</h2>
  <div class="rec-faq">
    ${items.map((f) => `<div class="rec-faq-item">
      <button onclick="var a=this.nextElementSibling;a.style.display=a.style.display==='block'?'none':'block'">${f.q} <span aria-hidden="true">&#8964;</span></button>
      <div class="rec-faq-a">${f.a}</div>
    </div>`).join('\n    ')}
  </div>
</section>`;
}

function cardsSection(title, sub, items, numbered) {
  return `<section class="rec-section"><h2>${title}</h2>${sub ? `<p class="rec-sub">${sub}</p>` : ''}
  <div class="rec-grid">
    ${items.map((it) => `<div class="rec-card">${numbered ? `<div class="rec-num">${it.n}</div>` : ''}<h3>${esc(it.t)}</h3><p>${esc(it.d)}</p></div>`).join('\n    ')}
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
  const title = `Furniture Assembly & TV Mounting Jobs in ${city.name}, TX | Become an Easer`;
  const metaDesc = `Earn as an independent assembly and TV-mounting pro in ${city.name}, TX. Set your own schedule, bring your own tools, keep 70% of every completed job. Apply to become an Easer.`;
  const applyHref = `/assembler/apply?city=${encodeURIComponent(city.name)}`;
  const nearby = (city.nearby || []).slice(0, 4);

  const faqs = [
    { q: 'Is this a job or independent contractor work?', a: 'It&rsquo;s independent-contractor work. You&rsquo;re not an employee — you set your own schedule, use your own tools, and are paid per completed job. You sign an independent-contractor agreement during onboarding.' },
    { q: 'How and when do I get paid?', a: 'You earn 70% of each completed job&rsquo;s price. Payment is released after the job is finished and confirmed, and paid to your bank once your payout setup is complete.' },
    { q: 'Do I need my own tools?', a: 'Yes. Pros bring their own drills, bits, and hand tools. Customers supply their own furniture, mounts, and hardware — we don&rsquo;t provide parts or mounting hardware.' },
    { q: `How many jobs will I get in ${city.name}?`, a: volumeFaqAnswer(city, served) },
  ];

  const areaChips = [city.name, ...nearby].map((n) => `<span class="rec-chip">${esc(n)}, TX</span>`).join('\n      ');
  const nearbyLinks = nearby
    .map((n) => {
      const c = ALL_TEXAS_CITIES.find((x) => x.name === n);
      return c ? `<a href="/easer-jobs-${c.slug}-tx">Easer jobs in ${esc(c.name)}</a>` : '';
    })
    .filter(Boolean)
    .join('\n      ');

  return `${headBlock({ title, metaDesc, url, jsonLd: [jobPostingSchema(city, served), breadcrumbSchema(city)] })}

<section class="rec-hero">
  <div class="rec-hero-inner">
    <div class="rec-eyebrow">${esc(city.name)}, TX</div>
    <h1 class="rec-h1">Get paid to assemble and mount</h1>
    <p class="rec-status">${heroStatus(city, served)}</p>
    <p class="rec-lead">Join AssembleAtEase as an independent pro. Take the jobs that fit your schedule, bring your own tools, and keep 70% of every completed job.</p>
    <a href="${applyHref}" class="rec-cta">Apply to become an Easer &rarr;</a>
  </div>
</section>

${cardsSection('Why pros work with us', 'Real independent work, on your terms — with the jobs and the pay made clear before you accept.', WHY, false)}

<section class="rec-section">
  <div class="rec-earn">
    <strong>You keep 70% of every completed job.</strong>
    <p class="rec-sub" style="margin-top:0.6rem;margin-bottom:0">Pricing is shown up front, so you always know the pay before you accept. Earnings are per completed job and depend on how many you take — there are no guaranteed hours, and no fees to apply.</p>
  </div>
</section>

${cardsSection('How it works', null, STEPS, true)}

${cardsSection('What you need', null, REQUIREMENTS, false)}

<section class="rec-section">
  <div class="rec-area">
    <h2 style="margin-bottom:0.4rem">Serving ${esc(city.name)} and nearby areas</h2>
    <p class="rec-sub" style="margin-bottom:0">Approved pros are matched to assignments across the ${esc(city.name)} area${nearby.length ? ' and neighboring communities' : ''}.</p>
    <div class="rec-chips">
      ${areaChips}
    </div>
    ${nearbyLinks ? `<div class="rec-citylist" style="margin-top:1.5rem">\n      ${nearbyLinks}\n    </div>` : ''}
  </div>
</section>

${faqBlock(faqs)}

<section class="rec-final">
  <h2>Ready to earn on your schedule?</h2>
  <p>Apply in a few minutes. Get approved, and start accepting nearby jobs in ${esc(city.name)}.</p>
  <a href="${applyHref}" class="rec-cta">Apply to become an Easer &rarr;</a>
</section>

${footerBlock()}`;
}

// ── HUB PAGE (/become-an-easer) ──
function buildHubPage() {
  const url = `${ORIGIN}/become-an-easer`;
  const title = 'Become an Easer — Assembly & Handyman Jobs Across Texas | AssembleAtEase';
  const metaDesc = 'Earn as an independent furniture assembly, TV mounting, and home-setup pro across Texas. Set your own schedule, bring your own tools, keep 70% of every completed job. Apply to become an Easer.';
  const applyHref = '/assembler/apply';
  const genericCity = { name: 'Texas', slug: 'texas' };

  const faqs = [
    { q: 'Is this employment or independent contractor work?', a: 'Independent-contractor work. You set your own schedule, use your own tools, and are paid per completed job. There are no shifts or guaranteed hours.' },
    { q: 'What do I earn?', a: 'You keep 70% of each completed job&rsquo;s price. Pricing is shown before you accept, so you always know the pay. Earnings depend on how many jobs you take.' },
    { q: 'What do I need to start?', a: 'Your own tools, reliable transportation, a smartphone, identity verification, and a signed independent-contractor agreement. Approval is required before you receive jobs.' },
    { q: 'Which Texas cities can I work in?', a: 'We&rsquo;re actively booking across the Austin metro and accepting bookings statewide as we expand. Pick your city below to apply — approved pros are matched to nearby jobs as demand grows.' },
  ];

  const cityLinks = [...ALL_TEXAS_CITIES]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((c) => `<a href="/easer-jobs-${c.slug}-tx">${esc(c.name)}${SERVED_SLUGS.has(c.slug) ? '' : ''}</a>`)
    .join('\n      ');

  const hubJobPosting = jobPostingSchema({ name: 'Texas', slug: 'texas' }, true).replace('"addressLocality":"Texas"', '"addressLocality":"Austin"');

  return `${headBlock({ title, metaDesc, url, jsonLd: [hubJobPosting] })}

<section class="rec-hero">
  <div class="rec-hero-inner">
    <div class="rec-eyebrow">Now hiring pros — across Texas</div>
    <h1 class="rec-h1">Earn money doing what you&rsquo;re good at</h1>
    <p class="rec-status">Independent assembly &amp; mounting work, on your schedule.</p>
    <p class="rec-lead">Join AssembleAtEase as an Easer. Accept the jobs that fit your week, bring your own tools, and keep 70% of every completed job. No shifts, no quotas, no fees to apply.</p>
    <a href="${applyHref}" class="rec-cta">Apply to become an Easer &rarr;</a>
  </div>
</section>

${cardsSection('Why pros work with us', 'Real independent work, on your terms — with the jobs and the pay made clear before you accept.', WHY, false)}

<section class="rec-section">
  <div class="rec-earn">
    <strong>You keep 70% of every completed job.</strong>
    <p class="rec-sub" style="margin-top:0.6rem;margin-bottom:0">Pricing is shown up front, so you always know the pay before you accept. Earnings are per completed job — no guaranteed hours, and no fees to apply.</p>
  </div>
</section>

${cardsSection('How it works', null, STEPS, true)}

${cardsSection('What you need', null, REQUIREMENTS, false)}

<section class="rec-section">
  <h2>Find work in your city</h2>
  <p class="rec-sub">We&rsquo;re actively booking across the Austin metro and expanding statewide. Pick your city to apply.</p>
  <div class="rec-citylist">
      ${cityLinks}
  </div>
</section>

${faqBlock(faqs)}

<section class="rec-final">
  <h2>Ready to earn on your schedule?</h2>
  <p>Apply in a few minutes. Get approved, and start accepting nearby assembly and mounting jobs.</p>
  <a href="${applyHref}" class="rec-cta">Apply to become an Easer &rarr;</a>
</section>

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
  sitemapEntries.push(`  <url><loc>${ORIGIN}/easer-jobs-${city.slug}-tx</loc><lastmod>${TODAY}</lastmod><priority>0.6</priority></url>`);
}

// Sitemap: strip any prior recruitment entries, then insert fresh before </urlset>.
const sitemapPath = join(ROOT, 'sitemap.xml');
let sitemap = readFileSync(sitemapPath, 'utf8');
sitemap = sitemap.replace(/\s*<url><loc>https:\/\/www\.assembleatease\.com\/(become-an-easer|easer-jobs-[a-z-]+-tx)<\/loc>[^<]*<lastmod>[^<]*<\/lastmod>[^<]*<priority>[^<]*<\/priority><\/url>/g, '');
sitemap = sitemap.replace('</urlset>', `${sitemapEntries.join('\n')}\n</urlset>`);
writeFileSync(sitemapPath, sitemap, 'utf8');

console.log(`Generated ${written.length} recruitment pages (1 hub + ${written.length - 1} cities).`);
console.log(`sitemap.xml updated (+${sitemapEntries.length} entries).`);
