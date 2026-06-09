#!/usr/bin/env python3
# Truth pass: remove false "background-checked" / "licensed and insured" / "vetted" claims.
# Owner confirmed: NO insurance, NO background checks yet. Stripe Identity verification IS in
# place and is required before owner approval -> "identity-verified" is truthful.
import os, glob

os.chdir(r"c:/Users/tgbiz/Handyman-marketplace")

# Global exact-string replacements applied to every HTML file
GLOBAL = [
    # location pages + furniture hub
    ("a verified, background-checked Easer", "an identity-verified Pro"),
    ("verified, background-checked Easer",  "identity-verified Pro"),
    # blog CTA boxes (repeated across ~15 posts)
    ("Licensed and insured pros in Austin.", "Trusted local pros in Austin."),
    # blog CTA boxes variant
    ("Vetted professionals.", "Identity-verified pros."),
    # homepage meta + og
    ("Background-checked pros, transparent pricing", "Identity-verified pros, transparent pricing"),
    # home-repairs blog inline
    ("Flat-rate pricing, background-checked pros, and a workmanship guarantee.",
     "Flat-rate pricing, identity-verified pros, and quality work."),
]

# Per-file targeted rewrites (false insurance/background claims in body copy)
TARGETED = {
    "about.html": [
        (">Vetted pros<", ">Identity-verified pros<"),
        ("Licensed and insured for every job. You're protected, and so is your home, from the moment we walk in.",
         "You don't pay until the work is finished. Your card is only charged after the job is complete and done right."),
        ("Every pro is vetted before their first job. We only work with people we&rsquo;d trust in our own home.",
         "Every pro is identity-verified and personally reviewed before their first job. We only work with people we&rsquo;d trust in our own home."),
    ],
    "blog/best-furniture-assembly-austin.html": [
        ("Technicians are background-checked, insured, and trained on dozens of furniture brands.",
         "Technicians are identity-verified, experienced, and trained on dozens of furniture brands."),
        ("we built our Austin service around exactly the standards described above &mdash; licensed, insured, background-checked, and backed by a workmanship guarantee on every job.",
         "we built our Austin service around clear upfront pricing, identity-verified pros, and a focus on getting every job done right."),
    ],
    "blog/ikea-assembly-cost-austin.html": [
        ("<strong>Licensed and insured.</strong> Every job is covered by general liability insurance, so your floors, walls, and furniture are protected.",
         "<strong>Upfront, flat-rate pricing.</strong> You see the price before you book &mdash; no hourly surprises and no hidden fees."),
    ],
}

changed = []

# Apply global replacements
for fpath in glob.glob("*.html") + glob.glob("blog/*.html"):
    html = open(fpath, "r", encoding="utf-8").read()
    orig = html
    for old, new in GLOBAL:
        html = html.replace(old, new)
    if html != orig:
        open(fpath, "w", encoding="utf-8").write(html)
        changed.append(fpath)

# Apply targeted replacements
for fpath, edits in TARGETED.items():
    if not os.path.exists(fpath):
        print("MISSING:", fpath); continue
    html = open(fpath, "r", encoding="utf-8").read()
    orig = html
    for old, new in edits:
        if old not in html:
            print(f"  WARN not found in {fpath}: {old[:60]}")
        html = html.replace(old, new)
    if html != orig:
        open(fpath, "w", encoding="utf-8").write(html)
        if fpath not in changed:
            changed.append(fpath)

print(f"\nChanged {len(changed)} files.")
