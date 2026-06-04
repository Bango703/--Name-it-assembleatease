"""Rename 'TV Mounting' -> 'Mounting & Hanging' across the codebase."""
import os
import re

ROOT = 'C:/Users/tgbiz/Handyman-marketplace'

def patch(path, replacements, label=''):
    full = os.path.join(ROOT, path)
    with open(full, 'rb') as f:
        src = f.read()
    orig = src
    for old, new in replacements:
        if isinstance(old, str):
            old = old.encode('utf-8')
        if isinstance(new, str):
            new = new.encode('utf-8')
        count = src.count(old)
        if count == 0:
            print(f'  WARN: not found in {path}: {old[:60]}')
        else:
            src = src.replace(old, new)
            print(f'  OK ({count}x): {old[:60].decode("utf-8","replace")} -> {new[:60].decode("utf-8","replace")}')
    if src != orig:
        with open(full, 'wb') as f:
            f.write(src)
        print(f'SAVED: {path}')
    else:
        print(f'NO CHANGE: {path}')

# ── 1. booking-source-of-truth.js (JS key rename) ─────────────────────────────
patch('assets/js/booking-source-of-truth.js', [
    ("'TV Mounting':", "'Mounting & Hanging':"),
])

# ── 2. book.html (CRLF, byte-level) ───────────────────────────────────────────
patch('book.html', [
    # HTML attribute — browser decodes &amp; -> & for dataset.service
    ('data-service="TV Mounting"', 'data-service="Mounting &amp; Hanging"'),
    # Display text inside svc-row-name div
    ('>TV Mounting<', '>Mounting &amp; Hanging<'),
    # SVC_FROM JS object key (JS string literal, literal & is fine)
    ("'TV Mounting':", "'Mounting & Hanging':"),
])

# ── 3. mounting.html ───────────────────────────────────────────────────────────
patch('mounting.html', [
    # Page title / OG / Twitter title
    ('TV Mounting Austin TX', 'Mounting &amp; Hanging Austin TX'),
    # CTA booking URL param
    ('?service=TV+Mounting', '?service=Mounting+%26+Hanging'),
    # CTA button text
    ('Book TV Mounting', 'Book Mounting &amp; Hanging'),
    # Footer / nav link text
    ('>TV Mounting<', '>Mounting &amp; Hanging<'),
])

# ── 4. index.html ──────────────────────────────────────────────────────────────
patch('index.html', [
    # Meta title / OG / Twitter (page is about assembly + mounting)
    ('Furniture Assembly &amp; TV Mounting', 'Furniture Assembly &amp; Mounting &amp; Hanging'),
    # Nav logo sub
    ('Furniture Assembly &bull; TV Mounting', 'Furniture Assembly &bull; Mounting &amp; Hanging'),
    # Booking URL params (3 instances)
    ('?service=TV+Mounting', '?service=Mounting+%26+Hanging'),
    # Service card / footer link text
    ('>TV Mounting<', '>Mounting &amp; Hanging<'),
    # Schema serviceType array (JSON-LD)
    ('"TV Mounting"', '"Mounting & Hanging"'),
])

# ── 5. pricing.html ────────────────────────────────────────────────────────────
patch('pricing.html', [
    ('?service=TV+Mounting', '?service=Mounting+%26+Hanging'),
    ('>TV Mounting<', '>Mounting &amp; Hanging<'),
    ('TV Mounting', 'Mounting &amp; Hanging'),
])

# ── 6. Key marketing pages — footer link text only ────────────────────────────
FOOTER_PAGES = [
    'about.html', '404.html', 'contact.html', 'business.html',
    'track.html', 'terms.html', 'privacy.html',
    'furniture.html', 'smarthome.html',
]
for page in FOOTER_PAGES:
    patch(page, [
        ('>TV Mounting<', '>Mounting &amp; Hanging<'),
        ('?service=TV+Mounting', '?service=Mounting+%26+Hanging'),
    ])

# ── 7. The 12 tv-mounting city landing pages ───────────────────────────────────
import glob
city_pages = glob.glob(os.path.join(ROOT, 'tv-mounting-*-tx.html'))
for page in city_pages:
    rel = os.path.relpath(page, ROOT)
    patch(rel, [
        ('?service=TV+Mounting', '?service=Mounting+%26+Hanging'),
        ('Book TV Mounting', 'Book Mounting &amp; Hanging'),
        ('>TV Mounting<', '>Mounting &amp; Hanging<'),
        # H1 / headings on these pages
        ('>TV Mounting in ', '>Mounting &amp; Hanging in '),
        ('TV Mounting in ', 'Mounting &amp; Hanging in '),
    ])

# ── 8. All other location pages — footer link text only ───────────────────────
other_pages = (
    glob.glob(os.path.join(ROOT, 'furniture-assembly-*-tx.html')) +
    glob.glob(os.path.join(ROOT, 'smart-home-*-tx.html')) +
    glob.glob(os.path.join(ROOT, 'fitness-equipment-*-tx.html')) +
    glob.glob(os.path.join(ROOT, 'playset-assembly-*-tx.html')) +
    glob.glob(os.path.join(ROOT, 'office-furniture-*-tx.html'))
)
for page in other_pages:
    rel = os.path.relpath(page, ROOT)
    patch(rel, [
        ('>TV Mounting<', '>Mounting &amp; Hanging<'),
    ])

# ── 9. Blog pages ─────────────────────────────────────────────────────────────
blog_pages = glob.glob(os.path.join(ROOT, 'blog', '*.html'))
for page in blog_pages:
    rel = os.path.relpath(page, ROOT)
    patch(rel, [
        ('>TV Mounting<', '>Mounting &amp; Hanging<'),
    ])

# ── 10. scripts/generate-location-pages.js ────────────────────────────────────
patch('scripts/generate-location-pages.js', [
    ("'TV Mounting'", "'Mounting & Hanging'"),
    ("TV+Mounting", "Mounting+%26+Hanging"),
    ("TV Mounting", "Mounting & Hanging"),
])

# ── 11. api/cron/auto-blog.js ─────────────────────────────────────────────────
patch('api/cron/auto-blog.js', [
    ("? 'TV Mounting'", "? 'Mounting & Hanging'"),
])

# ── 12. owner/index.html ──────────────────────────────────────────────────────
patch('owner/index.html', [
    ("'TV Mounting'", "'Mounting & Hanging'"),
    ('"TV Mounting"', '"Mounting & Hanging"'),
    ('>TV Mounting<', '>Mounting &amp; Hanging<'),
])

print('\nDone. Run verification check next.')
