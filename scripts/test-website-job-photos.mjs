#!/usr/bin/env node
// Real job photos on the website (owner, 2026-10-20). Terms version 2026-10-20
// lets completion photos be shown with identifying details left out; earlier
// bookings and customers who opt out are never used. The owner saves a photo to
// a collection (the privacy check), then posts it to a service page when ready.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import {
  websiteServicesForBooking, websiteCitySlug, isWebsiteService, WEBSITE_PHOTO_SERVICES, websitePhotoPath,
  photoUseForBooking, PHOTO_USE_TERMS_FROM,
} from '../api/_website-photos.js';
import { CUSTOMER_TERMS_VERSION, PRIVACY_NOTICE_VERSION } from '../api/_legal-consent.js';

const read = rel => readFile(new URL(`../${rel}`, import.meta.url), 'utf8').then(s => s.replace(/\r\n/g, '\n'));

// ── Which bookings' photos may be used ──────────────────────────────────────
assert.ok(CUSTOMER_TERMS_VERSION.slice(0, 10) >= PHOTO_USE_TERMS_FROM, 'the current Terms include the photo clause');
assert.ok(PRIVACY_NOTICE_VERSION.slice(0, 10) >= PHOTO_USE_TERMS_FROM, 'the current Privacy Notice describes the photo use');
assert.deepEqual(photoUseForBooking({ customer_terms_version: CUSTOMER_TERMS_VERSION }), { allowed: true, reason: 'terms' });
assert.deepEqual(photoUseForBooking({ customer_terms_version: '2026-10-18-easer-responsibility-v1' }), { allowed: false, reason: 'earlier_terms' },
  'a booking under earlier Terms was promised no marketing use');
assert.deepEqual(photoUseForBooking({}), { allowed: false, reason: 'earlier_terms' }, 'unknown Terms version: not used');
assert.deepEqual(photoUseForBooking({ customer_terms_version: CUSTOMER_TERMS_VERSION, website_photo_opt_out_at: '2026-11-01' }),
  { allowed: false, reason: 'opted_out' });
const terms = await read('terms.html');
assert.match(terms, /<strong>Photos of completed work\.<\/strong> AssembleAtEase may show photos of completed work/, 'Terms grant the photo use');
assert.match(terms, /we leave out people, faces, house numbers/, 'Terms state the privacy safeguards');
assert.match(terms, /To ask us not to use photos from your bookings/, 'Terms give the opt-out');
assert.doesNotMatch(terms, /will not be used in public marketing without separate permission/, 'the old promise is gone from the current Terms');
assert.match(await read('privacy.html'), /To show photos of completed work on our website/, 'the Privacy Notice lists the use');
console.log('PASS photos are used only from bookings under the current Terms, never after an opt-out');

