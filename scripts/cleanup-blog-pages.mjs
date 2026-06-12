import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const SITE = 'https://www.assembleatease.com';
const root = process.cwd();
const blogDir = join(root, 'blog');

const posts = [
  {
    slug: 'new-home-setup-checklist-austin',
    title: 'New Home Setup Checklist for Austin Movers',
    tag: 'Move-in setup',
    image: '/images/people-service-calm.jpg',
    alt: 'Austin home setup service after a move',
    serviceUrl: '/book',
    cta: 'Book Home Setup',
    description: 'A short Austin move-in checklist for furniture, TV mounting, smart devices, and booking the right help.',
    paragraphs: [
      'Moving into an Austin home gets easier when the heavy setup happens in the right order: beds and desks first, TVs after furniture placement, then smart locks, cameras, thermostats, and Wi-Fi devices once the room layout is final.',
      'If boxes are stacking up, book one visit that bundles assembly, TV mounting, and smart-home setup. It saves separate appointments, reduces mistakes, and gets the home usable faster.'
    ],
  },
  {
    slug: 'tv-mounting-costs-austin',
    title: 'TV Mounting Costs in Austin TX',
    tag: 'TV mounting',
    image: '/images/service-tv-mounting.jpg',
    alt: 'TV mounting service in Austin',
    serviceUrl: '/book?service=Mounting+%26+Hanging',
    cta: 'Book TV Mounting',
    description: 'What affects TV mounting cost in Austin, including screen size, wall type, mount style, and cord planning.',
    paragraphs: [
      'TV mounting in Austin usually changes price based on screen size, wall type, mount style, and whether cords need to be hidden. Drywall with studs is simpler; brick, stone, fireplace installs, and full-motion mounts need more care.',
      'The expensive part is not the bracket. It is the risk of a crooked mount, missed studs, wall damage, or a dropped screen. A pro visit keeps the install clean, level, and secure before the TV becomes a problem.'
    ],
  },
  {
    slug: 'tv-wall-mount-installation-cost-austin',
    title: 'TV Wall Mount Installation Cost in Austin',
    tag: 'TV mounting',
    image: '/images/work-tv-mounting.jpg',
    alt: 'TV wall mount installation in Austin',
    serviceUrl: '/book?service=Mounting+%26+Hanging',
    cta: 'Schedule Wall Mounting',
    description: 'A short cost guide for Austin TV wall mounting, including mount type, cable planning, and wall material.',
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
    alt: 'Outdoor home setup in Austin',
    serviceUrl: '/book?service=Mounting+%26+Hanging',
    cta: 'Plan Outdoor Mounting',
    description: 'What changes when an Austin TV installation is outside, exposed, or part of a patio setup.',
    paragraphs: [
      'Outdoor TV installs in Austin need a different plan than indoor mounting. Sun, heat, rain exposure, outlet location, wall material, and viewing angle all matter before the bracket goes up.',
      'Use an outdoor-rated TV or protected enclosure, choose a shaded viewing spot when possible, and confirm power access before the visit. A careful setup keeps the patio useful without turning the job into rework.'
    ],
  },
  {
    slug: 'ikea-assembly-cost-austin',
    title: 'IKEA Assembly Cost in Austin',
    tag: 'Furniture assembly',
    image: '/images/service-furniture-assembly.jpg',
    alt: 'IKEA furniture assembly in Austin',
    serviceUrl: '/book?service=Furniture+Assembly',
    cta: 'Book IKEA Assembly',
    description: 'A quick Austin guide to IKEA assembly cost, timing, and when bundling multiple pieces makes sense.',
    paragraphs: [
      'IKEA assembly cost depends on the piece count, size, drawers, doors, wall anchoring, and whether the item has to be built in a tight room. Small pieces move fast; wardrobes, beds, and storage systems take longer.',
      'Bundling pieces into one visit is usually smarter than booking one item at a time. Clear the work area, keep hardware in the boxes, and note any wall-anchoring needs before the Easer arrives.'
    ],
  },
  {
    slug: 'best-furniture-assembly-austin',
    title: 'Best Furniture Assembly Service in Austin',
    tag: 'Furniture assembly',
    image: '/images/work-office-assembly.jpg',
    alt: 'Furniture assembly quality checklist',
    serviceUrl: '/book?service=Furniture+Assembly',
    cta: 'Book Furniture Assembly',
    description: 'What Austin customers should look for before choosing someone to assemble furniture at home.',
    paragraphs: [
      'The best furniture assembly service is not just fast. It should show up prepared, protect the floor, read the hardware correctly, anchor risky pieces, and leave the item stable enough for daily use.',
      'Before booking, know the brand, item type, quantity, and whether anything needs to be moved or removed. That helps AssembleAtEase match the visit to the job instead of guessing after arrival.'
    ],
  },
  {
    slug: 'wayfair-furniture-assembly-austin',
    title: 'Wayfair Furniture Assembly in Austin',
    tag: 'Furniture assembly',
    image: '/images/booking-service-furniture-assembly.jpg',
    alt: 'Wayfair furniture assembly service in Austin',
    serviceUrl: '/book?service=Furniture+Assembly',
    cta: 'Book Wayfair Assembly',
    description: 'How Wayfair assembly compares with a local Austin setup visit.',
    paragraphs: [
      'Wayfair pieces can look simple online but arrive with mixed hardware, multi-box parts, and instructions that assume plenty of space. Beds, dressers, cabinets, and storage pieces are where mistakes show up fastest.',
      'A local assembly visit gives you more control over timing, room placement, and bundled add-ons like TV mounting or old-item breakdown. Have the order link or item name ready when you book.'
    ],
  },
  {
    slug: 'bed-frame-assembly-austin',
    title: 'Bed Frame Assembly in Austin TX',
    tag: 'Furniture assembly',
    image: '/images/pricing-estimate-review.jpg',
    alt: 'Bed frame assembly planning in Austin',
    serviceUrl: '/book?service=Furniture+Assembly',
    cta: 'Book Bed Assembly',
    description: 'Cost, timing, and prep tips for Austin bed frame assembly.',
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
    alt: 'Wardrobe and storage assembly in Austin',
    serviceUrl: '/book?service=Furniture+Assembly',
    cta: 'Book Wardrobe Assembly',
    description: 'Why IKEA PAX takes longer and what should be anchored properly.',
    paragraphs: [
      'IKEA PAX wardrobes need more planning than a normal dresser. Height, wall clearance, doors, drawers, shelves, and anchoring all affect how stable and usable the system feels after assembly.',
      'Measure ceiling height, clear the wall, and decide the final placement before the appointment. For tall storage, anchoring is not a detail; it is part of doing the job responsibly.'
    ],
  },
  {
    slug: 'crate-and-barrel-furniture-assembly-austin',
    title: 'Crate and Barrel Assembly Cost in Austin',
    tag: 'Furniture assembly',
    image: '/images/booking-service-office-assembly.jpg',
    alt: 'Premium furniture assembly in Austin',
    serviceUrl: '/book?service=Furniture+Assembly',
    cta: 'Book Premium Assembly',
    description: 'What premium furniture usually needs during assembly and setup.',
    paragraphs: [
      'Crate and Barrel pieces often need careful handling because finishes, legs, drawers, and alignment details are part of the look. Rushing the assembly can leave gaps, scratches, or wobble that should have been prevented.',
      'Share the item name, room location, and whether packaging removal is needed. A careful setup protects the furniture and keeps the room looking finished instead of half-built.'
    ],
  },
  {
    slug: 'smart-home-installation-austin',
    title: 'Smart Home Installation in Austin',
    tag: 'Smart home',
    image: '/images/service-smart-home.jpg',
    alt: 'Smart home installation service in Austin',
    serviceUrl: '/book?service=Smart+Home',
    cta: 'Book Smart Home Setup',
    description: 'What to know before installing smart locks, cameras, thermostats, and doorbells in Austin.',
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
    alt: 'Garage shelving and storage setup in Austin',
    serviceUrl: '/book?service=Other',
    cta: 'Request Custom Setup',
    description: 'Garage shelving planning, wall anchoring, materials, and custom quote timing in Austin.',
    paragraphs: [
      'Garage shelving cost depends on shelf type, wall material, storage weight, and whether the unit needs anchoring. The wrong anchors can fail once bins, tools, or seasonal items are loaded.',
      'Take photos of the wall and the shelving product before booking. That makes it easier to quote the job correctly and avoid sending someone without the right hardware.'
    ],
  },
  {
    slug: 'same-day-handyman-austin',
    title: 'Same-Day Handyman Service in Austin',
    tag: 'Fast help',
    image: '/images/hero-pro-optimized.jpg',
    alt: 'Same-day home setup help in Austin',
    serviceUrl: '/book',
    cta: 'Check Availability',
    description: 'What can realistically happen same day and how to make an Austin visit efficient.',
    paragraphs: [
      'Same-day help works best for clear, contained jobs: furniture assembly, TV mounting, smart device setup, small installs, and move-in punch lists. Bigger custom work may need photos or a quote first.',
      'To make the visit efficient, send the item links, room photos, wall type, and any access notes when booking. The clearer the job is upfront, the easier it is to finish on the first visit.'
    ],
  },
  {
    slug: 'why-hire-handyman-austin',
    title: 'Why Austin Homeowners Hire Instead of DIY',
    tag: 'Decision guide',
    image: '/images/about-story-customer-review.jpg',
    alt: 'Austin homeowner service decision guide',
    serviceUrl: '/book',
    cta: 'Book a Pro',
    description: 'A short decision guide for time, tools, risk, and home setup jobs worth hiring out.',
    paragraphs: [
      'DIY is fine when the risk is low. Hiring makes more sense when the job involves heavy lifting, wall mounting, hidden studs, fragile furniture, electrical setup, or anything that gets expensive if it fails later.',
      'AssembleAtEase is built for those jobs that are too annoying or risky to wrestle with alone. You keep control of the booking while a prepared Easer handles the setup.'
    ],
  },
  {
    slug: 'tv-mounting-tips-austin',
    title: 'TV Mounting Tips for Austin Homes',
    tag: 'TV mounting',
    image: '/images/booking-service-tv-mounting.jpg',
    alt: 'TV mounting preparation in Austin',
    serviceUrl: '/book?service=Mounting+%26+Hanging',
    cta: 'Book Mounting Help',
    description: 'Simple prep tips before mounting a TV in an Austin home or apartment.',
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
<script>(function(){if(localStorage.getItem('cookie-consent')==='accepted'){var s=document.createElement('script');s.async=true;s.src='https://www.googletagmanager.com/gtag/js?id=G-ZN45GP8D25';document.head.appendChild(s);window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}window.gtag=gtag;gtag('js',new Date());gtag('config','G-ZN45GP8D25');gtag('config','AW-16551666395');}})();</script>
<meta charset="UTF-8"/>
<title>${esc(post.title)} | AssembleAtEase</title>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="description" content="${esc(post.description)}"/>
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
<link rel="icon" type="image/svg+xml" href="/images/favicon.svg"/>
<link rel="icon" type="image/jpeg" href="/images/logo.jpg"/>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=DM+Sans:wght@300;400;500;600&display=swap" rel="preload" as="style" onload="this.onload=null;this.rel='stylesheet'"/>
<noscript><link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=DM+Sans:wght@300;400;500;600&display=swap" rel="stylesheet"/></noscript>
<script type="application/ld+json">${JSON.stringify(json)}</script>
</head>
<body>
${nav()}
<main id="main-content">
  <section class="blog-hero">
    <div class="blog-hero-copy">
      <a href="/blog/" class="page-back">Back to Guides</a>
      <span class="guide-meta">${esc(post.tag)}</span>
      <h1 class="page-title">${esc(post.title)}</h1>
      <p class="page-desc">${esc(post.description)}</p>
    </div>
    <img class="blog-hero-image" src="${post.image}" alt="${esc(post.alt)}" width="640" height="440" loading="eager"/>
  </section>
  <article class="article article-short">
    <p>${esc(post.paragraphs[0])}</p>
    <p>${esc(post.paragraphs[1])}</p>
    <div class="article-cta">
      <strong>Need this handled in Austin?</strong>
      <a href="${post.serviceUrl}" class="btn btn-cyan btn-lg">${esc(post.cta)}</a>
    </div>
  </article>
</main>
${footer()}
${cookieBanner()}
<script type="text/javascript" id="hs-script-loader" async defer src="https://js-na2.hs-scripts.com/245917212.js"></script>
</body>
</html>
`;
}

function renderIndex(allPosts) {
  const cards = allPosts.map((post) => `      <a href="/blog/${post.slug}" class="guide-card">
        <span class="guide-thumb"><img src="${post.image}" alt="${esc(post.alt)}" loading="lazy" width="300" height="300"></span>
        <span><span class="guide-meta">${esc(post.tag)}</span><span class="guide-title">${esc(post.title)}</span><span class="guide-copy">${esc(post.description)}</span><span class="guide-link">Read guide</span></span>
      </a>`).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<script>(function(){if(localStorage.getItem('cookie-consent')==='accepted'){var s=document.createElement('script');s.async=true;s.src='https://www.googletagmanager.com/gtag/js?id=G-ZN45GP8D25';document.head.appendChild(s);window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}window.gtag=gtag;gtag('js',new Date());gtag('config','G-ZN45GP8D25');gtag('config','AW-16551666395');}})();</script>
<meta charset="UTF-8"/>
<title>Home Setup Guides | AssembleAtEase Austin TX</title>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="description" content="Short Austin home setup guides for furniture assembly, TV mounting, smart home installation, move-ins, and booking decisions."/>
<link rel="stylesheet" href="/assets/css/marketing.css"/>
<link rel="stylesheet" href="/assets/css/marketing-desktop.css" media="(min-width:900px)"/>
<link rel="canonical" href="${SITE}/blog"/>
<meta property="og:type" content="website"/>
<meta property="og:title" content="Home Setup Guides | AssembleAtEase Austin TX"/>
<meta property="og:description" content="Short Austin home setup guides for booking the right service without reading a long article."/>
<meta property="og:url" content="${SITE}/blog"/>
<meta property="og:site_name" content="AssembleAtEase"/>
<meta property="og:image" content="${SITE}/images/people-service-calm.jpg"/>
<meta name="twitter:card" content="summary_large_image"/>
<meta name="twitter:image" content="${SITE}/images/people-service-calm.jpg"/>
<link rel="icon" type="image/svg+xml" href="/images/favicon.svg"/>
<link rel="icon" type="image/jpeg" href="/images/logo.jpg"/>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=DM+Sans:wght@300;400;500;600&display=swap" rel="preload" as="style" onload="this.onload=null;this.rel='stylesheet'"/>
<noscript><link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=DM+Sans:wght@300;400;500;600&display=swap" rel="stylesheet"/></noscript>
</head>
<body>
${nav()}
<main id="main-content">
  <section class="page-hero">
    <div class="page-hero-inner">
      <a href="/" class="page-back">Back to Home</a>
      <h1 class="page-title">Home Setup Guides</h1>
      <p class="page-desc">Short, practical Austin guides that help you choose the right service and book without guesswork.</p>
    </div>
  </section>
  <section class="guides-section">
    <div class="guides-wrap">
      <div class="guides-head">
        <div>
          <div class="guides-kicker">Austin home setup</div>
          <h2 class="guides-heading">Pick the issue. Book the fix.</h2>
          <p class="guides-intro">Every guide is short on purpose: two paragraphs, one clear next step, no filler.</p>
        </div>
        <a href="/book" class="guides-head-link">Book a service</a>
      </div>
      <div class="guides-category-row" aria-label="Guide categories">
        <a href="/furniture-assembly-austin-tx" class="guide-filter">Furniture assembly</a>
        <a href="/tv-mounting-austin-tx" class="guide-filter">TV mounting</a>
        <a href="/smart-home-installation-austin-tx" class="guide-filter">Smart home</a>
        <a href="/business" class="guide-filter">Business projects</a>
      </div>
      <div class="guides-grid">
${cards}
      </div>
    </div>
  </section>
</main>
${footer()}
${cookieBanner()}
<script type="text/javascript" id="hs-script-loader" async defer src="https://js-na2.hs-scripts.com/245917212.js"></script>
</body>
</html>
`;
}

