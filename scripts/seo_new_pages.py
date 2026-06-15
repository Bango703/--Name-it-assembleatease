#!/usr/bin/env python3
# Creates 3 new niche service pages + fixes homepage H1 + OG image.
import os, re, json

BASE = r"c:/Users/tgbiz/Handyman-marketplace"
os.chdir(BASE)

SITE  = "https://www.assembleatease.com"
MAPS  = "https://www.google.com/maps?cid=7847022131459448801"
LOGO  = SITE + "/images/logo.jpg"
PHONE = "+17372906129"
EMAIL = "service@assembleatease.com"

# ── 1. Homepage H1 + OG image ─────────────────────────────────────────────
html = open("index.html", "r", encoding="utf-8").read()

# Desktop H1
html = html.replace(
    '<h1 class="hv2-h1">Skilled help.<br>Done right.</h1>',
    '<h1 class="hv2-h1">Assembly &amp; Mounting<br>in Austin, TX.</h1>'
)
# Mobile H1
html = html.replace(
    '<h1 class="m-hero-title">Home projects, handled.</h1>',
    '<h1 class="m-hero-title">Furniture Assembly &amp; TV Mounting in Austin.</h1>'
)
# Desktop eyebrow
html = html.replace(
    '<div class="hv2-eyebrow">Professional Home Services</div>',
    '<div class="hv2-eyebrow">Furniture Assembly &amp; TV Mounting &mdash; Austin, TX</div>'
)
# OG image -> hero photo (wider, more social-friendly than square logo)
html = html.replace(
    '<meta property="og:image" content="https://www.assembleatease.com/images/logo.jpg"/>\n<meta property="og:image:width" content="512"/>\n<meta property="og:image:height" content="512"/>',
    '<meta property="og:image" content="https://www.assembleatease.com/images/hero-pro-optimized.jpg"/>\n<meta property="og:image:width" content="1200"/>\n<meta property="og:image:height" content="630"/>'
)
html = html.replace(
    '<meta property="og:image:alt" content="AssembleAtEase &mdash; Professional Assembly &amp; Handyman Services Austin TX"/>',
    '<meta property="og:image:alt" content="Professional furniture assembly and TV mounting in Austin, TX — AssembleAtEase"/>'
)
# Twitter card -> large image now that we have a wide image
html = html.replace(
    '<meta name="twitter:card" content="summary"/>',
    '<meta name="twitter:card" content="summary_large_image"/>'
)
html = html.replace(
    '<meta name="twitter:image" content="https://www.assembleatease.com/images/logo.jpg"/>',
    '<meta name="twitter:image" content="https://www.assembleatease.com/images/hero-pro-optimized.jpg"/>'
)

open("index.html", "w", encoding="utf-8").write(html)
print("OK index.html — H1 keyword fix + OG image + twitter:card")


# ── 2. Page generator ─────────────────────────────────────────────────────
def schema_json(name, url, offers, service_type):
    return json.dumps({
        "@context": "https://schema.org",
        "@type": ["LocalBusiness", "HomeAndConstructionBusiness"],
        "name": name,
        "image": LOGO,
        "url": url,
        "telephone": PHONE,
        "email": EMAIL,
        "address": {"@type": "PostalAddress", "streetAddress": "1910 W Braker Ln",
                    "addressLocality": "Austin", "addressRegion": "TX",
                    "postalCode": "78701", "addressCountry": "US"},
        "geo": {"@type": "GeoCoordinates", "latitude": "30.4140535", "longitude": "-97.7491735"},
        "areaServed": {"@type": "City", "name": "Austin", "containedInPlace": {"@type": "State", "name": "Texas"}},
        "priceRange": "$$",
        "sameAs": MAPS,
        "aggregateRating": {"@type": "AggregateRating", "ratingValue": "5.0", "reviewCount": "11", "bestRating": "5"},
        "potentialAction": {"@type": "ReserveAction",
                            "target": {"@type": "EntryPoint", "urlTemplate": SITE + "/book"},
                            "result": {"@type": "Reservation", "name": "Book " + service_type}},
        "hasOfferCatalog": {"@type": "OfferCatalog", "name": service_type, "itemListElement": offers}
    }, separators=(",", ":"))

def breadcrumb_json(label, url):
    return json.dumps({
        "@context": "https://schema.org", "@type": "BreadcrumbList",
        "itemListElement": [
            {"@type": "ListItem", "position": 1, "name": "Home", "item": SITE},
            {"@type": "ListItem", "position": 2, "name": label, "item": url}
        ]
    }, separators=(",", ":"))

def faq_item(q, a):
    return f'''
      <div style="background:var(--white);border:1.5px solid var(--border);border-radius:var(--radius-lg);overflow:hidden">
        <button onclick="var a=this.nextElementSibling;a.style.display=a.style.display==='block'?'none':'block';this.querySelector('.faq-chevron').style.transform=a.style.display==='block'?'rotate(180deg)':'rotate(0)'" style="width:100%;display:flex;align-items:center;justify-content:space-between;padding:1rem 1.25rem;background:none;border:none;cursor:pointer;font-family:var(--font-body);font-size:0.9rem;font-weight:600;color:var(--ink);text-align:left">{q} <span class="faq-chevron" style="transition:transform 0.2s;flex-shrink:0;color:var(--muted);font-size:1.1rem">&#8964;</span></button>
        <div style="display:none;padding:0 1.25rem 1rem;font-size:0.875rem;color:var(--muted);line-height:1.75">{a}</div>
      </div>'''