// ── Booking services map onto the service pages ────────────────────────────
assert.deepEqual(websiteServicesForBooking('Mounting & Hanging'), ['tv-mounting']);
assert.deepEqual(websiteServicesForBooking('Outdoor & Playsets'), ['playset-assembly']);
assert.deepEqual(websiteServicesForBooking('Furniture Assembly, Mounting & Hanging'), ['furniture-assembly', 'tv-mounting']);
assert.deepEqual(websiteServicesForBooking('Fitness Equipment'), ['fitness-equipment-assembly']);
assert.equal(websiteCitySlug('Round Rock'), 'round-rock');
assert.ok(!isWebsiteService('anything-else'));
assert.equal(websitePhotoPath('tv-mounting', 'abc', 'image/webp'), 'tv-mounting/abc.webp');
const sql = await read('api/migrations/118_website_job_photos.sql');
for (const slug of Object.keys(WEBSITE_PHOTO_SERVICES)) assert.ok(sql.includes(`'${slug}'`), `migration allows ${slug}`);
assert.match(sql, /website_published_at IS NULL\s*OR \(website_collected_at IS NOT NULL/, 'the database refuses a posted photo that is not in the collection');
console.log('PASS booking services map onto the six service pages; posted photos are always collected first');

// ── Collect, then post; the original stays private ──────────────────────────
const action = await read('api/owner/website-photo.js');
assert.match(action, /verifyOwner\(req\)/, 'owner only');
assert.match(action, /const use = photoUseForBooking\(booking\);\s*if \(!use\.allowed\)/, 'collect and post both check the photo-use rule');
assert.match(action, /if \(action === 'collect'\) \{\s*if \(req\.body\.checklistConfirmed !== true\)/, 'saving to the collection is the privacy check');
assert.match(action, /if \(!row\.website_collected_at\)[\s\S]{0,160}NOT_COLLECTED/, 'nothing is posted without being collected');
assert.match(action, /storage\.from\(WEBSITE_PHOTO_BUCKET\)\.upload\(/, 'a posted photo is a copy in the public bucket');
assert.doesNotMatch(action, /storage\.from\(EVIDENCE_BUCKET\)\.(upload|update|move|getPublicUrl)/, 'the private original is never made public');
assert.match(action, /async function optOut[\s\S]*takeDown\(sb, photo\)[\s\S]*website_photo_opt_out_at/, 'an opt-out takes photos down and is recorded');
assert.match(action, /ilike\('customer_email', email\.replace\(/, 'an opt-out covers all of the customer\'s bookings, wildcards escaped');
console.log('PASS the owner saves a photo to the collection (privacy check), posts it when ready; opt-outs remove everything');

// ── The public read returns nothing about the customer ─────────────────────
const pub = await read('api/job-photos.js');
const select = pub.match(/\.select\('([^']+)'\)/)[1];
for (const field of ['booking_id', 'storage_path', 'uploaded_by', 'customer', 'address']) {
  assert.ok(!select.includes(field), `the public read never selects ${field}`);
}
assert.match(pub, /\.not\('website_published_at', 'is', null\)/, 'only posted photos');
const library = await read('api/owner/website-photos.js');
assert.match(library, /verifyOwner\(req\)/);
assert.match(library, /photoUseForBooking\(b\)\.allowed/, 'the library lists only photos that may be used');
console.log('PASS the public read returns only posted copies; the owner library lists only usable photos');

// ── Owner dashboard ─────────────────────────────────────────────────────────
const owner = await read('owner/index.html');
assert.match(owner, /<a data-view="website-photos">/, 'Website Photos page in the sidebar');
assert.match(owner, /<script src="\/owner\/assets\/website-photos\.js" defer><\/script>/);
assert.match(owner, /window\.OwnerWebsitePhotos\.actionsHtml\(photo,/, 'the booking record uses the same buttons as the library');
const module = await read('owner/assets/website-photos.js');
for (const label of ['Save to collection', 'Post to website', 'Take off website', "'Remove', 'uncollect'"]) {
  assert.ok(module.includes(label), `button: ${label}`);
}
assert.doesNotMatch(await read('review.html'), /r-photo-consent/, 'customers are not asked again on the review page');
console.log('PASS one set of photo buttons in the booking record and the Website Photos page');

// ── Every service/city page can show posted photos ─────────────────────────
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
assert.match(js, /if \(photos\.length\) render\(/, 'with no posted photos the page keeps what it had');
assert.match(js, /img\.alt = photo\.alt/, 'photos are built as elements, never as HTML strings');
assert.match(js, /photos\.length > 1 && photos\.length % 2/, 'the two-column grid always gets an even number of photos');
console.log(`PASS all ${files.length} service/city pages show posted job photos; empty pages stay as they were`);

// ── Layout holds for any number of posted photos ───────────────────────────
// (Measured in a browser 2026-10-20 at 1280px and 390px with 1, 2, 3, 6 and 9
// photos, tall and wide: equal sizes, no sideways scroll.)
assert.match(js, /var MAX_PHOTOS = 6;/, 'never more than six on a page');
assert.match(js, /\.slice\(0, MAX_PHOTOS\)/);
assert.match(js, /@media \(max-width:560px\)\{\[data-job-photos-loaded\] > \.fa-shot:nth-child\(n\+5\)\{display:none\}\}/, 'phones show at most four');
assert.match(js, /photos\.length === 1 \? gallery\.querySelector\('\.fa-shot'\) : null/, 'one photo pairs with a built-in photo');
assert.match(js, /figures\[0\]\.style\.gridColumn = '1 \/ -1'/, 'or is centred when the page has none');
for (const f of files) {
  const html = await read(f);
  assert.ok(html.includes('.fa-shot .frame{width:100%;aspect-ratio:7/5'), `${f}: every photo is cropped to one shape`);
  assert.ok(html.includes('.fa-gallery{grid-template-columns:1fr}'), `${f}: one column on phones`);
}
console.log('PASS layout: at most six photos (four on phones), one shape, even rows, a single photo never sits alone');

// ── The public copy carries no location or camera data ─────────────────────
{
  const { stripImageMetadata } = await import('../api/_website-photos.js');
  const seg = (m, payload) => { const b = Buffer.alloc(4 + payload.length); b[0] = 0xff; b[1] = m; b.writeUInt16BE(payload.length + 2, 2); payload.copy(b, 4); return b; };
  const jpeg = Buffer.concat([
    Buffer.from([0xff, 0xd8]), seg(0xe0, Buffer.from('JFIF\0')), seg(0xe1, Buffer.from('Exif\0\0GPSLatitude30.2672')),
    Buffer.from([0xff, 0xda, 0x00, 0x04, 0x01, 0x00, 0x11, 0x22, 0xff, 0xd9]),
  ]);
  const out = stripImageMetadata(jpeg, 'image/jpeg');
  assert.ok(out.ok && !out.buffer.includes(Buffer.from('GPS')), 'EXIF/GPS is removed from a JPEG');
  assert.ok(out.buffer.includes(Buffer.from('JFIF')) && out.buffer.includes(Buffer.from([0x11, 0x22, 0xff, 0xd9])), 'the image data is untouched');
  assert.equal(stripImageMetadata(Buffer.from('not an image'), 'image/heic').ok, false, 'an unknown format is refused, not posted as-is');
  assert.match(action, /const cleaned = stripImageMetadata\(/, 'posting strips metadata');
  assert.match(action, /path, cleaned\.buffer, \{ contentType, cacheControl: '600'/, 'only the cleaned copy is uploaded, with a short cache');
  assert.match(pub, /s-maxage=300/, 'the page list refreshes within five minutes of a take-down');
}
console.log('PASS the public copy is stripped of EXIF/GPS; take-downs leave the site within minutes');