function nav() {
  return `<a href="#main-content" class="skip-nav">Skip to main content</a>
<nav class="nav">
  <div class="nav-inner">
    <a href="/" class="nav-logo">
      <picture><source srcset="/images/logo.webp" type="image/webp"><img src="/images/logo.jpg" alt="AssembleAtEase Logo" width="42" height="42"/></picture>
      <div class="nav-logo-text">Assemble<span>AtEase</span></div>
    </a>
    <ul class="nav-links">
      <li><a href="/#services">Services</a></li>
      <li><a href="/blog/">Guides</a></li>
      <li><a href="/pricing">Pricing</a></li>
      <li><a href="/about">About</a></li>
    </ul>
    <a href="/book" class="btn btn-cyan nav-book-pill">Book Now</a>
    <button class="nav-hamburger" id="hamburger" aria-label="Toggle navigation" onclick="document.getElementById('hamburger').classList.toggle('open');document.getElementById('mobileNav').classList.toggle('open')"><span></span><span></span><span></span></button>
  </div>
</nav>
<div class="nav-mobile" id="mobileNav">
  <a href="/furniture-assembly-austin-tx">Furniture Assembly</a>
  <a href="/tv-mounting-austin-tx">TV Mounting</a>
  <a href="/smart-home-installation-austin-tx">Smart Home Setup</a>
  <a href="/pricing">Pricing</a>
  <a href="/track">Track My Booking</a>
  <a href="/book" class="btn btn-cyan btn-full">Book Now</a>
</div>
<script>document.getElementById('mobileNav').addEventListener('click',function(e){if(e.target.closest('a')){document.getElementById('hamburger').classList.remove('open');document.getElementById('mobileNav').classList.remove('open');}});</script>`;
}

