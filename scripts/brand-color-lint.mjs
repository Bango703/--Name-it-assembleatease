#!/usr/bin/env node
// Brand & Design-System guard — owns the single brand-blue source of truth.
//
// Brand color is SKY BLUE #00BFFF (dark #0099CC). See CLAUDE.md "Brand & Design-System
// Engineer" seat + memory feedback_brand_color. This lint prevents the color drift that
// keeps recurring (e.g. the #5eead4 teal hero, the #0094C6 wrong fallback).
//
//   HARD FAIL (breaks --strict / launch suite):
//     1. A brand token (--cyan/--cyan-dark/--accent/--teal/--teal-dark) redefined to a
//        color OUTSIDE the brand blue hue band. This is what "drift" actually is: a brand
//        token quietly turned teal-GREEN (the #5eead4 hero, hue ~168) or grey/green.
//        Accessible dark-blue variants (e.g. book.html's #0077a8 accent, hue ~193, chosen
//        so accent text passes WCAG AA on white) are legitimately on-brand and allowed —
//        we never trade booking-page readability for an exact-hex match.
//     2. Reappearance of a retired off-brand hex (#0094c6) anywhere.
//
//   WARNING (informational inventory, does NOT fail): non-canonical brand-blue-band hexes
//     in the Easer/owner app shell — the tracked, larger re-skin follow-up.
//
// Run: node scripts/brand-color-lint.mjs [--strict]

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const strict = process.argv.includes('--strict');

// Brand tokens must stay in the BLUE hue band. The band rejects teal-green (hue < 185,
// the #5eead4 drift), greys, and greens, while allowing every legitimate accessible blue
// variant (#00BFFF hue195, #0099CC hue195, #0077a8 hue193). Saturation floor rejects greys.
const BRAND_TOKENS = new Set(['--cyan', '--cyan-dark', '--accent', '--teal', '--teal-dark', '--teal-light']);
const BLUE_HUE_MIN = 186;
const BLUE_HUE_MAX = 212;
const BRAND_SAT_MIN = 0.25; // token must be a real blue, not a near-grey
// --teal-light is a pale tint (low saturation by design) — exempt from the saturation floor.
const TINT_TOKENS = new Set(['--teal-light', '--cyan-light', '--cyan-mid']);
// Canonical brand blues + approved tints (uppercase).
const CANON = new Set(['#00BFFF', '#0099CC', '#8FE8FF', '#E0F7FA', '#B2EBF2', '#E0F7FA']);
// Hexes we deliberately retired — must never come back.
const RETIRED = ['#0094c6'];

function walk(dir, exts, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'scratchpad', '__pycache__'].includes(e.name) || e.name.startsWith('_')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, exts, acc);
    else if (exts.some((x) => e.name.endsWith(x))) acc.push(p);
  }
  return acc;
}

function hueSat(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  let s = 0, hue = 0;
  if (mx !== mn) {
    const d = mx - mn;
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    if (mx === r) hue = (g - b) / d + (g < b ? 6 : 0);
    else if (mx === g) hue = (b - r) / d + 2;
    else hue = (r - g) / d + 4;
    hue *= 60;
  }
  return { h: Math.round(hue), s: +s.toFixed(2), l: +l.toFixed(2) };
}

const files = walk(ROOT, ['.css', '.html']);
const hardFails = [];
const appBlueInventory = new Map(); // hex -> count (warning only)

const tokenRe = /(--(?:cyan(?:-dark|-light|-mid)?|accent|teal(?:-dark|-light)?))\s*:\s*(#[0-9a-fA-F]{3,6})/g;
const hexRe = /#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g;

for (const file of files) {
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  const txt = fs.readFileSync(file, 'utf8');

  // Rule 1 — brand tokens must stay in the blue hue band (reject teal-green / grey drift).
  for (const m of txt.matchAll(tokenRe)) {
    const token = m[1];
    if (!BRAND_TOKENS.has(token)) continue;
    const { h, s } = hueSat(m[2]);
    const outOfBand = h < BLUE_HUE_MIN || h > BLUE_HUE_MAX;
    const tooGrey = !TINT_TOKENS.has(token) && s < BRAND_SAT_MIN;
    if (outOfBand || tooGrey) {
      hardFails.push(`${rel}: ${token} is ${m[2]} (hue ${h}, sat ${s}) — outside the brand blue band. Teal-green/grey drift; use a sky-blue (hue ~193–195).`);
    }
  }

  // Rule 2 — retired hexes must not reappear.
  for (const dead of RETIRED) {
    if (txt.toLowerCase().includes(dead)) {
      hardFails.push(`${rel}: retired off-brand hex ${dead} reappeared — use #0099CC (--cyan-dark).`);
    }
  }

  // Warning inventory — app-shell blues in the brand-blue band that aren't canonical.
  const isApp = rel.startsWith('assembler/') || rel.startsWith('owner/') || rel.includes('/easer.css') || rel.includes('/dashboard.css');
  if (isApp) {
    for (const m of txt.matchAll(hexRe)) {
      const hex = ('#' + m[1]).toUpperCase();
      if (CANON.has(hex)) continue;
      const { h, s, l } = hueSat(hex);
      if (l > 0.9 || l < 0.06) continue; // skip near-white / near-black neutrals
      if (h >= 186 && h <= 210 && s > 0.3) appBlueInventory.set(hex, (appBlueInventory.get(hex) || 0) + 1);
    }
  }
}

console.log('=== BRAND COLOR LINT (source of truth: sky blue #00BFFF / dark #0099CC) ===');
console.log(`Scanned ${files.length} css/html files.`);

if (appBlueInventory.size) {
  const sorted = [...appBlueInventory.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`\nWARNING — ${sorted.length} non-canonical brand-blue variants in the Easer/owner app shell`);
  console.log('(tracked follow-up: unify onto brand tokens; informational, not a failure):');
  for (const [hex, n] of sorted.slice(0, 15)) console.log(`  ${hex}  x${n}`);
}

if (hardFails.length) {
  console.log(`\nFAIL — ${hardFails.length} brand-token / retired-hex violation(s):`);
  for (const f of hardFails) console.log(`  ✗ ${f}`);
  if (strict) process.exitCode = 1;
} else {
  console.log('\nPASS — brand tokens locked to sky blue, no retired hexes present.');
}
