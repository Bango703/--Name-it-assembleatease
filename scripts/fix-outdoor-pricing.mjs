// One-shot: reconcile the Outdoor & Playsets "From" price to the real catalog
// floor ($89, the cheapest selectable outdoor item) so the playset pages match
// home/book/pricing. Changes ONLY the service-floor claims — the real $169
// sandbox item price (JSON-LD offer + price card) is left untouched.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';

const PAIRS = [
  ['From $169', 'From $89'],
  ['starts at $169', 'starts at $89'],
  // flagship hero clarifier label (austin page only)
  ['sandboxes &amp; playhouses &mdash; playsets from $299', 'outdoor assembly &mdash; playsets from $299'],
];

let files = 0;
let edits = 0;
for (const f of readdirSync('.').filter((n) => /^playset-assembly-.*-tx\.html$/.test(n))) {
  let html = readFileSync(f, 'utf8');
  let n = 0;
  for (const [find, repl] of PAIRS) {
    if (html.includes(find)) { html = html.split(find).join(repl); n += 1; }
  }
  if (n) { writeFileSync(f, html); files += 1; edits += n; console.log(`fixed ${f} (${n})`); }
}
console.log(`Done: ${edits} replacements across ${files} files.`);
