#!/usr/bin/env python3
# Customer-facing "Easer" -> "Pro" rename. ROOT-LEVEL html only (customer pages):
# this naturally excludes assembler/, owner/, customer/, blog/, auth/ where "Easer"
# is the correct internal/recruiting term. Recruiting phrases ("Become an Easer",
# "network of skilled Easers", "Easer application") are left untouched.
import glob, os

os.chdir(r"c:/Users/tgbiz/Handyman-marketplace")

REPLACEMENTS = [
    ("Your Easer", "Your Pro"),
    ("your Easer", "your Pro"),
    ("our Easers", "our Pros"),
    ("the Easer marks", "the Pro marks"),
    ("verified Easer", "verified Pro"),
]

changed = []
for fpath in glob.glob("*.html"):          # root level only — not recursive
    # newline="" preserves original CRLF/LF (book.html is CRLF-sensitive)
    with open(fpath, "r", encoding="utf-8", newline="") as f:
        html = f.read()
    orig = html
    for old, new in REPLACEMENTS:
        html = html.replace(old, new)
    if html != orig:
        with open(fpath, "w", encoding="utf-8", newline="") as f:
            f.write(html)
        changed.append(fpath)

print(f"Changed {len(changed)} files:")
for c in sorted(changed):
    print(" ", c)
