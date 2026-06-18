// One-shot: remove "we provide/bring/supply mounts or hardware" claims from the
// existing old-layout pages (TV + playset city pages, gazebo, trampoline).
// Policy: pros bring TOOLS only; customer provides mounts/hardware/anchors or
// coordinates with the pro. Exact-string replacements, idempotent.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';

const PAIRS = [
  // TV city pages
  [
    `We can supply TV mount hardware for $39, or we'll use yours — your choice at booking.`,
    `You provide the TV mount and hardware &mdash; our pros bring the tools and handle the install. Not sure what fits your TV and wall? Message your pro after booking and they'll help you choose.`,
  ],
  // Playset city pages
  [
    `Yes — anchoring, leveling, and safety hardware can be added during booking when the kit or ground conditions require it.`,
    `Yes &mdash; we anchor and level the set to the manufacturer's spec and check stability before anyone plays. If your kit or ground needs extra anchoring, just coordinate with your pro.`,
  ],
  // Gazebo (austin)
  [
    `Yes &mdash; we anchor all gazebos and pergolas per manufacturer specifications. Ground anchoring hardware is included in the assembly price for standard grass or concrete surfaces.`,
    `Yes &mdash; we anchor all gazebos and pergolas per manufacturer specifications. Have your anchoring hardware ready for your surface, or coordinate with your pro on what&rsquo;s needed.`,
  ],
  [
    `Yes &mdash; we anchor to both grass and concrete or pavers. Just let us know your surface type at booking so we bring the right hardware.`,
    `Yes &mdash; we anchor to grass, concrete or pavers. Let us know your surface type at booking so your pro comes prepared, and have your anchoring hardware on hand.`,
  ],
  // Trampoline (austin)
  [
    `Yes &mdash; we install ground anchor kits to keep the trampoline in place during Texas wind and storms. Let us know at booking and we'll bring the right anchors.`,
    `Yes &mdash; we install ground anchor kits to keep the trampoline secure in Texas wind. Have your anchor kit ready (or coordinate with your pro) and let us know at booking.`,
  ],
];

let totalFiles = 0;
let totalReplacements = 0;
for (const file of readdirSync('.').filter((n) => n.endsWith('.html'))) {
  let html = readFileSync(file, 'utf8');
  let changed = 0;
  for (const [find, repl] of PAIRS) {
    if (html.includes(find)) {
      const before = html;
      html = html.split(find).join(repl);
      if (html !== before) changed += 1;
    }
  }
  if (changed) {
    writeFileSync(file, html);
    totalFiles += 1;
    totalReplacements += changed;
    console.log(`fixed ${file} (${changed})`);
  }
}
console.log(`Done: ${totalReplacements} replacements across ${totalFiles} files.`);
