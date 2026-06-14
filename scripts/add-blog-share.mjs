// Add a public share bar to every blog reader page so visitors can share a post.
// Uses the existing .article-share-kit styles + share INTENT links (work for any
// visitor, no business account needed). Idempotent: skips files already done.
import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';

const SITE = 'https://www.assembleatease.com';
const blogDir = join(process.cwd(), 'blog');

// slug -> share title
const TITLE = {
  'bed-frame-assembly-austin': 'Bed Frame Assembly in Austin TX',
  'best-furniture-assembly-austin': 'Best Furniture Assembly Service in Austin',
  'crate-and-barrel-furniture-assembly-austin': 'Crate and Barrel Assembly Cost in Austin',
  'garage-shelving-installation-austin': 'Garage Shelving Installation Cost in Austin',
  'ikea-assembly-cost-austin': 'IKEA Assembly Cost in Austin',
  'ikea-pax-wardrobe-assembly': 'IKEA PAX Wardrobe Assembly in Austin',
  'new-home-setup-checklist-austin': 'New Home Setup Checklist for Austin Movers',
  'outdoor-tv-installation-austin-texas': 'Outdoor TV Installation Cost in Austin',
  'same-day-handyman-austin': 'Same-Day Home Setup Help in Austin',
  'smart-home-installation-austin': 'Smart Home Installation in Austin',
  'tv-mounting-costs-austin': 'TV Mounting Costs in Austin TX',
  'tv-mounting-tips-austin': 'TV Mounting Tips for Austin Homes',
  'tv-wall-mount-installation-cost-austin': 'TV Wall Mount Installation Cost in Austin',
  'wayfair-furniture-assembly-austin': 'Wayfair Furniture Assembly in Austin',
  'why-hire-handyman-austin': 'Why Austin Homeowners Hire Instead of DIY',
};

function shareHtml(slug, title) {
  const url = `${SITE}/blog/${slug}`;
  const u = encodeURIComponent(url);
  const t = encodeURIComponent(title);
  // & must be &amp; inside an HTML attribute
  const x = `https://twitter.com/intent/tweet?url=${u}&amp;text=${t}`;
  return `
  <section class="article-share-kit">
    <div class="article-share-inner">
      <div class="article-share-copy">
        <strong>Know someone setting up a place in Austin?</strong>
        <span>Share this blog &mdash; it might save them a weekend.</span>
      </div>
      <div class="article-share-actions">
        <a href="https://www.facebook.com/sharer/sharer.php?u=${u}" target="_blank" rel="noopener" aria-label="Share on Facebook">Facebook</a>
        <a href="https://www.linkedin.com/sharing/share-offsite/?url=${u}" target="_blank" rel="noopener" aria-label="Share on LinkedIn">LinkedIn</a>
        <a href="${x}" target="_blank" rel="noopener" aria-label="Share on X">X</a>
        <a href="#" data-url="${url}" onclick="if(navigator.clipboard){navigator.clipboard.writeText(this.getAttribute('data-url'));this.textContent='Link copied';}return false;" aria-label="Copy link">Copy link</a>
      </div>
    </div>
  </section>`;
}

let changed = 0;
for (const file of readdirSync(blogDir)) {
  if (!file.endsWith('.html') || file === 'index.html') continue;
  const slug = file.replace(/\.html$/, '');
  const title = TITLE[slug];
  if (!title) { console.log('skip (no title):', slug); continue; }
  const path = join(blogDir, file);
  let html = readFileSync(path, 'utf8');
  if (html.includes('article-share-kit')) { console.log('skip (already done):', slug); continue; }
  if (!html.includes('</article>')) { console.log('skip (no </article>):', slug); continue; }
  html = html.replace('</article>', '</article>' + shareHtml(slug, title));
  writeFileSync(path, html, 'utf8');
  changed++;
  console.log('share bar added:', slug);
}
console.log('\nDone. Files changed:', changed);
