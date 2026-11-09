#!/usr/bin/env node
// Catalog search (owner, 2026-11-06): "mount tv", "couch" and "ikea dresser"
// found nothing and "art" found 42 items, in the app and on the website. One
// rule and one word list now live in assets/js/catalog-search.js; the website
// runs it, the catalog API ships its words to the app, and the app compares.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
const { catalogSearch } = await import('../api/_catalog-search.js');
const { getBookingCatalog } = await import('../api/_pricing.js');
const S = catalogSearch();
const catalog = getBookingCatalog();

const rows = [];
for (const [service, groups] of Object.entries(catalog.subcategories || {})) {
  for (const group of groups || []) {
    for (const item of group.items || []) rows.push({ service, group: group.group, name: item.name, text: S.searchText(service, group.group, item.name) });
  }
}
assert.ok(rows.length > 150, `the catalog loaded (${rows.length} items)`);

const results = (query) => rows
  .map((row, order) => ({ row, order, rank: S.rank(query, row.text) }))
  .filter((r) => r.rank >= 0)
  .sort((a, b) => a.rank - b.rank || a.order - b.order)
  .map((r) => r.row.name);

// What customers type.
{
  const tv = results('mount tv');
  assert.ok(tv.length >= 7 && /^TV /.test(tv[0]), `"mount tv" leads with a TV size: ${tv.slice(0, 3)}`);
  assert.ok(results('65 inch tv').some((n) => /65"/.test(n)), '"65 inch tv" finds the 56-65 inch TV');
  const couch = results('couch');
  assert.ok(couch.length >= 3 && couch.every((n) => /sofa/i.test(n)), `"couch" finds sofas and nothing else: ${couch}`);
  assert.ok(results('ikea dresser').length >= 2 && results('ikea dresser').every((n) => /dresser/i.test(n)), '"ikea dresser" finds the dressers');
  assert.ok(results('ikea').every((n) => /ikea/i.test(n)) && results('ikea').length >= 1, '"ikea" alone finds the IKEA items');
  assert.ok(results('ring doorbell').every((n) => /doorbell/i.test(n)) && results('ring doorbell').length >= 1, '"ring doorbell"');
  assert.ok(results('hang pictures').some((n) => /picture/i.test(n)), '"hang pictures"');
  assert.ok(results('bookshelf').some((n) => /bookcase/i.test(n)), '"bookshelf" finds bookcases');
  assert.ok(results('curtains').some((n) => /curtain rod/i.test(n)), 'plural "curtains" finds curtain rods');
  assert.ok(results('shelf').some((n) => /shelves/i.test(n)), 'singular "shelf" finds "shelves"');
  assert.ok(results('outdoor dome').some((n) => /gazebo/i.test(n)), '"outdoor dome" finds the gazebo');
  assert.ok(results('peloton').some((n) => /bike/i.test(n)), '"peloton"');
  assert.ok(results('wifi').some((n) => /wi-fi/i.test(n)), '"wifi" finds Wi-Fi');
  const art = results('art');
  assert.ok(art.length > 0 && art.length < 15 && !art.some((n) => /^smart/i.test(n)), `"art" no longer matches inside "smart" (${art.length})`);
  assert.equal(results('xyzzy plumbing').length, 0, 'a job not offered finds nothing, so the custom quote is offered');
}

// The rule itself.
{
  assert.deepEqual([...S.queryWords('Install my TV please')], ['tv']);
  assert.deepEqual([...S.queryWords('assembly')], ['assembly'], 'a query of only filler keeps it');
  assert.equal(S.singular('shelves'), 'shelf');
  assert.equal(S.singular('curtains'), 'curtain');
  assert.equal(S.singular('glass'), 'glass');
  assert.equal(S.plural('shelf'), 'shelves');
  assert.equal(S.plural('bench'), 'benches');
  assert.equal(S.plural('battery'), 'batteries');
  const sofa = S.searchText('Furniture Assembly', 'Seating & Sofas', 'Sofa (2–3 seat, standard)');
  assert.match(sofa, /^[^|]*\bsofa\b[^|]*\| [^|]*\bcouch\b/, 'own words, then " | ", then extra words');
  assert.doesNotMatch(S.searchText('Furniture Assembly', 'Seating & Sofas', 'Accent chair / armchair'), /\bcouch\b/, 'extra words come from the item name, not its group');
}

// Every word-list key still names something in the catalog.
{
  const nameWords = new Set(rows.flatMap((r) => r.name.toLowerCase().replace(/['\u2019]/g, '').split(/[^a-z0-9]+/).filter(Boolean).map(S.singular)));
  const dead = [...S.EXTRA_WORDS].flatMap((entry) => entry[0]).filter((key) => !nameWords.has(S.singular(key))).map(String);
  assert.equal(dead.length, 0, `these extra-word keys match no catalog item name (renamed?): ${dead.join(', ')}`);
}
console.log('PASS catalog search: what customers type finds the item, word by word, own name first');

// The catalog API ships the words and the stop words to the app.
{
  const { default: handler } = await import('../api/booking/catalog.js');
  const res = { status(c) { this.code = c; return this; }, setHeader() {}, json(b) { this.body = b; return this; } };
  handler({ method: 'GET' }, res);
  assert.equal(res.code, 200);
  const item = res.body.services.flatMap((s) => s.groups.flatMap((g) => g.items)).find((i) => /^Sofa \(/.test(i.name));
  assert.match(item.search, /\bcouch\b/, 'each item carries its search words');
  assert.deepEqual([...res.body.search_stop_words], [...S.STOP_WORDS], 'the stop words are the shared list');
}
console.log('PASS catalog API: each item ships its search words, and the stop words ship once');

// The website runs the shared file.
{
  const book = read('book.html');
  assert.match(book, /<script src="\/assets\/js\/booking-source-of-truth\.js"><\/script>\n<script src="\/assets\/js\/catalog-search\.js"><\/script>/, 'book.html loads the shared search');
  const filter = book.slice(book.indexOf('function filterItemList(q)'), book.indexOf('function filterItemList(q)') + 1800);
  assert.match(filter, /search\.matches\(q, search\.searchText\(item\.dataset\.itemSvc/, 'the item search uses the shared rule');
}
console.log('PASS website: the booking page searches with the shared rule');

// The app compares the shipped words by the same rule.
{
  const models = read('mobile/ios/Customer/Customer/CustomerModels.swift');
  const home = read('mobile/ios/Customer/Customer/CustomerHome.swift');
  assert.match(models, /search = c\.string\("search"\) \?\? ""/, 'the app reads each item\'s words');
  assert.match(models, /searchStopWords = Set\(\(try\? c\.decodeIfPresent\(\[String\]\.self, forKey: DynamicKey\("search_stop_words"\)\)\) \?\? \[\]\)/, 'and the stop words');
  assert.match(models, /\.replacingOccurrences\(of: "'", with: ""\)\s*\.replacingOccurrences\(of: "\\u\{2019\}", with: ""\)\s*\.split\(whereSeparator: \{ !\(\$0\.isASCII && \(\$0\.isLetter \|\| \$0\.isNumber\)\) \}\)/, 'words: apostrophes dropped, split on anything not an ASCII letter or digit (as words() in the JS)');
  assert.match(models, /return kept\.isEmpty \? all : kept/, 'a query of only filler keeps it (as queryWords() in the JS)');
  assert.match(models, /text\.components\(separatedBy: " \| "\)/, 'own words before " | ", extra words after');
  assert.match(models, /list\.contains \{ \$0\.hasPrefix\(word\) \}/, 'each word typed must start a word');
  assert.match(models, /if covered\(own\) \{ return 0 \}\s*if covered\(all\) \{ return 1 \}\s*return nil/, 'own name ranks before extra words (as rank() in the JS)');
  assert.match(home, /CatalogSearch\.rank\(trimmed, text: text, stop: catalog\.searchStopWords\)/, 'the search sheet ranks by the shared rule');
  assert.match(home, /ranked\.sort \{ \(\$0\.rank, \$0\.order\) < \(\$1\.rank, \$1\.order\) \}/, 'own-name matches first, catalog order within');
  const sheet = home.slice(home.indexOf('struct SearchSheet'), home.indexOf('var body', home.indexOf('struct SearchSheet')));
  assert.doesNotMatch(sheet, /localizedCaseInsensitiveContains/, 'no letter-run matching left in the search sheet');
}
console.log('PASS app: the search sheet compares the server\'s words by the same rule');

console.log('\nCatalog search tests passed.');
