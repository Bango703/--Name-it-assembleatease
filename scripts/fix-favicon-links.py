"""Standardize favicon <link> tags across every HTML page.

Old (broken) pattern linked a JPEG as an icon:
  <link rel="icon" type="image/svg+xml" href="/images/favicon.svg"/><link rel="icon" type="image/jpeg" href="/images/logo.jpg" />
  <link rel="apple-touch-icon" href="/images/logo.jpg" />

New (valid) pattern:
  <link rel="icon" href="/favicon.ico" sizes="any"/><link rel="icon" type="image/svg+xml" href="/images/favicon.svg"/>
  <link rel="apple-touch-icon" href="/images/apple-touch-icon.png" />

Byte-level so book.html's mixed encoding is preserved. Only touches <link rel="icon">
and <link rel="apple-touch-icon"> tags -- the nav <img src="/images/logo.jpg"> is untouched.
Idempotent.

Run: python scripts/fix-favicon-links.py
"""
import os
import re
import glob

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

ICO_LINK = b'<link rel="icon" href="/favicon.ico" sizes="any"/>'
APPLE_LINK = b'<link rel="apple-touch-icon" href="/images/apple-touch-icon.png" />'

re_jpeg_icon = re.compile(rb'<link rel="icon" type="image/jpeg" href="/images/logo\.jpg"\s*/?>', re.I)
re_apple = re.compile(rb'<link rel="apple-touch-icon" href="/images/logo\.jpg"\s*/?>', re.I)
re_svg_icon = re.compile(rb'<link rel="icon" type="image/svg\+xml" href="/images/favicon\.svg"\s*/?>', re.I)

changed = []
for path in glob.glob(os.path.join(ROOT, "**", "*.html"), recursive=True):
    if "node_modules" in path:
        continue
    with open(path, "rb") as fh:
        data = fh.read()
    orig = data

    data = re_jpeg_icon.sub(b"", data)
    data = re_apple.sub(APPLE_LINK, data)
    if b"/favicon.ico" not in data:
        data = re_svg_icon.sub(ICO_LINK + rb"\g<0>", data, count=1)

    if data != orig:
        with open(path, "wb") as fh:
            fh.write(data)
        changed.append(os.path.relpath(path, ROOT))

print(f"Updated {len(changed)} HTML files")
for c in changed:
    print("  ", c)
