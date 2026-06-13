#!/usr/bin/env node
// scripts/generate-location-pages.js
// Generates 72 local SEO landing pages (12 cities × 6 services) + updates sitemap.xml
// Run: node scripts/generate-location-pages.js

import { writeFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const TODAY = '2026-06-04';

function esc(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function safeJson(obj) {
  return JSON.stringify(obj).replace(/<\//g, '<\\/');
}

// ── CITY DATA ──────────────────────────────────────────────────────────────
const CITIES = [
  {
    name: 'Austin',
    slug: 'austin',
    zip: '78701',
    bio: 'Austin is the state capital of Texas and a booming tech and creative hub, home to the University of Texas, a vibrant live-music scene, and one of the fastest-growing professional populations in the country.',
    landmark: 'Barton Springs Pool and South Congress Avenue',
    nearby: ['Round Rock', 'Cedar Park', 'Pflugerville', 'Lakeway'],
    lat: '30.2672',
    lng: '-97.7431',
  },
  {
    name: 'Pflugerville',
    slug: 'pflugerville',
    zip: '78660',
    bio: 'Pflugerville is a fast-growing suburb northeast of Austin, known for its affordable family neighborhoods, excellent schools, and quick access to major employers along the SH-130 corridor.',
    landmark: 'Lake Pflugerville and Typhoon Texas waterpark',
    nearby: ['Austin', 'Round Rock', 'Hutto', 'Manor'],
    lat: '30.4349',
    lng: '-97.6200',
  },
  {
    name: 'Round Rock',
    slug: 'round-rock',
    zip: '78664',
    bio: 'Round Rock is a thriving suburb north of Austin, nationally recognized for its family-friendly neighborhoods and proximity to major employers along the I-35 corridor, including Dell Technologies headquarters.',
    landmark: 'Dell Diamond baseball stadium and Old Settlers Park',
    nearby: ['Austin', 'Georgetown', 'Pflugerville', 'Hutto'],
    lat: '30.5083',
    lng: '-97.6789',
  },
  {
    name: 'Cedar Park',
    slug: 'cedar-park',
    zip: '78613',
    bio: 'Cedar Park is a rapidly growing suburb northwest of Austin, popular with families and tech professionals for its top-rated schools, master-planned communities, and easy access to the 183A Toll Road.',
    landmark: 'H-E-B Center at Cedar Park and Brushy Creek Lake Park',
    nearby: ['Austin', 'Leander', 'Round Rock', 'Georgetown'],
    lat: '30.5052',
    lng: '-97.8203',
  },
  {
    name: 'Georgetown',
    slug: 'georgetown',
    zip: '78626',
    bio: 'Georgetown is a historic city north of Austin, celebrated for its beautifully preserved Victorian-era courthouse square, vibrant downtown dining scene, and one of the fastest population growth rates in the entire country.',
    landmark: 'Williamson County Courthouse Square and Blue Hole Regional Park',
    nearby: ['Round Rock', 'Cedar Park', 'Leander', 'Hutto'],
    lat: '30.6332',
    lng: '-97.6777',
  },
  {
    name: 'Leander',
    slug: 'leander',
    zip: '78641',
    bio: 'Leander is one of Austin\'s fastest-growing suburbs, situated along the MetroRail line northwest of the city and known for its master-planned communities, new construction homes, and family-oriented lifestyle.',
    landmark: 'Crystal Falls Golf Course and Leander MetroRail Station',
    nearby: ['Cedar Park', 'Georgetown', 'Austin', 'Round Rock'],
    lat: '30.5788',
    lng: '-97.8530',
  },
  {
    name: 'Hutto',
    slug: 'hutto',
    zip: '78634',
    bio: 'Hutto is a small but rapidly expanding city northeast of Austin along the SH-130 corridor, known for its tight-knit community feel, newer subdivisions, and proximity to major distribution and tech employers.',
    landmark: 'Hippo Stadium and historic Old Town Hutto',
    nearby: ['Round Rock', 'Pflugerville', 'Georgetown', 'Manor'],
    lat: '30.5432',
    lng: '-97.5467',
  },
  {
    name: 'Manor',
    slug: 'manor',
    zip: '78653',
    bio: 'Manor is a growing community just east of Austin, attracting families and first-time homebuyers with affordable new-construction neighborhoods and convenient access to downtown Austin via US-290.',
    landmark: 'Colorado River greenway and the ShadowGlen master-planned community',
    nearby: ['Austin', 'Pflugerville', 'Hutto', 'Round Rock'],
    lat: '30.3413',
    lng: '-97.5567',
  },
  {
    name: 'Bee Cave',
    slug: 'bee-cave',
    zip: '78738',
    bio: 'Bee Cave is an upscale community nestled in the Texas Hill Country just west of Austin, known for luxury master-planned developments, the Hill Country Galleria shopping center, and easy access to Lake Travis.',
    landmark: 'Hill Country Galleria and Falconhead Golf Club',
    nearby: ['Lakeway', 'Austin', 'Cedar Park', 'Leander'],
    lat: '30.3087',
    lng: '-97.9594',
  },
  {
    name: 'Lakeway',
    slug: 'lakeway',
    zip: '78734',
    bio: 'Lakeway is a scenic Lake Travis community in the Texas Hill Country west of Austin, prized for its stunning water views, resort-style amenities, and the sought-after Eanes ISD school district.',
    landmark: 'Lake Travis waterfront and the Lakeway Resort and Spa',
    nearby: ['Bee Cave', 'Austin', 'Cedar Park', 'Leander'],
    lat: '30.3522',
    lng: '-97.9780',
  },
  {
    name: 'Buda',
    slug: 'buda',
    zip: '78610',
    bio: 'Buda is a charming Hill Country gateway town south of Austin on I-35, known for its walkable historic downtown, strong community character, and some of the most sought-after family neighborhoods in the greater Austin metro.',
    landmark: 'Buda City Park and the historic Main Street district',
    nearby: ['Kyle', 'Austin', 'Cedar Park', 'Leander'],
    lat: '30.0852',
    lng: '-97.8397',
  },
  {
    name: 'Kyle',
    slug: 'kyle',
    zip: '78640',
    bio: 'Kyle is one of the fastest-growing cities in America, located south of Austin along I-35 and drawing families with its new master-planned communities, competitive home prices, and easy access to Austin\'s booming job market.',
    landmark: 'Plum Creek Trail System and Kyle\'s revitalized downtown district',
    nearby: ['Buda', 'Austin', 'Cedar Park', 'Leander'],
    lat: '29.9889',
    lng: '-97.8772',
  },
];

// ── SERVICE DATA ───────────────────────────────────────────────────────────
const SERVICES = [
  {
    name: 'Furniture Assembly',
    slug: 'furniture-assembly',
    bookingParam: 'Furniture+Assembly',
    tagline: 'Professional assembly for any brand, any room.',
    intro: 'We assemble IKEA, Wayfair, Amazon, Ashley, and any other brand — beds, dressers, sofas, desks, wardrobes, and more. All tools included, work guaranteed.',
    fromPrice: '$69',
    pricingHighlights: [
      { name: 'Bed Frame (Queen)', price: '$119', popular: true },
      { name: 'Sectional Sofa (L-shape)', price: '$139–$169', popular: false },
      { name: 'Dresser / Chest of Drawers', price: '$99–$119', popular: false },
      { name: 'IKEA PAX Wardrobe', price: '$169+', popular: false },
    ],
    faqs: [
      { q: 'How long does furniture assembly take?', a: 'Most single items take 30–90 minutes. A full bedroom set (bed + dresser + desk) typically takes 2–3 hours. We\'ll give you a time estimate when confirming your booking.' },
      { q: 'Do you bring your own tools?', a: 'Yes — our Easers arrive fully equipped. You don\'t need to provide any tools or equipment.' },
      { q: 'Can you assemble any brand?', a: 'Yes — IKEA, Wayfair, Amazon, Ashley, Target, Costco, CB2, Pottery Barn, West Elm, and more. If it came in a box with instructions, we can build it.' },
    ],
    relatedService: 'office-furniture-assembly',
    brands: ['IKEA', 'Wayfair', 'Amazon', 'Ashley', 'West Elm', 'Pottery Barn', 'Costco', 'Target'],
    mainPage: '/furniture-assembly-austin-tx',
  },
  {
    name: 'Mounting & Hanging',
    slug: 'tv-mounting',
    bookingParam: 'Mounting+%26+Hanging',
    tagline: 'Safe, level, and clean mounting on any wall.',
    intro: 'We mount TVs, shelves, mirrors, gallery walls, curtain rods, projectors, and more — standard drywall, brick, concrete, tile, or above the fireplace. All bracket types handled, cords managed, no mess left behind.',
    fromPrice: '$79',
    pricingHighlights: [
      { name: 'Single framed picture / mirror', price: '$79', popular: false },
      { name: 'TV up to 40" (standard wall)', price: '$99', popular: false },
      { name: 'TV 41"–55" (standard wall)', price: '$119', popular: true },
      { name: 'In-wall cord concealment', price: '$189', popular: false },
    ],
    faqs: [
      { q: 'Do you supply the TV mount?', a: 'We can supply TV mount hardware for $39, or we\'ll use yours — your choice at booking.' },
      { q: 'Can you mount a TV above a fireplace?', a: 'Yes. Above-fireplace mounts include an $85 add-on for the extra height, reach, and precise tilt-angle work required.' },
      { q: 'What wall types do you work with?', a: 'Drywall, brick, concrete, tile, and steel-stud framing. Brick/concrete is a $75 add-on, tile is $65, and steel stud framing is $55.' },
    ],
    relatedService: 'smart-home-installation',
    brands: ['Samsung', 'LG', 'Sony', 'TCL', 'Vizio', 'Hisense'],
    mainPage: '/tv-mounting-austin-tx',
  },
  {
    name: 'Smart Home Installation',
    slug: 'smart-home-installation',
    bookingParam: 'Smart+Home',
    tagline: 'Seamless smart device setup in every room.',
    intro: 'From smart thermostats and doorbells to locks, cameras, lighting systems, hubs, Wi-Fi, and streaming devices — we install, connect, and test every device so it works perfectly the first time.',
    fromPrice: '$69',
    pricingHighlights: [
      { name: 'Smart plug install + setup (per 2 plugs)', price: '$69', popular: false },
      { name: 'Smart Thermostat (Nest, Ecobee)', price: '$99', popular: true },
      { name: 'Smart Doorbell — wireless', price: '$89', popular: false },
      { name: 'Camera System (4 cameras)', price: '$249', popular: false },
    ],
    faqs: [
      { q: 'Do I need WiFi set up before the appointment?', a: 'Yes — a working WiFi network is required. We handle all device pairing, configuration, and app setup during the visit.' },
      { q: 'Can you install a smart thermostat without a C-wire?', a: 'Yes. Choose the no-C-wire thermostat option in booking; current catalog price is $129.' },
      { q: 'Do you set up the app on my phone too?', a: 'Yes — we configure and test the device app on your phone before we leave, so everything works before we go.' },
    ],
    relatedService: 'tv-mounting',
    brands: ['Nest', 'Ring', 'Ecobee', 'August', 'Schlage', 'Lutron', 'Philips Hue'],
    mainPage: '/smart-home-installation-austin-tx',
  },
  {
    name: 'Fitness Equipment Assembly',
    slug: 'fitness-equipment-assembly',
    bookingParam: 'Fitness+Equipment',
    tagline: 'Get your home gym set up and ready to use.',
    intro: 'We assemble treadmills, ellipticals, stationary bikes, rowing machines, weight benches, squat racks, and cable machines — heavy equipment handled safely and placed exactly where you want it.',
    fromPrice: '$119',
    pricingHighlights: [
      { name: 'Inversion Table', price: '$119', popular: false },
      { name: 'Treadmill Assembly', price: '$189', popular: true },
      { name: 'Elliptical Machine', price: '$209', popular: false },
      { name: 'Squat Rack / Power Cage', price: '$219+', popular: false },
    ],
    faqs: [
      { q: 'Do you move the equipment to the right room?', a: 'Yes — same-floor equipment moves can be added during booking. Heavy or stair moves may need a custom quote.' },
      { q: 'Can you assemble Peloton or NordicTrack machines?', a: 'Yes. We assemble all major brands including Peloton, NordicTrack, Bowflex, Life Fitness, Concept2, and more.' },
      { q: 'What if the machine is very heavy?', a: 'We\'re prepared for heavy equipment. Very large machines or two-person moves may need a custom quote before booking.' },
    ],
    relatedService: 'furniture-assembly',
    brands: ['Peloton', 'NordicTrack', 'Bowflex', 'Life Fitness', 'Rogue', 'Concept2'],
    mainPage: '/book?service=Fitness+Equipment',
  },
  {
    name: 'Playset Assembly',
    slug: 'playset-assembly',
    bookingParam: 'Outdoor+%26+Playsets',
    tagline: 'Professional outdoor playset, trampoline, and structure assembly.',
    intro: 'We assemble swing sets, playsets, trampolines, pergolas, gazebos, storage sheds, and outdoor structures — fully built, safely leveled, and ready for your family to enjoy.',
    fromPrice: '$169',
    pricingHighlights: [
      { name: 'Sandbox / Outdoor Playhouse', price: '$169', popular: false },
      { name: 'Trampoline Assembly', price: '$199', popular: true },
      { name: 'Swing Set / Backyard Playset', price: '$299–$379', popular: false },
      { name: 'Pergola / Gazebo Kit', price: '$399–$599', popular: false },
    ],
    faqs: [
      { q: 'Do you anchor the playset to the ground?', a: 'Yes — anchoring, leveling, and safety hardware can be added during booking when the kit or ground conditions require it.' },
      { q: 'How long does playset assembly take?', a: 'Small outdoor items may take a couple of hours. Large modular playsets, gazebos, and sheds often take longer and may need a custom quote.' },
      { q: 'Do you work on concrete pads or grass?', a: 'Both. Grass, concrete, paver, and deck installs are supported. Tell us your surface type when booking.' },
    ],
    relatedService: 'furniture-assembly',
    brands: ['Lifetime', 'Step2', 'Gorilla Playsets', 'Cedar Summit', 'KidKraft', 'Backyard Discovery'],
    mainPage: '/book?service=Outdoor+%26+Playsets',
  },
  {
    name: 'Office Furniture Assembly',
    slug: 'office-furniture-assembly',
    bookingParam: 'Office+Assembly',
    tagline: 'Home office and commercial workspace setup done right.',
    intro: 'We assemble desks, standing desks, L-shaped workstations, office chairs, bookcases, filing cabinets, conference tables, and storage — for home offices, commercial spaces, and everything in between.',
    fromPrice: '$89',
    pricingHighlights: [
      { name: 'Office Chair / File Cabinet', price: '$89', popular: false },
      { name: 'Simple Flat-Pack Desk', price: '$99', popular: false },
      { name: 'L-Shape / Executive Desk', price: '$179', popular: true },
      { name: 'Electric Standing Desk', price: '$199', popular: false },
    ],
    faqs: [
      { q: 'Can you do a full office setup in one visit?', a: 'Yes — we can knock out multiple desks, chairs, and shelving units in a single visit. Bundle pricing applies for 3+ qualifying items booked together.' },
      { q: 'Do you assemble motorized standing desks?', a: 'Yes. We assemble and test all electric standing desks including UPLIFT, Flexispot, Autonomous, and similar brands.' },
      { q: 'Can you handle a commercial office buildout?', a: 'Yes — we work with businesses, real estate offices, and coworking spaces. Contact us for a custom quote on larger commercial projects.' },
    ],
    relatedService: 'furniture-assembly',
    brands: ['UPLIFT', 'Flexispot', 'IKEA', 'Autonomous', 'Hon', 'Steelcase', 'Branch'],
    mainPage: '/book?service=Office+Assembly',
  },
];

// ── PAGE TEMPLATE ──────────────────────────────────────────────────────────
function generatePage(city, service) {
  const pageSlug = `${service.slug}-${city.slug}-tx`;
  const url = `https://www.assembleatease.com/${pageSlug}`;
  const title = `${service.name} in ${city.name}, TX — From ${service.fromPrice} | AssembleAtEase`;
  const metaDesc = `Professional ${service.name.toLowerCase()} in ${city.name}, TX. ${city.bio.split('.')[0]}. Same-day available — book online with secure payment.`;

  // JSON-LD schema
  const schema = safeJson({
    '@context': 'https://schema.org',
    '@type': ['LocalBusiness', 'HomeAndConstructionBusiness'],
    'name': `AssembleAtEase — ${service.name} in ${city.name}`,
    'image': 'https://www.assembleatease.com/images/logo.jpg',
    'url': url,
    'telephone': '+17372906129',
    'email': 'service@assembleatease.com',
    'address': {
      '@type': 'PostalAddress',
      'streetAddress': '1910 W Braker Ln',
      'addressLocality': 'Austin',
      'addressRegion': 'TX',
      'postalCode': '78701',
      'addressCountry': 'US',
    },
    'areaServed': {
      '@type': 'City',
      'name': city.name,
      'containedInPlace': { '@type': 'State', 'name': 'Texas' },
    },
    'priceRange': '$$',
    'hasOfferCatalog': {
      '@type': 'OfferCatalog',
      'name': service.name,
      'itemListElement': service.pricingHighlights.map((p, i) => ({
        '@type': 'Offer',
        'position': i + 1,
        'name': p.name,
        'description': p.price,
      })),
    },
  });

  // City-specific FAQ
  const cityFaq = {
    q: `Do you serve ${city.nearby[0]} too?`,
    a: `Yes — in addition to ${city.name}, we cover ${city.nearby.join(', ')}, and the entire Austin metro. Book online and we’ll follow up quickly to confirm the details.`,
  };

  const allFaqs = [...service.faqs, cityFaq];

  // Pricing cards
  const priceCards = service.pricingHighlights.map(p => `
      <div class="price-card"${p.popular ? ' style="border-color:var(--cyan);box-shadow:var(--shadow)"' : ''}>
        ${p.popular ? '<div style="font-size:0.65rem;font-weight:700;color:var(--cyan-dark);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:0.4rem">Popular</div>' : ''}
        <div class="price-card-name">${esc(p.name)}</div>
        <div class="price-card-price">${esc(p.price)}</div>
        <a href="/book?service=${service.bookingParam}" class="btn btn-cyan btn-full" style="margin-top:0.75rem;font-size:0.82rem;padding:0.5rem 1rem">Book Now &rarr;</a>
      </div>`).join('');

  // FAQ items
  const faqItems = allFaqs.map(f => `
      <div style="background:var(--white);border:1.5px solid var(--border);border-radius:var(--radius-lg);overflow:hidden">
        <button onclick="var a=this.nextElementSibling;a.style.display=a.style.display==='block'?'none':'block';this.querySelector('.faq-chevron').style.transform=a.style.display==='block'?'rotate(180deg)':'rotate(0)'" style="width:100%;display:flex;align-items:center;justify-content:space-between;padding:1rem 1.25rem;background:none;border:none;cursor:pointer;font-family:var(--font-body);font-size:0.9rem;font-weight:600;color:var(--ink);text-align:left">${esc(f.q)} <span class="faq-chevron" style="transition:transform 0.2s;flex-shrink:0;color:var(--muted);font-size:1.1rem">&#8964;</span></button>
        <div style="display:none;padding:0 1.25rem 1rem;font-size:0.875rem;color:var(--muted);line-height:1.75">${esc(f.a)}</div>
      </div>`).join('');

  // Brands
  const brandsHtml = service.brands.map(b =>
    `<span style="background:var(--white);border:1px solid var(--border);border-radius:999px;padding:0.3rem 0.85rem;font-size:0.8rem;font-weight:500;color:var(--ink-soft)">${esc(b)}</span>`
  ).join('\n      ');

  // Service area chips
  const areaChips = [city.name, ...city.nearby].map(n =>
    `<span style="background:var(--white);border:1px solid var(--border);border-radius:999px;padding:0.3rem 0.85rem;font-size:0.8rem;font-weight:500;color:var(--ink-soft)">${esc(n)}, TX</span>`
  ).join('\n      ');

  // Internal links
  const nearbyCityLinks = city.nearby.slice(0, 4).map(n => {
    const c = CITIES.find(x => x.name === n);
    return c
      ? `<div><a href="/${service.slug}-${c.slug}-tx" style="color:var(--cyan-dark);text-decoration:none;font-size:0.875rem;font-weight:500">${esc(service.name)} in ${esc(c.name)}</a></div>`
      : '';
  }).filter(Boolean).join('\n          ');

  const otherServiceLinks = SERVICES.filter(s => s.slug !== service.slug).slice(0, 4).map(s =>
    `<div><a href="/${s.slug}-${city.slug}-tx" style="color:var(--cyan-dark);text-decoration:none;font-size:0.875rem;font-weight:500">${esc(s.name)} in ${esc(city.name)}</a></div>`
  ).join('\n          ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<script>(function(){if(localStorage.getItem('cookie-consent')==='accepted'){var s=document.createElement('script');s.async=true;s.src='https://www.googletagmanager.com/gtag/js?id=G-ZN45GP8D25';document.head.appendChild(s);window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}window.gtag=gtag;gtag('js',new Date());gtag('config','G-ZN45GP8D25');gtag('config','AW-16551666395');}})();</script>
<meta charset="UTF-8"/>
<title>${esc(title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="description" content="${esc(metaDesc)}"/>
<link rel="canonical" href="${esc(url)}"/>
<meta property="og:type" content="website"/>
<meta property="og:title" content="${esc(title)}"/>
<meta property="og:description" content="${esc(metaDesc)}"/>
<meta property="og:url" content="${esc(url)}"/>
<meta property="og:site_name" content="AssembleAtEase"/>
<meta property="og:image" content="https://www.assembleatease.com/images/logo.jpg"/>
<meta name="twitter:card" content="summary"/>
<meta name="twitter:title" content="${esc(title)}"/>
<meta name="twitter:image" content="https://www.assembleatease.com/images/logo.jpg"/>
<script type="application/ld+json">${schema}</script>
<link rel="icon" type="image/svg+xml" href="/images/favicon.svg"/><link rel="icon" type="image/jpeg" href="/images/logo.jpg"/>
<link rel="apple-touch-icon" href="/images/logo.jpg"/>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=DM+Sans:wght@300;400;500;600&display=swap" rel="preload" as="style" onload="this.onload=null;this.rel='stylesheet'"/>
<noscript><link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=DM+Sans:wght@300;400;500;600&display=swap" rel="stylesheet"/></noscript>
<link rel="stylesheet" href="/assets/css/marketing.css"/><link rel="stylesheet" href="/assets/css/marketing-desktop.css" media="(min-width:900px)"/>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--cyan:#00BFFF;--cyan-dark:#0099CC;--cyan-light:#e0f7fa;--cyan-mid:#b2ebf2;--ink:#0d1117;--ink-soft:#374151;--muted:#6b7280;--border:#e5e7eb;--off-white:#f9fafb;--white:#ffffff;--radius:12px;--radius-lg:18px;--radius-xl:24px;--font-display:'DM Serif Display',serif;--font-body:'DM Sans',sans-serif;--shadow:0 4px 20px rgba(0,0,0,0.08);--shadow-lg:0 8px 40px rgba(0,0,0,0.12);}
html{scroll-behavior:smooth}
body{font-family:var(--font-body);background:var(--white);color:var(--ink);-webkit-font-smoothing:antialiased;overflow-x:hidden}
.nav{position:sticky;top:0;z-index:200;background:rgba(255,255,255,0.97);backdrop-filter:blur(12px);border-bottom:1px solid var(--border)}
.nav-inner{max-width:1100px;margin:0 auto;padding:0 2rem;height:56px;display:flex;align-items:center;justify-content:space-between;gap:1rem}
.nav-logo{display:flex;align-items:center;gap:10px;text-decoration:none}
.nav-logo img{width:42px;height:42px;border-radius:50%;object-fit:cover}
.nav-logo-text{font-family:var(--font-display);font-size:1.15rem;color:var(--ink)}
.nav-links{display:flex;align-items:center;gap:2rem;list-style:none}
.nav-links a{font-size:0.875rem;font-weight:500;color:var(--ink-soft);text-decoration:none;transition:color 0.15s}
.nav-links a:hover{color:var(--cyan)}
.nav-easer-link{display:flex;align-items:center;gap:1rem}
.btn{display:inline-flex;align-items:center;justify-content:center;padding:0.65rem 1.5rem;border-radius:999px;font-family:var(--font-body);font-size:0.875rem;font-weight:600;cursor:pointer;text-decoration:none;border:none;transition:all 0.18s}
.btn-cyan{background:var(--cyan);color:#fff}
.btn-cyan:hover{background:var(--cyan-dark);box-shadow:0 4px 16px rgba(0,191,255,0.35);transform:translateY(-1px)}
.btn-lg{padding:0.85rem 2.25rem;font-size:1rem}
.btn-full{width:100%;text-align:center}
.pricing-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:1rem;margin-bottom:3rem}
.price-card{background:var(--white);border:1.5px solid var(--border);border-radius:var(--radius);padding:1.25rem 1.5rem;transition:border-color 0.15s,box-shadow 0.15s}
.price-card:hover{border-color:var(--cyan);box-shadow:var(--shadow)}
.price-card-name{font-size:0.92rem;font-weight:600;color:var(--ink);margin-bottom:0.85rem}
.price-card-price{font-family:var(--font-display);font-size:1.45rem;color:var(--cyan)}
.footer{background:#0a1628;padding:3rem 2rem 2rem}
.footer-inner{max-width:1100px;margin:0 auto;display:grid;grid-template-columns:2fr 1fr 1fr;gap:3rem;margin-bottom:2rem}
.footer-logo{display:flex;align-items:center;gap:10px;margin-bottom:0.75rem}
.footer-logo img{width:38px;height:38px;border-radius:50%;object-fit:cover}
.footer-logo-text{font-family:var(--font-display);font-size:1.05rem;color:#fff}
.footer-logo-text span{color:var(--cyan)}
.footer-tagline{font-size:0.82rem;color:rgba(255,255,255,0.55);line-height:1.65;margin-bottom:1rem}
.footer-contact a{display:block;font-size:0.85rem;color:rgba(255,255,255,0.5);text-decoration:none;margin-bottom:3px;transition:color 0.15s}
.footer-contact a:hover{color:var(--cyan)}
.footer-col-title{font-size:0.68rem;text-transform:uppercase;letter-spacing:0.12em;color:rgba(255,255,255,0.55);margin-bottom:0.85rem;font-weight:700}
.footer-links{list-style:none;display:flex;flex-direction:column;gap:0.55rem}
.footer-links a{font-size:0.85rem;color:rgba(255,255,255,0.65);text-decoration:none;transition:color 0.15s}
.footer-links a:hover{color:#fff}
.footer-bottom{max-width:1100px;margin:0 auto;padding-top:1.25rem;border-top:1px solid rgba(255,255,255,0.07);display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:0.5rem}
.footer-copy{font-size:0.72rem;color:rgba(255,255,255,0.5)}
.nav-hamburger{display:none;flex-direction:column;gap:5px;cursor:pointer;padding:8px;background:none;border:none;z-index:300}
.nav-hamburger span{display:block;width:24px;height:2px;background:var(--ink);border-radius:2px;transition:all 0.3s}
.nav-hamburger.open span:nth-child(1){transform:translateY(7px) rotate(45deg)}
.nav-hamburger.open span:nth-child(2){opacity:0}
.nav-hamburger.open span:nth-child(3){transform:translateY(-7px) rotate(-45deg)}
.nav-mobile{display:none;position:fixed;top:56px;left:0;right:0;background:#fff;border-bottom:1px solid var(--border);padding:1.5rem 2rem;z-index:199;flex-direction:column;gap:1rem;box-shadow:0 4px 20px rgba(0,0,0,0.08)}
.nav-mobile.open{display:flex}
.nav-mobile a{font-size:1rem;font-weight:500;color:var(--ink-soft);text-decoration:none;padding:0.5rem 0;border-bottom:1px solid var(--border)}
.nav-mobile .btn{margin-top:0.5rem;justify-content:center}
.how-grid{display:grid;grid-template-columns:1fr auto 1fr auto 1fr;align-items:start;gap:0.5rem}
#m-svc-bar{display:none}
@media(max-width:900px){.nav-links{display:none}.nav-hamburger{display:flex}}
@media(max-width:700px){.footer-inner{grid-template-columns:1fr;gap:2rem}.pricing-grid{grid-template-columns:1fr}}
@media(max-width:768px){
  .nav-inner{padding:0 1rem}
  .nav-inner>.btn-cyan{display:none}
  .nav-easer-link{display:none}
  .pricing-grid{display:flex;flex-direction:column;gap:0}
  .price-card{border:none;border-radius:0;box-shadow:none;border-bottom:1px solid var(--border);padding:.9rem 0;display:grid;grid-template-areas:"name price" "btn btn";grid-template-columns:1fr auto;align-items:center;gap:0 .75rem}
  .price-card:first-child{border-top:1px solid var(--border)}
  .price-card:hover{border-color:var(--border)!important;box-shadow:none!important}
  .price-card-name{grid-area:name;font-size:.92rem;margin:0}
  .price-card-price{grid-area:price;font-size:1rem;white-space:nowrap;margin:0}
  .price-card .btn{grid-area:btn;margin-top:.65rem!important;font-size:.9rem!important;min-height:44px;padding:.7rem 1rem!important}
  .footer{padding-bottom:calc(80px + env(safe-area-inset-bottom,0px))}
  .footer-inner{grid-template-columns:1fr;gap:2rem}
  .btn{min-height:44px}
  #m-svc-bar{display:flex;position:fixed;bottom:0;left:0;right:0;height:64px;padding:0 1.5rem;padding-bottom:env(safe-area-inset-bottom,0px);z-index:290;background:var(--cyan);align-items:center;justify-content:center}
  #m-svc-bar a{color:#fff;font-weight:700;font-size:1.05rem;text-decoration:none;width:100%;text-align:center;display:flex;align-items:center;justify-content:center;gap:6px}
  .how-grid{display:flex!important;flex-direction:column!important;gap:0.75rem!important}
  .how-grid > div:nth-child(2),.how-grid > div:nth-child(4){display:none!important}
  .how-grid > div{width:100%!important;padding:0.95rem 0.5rem!important}
}
</style>
<style>#cookie-banner{position:fixed;bottom:0;left:0;right:0;background:#0d1117;color:#fff;padding:1rem 2rem;z-index:9999;display:flex;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap;font-size:0.85rem;box-shadow:0 -4px 20px rgba(0,0,0,0.2)}#cookie-banner a{color:#00BFFF;text-decoration:underline}#cookie-banner.hidden{display:none}.cookie-btns{display:flex;gap:0.75rem;flex-shrink:0}.cookie-btn{padding:0.5rem 1.25rem;border-radius:999px;font-size:0.8rem;font-weight:600;cursor:pointer;border:none}.cookie-accept{background:#00BFFF;color:#fff}.cookie-decline{background:transparent;color:#fff;border:1.5px solid rgba(255,255,255,0.3)}@media(max-width:680px){#cookie-banner{left:.75rem;right:.75rem;bottom:.75rem;border-radius:14px;padding:.85rem;display:block;font-size:.78rem;line-height:1.45}.cookie-btns{display:flex;gap:.5rem;margin-top:.75rem}.cookie-btn{flex:1;min-height:44px;padding:.55rem .8rem}}</style>
</head>
<body>

<nav class="nav">
  <div class="nav-inner">
    <a href="/" class="nav-logo">
      <picture><source srcset="/images/logo.webp" type="image/webp"><img src="/images/logo.jpg" alt="AssembleAtEase Logo"/></picture>
      <div class="nav-logo-text">AssembleAtEase</div>
    </a>
    <ul class="nav-links">
      <li><a href="/#services">Services</a></li>
      <li><a href="/#how-it-works">How it works</a></li>
      <li><a href="/pricing">Pricing</a></li>
    </ul>
    <a href="/book" class="btn btn-cyan" style="padding:0.5rem 1.25rem;font-size:0.875rem">Book Now &rarr;</a>
    <div class="nav-easer-link">
      <a href="/assembler/apply" style="font-size:0.875rem;font-weight:500;color:var(--ink-soft);text-decoration:none">Become an Easer</a>
    </div>
    <button class="nav-hamburger" id="hamburger" aria-label="Toggle navigation" onclick="document.getElementById('hamburger').classList.toggle('open');document.getElementById('mobileNav').classList.toggle('open')">
      <span></span><span></span><span></span>
    </button>
  </div>
</nav>
<div class="nav-mobile" id="mobileNav">
  <a href="/book?service=Furniture+Assembly">Furniture Assembly</a>
  <a href="/book?service=Mounting+%26+Hanging">Mounting &amp; Hanging</a>
  <a href="/book?service=Fitness+Equipment">Fitness Equipment</a>
  <a href="/book?service=Outdoor+%26+Playsets">Outdoor / Playsets</a>
  <a href="/book?service=Office+Assembly">Office Assembly</a>
  <a href="/book?service=Smart+Home">Smart Home Setup</a>
  <a href="/pricing">Pricing</a>
  <a href="/about">About Us</a>
  <a href="/track">Track My Booking</a>
  <a href="/book" class="btn btn-cyan btn-full">Book Now &rarr;</a>
</div>
<script>document.getElementById('mobileNav').addEventListener('click',function(e){if(e.target.closest('a')){document.getElementById('hamburger').classList.remove('open');document.getElementById('mobileNav').classList.remove('open');}});</script>

<!-- HERO -->
<section style="background:linear-gradient(135deg,#f0fdff 0%,#e0f7fa 50%,#f9fafb 100%);padding:4.5rem 2rem 3.5rem;border-bottom:1px solid var(--border)">
  <div style="max-width:720px;margin:0 auto;text-align:center">
    <div style="display:inline-flex;align-items:center;gap:6px;background:var(--white);border:1px solid var(--cyan-mid);border-radius:999px;padding:0.3rem 0.9rem;font-size:0.72rem;font-weight:700;color:var(--cyan-dark);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:1.25rem">${esc(city.name)}, TX &mdash; Serving the Austin Metro</div>
    <h1 style="font-family:var(--font-display);font-size:clamp(2rem,5vw,3.2rem);color:var(--ink);line-height:1.1;margin-bottom:1rem">${esc(service.name)} in ${esc(city.name)}, TX</h1>
    <p style="font-size:1.05rem;color:var(--ink-soft);line-height:1.75;max-width:580px;margin:0 auto 0.75rem">${esc(service.tagline)}</p>
    <p style="font-size:0.95rem;color:var(--muted);line-height:1.7;max-width:560px;margin:0 auto 1.5rem">${esc(city.bio)}</p>
    <div style="display:flex;align-items:center;justify-content:center;gap:6px;margin-bottom:1.75rem;flex-wrap:wrap">
      <span style="display:flex;gap:2px;color:#f59e0b">&#9733;&#9733;&#9733;&#9733;&#9733;</span>
      <strong style="font-size:0.95rem;color:var(--ink)">4.9</strong>
      <span style="font-size:0.85rem;color:var(--muted)">&bull; Serving ${esc(city.name)} &amp; surrounding areas</span>
    </div>
    <div style="display:flex;flex-direction:column;align-items:center;gap:0.75rem;margin-bottom:2rem">
      <a href="/book?service=${service.bookingParam}" style="display:inline-flex;align-items:center;gap:8px;background:var(--cyan);color:#fff;font-family:var(--font-body);font-size:1.05rem;font-weight:700;padding:1rem 2.5rem;border-radius:999px;text-decoration:none;transition:all 0.18s;box-shadow:0 4px 20px rgba(0,191,255,0.3)" onmouseover="this.style.background='#0099CC';this.style.transform='translateY(-2px)'" onmouseout="this.style.background='#00BFFF';this.style.transform='none'">Book in ${esc(city.name)} &rarr;</a>
      <span style="font-size:0.82rem;color:var(--muted)">From ${esc(service.fromPrice)} &bull; Secure checkout</span>
    </div>
    <div style="display:flex;justify-content:center;gap:1.5rem;flex-wrap:wrap;font-size:0.82rem;color:var(--ink-soft)">
      <span>&#10003; Total shown upfront</span>
      <span>&#10003; Fast follow-up</span>
      <span>&#10003; Same-Day Available</span>
      <span>&#10003; Clear pricing</span>
    </div>
  </div>
</section>

<!-- HOW IT WORKS -->
<section style="background:var(--off-white);padding:4rem 2rem;border-bottom:1px solid var(--border)">
  <div style="max-width:900px;margin:0 auto">
    <div style="text-align:center;margin-bottom:2.5rem">
      <div style="font-size:0.72rem;text-transform:uppercase;letter-spacing:0.12em;color:var(--cyan-dark);font-weight:700;margin-bottom:0.5rem">Simple Process</div>
      <h2 style="font-family:var(--font-display);font-size:clamp(1.6rem,3vw,2.2rem);color:var(--ink)">Book in minutes. Done today.</h2>
    </div>
    <div class="how-grid">
      <div style="text-align:center;padding:1.5rem 1rem">
        <div style="width:52px;height:52px;border-radius:50%;background:var(--cyan);color:#fff;font-family:var(--font-display);font-size:1.4rem;display:flex;align-items:center;justify-content:center;margin:0 auto 1rem">1</div>
        <h3 style="font-size:1rem;font-weight:700;color:var(--ink);margin-bottom:0.5rem">Book online</h3>
        <p style="font-size:0.875rem;color:var(--muted);line-height:1.65">Choose your service, pick a date and time. Takes under 2 minutes.</p>
      </div>
      <div style="font-size:1.5rem;color:var(--border);padding-top:2.5rem">&#8594;</div>
      <div style="text-align:center;padding:1.5rem 1rem">
        <div style="width:52px;height:52px;border-radius:50%;background:var(--cyan);color:#fff;font-family:var(--font-display);font-size:1.4rem;display:flex;align-items:center;justify-content:center;margin:0 auto 1rem">2</div>
        <h3 style="font-size:1rem;font-weight:700;color:var(--ink);margin-bottom:0.5rem">We confirm</h3>
        <p style="font-size:0.875rem;color:var(--muted);line-height:1.65">We follow up quickly to confirm availability and assign a reviewed service pro in ${esc(city.name)}.</p>
      </div>
      <div style="font-size:1.5rem;color:var(--border);padding-top:2.5rem">&#8594;</div>
      <div style="text-align:center;padding:1.5rem 1rem">
        <div style="width:52px;height:52px;border-radius:50%;background:var(--cyan);color:#fff;font-family:var(--font-display);font-size:1.4rem;display:flex;align-items:center;justify-content:center;margin:0 auto 1rem">3</div>
        <h3 style="font-size:1rem;font-weight:700;color:var(--ink);margin-bottom:0.5rem">Payment after completion</h3>
        <p style="font-size:0.875rem;color:var(--muted);line-height:1.65">The total is shown before you confirm, and payment is processed after the job is complete.</p>
      </div>
    </div>
  </div>
</section>

<!-- PRICING -->
<section style="padding:4.5rem 2rem;background:var(--white)">
  <div style="max-width:960px;margin:0 auto">
    <div style="text-align:center;margin-bottom:2.5rem">
      <div style="font-size:0.72rem;text-transform:uppercase;letter-spacing:0.12em;color:var(--cyan-dark);font-weight:700;margin-bottom:0.5rem">Transparent Pricing</div>
      <h2 style="font-family:var(--font-display);font-size:clamp(1.6rem,3vw,2.2rem);color:var(--ink);margin-bottom:0.6rem">${esc(service.name)} Pricing in ${esc(city.name)}</h2>
      <p style="font-size:0.95rem;color:var(--muted);max-width:520px;margin:0 auto">Flat upfront item pricing. Service-call fees and visit minimums are shown before checkout for ${esc(city.name)} and nearby ${esc(city.landmark)}.</p>
    </div>
    <div class="pricing-grid">
      ${priceCards}
    </div>
    <div style="background:var(--off-white);border:1.5px solid var(--border);border-radius:var(--radius-xl);padding:3rem 2rem;text-align:center">
      <h2 style="font-family:var(--font-display);font-size:1.8rem;color:var(--ink);margin-bottom:0.65rem">Ready to book in ${esc(city.name)}?</h2>
      <p style="font-size:0.95rem;color:var(--muted);margin-bottom:1.75rem;line-height:1.65;max-width:520px;margin-left:auto;margin-right:auto">Book in minutes. We follow up quickly and show up on time.</p>
      <a href="/book?service=${service.bookingParam}" class="btn btn-cyan btn-lg">Book Now &mdash; ${esc(city.name)}</a>
      <div style="display:flex;gap:1.5rem;justify-content:center;flex-wrap:wrap;margin-top:1.75rem;font-size:0.82rem;color:var(--muted)">
        <span>&#10003; Fast follow-up</span>
        <span>&#10003; Payment after completion</span>
        <span>&#10003; Service-call fee shown upfront</span>
      </div>
    </div>
  </div>
</section>

<!-- BRANDS / WHAT WE WORK WITH -->
<section style="background:var(--off-white);border-top:1px solid var(--border);border-bottom:1px solid var(--border);padding:2rem 2rem">
  <div style="max-width:800px;margin:0 auto;text-align:center">
    <div style="font-size:0.7rem;text-transform:uppercase;letter-spacing:0.1em;color:var(--muted);font-weight:700;margin-bottom:1rem">Brands We Work With Every Day</div>
    <div style="display:flex;flex-wrap:wrap;gap:0.5rem;justify-content:center">
      ${brandsHtml}
    </div>
  </div>
</section>

<!-- SERVICE AREA -->
<section style="background:var(--white);padding:4rem 2rem;border-bottom:1px solid var(--border)">
  <div style="max-width:780px;margin:0 auto;text-align:center">
    <div style="font-size:0.72rem;text-transform:uppercase;letter-spacing:0.12em;color:var(--cyan-dark);font-weight:700;margin-bottom:0.5rem">Service Area</div>
    <h2 style="font-family:var(--font-display);font-size:clamp(1.5rem,2.5vw,2rem);color:var(--ink);margin-bottom:0.75rem">${esc(service.name)} Near ${esc(city.name)}</h2>
    <p style="font-size:0.95rem;color:var(--muted);line-height:1.75;margin-bottom:1.75rem">We serve ${esc(city.name)} and the surrounding Austin metro area. Near ${esc(city.landmark)}, we&rsquo;re your local assembly and installation team.</p>
    <div style="display:flex;flex-wrap:wrap;gap:0.5rem;justify-content:center">
      ${areaChips}
    </div>
  </div>
</section>

<!-- WHY CHOOSE US -->
<section style="background:var(--off-white);padding:4.5rem 2rem;border-bottom:1px solid var(--border)">
  <div style="max-width:960px;margin:0 auto">
    <div style="text-align:center;margin-bottom:2.5rem">
      <div style="font-size:0.72rem;text-transform:uppercase;letter-spacing:0.12em;color:var(--cyan-dark);font-weight:700;margin-bottom:0.5rem">Why Choose Us</div>
      <h2 style="font-family:var(--font-display);font-size:clamp(1.6rem,3vw,2.2rem);color:var(--ink)">${esc(city.name)}&rsquo;s trusted assembly service.</h2>
      <p style="font-size:0.95rem;color:var(--muted);margin-top:0.5rem;line-height:1.6">Austin-based and built on referrals &mdash; every job matters to us personally.</p>
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:1.25rem">
      <div style="background:var(--white);border:1.5px solid var(--border);border-radius:var(--radius-xl);padding:1.75rem"><div style="font-size:1.75rem;margin-bottom:0.75rem">&#x1F4B3;</div><div style="font-size:0.95rem;font-weight:700;color:var(--ink);margin-bottom:0.5rem">Secure checkout</div><p style="font-size:0.875rem;color:var(--muted);line-height:1.65">Review your total before confirming. Payment is handled securely by Stripe after completion.</p></div>
      <div style="background:var(--white);border:1.5px solid var(--border);border-radius:var(--radius-xl);padding:1.75rem"><div style="font-size:1.75rem;margin-bottom:0.75rem">&#x1F4C5;</div><div style="font-size:0.95rem;font-weight:700;color:var(--ink);margin-bottom:0.5rem">Same-day &amp; next-day available</div><p style="font-size:0.875rem;color:var(--muted);line-height:1.65">We keep open slots for last-minute bookings in ${esc(city.name)} and across the Austin metro.</p></div>
      <div style="background:var(--white);border:1.5px solid var(--border);border-radius:var(--radius-xl);padding:1.75rem"><div style="font-size:1.75rem;margin-bottom:0.75rem">&#x1F3F7;&#xFE0F;</div><div style="font-size:0.95rem;font-weight:700;color:var(--ink);margin-bottom:0.5rem">Flat-rate pricing &mdash; no surprises</div><p style="font-size:0.875rem;color:var(--muted);line-height:1.65">Every item price, service-call fee, and visit minimum is shown before checkout.</p></div>
      <div style="background:var(--white);border:1.5px solid var(--border);border-radius:var(--radius-xl);padding:1.75rem"><div style="font-size:1.75rem;margin-bottom:0.75rem">&#x1F4CD;</div><div style="font-size:0.95rem;font-weight:700;color:var(--ink);margin-bottom:0.5rem">Austin-based &amp; locally operated</div><p style="font-size:0.875rem;color:var(--muted);line-height:1.65">Not a national chain. We live and work in the same communities we serve, including ${esc(city.name)}.</p></div>
      <div style="background:var(--white);border:1.5px solid var(--border);border-radius:var(--radius-xl);padding:1.75rem"><div style="font-size:1.75rem;margin-bottom:0.75rem">&#x26A1;</div><div style="font-size:0.95rem;font-weight:700;color:var(--ink);margin-bottom:0.5rem">Fast follow-up</div><p style="font-size:0.875rem;color:var(--muted);line-height:1.65">Book online and get a real confirmation fast &mdash; not a chatbot, not days later.</p></div>
      <div style="background:var(--white);border:1.5px solid var(--border);border-radius:var(--radius-xl);padding:1.75rem"><div style="font-size:1.75rem;margin-bottom:0.75rem">&#x1F6E1;&#xFE0F;</div><div style="font-size:0.95rem;font-weight:700;color:var(--ink);margin-bottom:0.5rem">Careful, clean, respectful</div><p style="font-size:0.875rem;color:var(--muted);line-height:1.65">We treat your home like it&rsquo;s ours. No rushing, no shortcuts. Every time.</p></div>
    </div>
  </div>
</section>

<!-- FAQ -->
<section style="background:var(--white);padding:4.5rem 2rem;border-bottom:1px solid var(--border)">
  <div style="max-width:680px;margin:0 auto">
    <div style="text-align:center;margin-bottom:2.5rem">
      <div style="font-size:0.72rem;text-transform:uppercase;letter-spacing:0.12em;color:var(--cyan-dark);font-weight:700;margin-bottom:0.5rem">FAQ</div>
      <h2 style="font-family:var(--font-display);font-size:clamp(1.6rem,3vw,2.2rem);color:var(--ink)">Common questions about ${esc(service.name)} in ${esc(city.name)}</h2>
    </div>
    <div style="display:flex;flex-direction:column;gap:0.75rem">
      ${faqItems}
    </div>
  </div>
</section>

<!-- INTERNAL LINKS -->
<section style="background:var(--off-white);padding:3.5rem 2rem;border-bottom:1px solid var(--border)">
  <div style="max-width:960px;margin:0 auto">
    <div style="text-align:center;margin-bottom:2rem">
      <div style="font-size:0.72rem;text-transform:uppercase;letter-spacing:0.12em;color:var(--cyan-dark);font-weight:700;margin-bottom:0.5rem">Explore More</div>
      <h2 style="font-family:var(--font-display);font-size:clamp(1.4rem,2.5vw,1.9rem);color:var(--ink)">${esc(service.name)} &amp; More Near ${esc(city.name)}</h2>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:2.5rem">
      <div>
        <div style="font-size:0.68rem;text-transform:uppercase;letter-spacing:0.1em;color:var(--muted);font-weight:700;margin-bottom:1rem">${esc(service.name)} in Nearby Cities</div>
        <div style="display:flex;flex-direction:column;gap:0.65rem">
          ${nearbyCityLinks}
        </div>
      </div>
      <div>
        <div style="font-size:0.68rem;text-transform:uppercase;letter-spacing:0.1em;color:var(--muted);font-weight:700;margin-bottom:1rem">Other Services in ${esc(city.name)}</div>
        <div style="display:flex;flex-direction:column;gap:0.65rem">
          ${otherServiceLinks}
        </div>
      </div>
    </div>
    <div style="margin-top:1.75rem;padding-top:1.5rem;border-top:1px solid var(--border);text-align:center">
      <a href="/book" style="color:var(--cyan-dark);font-size:0.875rem;font-weight:500;text-decoration:none">View all services &rarr;</a>
    </div>
  </div>
</section>

<!-- FINAL CTA -->
<section style="background:linear-gradient(135deg,#003d47,#006070);padding:5rem 2rem;text-align:center">
  <div style="max-width:600px;margin:0 auto">
    <h2 style="font-family:var(--font-display);font-size:clamp(2rem,4vw,2.8rem);color:#fff;margin-bottom:1rem">Ready to get it done in ${esc(city.name)}?</h2>
    <p style="font-size:1rem;color:rgba(255,255,255,0.82);margin-bottom:2rem;line-height:1.75">Flat-rate pricing and same-day availability in ${esc(city.name)} and the Austin metro. Book in minutes with secure checkout.</p>
    <a href="/book?service=${service.bookingParam}" style="display:inline-flex;align-items:center;gap:8px;background:#fff;color:#006070;font-family:var(--font-body);font-size:1rem;font-weight:700;padding:1rem 2.5rem;border-radius:999px;text-decoration:none;margin-bottom:1rem">Book ${esc(service.name)} &rarr;</a>
    <p style="font-size:0.82rem;color:rgba(255,255,255,0.55)"><a href="tel:+17372906129" style="color:rgba(255,255,255,0.7);text-decoration:none">(737) 290-6129</a> &nbsp;&bull;&nbsp; <a href="mailto:service@assembleatease.com" style="color:rgba(255,255,255,0.7);text-decoration:none">service@assembleatease.com</a></p>
  </div>
</section>

<footer class="footer">
  <div class="footer-inner">
    <div>
      <div class="footer-logo"><picture><source srcset="/images/logo.webp" type="image/webp"><img src="/images/logo.jpg" alt="AssembleAtEase Logo"/></picture><div class="footer-logo-text">AssembleAtEase</div></div>
      <p class="footer-tagline">Professional assembly and installation services in ${esc(city.name)}, TX and the greater Austin area. Quality work, done right.</p>
      <div class="footer-contact"><a href="mailto:service@assembleatease.com">service@assembleatease.com</a></div>
    </div>
    <div>
      <div class="footer-col-title">Services</div>
      <ul class="footer-links">
        <li><a href="/furniture-assembly-austin-tx">Furniture Assembly</a></li>
        <li><a href="/tv-mounting-austin-tx">Mounting & Hanging</a></li>
        <li><a href="/smart-home-installation-austin-tx">Smart Home Setup</a></li>
        <li><a href="/book?service=Fitness+Equipment">Fitness Equipment</a></li>
        <li><a href="/book?service=Outdoor+%26+Playsets">Outdoor / Playsets</a></li>
        <li><a href="/book?service=Office+Assembly">Office Assembly</a></li>
      </ul>
    </div>
    <div>
      <div class="footer-col-title">Company</div>
      <ul class="footer-links">
        <li><a href="/about">About Us</a></li>
        <li><a href="/pricing">Pricing</a></li>
        <li><a href="/#faq">FAQ</a></li>
        <li><a href="/contact">Contact</a></li>
        <li><a href="/business">Business Services</a></li>
        <li><a href="/privacy">Privacy Policy</a></li>
        <li><a href="/terms">Terms &amp; Conditions</a></li>
      </ul>
    </div>
  </div>
  <div class="footer-bottom">
    <div class="footer-copy">&copy; <span id="year"></span> AssembleAtEase. All rights reserved. Austin, TX.</div>
    <div class="footer-copy">${esc(city.name)}, TX &bull; Same-Day Available &bull; Clear Pricing</div>
  </div>
</footer>

<div id="m-svc-bar"><a href="/book?service=${service.bookingParam}">Book ${esc(service.name)} &#8594;</a></div>

<div id="cookie-banner" class="hidden">
  <span>We use cookies to improve your experience. <a href="/privacy">Learn more</a>.</span>
  <div class="cookie-btns">
    <button class="cookie-btn cookie-accept" onclick="acceptCookies()">Accept</button>
    <button class="cookie-btn cookie-decline" onclick="declineCookies()">Decline</button>
  </div>
</div>
<script>
function acceptCookies(){localStorage.setItem('cookie-consent','accepted');document.getElementById('cookie-banner').classList.add('hidden');var s=document.createElement('script');s.async=true;s.src='https://www.googletagmanager.com/gtag/js?id=G-ZN45GP8D25';document.head.appendChild(s);window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}window.gtag=gtag;gtag('js',new Date());gtag('config','G-ZN45GP8D25');gtag('config','AW-16551666395');}
function declineCookies(){localStorage.setItem('cookie-consent','declined');document.getElementById('cookie-banner').classList.add('hidden');}
document.getElementById('year').textContent=new Date().getFullYear();
window.addEventListener('DOMContentLoaded',function(){if(!localStorage.getItem('cookie-consent')){document.getElementById('cookie-banner').classList.remove('hidden');}});
</script>

</body>
</html>`;
}

// ── WRITE FILES ────────────────────────────────────────────────────────────
let generated = 0;
const sitemapEntries = [];

for (const service of SERVICES) {
  for (const city of CITIES) {
    const pageSlug = `${service.slug}-${city.slug}-tx`;
    const filename = `${pageSlug}.html`;
    const html = generatePage(city, service);
    writeFileSync(join(ROOT, filename), html, 'utf8');
    sitemapEntries.push(`  <url><loc>https://www.assembleatease.com/${pageSlug}</loc><lastmod>${TODAY}</lastmod><priority>0.8</priority></url>`);
    generated++;
    process.stdout.write(`\r  Generated ${generated}/72: ${filename}                    `);
  }
}

console.log(`\n  All ${generated} pages written.`);

// ── UPDATE SITEMAP ─────────────────────────────────────────────────────────
const sitemapPath = join(ROOT, 'sitemap.xml');
let sitemap = readFileSync(sitemapPath, 'utf8');

// Remove any previously generated location page entries (idempotent re-runs)
sitemap = sitemap.replace(/\s*<url><loc>https:\/\/www\.assembleatease\.com\/(furniture-assembly|tv-mounting|smart-home-installation|fitness-equipment-assembly|playset-assembly|office-furniture-assembly)-[a-z-]+-tx<\/loc>[^<]*<lastmod>[^<]*<\/lastmod>[^<]*<priority>[^<]*<\/priority><\/url>/g, '');

// Insert before closing </urlset>
sitemap = sitemap.replace('</urlset>', `${sitemapEntries.join('\n')}\n</urlset>`);

writeFileSync(sitemapPath, sitemap, 'utf8');
console.log(`  sitemap.xml updated (+${sitemapEntries.length} entries).`);
console.log('\nDone. Run: git add -A && git commit -m "feat(seo): 72 local service-area landing pages"');
