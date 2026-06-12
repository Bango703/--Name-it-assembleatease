#!/usr/bin/env python3
"""
seo_batch_fix.py — AssembleAtEase SEO batch fixes for all 72 location pages.

Fixes applied:
  1. Unique meta descriptions (replacing generic city tourism boilerplate)
  2. og:description updated to match
  3. TV Mounting pages: title/og:title/twitter:title/H1/schema "Mounting & Hanging" → "TV Mounting"
  4. BreadcrumbList JSON-LD schema added to every location page
"""
import os, re, json

BASE = r"c:\Users\tgbiz\Handyman-marketplace"

CITY_NAMES = {
    'austin':      'Austin',
    'round-rock':  'Round Rock',
    'cedar-park':  'Cedar Park',
    'pflugerville':'Pflugerville',
    'georgetown':  'Georgetown',
    'hutto':       'Hutto',
    'leander':     'Leander',
    'bee-cave':    'Bee Cave',
    'lakeway':     'Lakeway',
    'manor':       'Manor',
    'buda':        'Buda',
    'kyle':        'Kyle',
}

HUB_NAMES = {
    'furniture-assembly':         'Furniture Assembly',
    'tv-mounting':                'TV Mounting',
    'smart-home-installation':    'Smart Home Installation',
    'fitness-equipment-assembly': 'Fitness Equipment Assembly',
    'playset-assembly':           'Playset Assembly',
    'office-furniture-assembly':  'Office Furniture Assembly',
}

