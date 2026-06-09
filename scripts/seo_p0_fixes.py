#!/usr/bin/env python3
"""SEO P0+P1 batch fix — hub schemas, FAQPage, title/meta/price fixes, WebSite schema."""
import re, json, os, glob

BASE   = r"c:\Users\tgbiz\Handyman-marketplace"
os.chdir(BASE)

MAPS  = "https://www.google.com/maps?cid=7847022131459448801"
SITE  = "https://www.assembleatease.com"
BOOK  = SITE + "/book"
LOGO  = SITE + "/images/logo.jpg"
PHONE = "+17372906129"
EMAIL = "service@assembleatease.com"
ADDR  = {"@type":"PostalAddress","streetAddress":"1910 W Braker Ln",
         "addressLocality":"Austin","addressRegion":"TX",
         "postalCode":"78701","addressCountry":"US"}
GEO   = {"@type":"GeoCoordinates","latitude":"30.4140535","longitude":"-97.7491735"}
RATING = {"@type":"AggregateRating","ratingValue":"5.0","reviewCount":"9","bestRating":"5"}
ACTION = {"@type":"ReserveAction",
          "target":{"@type":"EntryPoint","urlTemplate":BOOK},
          "result":{"@type":"Reservation","name":"Book Assembly Service"}}

def local_biz(name, url):
    return {
        "@context":"https://schema.org",
        "@type":["LocalBusiness","HomeAndConstructionBusiness"],
        "name": name, "image": LOGO, "url": url,
        "telephone": PHONE, "email": EMAIL,
        "address": ADDR, "geo": GEO,
        "areaServed":{"@type":"City","name":"Austin",
                      "containedInPlace":{"@type":"State","name":"Texas"}},
        "priceRange":"$$","sameAs":MAPS,
        "aggregateRating":RATING,"potentialAction":ACTION,
    }

def breadcrumb(label, url):
    return {
        "@context":"https://schema.org","@type":"BreadcrumbList",
        "itemListElement":[
            {"@type":"ListItem","position":1,"name":"Home","item":SITE},
            {"@type":"ListItem","position":2,"name":label,"item":url},
        ]
    }

def faq_schema(pairs):
    return {
        "@context":"https://schema.org","@type":"FAQPage",
        "mainEntity":[{
            "@type":"Question","name":q,
            "acceptedAnswer":{"@type":"Answer","text":a}
        } for q,a in pairs]
    }

def stag(obj):
    return '<script type="application/ld+json">' + json.dumps(obj, separators=(",",":")) + "</script>"

def inject(html, *tags):
    return html.replace("</head>", "\n".join(tags) + "\n</head>", 1)

changed = []

# ── 1. Homepage: fix title + add WebSite SearchAction schema ────────────────
html = open("index.html", "r", encoding="utf-8").read()
html = html.replace(
    "AssembleAtEase &mdash; Professional Furniture Assembly &amp; Mounting &amp; Hanging Austin TX",
    "AssembleAtEase &mdash; Furniture Assembly &amp; TV Mounting Austin TX"
)
if "WebSite" not in html:
    ws = {
        "@context":"https://schema.org","@type":"WebSite",
        "name":"AssembleAtEase","url":SITE,
        "potentialAction":{
            "@type":"SearchAction",
            "target":SITE+"/book?q={search_term_string}",
            "query-input":"required name=search_term_string"
        }
    }
    html = inject(html, stag(ws))
open("index.html", "w", encoding="utf-8").write(html)
changed.append("index.html — title fix + WebSite SearchAction schema")

# ── 2. about.html — fix duplicate meta description ──────────────────────────
html = open("about.html", "r", encoding="utf-8").read()
new_desc = "AssembleAtEase is Austin's assembly and installation service. Background-checked pros, transparent pricing, and you don't pay until the job is done."
html = re.sub(r'(name="description" content=")[^"]*(")', r"\g<1>" + new_desc + r"\2", html)
html = re.sub(r'(og:description" content=")[^"]*(")', r"\g<1>" + new_desc + r"\2", html)
open("about.html", "w", encoding="utf-8").write(html)
changed.append("about.html — meta description deduped")

# ── 3. blog/index.html — remove dead service from meta ──────────────────────
bpath = os.path.join("blog", "index.html")
if os.path.exists(bpath):
    html = open(bpath, "r", encoding="utf-8").read()
    new_desc = "Tips, guides, and local pricing for furniture assembly, TV mounting, smart home installation, and outdoor assembly in Austin, TX."
    html = re.sub(r'(name="description" content=")[^"]*(")', r"\g<1>" + new_desc + r"\2", html)
    html = re.sub(r'(og:description" content=")[^"]*(")', r"\g<1>" + new_desc + r"\2", html)
    open(bpath, "w", encoding="utf-8").write(html)
    changed.append("blog/index.html — meta fixed (removed dead service)")

