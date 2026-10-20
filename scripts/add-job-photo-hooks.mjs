#!/usr/bin/env node
// Marks the "Recent work" gallery on every service/city page so
// assets/js/job-photos.js can show the owner's published job photos there.
// Idempotent: run again after pages are regenerated.
//
// The location generator is not the source of truth for these pages (they
// carry a later layout the generator does not produce), so this edits the
// committed pages in place rather than regenerating them.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { ALL_TEXAS_CITIES } from './lib/texas-cities.mjs';

export const PHOTO_PAGE_SERVICES = [
  'furniture-assembly', 'tv-mounting', 'smart-home-installation',
  'fitness-equipment-assembly', 'office-furniture-assembly', 'playset-assembly',
];
const SCRIPT_TAG = '<script src="/assets/js/job-photos.js" defer></script>';

const esc = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

let changed = 0;
let missing = 0;
for (const city of ALL_TEXAS_CITIES) {
  for (const service of PHOTO_PAGE_SERVICES) {
    const file = `${service}-${city.slug}-tx.html`;
    if (!existsSync(file)) continue;
    let html = readFileSync(file, 'utf8');
    const before = html;
    const hook = `<div class="fa-gallery" data-job-photos="${service}" data-job-city="${city.slug}" data-job-city-name="${esc(city.name)}">`;
    html = html.replace(/<div class="fa-gallery"(?: data-job-photos="[^"]*" data-job-city="[^"]*" data-job-city-name="[^"]*")?>/, hook);
    // A page with no built-in photos (fitness) gets an empty grid that stays
    // hidden (inline: .fa-gallery sets display:grid, which beats [hidden])
    // until job-photos.js has published photos to put in it.
    const hiddenHook = hook.replace(/>$/, ' style="display:none"></div>');
    if (!html.includes(hook) && !html.includes(hiddenHook)) {
      const work = html.indexOf('<!-- OUR WORK -->');
      const note = work >= 0 ? html.indexOf('<div class="fa-note">', work) : -1;
      const noteEnd = note >= 0 ? html.indexOf('</div>', html.indexOf('</p>', note)) + '</div>'.length : -1;
      if (noteEnd > 0) html = html.slice(0, noteEnd) + '\n    ' + hiddenHook + html.slice(noteEnd);
    }
    if (!html.includes(hook) && !html.includes(hiddenHook)) { missing++; console.error(`no gallery in ${file}`); continue; }
    if (!html.includes(SCRIPT_TAG)) {
      html = html.replace('<script src="/assets/js/mobile-nav.js" defer></script>', `<script src="/assets/js/mobile-nav.js" defer></script>\n${SCRIPT_TAG}`);
    }
    if (!html.includes(SCRIPT_TAG)) { missing++; console.error(`no script anchor in ${file}`); continue; }
    if (html !== before) { writeFileSync(file, html); changed++; }
  }
}
console.log(`Job photo hooks: ${changed} page(s) updated${missing ? `, ${missing} page(s) could not be updated` : ''}.`);
if (missing) process.exit(1);