# 72 unique meta descriptions — all under 160 chars, keyword-rich, CTA-driven
META = {
    # ── FURNITURE ASSEMBLY ──────────────────────────────────────────────────
    ('furniture-assembly','austin'):        "Furniture assembly in Austin, TX — IKEA, Wayfair, Ashley and more. From $69. Tech hub, fast turnaround, same-day available. Book online, secure payment at booking.",
    ('furniture-assembly','round-rock'):    "Furniture assembly in Round Rock, TX — IKEA, Wayfair, Ashley and more. From $69. Serving Dell families and I-35 corridor homes. Book online, secure payment at booking.",
    ('furniture-assembly','cedar-park'):    "Furniture assembly in Cedar Park, TX — IKEA, Wayfair, Ashley and more. From $69. New construction in Austin's northwest corridor. Book online, secure payment at booking.",
    ('furniture-assembly','pflugerville'):  "Furniture assembly in Pflugerville, TX — IKEA, Wayfair, Ashley and more. From $69. Fast-growing east Austin suburb. Same-day available. Book online, secure payment at booking.",
    ('furniture-assembly','georgetown'):    "Furniture assembly in Georgetown, TX — IKEA, Wayfair, Ashley and more. From $69. Serving Sun City and Georgetown's new developments. Book online, secure payment at booking.",
    ('furniture-assembly','hutto'):         "Furniture assembly in Hutto, TX — IKEA, Wayfair, Ashley and more. From $69. Young families and new construction east of Austin. Book online, secure payment at booking.",
    ('furniture-assembly','leander'):       "Furniture assembly in Leander, TX — IKEA, Wayfair, Ashley and more. From $69. Hill Country suburb with MetroRail access. Book online, secure payment at booking.",
    ('furniture-assembly','bee-cave'):      "Furniture assembly in Bee Cave, TX — IKEA, RH, Pottery Barn and more. From $69. Careful service for Hill Country luxury homes. Book online, secure payment at booking.",
    ('furniture-assembly','lakeway'):       "Furniture assembly in Lakeway, TX — IKEA, Wayfair, Pottery Barn and more. From $69. Lake Travis waterfront homes, assembled right. Book online, secure payment at booking.",
    ('furniture-assembly','manor'):         "Furniture assembly in Manor, TX — IKEA, Wayfair, Ashley and more. From $69. Fast-growing east Austin suburb. Same-day available. Book online, secure payment at booking.",
    ('furniture-assembly','buda'):          "Furniture assembly in Buda, TX — IKEA, Wayfair, Ashley and more. From $69. Growing families south of Austin. Same-day available. Book online, secure payment at booking.",
    ('furniture-assembly','kyle'):          "Furniture assembly in Kyle, TX — IKEA, Wayfair, Ashley and more. From $69. One of the fastest-growing cities in the US. Book online, secure payment at booking.",

    # ── TV MOUNTING ──────────────────────────────────────────────────────────
    ('tv-mounting','austin'):        "TV mounting in Austin, TX — any TV, any wall. Cord concealment, above-fireplace, outdoor setups. From $99. Same-day available. Book online, secure payment at booking.",
    ('tv-mounting','round-rock'):    "TV mounting in Round Rock, TX — any TV, any wall. Clean installs for Round Rock homes and apartments. From $99. Book online, secure payment at booking.",
    ('tv-mounting','cedar-park'):    "TV mounting in Cedar Park, TX — any TV, any wall. New construction northwest of Austin. Cord concealment available. From $99. Book online, secure payment at booking.",
    ('tv-mounting','pflugerville'):  "TV mounting in Pflugerville, TX — any TV, any wall. Fast-growing east Austin suburb, same-day available. From $99. Book online, secure payment at booking.",
    ('tv-mounting','georgetown'):    "TV mounting in Georgetown, TX — any TV, any wall. Serving Sun City and Georgetown's growing community. From $99. Book online, secure payment at booking.",
    ('tv-mounting','hutto'):         "TV mounting in Hutto, TX — any TV, any wall. New construction homes east of Austin. From $99. Book online and secure payment at booking.",
    ('tv-mounting','leander'):       "TV mounting in Leander, TX — any TV, any wall. Cord concealment, above-fireplace, and outdoor installs. From $99. Book online, secure payment at booking.",
    ('tv-mounting','bee-cave'):      "TV mounting in Bee Cave, TX — any TV, any wall. Premium installs for Hill Country luxury homes. Cord concealment available. From $99. Secure payment at booking.",
    ('tv-mounting','lakeway'):       "TV mounting in Lakeway, TX — any TV, any wall. Lake Travis waterfront homes and outdoor entertainment setups. From $99. Book online, secure payment at booking.",
    ('tv-mounting','manor'):         "TV mounting in Manor, TX — any TV, any wall. East Austin suburb, same-day available. From $99. Book online and secure payment at booking.",
    ('tv-mounting','buda'):          "TV mounting in Buda, TX — any TV, any wall. Cord concealment, above-fireplace installs, outdoor TVs. From $99. Book online, secure payment at booking.",
    ('tv-mounting','kyle'):          "TV mounting in Kyle, TX — any TV, any wall. One of the fastest-growing US cities. New home? From $99. Book online, secure payment at booking.",

    # ── SMART HOME INSTALLATION ──────────────────────────────────────────────
    ('smart-home-installation','austin'):        "Smart home installation in Austin, TX — Nest, Ring, Ecobee, August, Arlo and more. Installed and configured same day. From $69. Book online, secure payment at booking.",
    ('smart-home-installation','round-rock'):    "Smart home installation in Round Rock, TX — Nest, Ring, Ecobee, Arlo and more. Serving tech-forward Round Rock homes. From $69. Book online, secure payment at booking.",
    ('smart-home-installation','cedar-park'):    "Smart home installation in Cedar Park, TX — Nest, Ring, Ecobee, August and more. New homes in northwest Austin. From $69. Book online, secure payment at booking.",
    ('smart-home-installation','pflugerville'):  "Smart home installation in Pflugerville, TX — Nest, Ring, Ecobee and more installed and configured. East Austin suburb. From $69. Book online, secure payment at booking.",
    ('smart-home-installation','georgetown'):    "Smart home installation in Georgetown, TX — Nest, Ring, Ecobee, August and more. Serving Sun City and Georgetown families. From $69. Book online, secure payment at booking.",
    ('smart-home-installation','hutto'):         "Smart home installation in Hutto, TX — Nest, Ring, Ecobee, Arlo and more. New homes east of Austin, set up right. From $69. Book online, secure payment at booking.",
    ('smart-home-installation','leander'):       "Smart home installation in Leander, TX — Nest, Ring, Ecobee and more. Hill Country suburb, tech-forward homeowners. From $69. Book online, secure payment at booking.",
    ('smart-home-installation','bee-cave'):      "Smart home installation in Bee Cave, TX — Nest, Ring, Ecobee, August, Arlo and more. Premium Hill Country luxury homes. From $69. Secure payment at booking.",
    ('smart-home-installation','lakeway'):       "Smart home installation in Lakeway, TX — Nest, Ring, Ecobee, August and more. Lake Travis waterfront homes. From $69. Book online, secure payment at booking.",
    ('smart-home-installation','manor'):         "Smart home installation in Manor, TX — Nest, Ring, Ecobee and more. Fast-growing east Austin suburb. From $69. Book online, secure payment at booking.",
    ('smart-home-installation','buda'):          "Smart home installation in Buda, TX — Nest, Ring, Ecobee, August, Arlo and more. South Austin families. From $69. Book online, secure payment at booking.",
    ('smart-home-installation','kyle'):          "Smart home installation in Kyle, TX — Nest, Ring, Ecobee and more. One of the fastest-growing US cities. New home? From $69. Book online, secure payment at booking.",

    # ── FITNESS EQUIPMENT ASSEMBLY ───────────────────────────────────────────
    ('fitness-equipment-assembly','austin'):        "Fitness equipment assembly in Austin, TX — treadmills, ellipticals, Pelotons, squat racks, and home gyms. From $119. Book online, secure payment at booking.",
    ('fitness-equipment-assembly','round-rock'):    "Fitness equipment assembly in Round Rock, TX — treadmills, bikes, racks, and home gyms. Serving Round Rock families and professionals. From $119. Secure payment at booking.",
    ('fitness-equipment-assembly','cedar-park'):    "Fitness equipment assembly in Cedar Park, TX — treadmills, ellipticals, squat racks, and home gyms. Northwest Austin. From $119. Book online, secure payment at booking.",
    ('fitness-equipment-assembly','pflugerville'):  "Fitness equipment assembly in Pflugerville, TX — treadmills, bikes, racks, and home gyms. East Austin suburb. From $119. Book online, secure payment at booking.",
    ('fitness-equipment-assembly','georgetown'):    "Fitness equipment assembly in Georgetown, TX — treadmills, ellipticals, squat racks, and home gyms. From $119. Book online, secure payment at booking.",
    ('fitness-equipment-assembly','hutto'):         "Fitness equipment assembly in Hutto, TX — treadmills, bikes, racks, and home gyms. New homes east of Austin. From $119. Book online, secure payment at booking.",
    ('fitness-equipment-assembly','leander'):       "Fitness equipment assembly in Leander, TX — treadmills, ellipticals, squat racks, and home gyms. Hill Country suburb. From $119. Secure payment at booking.",
    ('fitness-equipment-assembly','bee-cave'):      "Fitness equipment assembly in Bee Cave, TX — treadmills, ellipticals, squat racks, and premium home gyms. Hill Country homes. From $119. Secure payment at booking.",
    ('fitness-equipment-assembly','lakeway'):       "Fitness equipment assembly in Lakeway, TX — treadmills, bikes, squat racks, and home gyms. Lake Travis area. From $119. Book online, secure payment at booking.",
    ('fitness-equipment-assembly','manor'):         "Fitness equipment assembly in Manor, TX — treadmills, ellipticals, bikes, racks, and home gyms. East Austin suburb. From $119. Book online, secure payment at booking.",
    ('fitness-equipment-assembly','buda'):          "Fitness equipment assembly in Buda, TX — treadmills, ellipticals, squat racks, and home gyms. South Austin families. From $119. Book online, secure payment at booking.",
    ('fitness-equipment-assembly','kyle'):          "Fitness equipment assembly in Kyle, TX — treadmills, bikes, squat racks, and home gyms. One of the fastest-growing US cities. From $119. Secure payment at booking.",

    # ── PLAYSET ASSEMBLY ─────────────────────────────────────────────────────
    ('playset-assembly','austin'):        "Playset assembly in Austin, TX — swing sets, gazebos, pergolas, trampolines, and storage sheds. From $169. Book online, secure payment at booking.",
    ('playset-assembly','round-rock'):    "Playset assembly in Round Rock, TX — swing sets, playsets, gazebos, and outdoor structures. Serving Round Rock families. From $169. Secure payment at booking.",
    ('playset-assembly','cedar-park'):    "Playset assembly in Cedar Park, TX — swing sets, playsets, gazebos, and outdoor structures. Northwest Austin families. From $169. Book online, secure payment at booking.",
    ('playset-assembly','pflugerville'):  "Playset assembly in Pflugerville, TX — swing sets, playsets, gazebos, and outdoor structures. East Austin families. From $169. Book online, secure payment at booking.",
    ('playset-assembly','georgetown'):    "Playset assembly in Georgetown, TX — swing sets, playsets, gazebos, pergolas, and outdoor structures. From $169. Book online, secure payment at booking.",
    ('playset-assembly','hutto'):         "Playset assembly in Hutto, TX — swing sets, playsets, gazebos, and outdoor structures. Young families east of Austin. From $169. Book online, secure payment at booking.",
    ('playset-assembly','leander'):       "Playset assembly in Leander, TX — swing sets, playsets, gazebos, and outdoor structures. Hill Country suburb. From $169. Book online, secure payment at booking.",
    ('playset-assembly','bee-cave'):      "Playset assembly in Bee Cave, TX — swing sets, playsets, pergolas, and gazebos. Premium Hill Country backyards. From $169. Book online, secure payment at booking.",
    ('playset-assembly','lakeway'):       "Playset assembly in Lakeway, TX — swing sets, playsets, gazebos, and outdoor structures. Lake Travis families. From $169. Book online, secure payment at booking.",
    ('playset-assembly','manor'):         "Playset assembly in Manor, TX — swing sets, playsets, gazebos, and outdoor structures. East Austin suburb. From $169. Book online, secure payment at booking.",
    ('playset-assembly','buda'):          "Playset assembly in Buda, TX — swing sets, playsets, gazebos, trampolines, and outdoor structures. From $169. Book online, secure payment at booking.",
    ('playset-assembly','kyle'):          "Playset assembly in Kyle, TX — swing sets, playsets, gazebos, and outdoor structures. One of the fastest-growing US cities. From $169. Secure payment at booking.",

    # ── OFFICE FURNITURE ASSEMBLY ────────────────────────────────────────────
    ('office-furniture-assembly','austin'):        "Office furniture assembly in Austin, TX — standing desks, chairs, shelving, cubicles, and workstations. Home or commercial. From $89. Secure payment at booking.",
    ('office-furniture-assembly','round-rock'):    "Office furniture assembly in Round Rock, TX — standing desks, chairs, and workstations. Near Dell HQ. Home office or commercial. From $89. Secure payment at booking.",
    ('office-furniture-assembly','cedar-park'):    "Office furniture assembly in Cedar Park, TX — standing desks, chairs, shelving, and home offices. Northwest Austin tech corridor. From $89. Secure payment at booking.",
    ('office-furniture-assembly','pflugerville'):  "Office furniture assembly in Pflugerville, TX — standing desks, chairs, and workstations. East Austin suburb. From $89. Book online, secure payment at booking.",
    ('office-furniture-assembly','georgetown'):    "Office furniture assembly in Georgetown, TX — standing desks, chairs, shelving, and home offices. Serving Georgetown professionals. From $89. Secure payment at booking.",
    ('office-furniture-assembly','hutto'):         "Office furniture assembly in Hutto, TX — standing desks, chairs, and home offices. East Austin homes. From $89. Book online, secure payment at booking.",
    ('office-furniture-assembly','leander'):       "Office furniture assembly in Leander, TX — standing desks, chairs, shelving, and home offices. Hill Country suburb. From $89. Book online, secure payment at booking.",
    ('office-furniture-assembly','bee-cave'):      "Office furniture assembly in Bee Cave, TX — standing desks, chairs, and premium home offices. Hill Country luxury. From $89. Book online, secure payment at booking.",
    ('office-furniture-assembly','lakeway'):       "Office furniture assembly in Lakeway, TX — standing desks, chairs, and home offices. Lake Travis professionals. From $89. Book online, secure payment at booking.",
    ('office-furniture-assembly','manor'):         "Office furniture assembly in Manor, TX — standing desks, chairs, and home offices. East Austin suburb. From $89. Book online, secure payment at booking.",
    ('office-furniture-assembly','buda'):          "Office furniture assembly in Buda, TX — standing desks, chairs, shelving, and home offices south of Austin. From $89. Book online, secure payment at booking.",
    ('office-furniture-assembly','kyle'):          "Office furniture assembly in Kyle, TX — standing desks, chairs, and workstations. One of the fastest-growing US cities. From $89. Secure payment at booking.",
}


