#!/usr/bin/env node
// Seasonal picks on the customer app's Home (owner, 2026-10-14: "lets go with
// seasonal, specific, I don't want double talk"). The seasons live in
// assets/js/booking-source-of-truth.js; api/booking/catalog.js picks today's.
//
// What must hold:
//   - every day of the year (Feb 29 included) belongs to exactly one season;
//   - every season item is a real, bookable main item (no add-on, no quote);
//   - no item repeats inside a season, and a season never repeats a bundle whole;
//   - the day is decided in Central time.

import assert from 'node:assert/strict';
import { getBookingCatalog } from '../api/_pricing.js';
import { activeSeason } from '../api/booking/catalog.js';

const catalog = getBookingCatalog();
const seasons = catalog.seasons || [];
assert.ok(seasons.length >= 4, 'seasons are defined');

const bookable = new Set();
for (const [service, groups] of Object.entries(catalog.subcategories || {})) {
  for (const group of groups) for (const item of group.items) {
    if (!item.addon && !item.customQuote && Number(item.price) > 0) bookable.add(`${service}|${item.name}`);
  }
}

const slugs = new Set();
for (const season of seasons) {
  assert.ok(season.slug && !slugs.has(season.slug), `unique slug ${season.slug}`);
  slugs.add(season.slug);
  assert.ok(season.title && season.title.length <= 32, `${season.slug} has a short title`);
  assert.match(season.from, /^\d{2}-\d{2}$/);
  assert.match(season.to, /^\d{2}-\d{2}$/);
  assert.match(season.symbol || '', /^[a-z0-9.]+$/, `${season.slug} names an SF Symbol`);
  assert.ok(season.items.length >= 3 && season.items.length <= 6, `${season.slug} has 3 to 6 picks`);
  const keys = season.items.map(line => `${line.service}|${line.name}`);
  assert.equal(new Set(keys).size, keys.length, `${season.slug} repeats no item`);
  for (const key of keys) assert.ok(bookable.has(key), `${season.slug}: "${key}" is a bookable catalog item`);
  for (const bundle of catalog.bundles || []) {
    const inBundle = new Set((bundle.included || []).map(line => `${line.service}|${line.name}`));
    assert.ok(!keys.every(key => inBundle.has(key)), `${season.slug} is not the ${bundle.slug} bundle again`);
  }
}

// Every day of a leap year, exactly one season.
const days = [];
for (let d = new Date(Date.UTC(2028, 0, 1)); d.getUTCFullYear() === 2028; d = new Date(d.getTime() + 86400000)) {
  days.push(`${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`);
}
for (const day of days) {
  const matches = seasons.filter(s => s.from <= day && day <= s.to);
  assert.equal(matches.length, 1, `${day} belongs to exactly one season (found ${matches.map(s => s.slug).join(', ') || 'none'})`);
}

// The API answer: Central time decides the day.
assert.equal(activeSeason(catalog, new Date('2027-01-01T03:00:00Z')).slug, activeSeason(catalog, new Date('2026-12-31T18:00:00Z')).slug, 'New Year in UTC is still Dec 31 in Austin');
const today = activeSeason(catalog, new Date('2026-10-14T18:00:00Z'));
assert.ok(today && today.title && today.items.length, 'a season is always sent');
assert.deepEqual(Object.keys(today.items[0]).sort(), ['name', 'service'], 'items are references; the price comes from the catalog');
assert.equal(today.through, 'Nov 14', 'the end date is worded for the customer');
assert.equal(activeSeason(catalog, new Date('2027-02-10T18:00:00Z')).through, 'Feb 28', 'no Feb 29 in a year without one');
assert.equal(activeSeason(catalog, new Date('2028-02-10T18:00:00Z')).through, 'Feb 29');

console.log(`PASS catalog seasons: ${seasons.length} seasons cover every day once, every pick is a bookable item, none repeats a bundle, Central time decides the day.`);
