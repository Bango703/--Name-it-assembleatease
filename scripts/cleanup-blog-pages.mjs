import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { buildPublicCookieConsentBlock } from './lib/public-consent.mjs';
import { buildPublicFooterBlock } from './lib/public-footer.mjs';
import { buildPublicNavBlock } from './lib/public-nav.mjs';

const SITE = 'https://www.assembleatease.com';
const root = process.cwd();
const blogDir = join(root, 'blog');

const posts = [
  {
    slug: 'new-home-setup-checklist-austin',
    title: 'New Home Setup Checklist for Austin Movers',
    tag: 'Move-in setup',
    image: '/images/about-story-customer-review.jpg',
    alt: 'Austin move-in setup consultation with a local service pro',
    serviceUrl: '/book',
    cta: 'Book Home Setup',
    description: 'A short Austin move-in checklist for furniture, TV mounting, smart devices, and booking the right help.',
    metaDescription: 'A move-in checklist for Austin covering furniture assembly, TV mounting, smart devices, and booking the right help so your new home is ready in fewer visits.',
    paragraphs: [
      'Moving into an Austin home gets easier when the heavy setup happens in the right order: beds and desks first, TVs after furniture placement, then smart locks, cameras, thermostats, and Wi-Fi devices once the room layout is final.',
      'If boxes are stacking up, book one visit that bundles assembly, TV mounting, and smart-home setup. It saves separate appointments, reduces mistakes, and gets the home usable faster.'
    ],
  },
  {
    slug: 'tv-mounting-costs-austin',
    title: 'TV Mounting Costs in Austin TX',
    tag: 'TV mounting',
    image: '/images/booking-service-tv-mounting.jpg',
    alt: 'Austin TV mounting service with a pro installing a bracket',
    serviceUrl: '/book?service=Mounting+%26+Hanging',
    cta: 'Book TV Mounting',
    description: 'What affects TV mounting cost in Austin, including screen size, wall type, mount style, and cord planning.',
    metaDescription: 'What affects TV mounting cost in Austin, including screen size, wall type, mount style, and cord concealment, plus how to get an upfront price and book online.',
    paragraphs: [
      'TV mounting in Austin usually changes price based on screen size, wall type, mount style, and whether cords need to be hidden. Drywall with studs is simpler; brick, stone, fireplace installs, and full-motion mounts need more care.',
      'The expensive part is not the bracket. It is the risk of a crooked mount, missed studs, wall damage, or a dropped screen. A pro visit keeps the install clean, level, and secure before the TV becomes a problem.'
    ],
  },
  {
    slug: 'tv-wall-mount-installation-cost-austin',
    title: 'TV Wall Mount Installation Cost in Austin',
    tag: 'TV mounting',
    image: '/images/service-tv-mounting.jpg',
    alt: 'Austin TV wall mount installation with tools and bracket setup',
    serviceUrl: '/book?service=Mounting+%26+Hanging',
    cta: 'Schedule Wall Mounting',
    description: 'A short cost blog for Austin TV wall mounting, including mount type, cable planning, and wall material.',
    metaDescription: 'A cost guide for TV wall mounting in Austin, covering how mount type, cable concealment, and wall material affect price. See upfront pricing and book online.',
    paragraphs: [
      'A clean TV wall mount depends on more than screen size. Austin homes can have drywall, masonry, older studs, fireplaces, and awkward outlet placement, so the right plan depends on what is behind the wall.',
      'Before booking, know your TV size, mount type, wall surface, and whether you want cords hidden. That gives the Easer enough detail to arrive with the right tools and avoid surprise add-ons.'
    ],
  },
  {
    slug: 'outdoor-tv-installation-austin-texas',
    title: 'Outdoor TV Installation Cost in Austin',
    tag: 'Outdoor installs',
    image: '/images/service-outdoor-playsets.jpg',
    alt: 'Austin outdoor setup service with a pro working in a backyard',
    serviceUrl: '/book?service=Mounting+%26+Hanging',
    cta: 'Plan Outdoor Mounting',
    description: 'What changes when an Austin TV installation is outside, exposed, or part of a patio setup.',
    metaDescription: 'What changes when an Austin TV installation is outdoors, from weatherproofing and mounts to cable protection and patio setup. See what to prep and get pricing.',
    paragraphs: [
      'Outdoor TV installs in Austin need a different plan than indoor mounting. Sun, heat, rain exposure, outlet location, wall material, and viewing angle all matter before the bracket goes up.',
      'Use an outdoor-rated TV or protected enclosure, choose a shaded viewing spot when possible, and confirm power access before the visit. A careful setup keeps the patio useful without turning the job into rework.'
    ],
  },
  {
    slug: 'ikea-assembly-cost-austin',
    title: 'IKEA Assembly Cost in Austin: Prices From $69',
    tag: 'Furniture assembly',
    image: '/images/booking-service-furniture-assembly.jpg',
    alt: 'Austin flat-pack furniture assembly with parts organized',
    serviceUrl: '/book?service=Furniture+Assembly',
    cta: 'Book IKEA Assembly',
    description: 'See current IKEA furniture assembly prices in Austin, including common item costs, timing factors, and how to prepare for the visit.',
    paragraphs: [
      'IKEA assembly cost depends on the piece count, size, drawers, doors, wall anchoring, and whether the item has to be built in a tight room. Small pieces move fast; wardrobes, beds, and storage systems take longer.',
      'Current Austin pricing starts at $69 for a side or end table. A nightstand is $79, a queen bed frame starts at $119, dressers typically run $109–$149, and a single IKEA PAX wardrobe starts at $199. The exact total depends on the items and options selected during booking.',
      'For multiple pieces, add every item to the same booking so the full visit is priced together. Clear the work area, keep hardware in the boxes, and note any wall-anchoring needs before the Easer arrives.'
    ],
    relatedLinks: [
      { href: '/furniture-assembly-austin-tx', label: 'Austin furniture assembly service' },
      { href: '/pricing', label: 'complete service pricing' },
    ],
  },
  {
    slug: 'best-furniture-assembly-austin',
    title: 'Best Furniture Assembly Service in Austin',
    tag: 'Furniture assembly',
    image: '/images/booking-service-furniture-assembly.jpg',
    alt: 'Austin homeowners talking with a local setup pro after service',
    serviceUrl: '/book?service=Furniture+Assembly',
    cta: 'Book Furniture Assembly',
    description: 'What Austin customers should look for before choosing someone to assemble furniture at home.',
    metaDescription: 'What Austin customers should look for before choosing someone to assemble furniture at home, from vetting to pricing clarity, tools, and trust. See how it works.',
    paragraphs: [
      'The best furniture assembly service is not just fast. It should show up prepared, protect the floor, read the hardware correctly, anchor risky pieces, and leave the item stable enough for daily use.',
      'Before booking, know the brand, item type, quantity, and whether anything needs to be moved or removed. That helps AssembleAtEase match the visit to the job instead of guessing after arrival.'
    ],
  },
  {
    slug: 'wayfair-furniture-assembly-austin',
    title: 'Wayfair Furniture Assembly in Austin',
    tag: 'Furniture assembly',
    image: '/images/service-furniture-assembly.jpg',
    alt: 'Austin furniture assembly service with a pro building a storage piece',
    serviceUrl: '/book?service=Furniture+Assembly',
    cta: 'Book Wayfair Assembly',
    description: 'How Wayfair assembly compares with a local Austin setup visit.',
    metaDescription: 'How Wayfair furniture assembly compares with a local Austin setup visit, what takes the longest, what to prep, and when hiring a pro is worth it. Upfront pricing.',
    paragraphs: [
      'Wayfair pieces can look simple online but arrive with mixed hardware, multi-box parts, and instructions that assume plenty of space. Beds, dressers, cabinets, and storage pieces are where mistakes show up fastest.',
      'A local assembly visit gives you more control over timing, room placement, and bundled add-ons like TV mounting or old-item breakdown. Have the order link or item name ready when you book.'
    ],
  },
  {
    slug: 'bed-frame-assembly-austin',
    title: 'Bed Frame Assembly in Austin TX',
    tag: 'Furniture assembly',
    image: '/images/hero-pro-optimized.jpg',
    alt: 'Home setup guides pro assembling furniture after delivery',
    serviceUrl: '/book?service=Furniture+Assembly',
    cta: 'Book Bed Assembly',
    description: 'Cost, timing, and prep tips for Austin bed frame assembly.',
    metaDescription: 'Cost, timing, and prep tips for bed frame assembly in Austin, from queen and king to storage and platform beds built solid and leveled. Upfront pricing, book online.',
    paragraphs: [
      'Bed frame assembly can be quick for a basic metal frame, but storage beds, platform beds, headboards, and adjustable bases take longer because alignment and support matter. A missed center leg or loose slat can create wobble fast.',
      'Clear the bedroom before the visit, keep all hardware together, and confirm whether an old frame needs breakdown or removal. One clean appointment can get the room sleep-ready the same day.'
    ],
  },
  {
    slug: 'ikea-pax-wardrobe-assembly',
    title: 'IKEA PAX Wardrobe Assembly',
    tag: 'Furniture assembly',
    image: '/images/service-office-assembly.jpg',
    alt: 'Austin storage and furniture assembly with a pro aligning parts',
    serviceUrl: '/book?service=Furniture+Assembly',
    cta: 'Book Wardrobe Assembly',
    description: 'Why IKEA PAX takes longer and what should be anchored properly.',
    metaDescription: 'Why an IKEA PAX wardrobe takes longer to assemble, what must be anchored to the wall for safety, and how to prep the space. See PAX pricing and book a pro online.',
    paragraphs: [
      'IKEA PAX wardrobes need more planning than a normal dresser. Height, wall clearance, doors, drawers, shelves, and anchoring all affect how stable and usable the system feels after assembly.',
      'Measure ceiling height, clear the wall, and decide the final placement before the appointment. For tall storage, anchoring is not a detail; it is part of doing the job responsibly.'
    ],
  },
  {
    slug: 'crate-and-barrel-furniture-assembly-austin',
    title: 'Crate and Barrel Assembly Cost in Austin',
    tag: 'Furniture assembly',
    image: '/images/about-hero-local-service.jpg',
    alt: 'Austin homeowners reviewing a finished setup with a local pro',
    serviceUrl: '/book?service=Furniture+Assembly',
    cta: 'Book Premium Assembly',
    description: 'What premium furniture usually needs during assembly and setup.',
    metaDescription: 'What premium Crate & Barrel furniture needs during assembly and setup in Austin, from careful handling to leveling and anchoring. See common pricing and book online.',
    paragraphs: [
      'Crate and Barrel pieces often need careful handling because finishes, legs, drawers, and alignment details are part of the look. Rushing the assembly can leave gaps, scratches, or wobble that should have been prevented.',
      'Share the item name, room location, and whether packaging removal is needed. A careful setup protects the furniture and keeps the room looking finished instead of half-built.'
    ],
  },
  {
    slug: 'smart-home-installation-austin',
    title: 'Smart Home Installation in Austin',
    tag: 'Smart home',
    image: '/images/work-smart-home.jpg',
    alt: 'Austin smart camera setup with a local pro installing a device',
    serviceUrl: '/book?service=Smart+Home',
    cta: 'Book Smart Home Setup',
    description: 'What to know before installing smart locks, cameras, thermostats, and doorbells in Austin.',
    metaDescription: 'What to know before installing smart locks, cameras, thermostats, and doorbells in Austin, from wiring to Wi-Fi and app setup. Installed and tested, upfront pricing.',
    paragraphs: [
      'Smart-home setup is best done before you need it. Locks, cameras, doorbells, thermostats, and sensors all depend on placement, Wi-Fi signal, app access, and clean account setup.',
      'Bring the device login, confirm Wi-Fi access, and decide where visibility matters most. The goal is simple: devices that work when you open the app, not another box sitting on the counter.'
    ],
  },
  {
    slug: 'garage-shelving-installation-austin',
    title: 'Garage Shelving Installation Cost in Austin',
    tag: 'Custom setup',
    image: '/images/business-commercial-services.jpg',
    alt: 'Austin storage and setup project planning with a service team',
    serviceUrl: '/book?service=Other',
    cta: 'Request Custom Setup',
    description: 'Garage shelving planning, wall anchoring, materials, and custom quote timing in Austin.',
    metaDescription: 'Garage shelving installation in Austin, covering layout planning, wall anchoring, materials, weight limits, and how custom-quote timing works. Book online.',
    paragraphs: [
      'Garage shelving cost depends on shelf type, wall material, storage weight, and whether the unit needs anchoring. The wrong anchors can fail once bins, tools, or seasonal items are loaded.',
      'Take photos of the wall and the shelving product before booking. That makes it easier to quote the job correctly and avoid sending someone without the right hardware.'
    ],
  },
  {
    slug: 'same-day-handyman-austin',
    title: 'Same-Day Handyman Service in Austin',
    tag: 'Fast help',
    image: '/images/easer-apply-crew.jpg',
    alt: 'Austin service pro arriving for a same-day home setup visit',
    serviceUrl: '/book',
    cta: 'Check Availability',
    description: 'What can realistically happen same day and how to make an Austin visit efficient.',
    metaDescription: 'What can realistically happen same day for Austin assembly and mounting jobs, how to make the visit efficient, and how to book the right time slot online.',
    paragraphs: [
      'Same-day help works best for clear, contained jobs: furniture assembly, TV mounting, smart device setup, small installs, and move-in punch lists. Bigger custom work may need photos or a quote first.',
      'To make the visit efficient, send the item links, room photos, wall type, and any access notes when booking. The clearer the job is upfront, the easier it is to finish on the first visit.'
    ],
  },
  {
    slug: 'why-hire-handyman-austin',
    title: 'Why Austin Homeowners Hire Instead of DIY',
    tag: 'Decision help',
    image: '/images/pricing-estimate-review.jpg',
    alt: 'Austin homeowners reviewing service details before booking',
    serviceUrl: '/book',
    cta: 'Book a Pro',
    description: 'A short decision blog for time, tools, risk, and home setup jobs worth hiring out.',
    metaDescription: 'When Austin homeowners should hire instead of DIY, weighing time, tools, risk, and the home setup jobs worth handing to a pro. Upfront pricing and online booking.',
    paragraphs: [
      'DIY is fine when the risk is low. Hiring makes more sense when the job involves heavy lifting, wall mounting, hidden studs, fragile furniture, electrical setup, or anything that gets expensive if it fails later.',
      'AssembleAtEase is built for those jobs that are too annoying or risky to wrestle with alone. You keep control of the booking while a prepared Easer handles the setup.'
    ],
  },
  {
    slug: 'tv-mounting-tips-austin',
    title: 'TV Mounting Tips for Austin Homes',
    tag: 'TV mounting',
    image: '/images/work-tv-mounting.jpg',
    alt: 'Austin TV mounting preparation with a pro leveling a bracket',
    serviceUrl: '/book?service=Mounting+%26+Hanging',
    cta: 'Book Mounting Help',
    description: 'Simple prep tips before mounting a TV in an Austin home or apartment.',
    metaDescription: 'Simple prep tips before mounting a TV in an Austin home or apartment, covering wall type, studs, height, and hiding cables, or book a pro with upfront pricing.',
    paragraphs: [
      'Before mounting a TV, decide the viewing height, check glare, confirm the wall type, and know whether the mount is fixed, tilting, or full-motion. Those choices matter more than people expect.',
      'If you rent, check wall rules first. If you own, think about cord visibility and outlet location before drilling starts. A little planning keeps the finished wall clean.'
    ],
  },
];

