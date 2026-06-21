"""Generate correctly-formatted favicons from the real AAE logo.

Source of truth = images/logo.jpg (the AAE monogram). We DO NOT alter the logo;
we only re-package it into valid favicon formats (a real .ico + PNGs), because the
old /favicon.ico was actually a JPEG with the wrong extension, which Google rejects
(generic globe in search results).

Run: python scripts/make-favicons.py
"""
import os
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LANCZOS = Image.Resampling.LANCZOS

src = Image.open(os.path.join(ROOT, "images", "logo.jpg")).convert("RGB")
w, h = src.size
side = min(w, h)
left = (w - side) // 2
top = (h - side) // 2
square = src.crop((left, top, left + side, top + side))


def at(size):
    return square.resize((size, size), LANCZOS)


# Real multi-resolution .ico at the web root (this is what Google probes first).
at(256).save(
    os.path.join(ROOT, "favicon.ico"),
    format="ICO",
    sizes=[(16, 16), (32, 32), (48, 48), (64, 64)],
)

# PNG raster icons (correct MIME, square, on-brand).
at(96).save(os.path.join(ROOT, "images", "favicon-96.png"), format="PNG", optimize=True)
at(180).save(os.path.join(ROOT, "images", "apple-touch-icon.png"), format="PNG", optimize=True)
at(192).save(os.path.join(ROOT, "images", "icon-192.png"), format="PNG", optimize=True)
at(512).save(os.path.join(ROOT, "images", "icon-512.png"), format="PNG", optimize=True)

print("Generated favicon.ico + images/{favicon-96,apple-touch-icon,icon-192,icon-512}.png")