function footer() {
  return `<footer class="footer">
  <div class="footer-inner">
    <div>
      <div class="footer-logo"><picture><source srcset="/images/logo.webp" type="image/webp"><img src="/images/logo.jpg" alt="AssembleAtEase Logo" width="38" height="38"/></picture><div class="footer-logo-text">Assemble<span>AtEase</span></div></div>
      <p class="footer-tagline">Professional furniture assembly, TV mounting, smart home setup, and home services in Austin, Texas.</p>
      <div class="footer-contact"><a href="mailto:service@assembleatease.com">service@assembleatease.com</a></div>
    </div>
    <div>
      <div class="footer-col-title">Services</div>
      <ul class="footer-links">
        <li><a href="/furniture-assembly-austin-tx">Furniture Assembly</a></li>
        <li><a href="/tv-mounting-austin-tx">TV Mounting</a></li>
        <li><a href="/smart-home-installation-austin-tx">Smart Home</a></li>
      </ul>
    </div>
    <div>
      <div class="footer-col-title">Company</div>
      <ul class="footer-links">
        <li><a href="/about">About</a></li>
        <li><a href="/pricing">Pricing</a></li>
        <li><a href="/blog/">Guides</a></li>
        <li><a href="/contact">Contact</a></li>
      </ul>
    </div>
  </div>
  <div class="footer-bottom">
    <div class="footer-copy">&copy; <span id="year"></span> AssembleAtEase. All rights reserved. Austin, TX.</div>
    <div class="footer-legal"><a href="/privacy">Privacy Policy</a><a href="/terms">Terms</a></div>
  </div>
</footer>
<script>document.getElementById('year').textContent=new Date().getFullYear();</script>`;
}

function cookieBanner() {
  return `<div id="cookie-banner" class="hidden">
  <span>We use cookies to improve your experience and track site analytics. See our <a href="/privacy">Privacy Policy</a>.</span>
  <div class="cookie-btns">
    <button class="cookie-btn cookie-decline" onclick="declineCookies()">Decline</button>
    <button class="cookie-btn cookie-accept" onclick="acceptCookies()">Accept</button>
  </div>
</div>
<script>
function acceptCookies(){document.getElementById("cookie-banner").classList.add("hidden");localStorage.setItem("cookie-consent","accepted");(function(){var s=document.createElement('script');s.async=true;s.src='https://www.googletagmanager.com/gtag/js?id=G-ZN45GP8D25';document.head.appendChild(s);window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}window.gtag=gtag;gtag('js',new Date());gtag('config','G-ZN45GP8D25');gtag('config','AW-16551666395');})();}
function declineCookies(){document.getElementById("cookie-banner").classList.add("hidden");localStorage.setItem("cookie-consent","declined");}
window.addEventListener("DOMContentLoaded",function(){if(!localStorage.getItem("cookie-consent")){document.getElementById("cookie-banner").classList.remove("hidden");}});
</script>`;
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