const bySlug = new Map(posts.map((post) => [post.slug, post]));

for (const post of posts) {
  const path = join(blogDir, `${post.slug}.html`);
  writeFileSync(path, renderPost(post), 'utf8');
}

writeFileSync(join(blogDir, 'index.html'), renderIndex(posts), 'utf8');

function renderPost(post) {
  const canonical = `${SITE}/blog/${post.slug}`;
  const metaDescription = post.metaDescription || post.description;
  const paragraphs = post.paragraphs.map((paragraph) => `    <p>${esc(paragraph)}</p>`).join('\n');
  const relatedLinks = post.relatedLinks?.length
    ? `\n    <p>Compare ${post.relatedLinks.map((link) => `<a href="${link.href}">${esc(link.label)}</a>`).join(' and ')} before booking.</p>`
    : '';
  const json = {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: post.title,
    description: post.description,
    url: canonical,
    author: { '@type': 'Organization', name: 'AssembleAtEase', url: SITE },
    publisher: {
      '@type': 'Organization',
      name: 'AssembleAtEase',
      url: SITE,
      logo: { '@type': 'ImageObject', url: `${SITE}/images/logo.jpg` },
    },
    image: `${SITE}${post.image}`,
    mainEntityOfPage: canonical,
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<title>${esc(post.title)} | AssembleAtEase</title>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="description" content="${esc(metaDescription)}"/>
<link rel="stylesheet" href="/assets/css/marketing.css"/>
<link rel="stylesheet" href="/assets/css/marketing-desktop.css" media="(min-width:900px)"/>
<link rel="canonical" href="${canonical}"/>
<meta property="og:type" content="article"/>
<meta property="og:title" content="${esc(post.title)}"/>
<meta property="og:description" content="${esc(post.description)}"/>
<meta property="og:url" content="${canonical}"/>
<meta property="og:site_name" content="AssembleAtEase"/>
<meta property="og:image" content="${SITE}${post.image}"/>
<meta property="og:image:alt" content="${esc(post.alt)}"/>
<meta name="twitter:card" content="summary_large_image"/>
<meta name="twitter:title" content="${esc(post.title)}"/>
<meta name="twitter:description" content="${esc(post.description)}"/>
<meta name="twitter:image" content="${SITE}${post.image}"/>
<link rel="icon" href="/favicon.ico" sizes="any"/>
<link rel="icon" type="image/svg+xml" href="/images/favicon.svg"/>
<link rel="apple-touch-icon" href="/images/apple-touch-icon.png" />
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=DM+Sans:wght@300;400;500;600&display=swap" rel="preload" as="style" onload="this.onload=null;this.rel='stylesheet'"/>
<noscript><link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=DM+Sans:wght@300;400;500;600&display=swap" rel="stylesheet"/></noscript>
<script type="application/ld+json">${JSON.stringify(json)}</script>
</head>
<body>
${nav()}<main id="main-content">
  <section class="blog-hero">
    <div class="blog-hero-copy">
      <a href="/blog/" class="page-back">Back to Blogs</a>
      <span class="guide-meta">${esc(post.tag)}</span>
      <h1 class="page-title">${esc(post.title)}</h1>
      <p class="page-desc">${esc(post.description)}</p>
    </div>
    <img class="blog-hero-image" src="${post.image}" alt="${esc(post.alt)}" width="640" height="440" loading="eager"/>
  </section>
  <article class="article article-short">
${paragraphs}${relatedLinks}
    <div class="article-cta">
      <strong>Need this handled in Austin?</strong>
      <a href="${post.serviceUrl}" class="btn btn-cyan btn-lg">${esc(post.cta)}</a>
    </div>
  </article>
</main>
${footer()}
${cookieBanner()}
</body>
</html>
`;
}

function renderIndex(allPosts) {
  const cards = allPosts.map((post) => `      <a href="/blog/${post.slug}" class="guide-card">
        <span class="guide-thumb"><img src="${post.image}" alt="${esc(post.alt)}" loading="lazy" width="300" height="300"></span>
        <span><span class="guide-meta">${esc(post.tag)}</span><span class="guide-title">${esc(post.title)}</span><span class="guide-copy">${esc(post.description)}</span><span class="guide-link">Read blog</span></span>
      </a>`).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<title>Texas Home Setup Guides | AssembleAtEase</title>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="description" content="Texas home setup guides covering furniture assembly, TV mounting, fitness equipment, outdoor setup, move-in planning, and practical booking advice across the state."/>
<link rel="stylesheet" href="/assets/css/marketing.css"/>
<link rel="stylesheet" href="/assets/css/marketing-desktop.css" media="(min-width:900px)"/>
<link rel="canonical" href="${SITE}/blog"/>
<meta property="og:type" content="website"/>
<meta property="og:title" content="Texas Home Setup Guides | AssembleAtEase"/>
<meta property="og:description" content="Practical home setup guides for customers across Texas, with city-specific resources where they add value."/>
<meta property="og:url" content="${SITE}/blog"/>
<meta property="og:site_name" content="AssembleAtEase"/>
<meta property="og:image" content="${SITE}/images/people-service-calm.jpg"/>
<meta name="twitter:card" content="summary_large_image"/>
<meta name="twitter:image" content="${SITE}/images/people-service-calm.jpg"/>
<link rel="icon" href="/favicon.ico" sizes="any"/>
<link rel="icon" type="image/svg+xml" href="/images/favicon.svg"/>
<link rel="apple-touch-icon" href="/images/apple-touch-icon.png" />
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=DM+Sans:wght@300;400;500;600&display=swap" rel="preload" as="style" onload="this.onload=null;this.rel='stylesheet'"/>
<noscript><link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=DM+Sans:wght@300;400;500;600&display=swap" rel="stylesheet"/></noscript>
</head>
<body>
${nav('/blog/')}<main id="main-content">
  <section class="page-hero">
    <div class="page-hero-inner">
      <a href="/" class="page-back">Back to Home</a>
      <h1 class="page-title">Texas Home Setup Guides</h1>
      <p class="page-desc">Practical statewide and local guides that help you choose the right service and book without guesswork.</p>
    </div>
  </section>
  <section class="guides-section">
    <div class="guides-wrap">
      <div class="guides-head">
        <div>
          <div class="guides-kicker">Home setup guides</div>
          <h2 class="guides-heading">Pick the issue. Book the fix.</h2>
          <p class="guides-intro">Start with the statewide planning guide, then use local articles when city-specific access, housing, or service details matter.</p>
        </div>
        <a href="/book" class="guides-head-link">Book a service</a>
      </div>
      <div class="guides-category-row" aria-label="Blog categories">
        <a href="/book?service=Furniture+Assembly" class="guide-filter">Furniture assembly</a>
        <a href="/book?service=Mounting+%26+Hanging" class="guide-filter">TV mounting</a>
        <a href="/book?service=Smart+Home" class="guide-filter">Smart home</a>
        <a href="/business" class="guide-filter">Business projects</a>
      </div>
      <div class="guides-grid">
      <a href="/blog/texas-furniture-assembly-home-setup-guide" class="guide-card">
        <span class="guide-thumb"><img src="/images/service-furniture-assembly.jpg" alt="Professional furniture assembly and home setup in Texas" loading="lazy" width="300" height="300"></span>
        <span><span class="guide-meta">Statewide Texas</span><span class="guide-title">Texas Furniture Assembly and Home Setup Guide</span><span class="guide-copy">Plan assembly, TV mounting, fitness equipment, outdoor setup, and move-in projects across every Texas region.</span><span class="guide-link">Read guide</span></span>
      </a>
${cards}
      </div>
    </div>
  </section>
</main>
${footer()}
${cookieBanner()}
</body>
</html>
`;
}

function nav(activeHref = '') {
  return buildPublicNavBlock({
    variant: 'blog',
    includeSkipNav: true,
    activeHref,
  });
}

function footer() {
  return buildPublicFooterBlock({
    variant: 'blog_resources',
    tagline: 'Professional furniture assembly, TV mounting, smart home setup, office assembly, outdoor assembly, and home services with clear pricing and careful work.',
  });
}

function cookieBanner() {
  return buildPublicCookieConsentBlock();
}

function esc(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

for (const post of posts) {
  if (!bySlug.has(post.slug)) throw new Error(`Missing post config for ${post.slug}`);
}
