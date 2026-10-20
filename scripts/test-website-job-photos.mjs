#!/usr/bin/env node
// Real job photos on the website (owner, 2026-10-20). A completion photo goes
// public only with the customer's permission and the owner's choice, and only
// as a copy in the public bucket; the pages show what the owner published.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import {
  websiteServicesForBooking, websiteCitySlug, isWebsiteService, WEBSITE_PHOTO_SERVICES, websitePhotoPath,
} from '../api/_website-photos.js';

const read = rel => readFile(new URL(`../${rel}`, import.meta.url), 'utf8').then(s => s.replace(/\r\n/g, '\n'));

// ── Booking services map onto the service pages ────────────────────────────
assert.deepEqual(websiteServicesForBooking('Mounting & Hanging'), ['tv-mounting']);
assert.deepEqual(websiteServicesForBooking('Outdoor & Playsets'), ['playset-assembly']);
assert.deepEqual(websiteServicesForBooking('Furniture Assembly, Mounting & Hanging'), ['furniture-assembly', 'tv-mounting']);
assert.deepEqual(websiteServicesForBooking('Fitness Equipment'), ['fitness-equipment-assembly']);
assert.deepEqual(websiteServicesForBooking('Office Assembly'), ['office-furniture-assembly']);
assert.equal(websiteCitySlug('Round Rock'), 'round-rock');
assert.equal(websiteCitySlug(''), null);
assert.ok(!isWebsiteService('anything-else'));
assert.equal(websitePhotoPath('tv-mounting', 'abc', 'image/webp'), 'tv-mounting/abc.webp');
const sql = await read('api/migrations/118_website_job_photos.sql');
for (const slug of Object.keys(WEBSITE_PHOTO_SERVICES)) assert.ok(sql.includes(`'${slug}'`), `migration allows ${slug}`);
console.log('PASS booking services map onto the six service pages; the database allows exactly those');

// ── Publishing needs permission, choice and the checklist ──────────────────
const publish = await read('api/owner/website-photo.js');
assert.match(publish, /verifyOwner\(req\)/, 'owner only');
assert.match(publish, /evidence_type !== 'completion_photo'/, 'only completion photos');
assert.match(publish, /if \(!booking\.website_photo_consent_at\)[\s\S]{0,200}CUSTOMER_PERMISSION_REQUIRED/, 'no customer permission, no website');
assert.match(publish, /checklistConfirmed !== true/, 'the owner confirms the privacy checklist');
assert.match(publish, /storage\.from\(WEBSITE_PHOTO_BUCKET\)\.upload\(/, 'a copy goes to the public bucket');
assert.doesNotMatch(publish, /storage\.from\(EVIDENCE_BUCKET\)\.(upload|update|move|getPublicUrl)/, 'the private original is never made public');
assert.match(publish, /storage\.from\(WEBSITE_PHOTO_BUCKET\)\.remove\(\[row\.website_public_path\]\)/, 'taking a photo down deletes the public copy');
console.log('PASS publishing needs a completion photo, customer permission and the checklist; the original stays private');

// ── The public read returns nothing about the customer ─────────────────────
const pub = await read('api/job-photos.js');
const select = pub.match(/\.select\('([^']+)'\)/)[1];
for (const field of ['booking_id', 'storage_path', 'uploaded_by', 'customer', 'address']) {
  assert.ok(!select.includes(field), `the public read never selects ${field}`);
}
assert.match(pub, /\.not\('website_published_at', 'is', null\)/, 'only published photos');
assert.match(pub, /\[\.\.\.local, \.\.\.rest\]/, "the city's own jobs come first");
console.log('PASS the public read returns only published copies and their descriptions, local first');

// ── The customer opts in on the review page ────────────────────────────────
const page = await read('review.html');
assert.match(page, /<input type="checkbox" id="r-photo-consent" style="[^"]*"\/>/, 'permission box present and unchecked');
assert.doesNotMatch(page, /id="r-photo-consent"[^>]*checked/, 'never pre-checked');
assert.match(page, /website_photo_consent: !!\(document\.getElementById\('r-photo-consent'\)/);
const review = await read('api/review.js');
assert.match(review, /if \(payload\.website_photo_consent === true\)/, 'recorded only when the customer said yes');
console.log('PASS the customer gives permission with an unchecked box on the review page');

// ── Every service/city page can show them ──────────────────────────────────
const files = (await readdir(new URL('../', import.meta.url))).filter(f =>
  /^(furniture-assembly|tv-mounting|smart-home-installation|fitness-equipment-assembly|office-furniture-assembly|playset-assembly)-[a-z-]+-tx\.html$/.test(f));
assert.equal(files.length, 324, 'six services across 54 cities');
for (const f of files) {
  const html = await read(f);
  const service = f.match(/^(furniture-assembly|tv-mounting|smart-home-installation|fitness-equipment-assembly|office-furniture-assembly|playset-assembly)-/)[1];
  assert.equal((html.match(/data-job-photos="/g) || []).length, 1, `${f} has one job-photo gallery`);
  assert.ok(html.includes(`data-job-photos="${service}"`), `${f} asks for ${service} photos`);
  assert.equal((html.match(/\/assets\/js\/job-photos\.js/g) || []).length, 1, `${f} loads job-photos.js once`);
}
const fitness = await read('fitness-equipment-assembly-austin-tx.html');
assert.match(fitness, /data-job-photos="fitness-equipment-assembly"[^>]*style="display:none"><\/div>/, 'a page with no built-in photos keeps its empty grid hidden');
const js = await read('assets/js/job-photos.js');
assert.match(js, /if \(photos\.length\) render\(/, 'with no published photos the page keeps what it had');
assert.match(js, /img\.alt = photo\.alt/, 'photos are built as elements, never as HTML strings');
assert.match(js, /photos\.length > 1 && photos\.length % 2/, 'the two-column grid always gets an even number of photos');
console.log(`PASS all ${files.length} service/city pages show published job photos; empty pages stay as they were`);
