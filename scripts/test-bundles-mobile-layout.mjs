#!/usr/bin/env node

/**
 * /bundles must not fall apart on a phone.
 *
 * WHY THIS EXISTS
 * bundles.html predates the governed .section-header and uses its own bn-* CSS,
 * so nothing sitewide covers it. Two separate mobile defects were reported from
 * a phone within days of each other:
 *
 *   1. Every heading sat left-aligned while the rest of the site centres, so the
 *      page read as if it belonged to a different product.
 *   2. .bn-steps was the one grid with no mobile override. Its base rule,
 *      repeat(auto-fit,minmax(170px,1fr)), resolves to TWO columns on a phone —
 *      and there are exactly five steps, so the fifth was always stranded alone
 *      on its own row.
 *
 * The second was still there after the first was fixed, because the first fix
 * looked at headings and not at grids. This guards the CLASS: every multi-column
 * grid on the page must say what it does on a phone.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const html = await fs.readFile(new URL('../bundles.html', import.meta.url), 'utf8');

const MOBILE = /@media\(max-width:720px\)\{([\s\S]*?)\}\s*@media/;
const mobileBlock = html.match(MOBILE)?.[1];
assert.ok(mobileBlock, 'bundles.html must keep a max-width:720px block');

// ── Every multi-column grid collapses on a phone ───────────────────────────
{
  // Base rules that declare more than one column.
  const multiCol = [...html.matchAll(/\.(bn-[a-z-]+)\{[^}]*grid-template-columns:\s*([^;}]+)/g)]
    .filter(([, , cols]) => /repeat\(|minmax\([^)]*\)\s+minmax\(/.test(cols) && !/repeat\(1,/.test(cols))
    .map(([, cls]) => cls);

  const unique = [...new Set(multiCol)];
  assert.ok(unique.length >= 3, `expected several grids on this page, found ${unique.length}`);

  const uncovered = unique.filter(cls => {
    // Covered if any mobile breakpoint restates its columns.
    const in720 = new RegExp(`\\.${cls}\\{[^}]*grid-template-columns`).test(mobileBlock);
    const in920 = new RegExp(`@media\\(max-width:920px\\)\\{[^@]*\\.${cls}\\{[^}]*grid-template-columns:\\s*1fr`).test(html);
    return !in720 && !in920;
  });

  assert.deepEqual(uncovered, [],
    `every multi-column grid must say what it does on a phone; uncovered: ${uncovered.join(', ')}`);
  console.log(`PASS all ${unique.length} multi-column grids declare a mobile layout`);
}

// ── Five steps must never render two-across ────────────────────────────────
// Any even-column layout strands the fifth card. This is the specific defect.
{
  const steps = (html.match(/class="bn-step"/g) || []).length;
  assert.ok(steps > 0, 'the How it works steps must exist');
  assert.ok(/\.bn-steps\{grid-template-columns:1fr\}/.test(mobileBlock),
    `there are ${steps} steps; on a phone they must stack in one column or the last one is stranded`);
  console.log(`PASS ${steps} steps stack in a single column on a phone`);
}

// ── Headings centre, body copy does not ────────────────────────────────────
{
  for (const cls of ['bn-sec-title', 'bn-hero-copy']) {
    assert.ok(new RegExp(`\\.${cls}\\{[^}]*text-align:center`).test(mobileBlock),
      `.${cls} must centre on mobile to match the governed .section-header`);
  }
  // Card and FAQ prose stays left: centred multi-line body copy is harder to
  // read, which is why .section-header centres the heading and never the card.
  for (const cls of ['bn-step', 'bn-card', 'bn-faq']) {
    assert.ok(!new RegExp(`\\.${cls}\\{[^}]*text-align:center`).test(mobileBlock),
      `.${cls} is body copy and must stay left-aligned`);
  }
  console.log('PASS headings centre on mobile, card and FAQ prose stays left');
}

// ── Desktop is untouched ───────────────────────────────────────────────────
// The hero is a two-column grid with the photo beside the copy; left-aligned
// copy is correct there, so the centring must live only in the media query.
{
  const base = html.slice(0, html.indexOf('@media'));
  assert.ok(!/\.bn-hero-copy\{[^}]*text-align:center/.test(base),
    'hero centring must not leak into the desktop base rules');
  assert.ok(/\.bn-steps\{display:grid;grid-template-columns:repeat\(auto-fit/.test(base),
    'the desktop multi-column step layout must remain');
  console.log('PASS desktop keeps its two-column hero and multi-column steps');
}

console.log('\nBundles mobile layout tests passed.');
