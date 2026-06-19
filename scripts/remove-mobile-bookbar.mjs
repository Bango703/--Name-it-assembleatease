// Remove the hovering mobile "Book" sticky bar (#m-svc-bar) from all service/city
// landing pages — it duplicates the hero CTA (two book buttons on mobile). Also
// drops the 80px mobile footer pad that only existed to clear the bar.
// Display-only change; leaves the now-unused #m-svc-bar CSS (harmless, targets nothing).
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';

let files = 0;
let removed = 0;
for (const f of readdirSync('.').filter((n) => /-tx\.html$/.test(n))) {
  let html = readFileSync(f, 'utf8');
  const before = html;
  // remove the sticky bar element (one per page; href/text varies by service)
  html = html.replace(/<div id="m-svc-bar">[\s\S]*?<\/div>\s*/, '');
  // restore normal mobile footer padding (was bumped to 80px to clear the bar)
  html = html.split('padding-bottom:calc(80px + env(safe-area-inset-bottom,0px))')
             .join('padding-bottom:calc(2rem + env(safe-area-inset-bottom,0px))');
  if (html !== before) { writeFileSync(f, html); files += 1; removed += 1; console.log(`fixed ${f}`); }
}
console.log(`Done: ${removed} pages updated.`);
