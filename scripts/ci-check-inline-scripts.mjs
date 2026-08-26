#!/usr/bin/env node
// Parse-checks the inline <script> blocks in every HTML page.
//
// The owner dashboard, the booking page and the Easer app carry their JavaScript
// inline, so `node --check` never sees it. A malformed string literal in
// owner/index.html therefore reached production undetected — the whole dashboard
// script block fails to parse, which is a blank or half-dead page for the owner
// with no build step anywhere to catch it.
//
// This extracts each inline block and parses it exactly as the browser would.

import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const ROOT = process.cwd();
const SKIP_DIRS = new Set(['node_modules', '.git', '_prev_', '__pycache__', '_local_artifacts', '.github']);

function htmlFiles(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let s; try { s = statSync(full); } catch { continue; }
    if (s.isDirectory()) htmlFiles(full, out);
    else if (entry.endsWith('.html')) out.push(full);
  }
  return out;
}

const work = await mkdtemp(join(tmpdir(), 'aae-inline-'));
const failures = [];
let blocks = 0;
let pages = 0;

try {
  for (const file of htmlFiles(ROOT)) {
    const html = await readFile(file, 'utf8');
    // Inline blocks only — a src= tag has no body to parse here.
    const matches = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
    if (!matches.length) continue;
    let pageCounted = false;

    for (let i = 0; i < matches.length; i++) {
      const body = matches[i][1];
      if (!body.trim()) continue;
      // JSON-LD and templates are not JavaScript.
      const openTag = matches[i][0].slice(0, matches[i][0].indexOf('>') + 1);
      if (/type\s*=\s*["'](?!text\/javascript|application\/javascript|module)/i.test(openTag)) continue;

      blocks++;
      if (!pageCounted) { pages++; pageCounted = true; }
      // `<\/` inside a JS string is how a page escapes a closing tag; the browser
      // sees `</`, so parse it that way.
      const source = body.replace(/<\\\//g, '</');
      const tmp = join(work, `b${blocks}.${/type\s*=\s*["']module["']/i.test(openTag) ? 'mjs' : 'js'}`);
      await writeFile(tmp, source, 'utf8');
      try {
        execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
      } catch (err) {
        const detail = String(err.stderr || err.message || '')
          .split('\n')
          .filter(l => l.trim() && !l.includes(tmp))
          .slice(0, 4)
          .join('\n    ');
        failures.push(`${relative(ROOT, file).replace(/\\/g, '/')} (inline block #${i + 1})\n    ${detail}`);
      }
    }
  }
} finally {
  await rm(work, { recursive: true, force: true });
}

if (failures.length) {
  console.error('\nINLINE SCRIPT SYNTAX FAILURES\n');
  for (const f of failures) console.error('  ' + f + '\n');
  console.error('These pages carry their JavaScript inline, so a parse error takes out the');
  console.error('entire block — a blank or half-dead page in production.\n');
  process.exit(1);
}

console.log(`Inline script syntax: PASS — ${blocks} block(s) across ${pages} page(s) parse cleanly.`);
