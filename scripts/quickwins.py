#!/usr/bin/env python3
# Quick-win cleanup pass: 4.9->5.0, Mounting&Hanging display->TV Mounting, de-list discontinued blogs.
import glob, os, re

os.chdir(r"c:/Users/tgbiz/Handyman-marketplace")

# ── 1. Location pages: rating 4.9 -> 5.0 (match schema + real Google rating) ──
loc_globs = ["furniture-assembly-*.html","tv-mounting-*.html","smart-home-installation-*.html",
             "fitness-equipment-assembly-*.html","playset-assembly-*.html","office-furniture-assembly-*.html",
             "ikea-assembly-austin-tx.html","gazebo-assembly-austin-tx.html","trampoline-assembly-austin-tx.html"]
loc_files = sorted(set(f for g in loc_globs for f in glob.glob(g)))
n_rating = 0
for f in loc_files:
    h = open(f, encoding="utf-8").read()
    o = h
    h = h.replace(">4.9</strong>", ">5.0</strong>").replace(">4.9</str", ">5.0</str")
    h = h.replace("4.9 star rating", "5.0 star rating").replace("4.9-star", "5.0-star")
    if h != o:
        open(f, "w", encoding="utf-8").write(h); n_rating += 1
print(f"1. rating 4.9->5.0 updated in {n_rating} location pages")

# ── 2. index.html: "Mounting & Hanging" DISPLAY -> "TV Mounting" (keep booking URL param) ──
h = open("index.html", encoding="utf-8").read()
reps = [
    ("&bull; Mounting &amp; Hanging</div>", "&bull; TV Mounting</div>"),         # nav logo sub
    ('<span class="svc-item-name">Mounting &amp; Hanging</span>', '<span class="svc-item-name">TV Mounting</span>'),
    ('<div class="svc5-name">Mounting &amp; Hanging</div>', '<div class="svc5-name">TV Mounting</div>'),
    (">Mounting &amp; Hanging</a>", ">TV Mounting</a>"),                          # footer link TEXT (href untouched)
    ('"Furniture Assembly","Mounting & Hanging","Smart Home Installation"', '"Furniture Assembly","TV Mounting","Smart Home Installation"'),  # schema serviceType
]
miss = []
for old, new in reps:
    if old not in h: miss.append(old[:40])
    h = h.replace(old, new)
open("index.html", "w", encoding="utf-8").write(h)
print(f"2. index.html Mounting&Hanging->TV Mounting. missing: {miss if miss else 'none'}")
# Safety: confirm the booking URL param was NOT altered
assert "/book?service=Mounting+%26+Hanging" in h, "ERROR: booking URL param was changed!"
print("   booking URL param intact: OK")

# ── 3. Remove discontinued blogs from blog/index.html listing ──
bi = open("blog/index.html", encoding="utf-8").read()
for slug in ["junk-removal-cost-austin", "home-repairs-diy-vs-hire-austin"]:
    # remove the whole <a ... class="blog-card"> ... </a> card for this slug
    pat = re.compile(r'\s*<a href="/blog/' + re.escape(slug) + r'"[^>]*class="blog-card">.*?</a>', re.DOTALL)
    bi2 = pat.sub("", bi)
    print(f"3. blog index card removed for {slug}: {'yes' if bi2 != bi else 'NOT FOUND'}")
    bi = bi2
open("blog/index.html", "w", encoding="utf-8").write(bi)

# ── 4. Remove discontinued blogs from sitemap.xml ──
sm = open("sitemap.xml", encoding="utf-8").read()
for slug in ["junk-removal-cost-austin", "home-repairs-diy-vs-hire-austin"]:
    pat = re.compile(r'\s*<url><loc>https://www\.assembleatease\.com/blog/' + re.escape(slug) + r'</loc>.*?</url>', re.DOTALL)
    sm2 = pat.sub("", sm)
    print(f"4. sitemap entry removed for {slug}: {'yes' if sm2 != sm else 'NOT FOUND'}")
    sm = sm2
open("sitemap.xml", "w", encoding="utf-8").write(sm)

print("\nContent pass complete.")
