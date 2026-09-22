// Exercise the real generator in a disposable fixture, never the working site.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const TEMP_ROOT = resolve(tmpdir());
const fixture = mkdtempSync(join(TEMP_ROOT, 'aae-sitemap-lastmod-'));
const baseUrl = 'https://www.assembleatease.com/';
const url = (slug) => `${baseUrl}${slug}`;
const parse = (xml) => {
  const entries = [...xml.matchAll(/<url>[\s\S]*?<\/url>/g)].map(([entry]) => ({
    loc: entry.match(/<loc>([^<]+)<\/loc>/)[1],
    lastmod: entry.match(/<lastmod>([^<]+)<\/lastmod>/)?.[1] || null,
    entry,
  }));
  assert.equal(new Set(entries.map((entry) => entry.loc)).size, entries.length, 'Duplicate sitemap URLs');
  return new Map(entries.map((entry) => [entry.loc, entry]));
};

try {
  const inputs = [
    'scripts/generate-location-pages.js',
    'scripts/lib/public-consent.mjs',
    'scripts/lib/public-footer.mjs',
    'scripts/lib/public-nav.mjs',
    'scripts/lib/site-governance.mjs',
    'business-artifacts/page-governance/site-governance.json',
    'locations.html',
  ];
  for (const file of inputs) {
    mkdirSync(dirname(join(fixture, file)), { recursive: true });
    copyFileSync(join(ROOT, file), join(fixture, file));
  }
  writeFileSync(join(fixture, 'package.json'), '{"type":"module"}\n');
  const original = readFileSync(join(ROOT, 'sitemap.xml'), 'utf8');
  const originalEntries = parse(original);
  const dates = new Map([
    [url('furniture-assembly-austin-tx'), '2026-09-05'],
    [url('furniture-assembly-dallas-tx'), '2026-09-06T14:30:00-05:00'],
    [url('furniture-assembly-houston-tx'), null],
    [url('furniture-assembly-san-antonio-tx'), '2026-02-30'],
  ]);
  const newUrl = url('furniture-assembly-lubbock-tx');
  assert.ok(originalEntries.has(newUrl), 'Fixture needs the existing Lubbock service URL');
  const input = original.replace(/<url>[\s\S]*?<\/url>/g, (entry) => {
    const loc = entry.match(/<loc>([^<]+)<\/loc>/)[1];
    if (loc === newUrl) return '';
    if (!dates.has(loc)) return entry;
    const date = dates.get(loc);
    return entry.replace(/<lastmod>[^<]*<\/lastmod>/, date ? `<lastmod>${date}</lastmod>` : '');
  });
  writeFileSync(join(fixture, 'sitemap.xml'), input);
  const inputEntries = parse(input);
  const dayBefore = new Date().toISOString().slice(0, 10);
  const generate = () => execFileSync(process.execPath, [join(fixture, 'scripts/generate-location-pages.js')], { cwd: fixture, timeout: 30000, stdio: 'pipe' });
  generate();
  const firstOutput = readFileSync(join(fixture, 'sitemap.xml'), 'utf8');
  const result = parse(firstOutput);
  const dayAfter = new Date().toISOString().slice(0, 10);
  assert.deepEqual([...result.keys()].sort(), [...originalEntries.keys()].sort(), 'Generator changed URL membership');
  assert.ok([dayBefore, dayAfter].includes(result.get(newUrl).lastmod), 'New URL must use the generation date');
  for (const [loc, entry] of inputEntries) {
    const expected = loc === url('furniture-assembly-san-antonio-tx') ? null : entry.lastmod;
    assert.equal(result.get(loc).lastmod, expected, `${loc}: existing modification date changed`);
    if (!/-[a-z-]+-tx$/.test(loc)) assert.equal(result.get(loc).entry, entry.entry, `${loc}: non-service entry changed`);
  }
  generate();
  assert.deepEqual(parse(readFileSync(join(fixture, 'sitemap.xml'), 'utf8')), result, 'Repeat generation changed sitemap entries');
  console.log(`PASS ${result.size} sitemap URLs: existing dates preserved, new URL dated, invalid/missing old dates omitted, membership stable, repeat generation stable.`);
} finally {
  // Validate the final absolute target before recursive temporary cleanup.
  assert.equal(dirname(resolve(fixture)), TEMP_ROOT);
  assert.ok(basename(fixture).startsWith('aae-sitemap-lastmod-'));
  rmSync(fixture, { recursive: true, force: true });
}