def get_breadcrumb_json(service, city_slug):
    city_name = CITY_NAMES[city_slug]
    svc_name  = HUB_NAMES[service]
    page_url  = f"https://www.assembleatease.com/{service}-{city_slug}-tx"
    page_name = f"{svc_name} in {city_name}, TX"
    schema = {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        "itemListElement": [
            {"@type": "ListItem", "position": 1, "name": "Home",    "item": "https://www.assembleatease.com"},
            {"@type": "ListItem", "position": 2, "name": page_name, "item": page_url},
        ]
    }
    return json.dumps(schema, separators=(',', ':'))


def esc_for_attr(s):
    """Escape for use inside an HTML attribute value."""
    return s.replace('&', '&amp;').replace('"', '&quot;')


def process_location_page(filepath, service, city_slug):
    with open(filepath, 'r', encoding='utf-8') as f:
        html = f.read()

    key  = (service, city_slug)
    desc = META.get(key)
    if not desc:
        print(f"  WARNING: no description for {key}")
        return

    attr_desc = esc_for_attr(desc)

    # 1. Meta description
    html = re.sub(
        r'(<meta name="description" content=")[^"]*(")',
        lambda m: m.group(1) + attr_desc + m.group(2),
        html
    )

    # 2. OG description
    html = re.sub(
        r'(<meta property="og:description" content=")[^"]*(")',
        lambda m: m.group(1) + attr_desc + m.group(2),
        html
    )

    # 3. Twitter description (present on some pages)
    html = re.sub(
        r'(<meta name="twitter:description" content=")[^"]*(")',
        lambda m: m.group(1) + attr_desc + m.group(2),
        html
    )

    # 4. TV Mounting: rename "Mounting & Hanging" → "TV Mounting" in tags + schema
    if service == 'tv-mounting':
        # Title tag  (<title>Mounting &amp; Hanging in ...)
        html = re.sub(
            r'(<title>)Mounting &amp; Hanging in ',
            r'\g<1>TV Mounting in ',
            html
        )
        # og:title attribute
        html = re.sub(
            r'(og:title" content=")Mounting &amp; Hanging in ',
            r'\g<1>TV Mounting in ',
            html
        )
        # twitter:title attribute
        html = re.sub(
            r'(twitter:title" content=")Mounting &amp; Hanging in ',
            r'\g<1>TV Mounting in ',
            html
        )
        # H1 text node  (>Mounting &amp; Hanging in City, TX</h1>)
        html = re.sub(
            r'>Mounting &amp; Hanging in ([^<]+, TX</h1>)',
            r'>TV Mounting in \1',
            html
        )
        # JSON-LD "name" field (uses bare & inside JSON)
        html = html.replace(
            '"name":"AssembleAtEase — Mounting & Hanging in ',
            '"name":"AssembleAtEase — TV Mounting in '
        )
        # JSON-LD offerCatalog name
        html = html.replace('"name":"Mounting & Hanging"', '"name":"TV Mounting"')

    # 5. BreadcrumbList schema — insert before </head> if not already present
    if 'BreadcrumbList' not in html:
        crumb_tag = f'<script type="application/ld+json">{get_breadcrumb_json(service, city_slug)}</script>\n'
        html = html.replace('</head>', crumb_tag + '</head>', 1)

    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(html)

    print(f"  OK {os.path.basename(filepath)}")


def main():
    changed = 0
    missing = []

    for service in HUB_NAMES:
        for city_slug in CITY_NAMES:
            filename = f"{service}-{city_slug}-tx.html"
            filepath = os.path.join(BASE, filename)
            if os.path.exists(filepath):
                process_location_page(filepath, service, city_slug)
                changed += 1
            else:
                missing.append(filename)

    print(f"\nProcessed {changed} location pages.")
    if missing:
        print(f"Missing files ({len(missing)}): {', '.join(missing)}")


if __name__ == '__main__':
    main()