def price_card(name, price, popular=False, book_url="/book"):
    pop = '<div style="font-size:0.65rem;font-weight:700;color:var(--cyan-dark);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:0.4rem">Popular</div>' if popular else ''
    border = ' style="border-color:var(--cyan);box-shadow:var(--shadow)"' if popular else ''
    return f'''
      <div class="price-card"{border}>
        {pop}
        <div class="price-card-name">{name}</div>
        <div class="price-card-price">{price}</div>
        <a href="{book_url}" class="btn btn-cyan btn-full" style="margin-top:0.75rem;font-size:0.82rem;padding:0.5rem 1rem">Book Now &rarr;</a>
      </div>'''

def brand_chip(name):
    return f'<span style="background:var(--white);border:1px solid var(--border);border-radius:999px;padding:0.3rem 0.85rem;font-size:0.8rem;font-weight:500;color:var(--ink-soft)">{name}</span>'

def make_page(slug, title, meta_desc, h1, tagline, city_blurb, price, book_param,
              price_cards_html, brands_html, faq_html, service_type,
              schema_offers, related_service, related_label):
    url = SITE + "/" + slug
    lb  = schema_json("AssembleAtEase — " + h1, url, schema_offers, service_type)
    bc  = breadcrumb_json(h1, url)
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<script>(function(){{if(localStorage.getItem('cookie-consent')==='accepted'){{var s=document.createElement('script');s.async=true;s.src='https://www.googletagmanager.com/gtag/js?id=G-ZN45GP8D25';document.head.appendChild(s);window.dataLayer=window.dataLayer||[];function gtag(){{dataLayer.push(arguments);}}window.gtag=gtag;gtag('js',new Date());gtag('config','G-ZN45GP8D25');gtag('config','AW-16551666395');}}}})();</script>
<meta charset="UTF-8"/>
<title>{title}</title>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="description" content="{meta_desc}"/>
<link rel="canonical" href="{url}"/>
<meta property="og:type" content="website"/>
<meta property="og:title" content="{title}"/>
<meta property="og:description" content="{meta_desc}"/>
<meta property="og:url" content="{url}"/>
<meta property="og:site_name" content="AssembleAtEase"/>
<meta property="og:image" content="{LOGO}"/>
<meta name="twitter:card" content="summary"/>
<meta name="twitter:title" content="{title}"/>
<meta name="twitter:image" content="{LOGO}"/>
<script type="application/ld+json">{lb}</script>
<script type="application/ld+json">{bc}</script>
<link rel="icon" type="image/svg+xml" href="/images/favicon.svg"/><link rel="icon" type="image/jpeg" href="/images/logo.jpg"/>
<link rel="apple-touch-icon" href="/images/logo.jpg"/>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=DM+Sans:wght@300;400;500;600&display=swap" rel="preload" as="style" onload="this.onload=null;this.rel='stylesheet'"/>
<noscript><link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=DM+Sans:wght@300;400;500;600&display=swap" rel="stylesheet"/></noscript>
<link rel="stylesheet" href="/assets/css/marketing.css"/><link rel="stylesheet" href="/assets/css/marketing-desktop.css" media="(min-width:900px)"/>
<style>
*,*::before,*::after{{box-sizing:border-box;margin:0;padding:0}}
:root{{--cyan:#00BFFF;--cyan-dark:#0099CC;--cyan-light:#e0f7fa;--cyan-mid:#b2ebf2;--ink:#0d1117;--ink-soft:#374151;--muted:#6b7280;--border:#e5e7eb;--off-white:#f9fafb;--white:#ffffff;--radius:12px;--radius-lg:18px;--radius-xl:24px;--font-display:'DM Serif Display',serif;--font-body:'DM Sans',sans-serif;--shadow:0 4px 20px rgba(0,0,0,0.08);--shadow-lg:0 8px 40px rgba(0,0,0,0.12);}}
html{{scroll-behavior:smooth}}
body{{font-family:var(--font-body);background:var(--white);color:var(--ink);-webkit-font-smoothing:antialiased;overflow-x:hidden}}
.nav{{position:sticky;top:0;z-index:200;background:rgba(255,255,255,0.97);backdrop-filter:blur(12px);border-bottom:1px solid var(--border)}}
.nav-inner{{max-width:1100px;margin:0 auto;padding:0 2rem;height:56px;display:flex;align-items:center;justify-content:space-between;gap:1rem}}
.nav-logo{{display:flex;align-items:center;gap:10px;text-decoration:none}}
.nav-logo img{{width:42px;height:42px;border-radius:50%;object-fit:cover}}
.nav-logo-text{{font-family:var(--font-display);font-size:1.15rem;color:var(--ink)}}
.nav-links{{display:flex;align-items:center;gap:2rem;list-style:none}}
.nav-links a{{font-size:0.875rem;font-weight:500;color:var(--ink-soft);text-decoration:none;transition:color 0.15s}}
.nav-links a:hover{{color:var(--cyan)}}
.btn{{display:inline-flex;align-items:center;justify-content:center;padding:0.65rem 1.5rem;border-radius:999px;font-family:var(--font-body);font-size:0.875rem;font-weight:600;cursor:pointer;text-decoration:none;border:none;transition:all 0.18s}}
.btn-cyan{{background:var(--cyan);color:#fff}}
.btn-cyan:hover{{background:var(--cyan-dark);box-shadow:0 4px 16px rgba(0,191,255,0.35);transform:translateY(-1px)}}
.btn-lg{{padding:0.85rem 2.25rem;font-size:1rem}}
.btn-full{{width:100%;text-align:center}}
.pricing-grid{{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:1rem;margin-bottom:3rem}}
.price-card{{background:var(--white);border:1.5px solid var(--border);border-radius:var(--radius);padding:1.25rem 1.5rem;transition:border-color 0.15s,box-shadow 0.15s}}
.price-card:hover{{border-color:var(--cyan);box-shadow:var(--shadow)}}
.price-card-name{{font-size:0.92rem;font-weight:600;color:var(--ink);margin-bottom:0.85rem}}
.price-card-price{{font-family:var(--font-display);font-size:1.45rem;color:var(--cyan)}}
.footer{{background:#0a1628;padding:3rem 2rem 2rem}}
.footer-inner{{max-width:1100px;margin:0 auto;display:grid;grid-template-columns:2fr 1fr 1fr;gap:3rem;margin-bottom:2rem}}
.footer-logo{{display:flex;align-items:center;gap:10px;margin-bottom:0.75rem}}
.footer-logo img{{width:38px;height:38px;border-radius:50%;object-fit:cover}}
.footer-logo-text{{font-family:var(--font-display);font-size:1.05rem;color:#fff}}
.footer-tagline{{font-size:0.82rem;color:rgba(255,255,255,0.55);line-height:1.65;margin-bottom:1rem}}
.footer-contact a{{display:block;font-size:0.85rem;color:rgba(255,255,255,0.5);text-decoration:none;margin-bottom:3px;transition:color 0.15s}}
.footer-contact a:hover{{color:var(--cyan)}}
.footer-col-title{{font-size:0.68rem;text-transform:uppercase;letter-spacing:0.12em;color:rgba(255,255,255,0.55);margin-bottom:0.85rem;font-weight:700}}
.footer-links{{list-style:none;display:flex;flex-direction:column;gap:0.55rem}}
.footer-links a{{font-size:0.85rem;color:rgba(255,255,255,0.65);text-decoration:none;transition:color 0.15s}}
.footer-links a:hover{{color:#fff}}
.footer-bottom{{max-width:1100px;margin:0 auto;padding-top:1.25rem;border-top:1px solid rgba(255,255,255,0.07);display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:0.5rem}}
.footer-copy{{font-size:0.72rem;color:rgba(255,255,255,0.5)}}
.nav-hamburger{{display:none;flex-direction:column;gap:5px;cursor:pointer;padding:8px;background:none;border:none;z-index:300}}
.nav-hamburger span{{display:block;width:24px;height:2px;background:var(--ink);border-radius:2px;transition:all 0.3s}}
.nav-mobile{{display:none;position:fixed;top:56px;left:0;right:0;background:#fff;border-bottom:1px solid var(--border);padding:1.5rem 2rem;z-index:199;flex-direction:column;gap:1rem;box-shadow:0 4px 20px rgba(0,0,0,0.08)}}
.nav-mobile.open{{display:flex}}
.nav-mobile a{{font-size:1rem;font-weight:500;color:var(--ink-soft);text-decoration:none;padding:0.5rem 0;border-bottom:1px solid var(--border)}}
.nav-mobile .btn{{margin-top:0.5rem;justify-content:center}}
.how-grid{{display:grid;grid-template-columns:1fr auto 1fr auto 1fr;align-items:start;gap:0.5rem}}
@media(max-width:900px){{.nav-links{{display:none}}.nav-hamburger{{display:flex}}}}
@media(max-width:768px){{.nav-inner{{padding:0 1rem}}.nav-inner>.btn-cyan{{display:none}}.btn{{min-height:44px}}}}
@media(max-width:700px){{.footer-inner{{grid-template-columns:1fr;gap:2rem}}.pricing-grid{{grid-template-columns:1fr}}.how-grid{{display:flex!important;flex-direction:column!important;gap:0.75rem!important}}.how-grid > div:nth-child(2),.how-grid > div:nth-child(4){{display:none!important}}}}
</style>
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
    <button class="nav-hamburger" id="hamburger" aria-label="Toggle navigation" onclick="document.getElementById('hamburger').classList.toggle('open');document.getElementById('mobileNav').classList.toggle('open')">
      <span></span><span></span><span></span>
    </button>
  </div>
</nav>
<div class="nav-mobile" id="mobileNav">
  <a href="/book?service=Furniture+Assembly">Furniture Assembly</a>
  <a href="/book?service=Mounting+%26+Hanging">TV Mounting</a>
  <a href="/book?service=Fitness+Equipment">Fitness Equipment</a>
  <a href="/book?service=Outdoor+%26+Playsets">Outdoor / Playsets</a>
  <a href="/book?service=Office+Assembly">Office Assembly</a>
  <a href="/book?service=Smart+Home">Smart Home Setup</a>
  <a href="/pricing">Pricing</a>
  <a href="/about">About Us</a>
  <a href="/track">Track My Booking</a>
  <a href="/book" class="btn btn-cyan btn-full">Book Now &rarr;</a>
</div>
<script>document.getElementById('mobileNav').addEventListener('click',function(e){{if(e.target.closest('a')){{document.getElementById('hamburger').classList.remove('open');document.getElementById('mobileNav').classList.remove('open');}}}});</script>

<!-- HERO -->
<section style="background:linear-gradient(135deg,#f0fdff 0%,#e0f7fa 50%,#f9fafb 100%);padding:4.5rem 2rem 3.5rem;border-bottom:1px solid var(--border)">
  <div style="max-width:720px;margin:0 auto;text-align:center">
    <div style="display:inline-flex;align-items:center;gap:6px;background:var(--white);border:1px solid var(--cyan-mid);border-radius:999px;padding:0.3rem 0.9rem;font-size:0.72rem;font-weight:700;color:var(--cyan-dark);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:1.25rem">Austin, TX &mdash; Serving the Austin Metro</div>
    <h1 style="font-family:var(--font-display);font-size:clamp(2rem,5vw,3.2rem);color:var(--ink);line-height:1.1;margin-bottom:1rem">{h1}</h1>
    <p style="font-size:1.05rem;color:var(--ink-soft);line-height:1.75;max-width:580px;margin:0 auto 0.75rem">{tagline}</p>
    <p style="font-size:0.95rem;color:var(--muted);line-height:1.7;max-width:560px;margin:0 auto 1.5rem">{city_blurb}</p>
    <div style="display:flex;align-items:center;justify-content:center;gap:6px;margin-bottom:1.75rem;flex-wrap:wrap">
      <span style="display:flex;gap:2px;color:#f59e0b">&#9733;&#9733;&#9733;&#9733;&#9733;</span>
      <strong style="font-size:0.95rem;color:var(--ink)">5.0</strong>
      <span style="font-size:0.85rem;color:var(--muted)">&bull; 11 Google reviews &bull; Serving Austin &amp; metro</span>
    </div>
    <div style="display:flex;flex-direction:column;align-items:center;gap:0.75rem;margin-bottom:2rem">
      <a href="/book?service={book_param}" style="display:inline-flex;align-items:center;gap:8px;background:var(--cyan);color:#fff;font-family:var(--font-body);font-size:1.05rem;font-weight:700;padding:1rem 2.5rem;border-radius:999px;text-decoration:none;transition:all 0.18s;box-shadow:0 4px 20px rgba(0,191,255,0.3)" onmouseover="this.style.background='#0099CC';this.style.transform='translateY(-2px)'" onmouseout="this.style.background='#00BFFF';this.style.transform='none'">Book in Austin &rarr;</a>
      <span style="font-size:0.82rem;color:var(--muted)">From {price} &bull; Secure checkout</span>
    </div>
    <div style="display:flex;justify-content:center;gap:1.5rem;flex-wrap:wrap;font-size:0.82rem;color:var(--ink-soft)">
      <span>&#10003; Total shown upfront</span>
      <span>&#10003; Fast follow-up</span>
      <span>&#10003; Same-Day Available</span>
      <span>&#10003; Clear pricing</span>
    </div>
  </div>
</section>

<!-- PRICING -->
<section style="padding:4.5rem 2rem;background:var(--white)">
  <div style="max-width:960px;margin:0 auto">
    <div style="text-align:center;margin-bottom:2.5rem">
      <div style="font-size:0.72rem;text-transform:uppercase;letter-spacing:0.12em;color:var(--cyan-dark);font-weight:700;margin-bottom:0.5rem">Transparent Pricing</div>
      <h2 style="font-family:var(--font-display);font-size:clamp(1.6rem,3vw,2.2rem);color:var(--ink);margin-bottom:0.6rem">{h1.replace(' in Austin, TX','')} Pricing in Austin</h2>
      <p style="font-size:0.95rem;color:var(--muted);max-width:520px;margin:0 auto">Flat upfront item pricing. Service-call fee and taxes are shown before checkout.</p>
    </div>
    <div class="pricing-grid">{price_cards_html}</div>
    <div style="background:var(--off-white);border:1.5px solid var(--border);border-radius:var(--radius-xl);padding:3rem 2rem;text-align:center">
      <h2 style="font-family:var(--font-display);font-size:1.8rem;color:var(--ink);margin-bottom:0.65rem">Ready to book in Austin?</h2>
      <p style="font-size:0.95rem;color:var(--muted);margin-bottom:1.75rem;line-height:1.65;max-width:520px;margin-left:auto;margin-right:auto">Book in minutes. We follow up quickly and show up on time.</p>
      <a href="/book?service={book_param}" class="btn btn-cyan btn-lg">Book Now &mdash; Austin</a>
      <div style="display:flex;gap:1.5rem;justify-content:center;flex-wrap:wrap;margin-top:1.75rem;font-size:0.82rem;color:var(--muted)">
        <span>&#10003; Fast follow-up</span><span>&#10003; Payment after completion</span><span>&#10003; Service-call fee shown upfront</span>
      </div>
    </div>
  </div>
</section>

<!-- BRANDS -->
<section style="background:var(--off-white);border-top:1px solid var(--border);border-bottom:1px solid var(--border);padding:2rem 2rem">
  <div style="max-width:800px;margin:0 auto;text-align:center">
    <div style="font-size:0.7rem;text-transform:uppercase;letter-spacing:0.1em;color:var(--muted);font-weight:700;margin-bottom:1rem">Brands We Work With Every Day</div>
    <div style="display:flex;flex-wrap:wrap;gap:0.5rem;justify-content:center">{brands_html}</div>
  </div>
</section>

<!-- FAQ -->
<section style="background:var(--white);padding:4.5rem 2rem;border-bottom:1px solid var(--border)">
  <div style="max-width:680px;margin:0 auto">
    <div style="text-align:center;margin-bottom:2.5rem">
      <div style="font-size:0.72rem;text-transform:uppercase;letter-spacing:0.12em;color:var(--cyan-dark);font-weight:700;margin-bottom:0.5rem">FAQ</div>
      <h2 style="font-family:var(--font-display);font-size:clamp(1.6rem,3vw,2.2rem);color:var(--ink)">Common questions about {h1.replace(' in Austin, TX','')}</h2>
    </div>
    <div style="display:flex;flex-direction:column;gap:0.75rem">{faq_html}</div>
  </div>
</section>

<!-- INTERNAL LINKS -->
<section style="background:var(--off-white);padding:3.5rem 2rem;border-bottom:1px solid var(--border)">
  <div style="max-width:960px;margin:0 auto">
    <div style="text-align:center;margin-bottom:2rem">
      <h2 style="font-family:var(--font-display);font-size:clamp(1.4rem,2.5vw,1.9rem);color:var(--ink)">More Assembly Services in Austin</h2>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:2.5rem">
      <div>
        <div style="font-size:0.68rem;text-transform:uppercase;letter-spacing:0.1em;color:var(--muted);font-weight:700;margin-bottom:1rem">Related Services</div>
        <div style="display:flex;flex-direction:column;gap:0.65rem">
          <div><a href="/furniture-assembly-austin-tx" style="color:var(--cyan-dark);text-decoration:none;font-size:0.875rem;font-weight:500">Furniture Assembly in Austin</a></div>
          <div><a href="/tv-mounting-austin-tx" style="color:var(--cyan-dark);text-decoration:none;font-size:0.875rem;font-weight:500">TV Mounting in Austin</a></div>
          <div><a href="/playset-assembly-austin-tx" style="color:var(--cyan-dark);text-decoration:none;font-size:0.875rem;font-weight:500">Playset Assembly in Austin</a></div>
          <div><a href="/fitness-equipment-assembly-austin-tx" style="color:var(--cyan-dark);text-decoration:none;font-size:0.875rem;font-weight:500">Fitness Equipment Assembly</a></div>
        </div>
      </div>
      <div>
        <div style="font-size:0.68rem;text-transform:uppercase;letter-spacing:0.1em;color:var(--muted);font-weight:700;margin-bottom:1rem">Assembly Near You</div>
        <div style="display:flex;flex-direction:column;gap:0.65rem">
          <div><a href="/{related_service}-round-rock-tx" style="color:var(--cyan-dark);text-decoration:none;font-size:0.875rem;font-weight:500">{related_label} in Round Rock</a></div>
          <div><a href="/{related_service}-cedar-park-tx" style="color:var(--cyan-dark);text-decoration:none;font-size:0.875rem;font-weight:500">{related_label} in Cedar Park</a></div>
          <div><a href="/{related_service}-pflugerville-tx" style="color:var(--cyan-dark);text-decoration:none;font-size:0.875rem;font-weight:500">{related_label} in Pflugerville</a></div>
          <div><a href="/{related_service}-georgetown-tx" style="color:var(--cyan-dark);text-decoration:none;font-size:0.875rem;font-weight:500">{related_label} in Georgetown</a></div>
        </div>
      </div>
    </div>
  </div>
</section>

<!-- FINAL CTA -->
<section style="background:linear-gradient(135deg,#003d47,#006070);padding:5rem 2rem;text-align:center">
  <div style="max-width:600px;margin:0 auto">
    <h2 style="font-family:var(--font-display);font-size:clamp(2rem,4vw,2.8rem);color:#fff;margin-bottom:1rem">Ready to get it done in Austin?</h2>
    <p style="font-size:1rem;color:rgba(255,255,255,0.82);margin-bottom:2rem;line-height:1.75">Flat-rate pricing, same-day available. Book in minutes with secure checkout.</p>
    <a href="/book?service={book_param}" style="display:inline-flex;align-items:center;gap:8px;background:#fff;color:#006070;font-family:var(--font-body);font-size:1rem;font-weight:700;padding:1rem 2.5rem;border-radius:999px;text-decoration:none;margin-bottom:1rem">Book Now &rarr;</a>
    <p style="font-size:0.82rem;color:rgba(255,255,255,0.55)"><a href="tel:+17372906129" style="color:rgba(255,255,255,0.7);text-decoration:none">(737) 290-6129</a> &nbsp;&bull;&nbsp; <a href="mailto:service@assembleatease.com" style="color:rgba(255,255,255,0.7);text-decoration:none">service@assembleatease.com</a></p>
  </div>
</section>

<footer class="footer">
  <div class="footer-inner">
    <div>
      <div class="footer-logo"><picture><source srcset="/images/logo.webp" type="image/webp"><img src="/images/logo.jpg" alt="AssembleAtEase Logo"/></picture><div class="footer-logo-text">AssembleAtEase</div></div>
      <p class="footer-tagline">Professional furniture assembly, TV mounting, smart home setup, office assembly, outdoor assembly, and home services in Austin, Texas.</p>
      <div class="footer-contact"><a href="tel:+17372906129">(737) 290-6129</a><a href="mailto:service@assembleatease.com">service@assembleatease.com</a><a href="https://www.facebook.com/profile.php?id=61572042722009" target="_blank" rel="noopener">Follow Austin project updates</a></div>
    </div>
    <div>
      <div class="footer-col-title">Services</div>
      <ul class="footer-links">
        <li><a href="/furniture-assembly-austin-tx">Furniture Assembly</a></li>
        <li><a href="/tv-mounting-austin-tx">TV Mounting</a></li>
        <li><a href="/smart-home-installation-austin-tx">Smart Home Setup</a></li>
        <li><a href="/fitness-equipment-assembly-austin-tx">Fitness Equipment</a></li>
        <li><a href="/office-furniture-assembly-austin-tx">Office Furniture</a></li>
        <li><a href="/playset-assembly-austin-tx">Outdoor / Playsets</a></li>
        <li><a href="/business">Business &amp; Custom Quotes</a></li>
      </ul>
    </div>
    <div>
      <div class="footer-col-title">Company</div>
      <ul class="footer-links">
        <li><a href="/about">About Us</a></li>
        <li><a href="/pricing">Pricing</a></li>
        <li><a href="/blog/">Guides</a></li>
        <li><a href="/#faq">FAQ</a></li>
        <li><a href="/contact">Contact</a></li>
        <li><a href="/track">Track My Booking</a></li>
        <li><a href="/business">Business Services</a></li>
        <li><a href="/assembler/apply">Become an Easer</a></li>
      </ul>
    </div>
    <div style="grid-column:1 / -1">
      <div class="footer-col-title">Home Setup Guides</div>
      <ul class="footer-links" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:0.5rem">
        <li><a href="/blog/ikea-assembly-cost-austin">IKEA Assembly Cost Austin</a></li>
        <li><a href="/blog/tv-mounting-costs-austin">TV Mounting Costs Austin</a></li>
        <li><a href="/blog/best-furniture-assembly-austin">Best Assembly Service Austin</a></li>
        <li><a href="/blog/new-home-setup-checklist-austin">New Home Setup Checklist</a></li>
        <li><a href="/blog/smart-home-installation-austin">Smart Home Install Austin</a></li>
        <li><a href="/blog/">All Guides &rarr;</a></li>
      </ul>
    </div>
  </div>
  <div class="footer-bottom">
    <span class="footer-copy">&copy; <script>document.write(new Date().getFullYear())</script> AssembleAtEase. All rights reserved. Austin, TX.</span>
    <div class="footer-legal"><a href="/privacy">Privacy Policy</a><a href="/terms">Terms &amp; Conditions</a></div>
  </div>
</footer>
</body>
</html>"""


# ── Page definitions ──────────────────────────────────────────────────────

# IKEA Assembly
ikea_cards = (
    price_card("IKEA PAX Wardrobe (single unit)", "$169+", popular=True, book_url="/book?service=Furniture+Assembly") +
    price_card("MALM / HEMNES Dresser", "$109&ndash;$129", book_url="/book?service=Furniture+Assembly") +
    price_card("HEMNES / SLAKT Bed Frame", "$99&ndash;$139", book_url="/book?service=Furniture+Assembly") +
    price_card("KALLAX / BILLY Shelving", "$79&ndash;$109", book_url="/book?service=Furniture+Assembly") +
    price_card("LACK / LISABO Table", "$79&ndash;$109", book_url="/book?service=Furniture+Assembly") +
    price_card("Any other IKEA item", "From $69", book_url="/book?service=Furniture+Assembly")
)
ikea_brands = "".join(brand_chip(b) for b in ["IKEA PAX","MALM","HEMNES","KALLAX","BILLY","LACK","BESTA","EKTORP","POANG","FRIHETEN"])
ikea_faq = (
    faq_item("Do you assemble all IKEA furniture?",
             "Yes &mdash; PAX wardrobes, KALLAX shelving, MALM dressers, HEMNES beds, BESTA TV units, LACK tables, EKTORP sofas, POANG chairs, and any other IKEA flat-pack item. If it came in a box with instructions, we assemble it.") +
    faq_item("Do I need to unbox everything first?",
             "No. We handle unboxing, assembly, and disposing of all packaging. Just let us know at booking if you'd like us to haul the boxes away.") +
    faq_item("How long does IKEA PAX assembly take?",
             "A single PAX unit takes approximately 60&ndash;90 minutes. A full wall of PAX (3&ndash;4 units) typically takes 3&ndash;4 hours. We'll confirm timing when you book.") +
    faq_item("What if parts are missing from the box?",
             "We check for missing parts during assembly. If IKEA parts are missing, we'll help you identify exactly what to order. We can return once parts arrive at no additional call-out fee.")
)
ikea_offers = [
    {"@type":"Offer","position":1,"name":"IKEA PAX Wardrobe (single unit)","description":"$169+"},
    {"@type":"Offer","position":2,"name":"MALM / HEMNES Dresser","description":"$109-$129"},
    {"@type":"Offer","position":3,"name":"HEMNES Bed Frame","description":"$99-$139"},
    {"@type":"Offer","position":4,"name":"KALLAX / BILLY Shelving","description":"$79-$109"},
]

# Gazebo Assembly
gazebo_cards = (
    price_card("Pergola Kit (12x12 or smaller)", "$399&ndash;$499", popular=True, book_url="/book?service=Outdoor+%26+Playsets") +
    price_card("Gazebo Kit (octagonal / rectangular)", "$449&ndash;$599", book_url="/book?service=Outdoor+%26+Playsets") +
    price_card("Large Pergola / Pavilion (16x20+)", "$599&ndash;$799", book_url="/book?service=Outdoor+%26+Playsets") +
    price_card("Shade Sail Frame", "$199&ndash;$299", book_url="/book?service=Outdoor+%26+Playsets")
)
gazebo_brands = "".join(brand_chip(b) for b in ["Sunjoy","Yardistry","Backyard Discovery","Costco","Hampton Bay","Allen+Roth","Outsunny","MCOMBO"])
gazebo_faq = (
    faq_item("Do you anchor gazebos to the ground?",
             "Yes &mdash; we anchor all gazebos and pergolas per manufacturer specifications. Ground anchoring hardware is included in the assembly price for standard grass or concrete surfaces.") +
    faq_item("How long does gazebo assembly take?",
             "Most gazebo and pergola kit assemblies take 3&ndash;6 hours depending on size and complexity. We'll confirm the estimated time when you book.") +
    faq_item("Do you work on concrete patios?",
             "Yes &mdash; we anchor to both grass and concrete or pavers. Just let us know your surface type at booking so we bring the right hardware.") +
    faq_item("Can you assemble any brand?",
             "Yes &mdash; Sunjoy, Yardistry, Backyard Discovery, Costco, Hampton Bay, Allen+Roth, and more. If it comes as a kit with instructions, we assemble it.")
)
gazebo_offers = [
    {"@type":"Offer","position":1,"name":"Pergola Kit (12x12 or smaller)","description":"$399-$499"},
    {"@type":"Offer","position":2,"name":"Gazebo Kit","description":"$449-$599"},
    {"@type":"Offer","position":3,"name":"Large Pergola / Pavilion","description":"$599-$799"},
    {"@type":"Offer","position":4,"name":"Shade Sail Frame","description":"$199-$299"},
]

# Trampoline Assembly
trampoline_cards = (
    price_card("Trampoline (round, up to 14 ft)", "$199", popular=True, book_url="/book?service=Outdoor+%26+Playsets") +
    price_card("Trampoline (15&ndash;17 ft)", "$249", book_url="/book?service=Outdoor+%26+Playsets") +
    price_card("Rectangular Trampoline", "$279&ndash;$349", book_url="/book?service=Outdoor+%26+Playsets") +
    price_card("Springfree / No-Spring Trampoline", "$299&ndash;$399", book_url="/book?service=Outdoor+%26+Playsets")
)
trampoline_brands = "".join(brand_chip(b) for b in ["Springfree","Skywalker","Vuly","Acon","Zupapa","JumpSport","Upper Bounce","Propel"])
trampoline_faq = (
    faq_item("Do you assemble the safety net enclosure?",
             "Yes &mdash; the safety enclosure net and poles are always assembled together with the trampoline frame and springs. Everything is included in the quoted price.") +
    faq_item("How long does trampoline assembly take?",
             "Most round trampolines take 1.5&ndash;2.5 hours. Rectangular and Springfree models typically take 2.5&ndash;4 hours. We'll confirm at booking.") +
    faq_item("Do you install ground anchors?",
             "Yes &mdash; we install ground anchor kits to keep the trampoline in place during Texas wind and storms. Let us know at booking and we'll bring the right anchors.") +
    faq_item("Can you assemble Springfree trampolines?",
             "Yes &mdash; Springfree trampolines are one of our most common trampoline assembly requests. They take slightly longer than spring-based models due to the flexible rod system, but we're very familiar with them.")
)
trampoline_offers = [
    {"@type":"Offer","position":1,"name":"Trampoline (round, up to 14 ft)","description":"$199"},
    {"@type":"Offer","position":2,"name":"Trampoline (15-17 ft)","description":"$249"},
    {"@type":"Offer","position":3,"name":"Rectangular Trampoline","description":"$279-$349"},
    {"@type":"Offer","position":4,"name":"Springfree / No-Spring Trampoline","description":"$299-$399"},
]

PAGES = [
    {
        "slug": "ikea-assembly-austin-tx",
        "title": "IKEA Furniture Assembly in Austin, TX — From $69 | AssembleAtEase",
        "meta": "IKEA furniture assembly in Austin, TX — PAX wardrobes, MALM dressers, HEMNES beds, KALLAX shelving and more. From $69. Same-day available with secure checkout.",
        "h1": "IKEA Furniture Assembly in Austin, TX",
        "tagline": "Every IKEA item assembled fast, clean, and correctly.",
        "city_blurb": "Austin is one of the busiest IKEA markets in Texas &mdash; new apartments, tech workers moving in, and growing families furnishing homes every day. We know every flat-pack, every hardware bag.",
        "price": "$69",
        "book_param": "Furniture+Assembly",
        "price_cards": ikea_cards,
        "brands": ikea_brands,
        "faq": ikea_faq,
        "service_type": "IKEA Furniture Assembly",
        "offers": ikea_offers,
        "related_service": "furniture-assembly",
        "related_label": "Furniture Assembly",
    },
    {
        "slug": "gazebo-assembly-austin-tx",
        "title": "Gazebo Assembly in Austin, TX — From $399 | AssembleAtEase",
        "meta": "Professional gazebo and pergola assembly in Austin, TX — any brand, any kit. Sunjoy, Yardistry, Costco, Hampton Bay and more. From $399. Secure checkout.",
        "h1": "Gazebo Assembly in Austin, TX",
        "tagline": "Pergolas, gazebos, and outdoor structures assembled and anchored.",
        "city_blurb": "Austin's year-round outdoor lifestyle means more backyard pergolas and gazebos going up than anywhere in Central Texas. Our team handles any kit, any surface, any size.",
        "price": "$399",
        "book_param": "Outdoor+%26+Playsets",
        "price_cards": gazebo_cards,
        "brands": gazebo_brands,
        "faq": gazebo_faq,
        "service_type": "Gazebo Assembly",
        "offers": gazebo_offers,
        "related_service": "playset-assembly",
        "related_label": "Playset Assembly",
    },
    {
        "slug": "trampoline-assembly-austin-tx",
        "title": "Trampoline Assembly in Austin, TX — From $199 | AssembleAtEase",
        "meta": "Professional trampoline assembly in Austin, TX — Springfree, Skywalker, Vuly, Acon and more. From $199. Same-day available with secure checkout.",
        "h1": "Trampoline Assembly in Austin, TX",
        "tagline": "All brands, all sizes &mdash; assembled and anchored safely.",
        "city_blurb": "Austin's family-friendly suburbs &mdash; Round Rock, Cedar Park, Georgetown, Kyle &mdash; are full of backyards that need trampolines set up right. We handle the springs, nets, and anchors so you don't have to.",
        "price": "$199",
        "book_param": "Outdoor+%26+Playsets",
        "price_cards": trampoline_cards,
        "brands": trampoline_brands,
        "faq": trampoline_faq,
        "service_type": "Trampoline Assembly",
        "offers": trampoline_offers,
        "related_service": "playset-assembly",
        "related_label": "Playset Assembly",
    },
]

for p in PAGES:
    content = make_page(
        slug=p["slug"], title=p["title"], meta_desc=p["meta"],
        h1=p["h1"], tagline=p["tagline"], city_blurb=p["city_blurb"],
        price=p["price"], book_param=p["book_param"],
        price_cards_html=p["price_cards"], brands_html=p["brands"],
        faq_html=p["faq"], service_type=p["service_type"],
        schema_offers=p["offers"],
        related_service=p["related_service"], related_label=p["related_label"],
    )
    fname = p["slug"] + ".html"
    open(fname, "w", encoding="utf-8").write(content)
    print("OK", fname)

# ── 3. Add new pages to sitemap.xml ──────────────────────────────────────
sitemap = open("sitemap.xml", "r", encoding="utf-8").read()
today = "2026-06-08"
new_entries = ""
for p in PAGES:
    url = SITE + "/" + p["slug"]
    if url not in sitemap:
        new_entries += f"  <url><loc>{url}</loc><lastmod>{today}</lastmod><changefreq>monthly</changefreq><priority>0.8</priority></url>\n"
if new_entries:
    sitemap = sitemap.replace("</urlset>", new_entries + "</urlset>")
    open("sitemap.xml", "w", encoding="utf-8").write(sitemap)
    print("OK sitemap.xml — 3 new URLs added")
else:
    print("sitemap already has new URLs")

print("\nAll done.")
