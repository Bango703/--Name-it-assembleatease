#!/usr/bin/env node
// Every script and stylesheet a page loads from this site must exist.
//
// assembler/index.html and assembler/my-assignments.html both loaded
// /assets/js/easer-notifications.js from 2026-08-26. The <script> tag reached
// main in af37aa06; the file itself only ever existed on an unmerged branch.
// Production answered 404 for three weeks, and the Easer notification bell
// opened an empty panel with no unread count. Nothing noticed, because a
// missing deferred script is silent. This makes it loud.

import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, relative, sep, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
// Only what git tracks is what deploys. A local browser profile or scratch copy
// on disk is not part of the site and must not fail the check.
function trackedPages() {
  const out = execFileSync('git', ['ls-files', '-z', '--', '*.html'], { cwd: ROOT, encoding: 'utf8' });
  return out.split('\0').filter(Boolean).map(rel => join(ROOT, rel));
}

const REF = /<(?:script\b[^>]*\bsrc|link\b[^>]*\brel=["']?stylesheet["']?[^>]*\bhref)=["']([^"']+)["']/gi;
const missing = [];
let checked = 0;

for (const page of trackedPages()) {
  const html = readFileSync(page, 'utf8');
  for (const match of html.matchAll(REF)) {
    const raw = match[1].trim();
    if (/^(?:[a-z]+:)?\/\//i.test(raw) || /^(?:data|blob|javascript):/i.test(raw) || raw.includes('${')) continue;
    const path = raw.split(/[?#]/)[0];
    if (!path) continue;
    const target = path.startsWith('/')
      ? join(ROOT, path)
      : resolve(dirname(page), path);
    checked += 1;
    if (!existsSync(target)) {
      missing.push(`${relative(ROOT, page).split(sep).join('/')} -> ${raw}`);
    }
  }
}

if (missing.length) {
  console.error(`FAIL ${missing.length} local asset reference(s) point at files that do not exist:`);
  for (const line of missing) console.error('  ' + line);
  process.exit(1);
}
console.log(`PASS ${checked} local script/stylesheet references all resolve to real files`);