# ── 4. Price fixes: tv-mounting ($89→$99) + playset ($175→$169) ─────────────
for fname in glob.glob("tv-mounting-*.html"):
    html = open(fname, "r", encoding="utf-8").read()
    if "From $89" in html:
        html = html.replace("From $89", "From $99")
        open(fname, "w", encoding="utf-8").write(html)

for fname in ["playset-assembly-austin-tx.html"] + glob.glob("playset-assembly-*.html"):
    html = open(fname, "r", encoding="utf-8").read()
    if "From $175" in html:
        html = html.replace("From $175", "From $169")
        open(fname, "w", encoding="utf-8").write(html)
changed.append("tv-mounting-*.html — price $89 -> $99")
changed.append("playset-assembly-*.html — price $175 -> $169")

# ── 5. Hub pages: LocalBusiness + BreadcrumbList + FAQPage ──────────────────
HUB_FAQS = {
    "furniture.html": [
        ("How long does furniture assembly take?",
         "Most single items take 30-90 minutes. A full bedroom set typically takes 2-3 hours. We will give you a time estimate when confirming your booking."),
        ("Do you bring your own tools?",
         "Yes - our Easers arrive fully equipped. You do not need to provide any tools or equipment."),
        ("Can you assemble any brand?",
         "Yes - IKEA, Wayfair, Amazon, Ashley, Target, Costco, CB2, Pottery Barn, West Elm, and more. If it came in a box with instructions, we can assemble it."),
        ("What if I have a large order?",
         "Bundle discounts apply for 3+ items in one booking. For whole-home setups or large commercial projects, contact us for a custom quote."),
    ],
    "mounting.html": [
        ("Do you bring your own TV mount?",
         "We bring all installation tools - drill, anchors, level, and stud finder. If you have a specific mount you want used, we are happy to use yours."),
        ("Can you mount a TV on a brick or concrete wall?",
         "Yes - brick and concrete mounts are available. We bring the appropriate masonry bits and anchors for the job."),
        ("Will you hide the cables inside the wall?",
         "Yes. In-wall cord concealment is available as an add-on. We run the power and HDMI cables inside the wall for a completely clean look."),
        ("What TV sizes do you mount?",
         'We mount TVs from 30" up to 85"+. Very large or commercial displays (86"+) are available with a custom quote.'),
    ],
    "smarthome.html": [
        ("Do you bring the smart devices or do I?",
         "You provide the devices - we install and configure them. If you are unsure which product to buy, just ask in your booking notes."),
        ("Will you set up the app and connect it to my network?",
         "Yes - we do not leave until the device is fully set up, connected to your Wi-Fi, and working in your app."),
        ("Can you install devices on any platform?",
         "Yes - Google Home, Amazon Alexa, Apple HomeKit, SmartThings and more. Let us know your platform in the booking notes."),
        ("What if my Wi-Fi does not reach the installation spot?",
         "We can assess signal strength and recommend a Wi-Fi extender if needed. Extender installation is available as an add-on."),
    ],
}

HUB_CONFIGS = {
    "furniture.html": ("AssembleAtEase — Furniture Assembly Austin TX", SITE+"/furniture",  "Furniture Assembly Austin TX"),
    "mounting.html":  ("AssembleAtEase — TV Mounting Austin TX",        SITE+"/mounting",   "TV Mounting Austin TX"),
    "smarthome.html": ("AssembleAtEase — Smart Home Installation Austin TX", SITE+"/smarthome", "Smart Home Installation Austin TX"),
    "business.html":  ("AssembleAtEase — Business Services Austin TX",  SITE+"/business",   "Business Assembly Services Austin TX"),
}

for fname, (biz_name, page_url, crumb_label) in HUB_CONFIGS.items():
    html = open(fname, "r", encoding="utf-8").read()
    tags = []
    if "LocalBusiness" not in html:
        tags.append(stag(local_biz(biz_name, page_url)))
    if "BreadcrumbList" not in html:
        tags.append(stag(breadcrumb(crumb_label, page_url)))
    if "FAQPage" not in html and fname in HUB_FAQS:
        tags.append(stag(faq_schema(HUB_FAQS[fname])))
    if tags:
        html = inject(html, *tags)
        open(fname, "w", encoding="utf-8").write(html)
        changed.append(fname + " — LocalBusiness + BreadcrumbList + FAQPage added")

# ── 6. Blog pages: add LocalBusiness + AggregateRating ──────────────────────
blog_tag = stag(local_biz("AssembleAtEase", SITE))
n = 0
for fpath in glob.glob(os.path.join("blog", "*.html")):
    if fpath.endswith("index.html"):
        continue
    html = open(fpath, "r", encoding="utf-8").read()
    if "LocalBusiness" in html:
        continue
    html = inject(html, blog_tag)
    open(fpath, "w", encoding="utf-8").write(html)
    n += 1
changed.append(f"blog/ — {n} posts got LocalBusiness + AggregateRating (5.0, 9 reviews)")

print("Done. Changes applied:")
for c in changed:
    print("  OK", c)
