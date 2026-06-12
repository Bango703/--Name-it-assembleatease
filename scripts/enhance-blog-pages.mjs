// Make the short Guides feel finished without breaking the 2-paragraph rule:
//  - a compact "Good to know" chip row (true, no overpromising) before the booking CTA
//  - a "Keep reading" related-guides strip after the article (internal funnel)
// Idempotent: skips a file that already has .article-facts.
import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';

const blogDir = join(process.cwd(), 'blog');

// slug -> [title, category]
const META = {
  'bed-frame-assembly-austin': ['Bed Frame Assembly in Austin TX', 'furniture'],
  'best-furniture-assembly-austin': ['Best Furniture Assembly Service in Austin', 'furniture'],
  'crate-and-barrel-furniture-assembly-austin': ['Crate & Barrel Assembly Cost in Austin', 'furniture'],
  'garage-shelving-installation-austin': ['Garage Shelving Installation Cost in Austin', 'storage'],
  'ikea-assembly-cost-austin': ['IKEA Assembly Cost in Austin', 'furniture'],
  'ikea-pax-wardrobe-assembly': ['IKEA PAX Wardrobe Assembly', 'furniture'],
  'new-home-setup-checklist-austin': ['New Home Setup Checklist for Austin Movers', 'movein'],
  'outdoor-tv-installation-austin-texas': ['Outdoor TV Installation Cost in Austin', 'tv'],
  'same-day-handyman-austin': ['Same-Day Handyman Service in Austin', 'fast'],
  'smart-home-installation-austin': ['Smart Home Installation in Austin', 'smart'],
  'tv-mounting-costs-austin': ['TV Mounting Costs in Austin TX', 'tv'],
  'tv-mounting-tips-austin': ['TV Mounting Tips for Austin Homes', 'tv'],
  'tv-wall-mount-installation-cost-austin': ['TV Wall Mount Installation Cost in Austin', 'tv'],
  'wayfair-furniture-assembly-austin': ['Wayfair Furniture Assembly in Austin', 'furniture'],
  'why-hire-handyman-austin': ['Why Austin Homeowners Hire Instead of DIY', 'decision'],
};

// Third chip is tailored by category (first two are universal + true).
const CHIP3 = {
  furniture: 'Any brand or piece',
  tv: 'Cords concealed on request',
  smart: 'Devices set up and tested',
  storage: 'Anchored to the wall',
  movein: 'Whole-home in one visit',
  fast: 'Flexible scheduling',
  decision: 'Book online in minutes',
};

const STAPLES = [
  'new-home-setup-checklist-austin',
  'why-hire-handyman-austin',
  'tv-mounting-costs-austin',
  'ikea-assembly-cost-austin',
  'smart-home-installation-austin',
];

function related(slug) {
  const cat = META[slug][1];
  const picks = [];
  for (const s of Object.keys(META)) {
    if (s !== slug && META[s][1] === cat && picks.length < 2) picks.push(s);
  }
  for (const s of STAPLES) {
    if (s !== slug && !picks.includes(s) && picks.length < 3) picks.push(s);
  }
  return picks.slice(0, 3);
}

function chipsHtml(slug) {
  const third = CHIP3[META[slug][1]] || 'Book online in minutes';
  return `    <div class="article-facts">
      <span class="article-fact">Upfront pricing</span>
      <span class="article-fact">Austin + nearby suburbs</span>
      <span class="article-fact">${third}</span>
    </div>
`;
}

function relatedHtml(slug) {
  const links = related(slug)
    .map((s) => `      <a class="related-link" href="/blog/${s}"><span>${META[s][0]}</span><span>&rarr;</span></a>`)
    .join('\n');
  return `
  <section class="article-related">
    <p class="article-related-title">Keep reading</p>
    <div class="related-strip">
${links}
    </div>
  </section>`;
}

let changed = 0;
for (const file of readdirSync(blogDir)) {
  if (!file.endsWith('.html') || file === 'index.html') continue;
  const slug = file.replace(/\.html$/, '');
  if (!META[slug]) { console.log('skip (no meta):', slug); continue; }
  const path = join(blogDir, file);
  let html = readFileSync(path, 'utf8');
  if (html.includes('article-facts')) { console.log('skip (already done):', slug); continue; }

  // 1) chips before the booking CTA
  const ctaMarker = '    <div class="article-cta">';
  if (!html.includes(ctaMarker)) { console.log('skip (no cta marker):', slug); continue; }
  html = html.replace(ctaMarker, chipsHtml(slug) + ctaMarker);

  // 2) related strip right after the article closes
  html = html.replace('</article>', '</article>' + relatedHtml(slug));

  writeFileSync(path, html, 'utf8');
  changed++;
  console.log('enhanced:', slug, '-> related:', related(slug).join(', '));
}
console.log('\nDone. Files changed:', changed);
