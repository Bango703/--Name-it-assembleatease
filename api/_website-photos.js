/**
 * Real job photos on the public website (migration 118). One owner for:
 * which service pages exist, how a booking's service maps onto them, how a
 * city becomes the slug its pages use, and what the owner confirms before a
 * photo goes public.
 */

export const WEBSITE_PHOTO_BUCKET = 'job-photos';
export const WEBSITE_PHOTO_LIMIT = 6;

// The service pages, by slug. Each has one page per Texas city
// (`${slug}-${city}-tx.html`).
export const WEBSITE_PHOTO_SERVICES = Object.freeze({
  'furniture-assembly': 'Furniture assembly',
  'tv-mounting': 'TV mounting',
  'smart-home-installation': 'Smart home installation',
  'fitness-equipment-assembly': 'Fitness equipment assembly',
  'office-furniture-assembly': 'Office furniture assembly',
  'playset-assembly': 'Outdoor and playset assembly',
});

// Booking service categories (as stored on bookings.service) to page slugs.
const CATEGORY_TO_SERVICE = [
  [/mount|hanging|\btv\b/i, 'tv-mounting'],
  [/smart\s*home/i, 'smart-home-installation'],
  [/fitness|treadmill|bike|gym/i, 'fitness-equipment-assembly'],
  [/office/i, 'office-furniture-assembly'],
  [/outdoor|playset|trampoline|swing|gazebo/i, 'playset-assembly'],
  [/furniture|bed|dresser|assembly/i, 'furniture-assembly'],
];

/** Page slugs for a booking's service text, most specific first. */
export function websiteServicesForBooking(serviceText) {
  const parts = String(serviceText || '').split(/,|\/|\+/).map(s => s.trim()).filter(Boolean);
  const found = [];
  for (const part of parts) {
    const match = CATEGORY_TO_SERVICE.find(([re]) => re.test(part));
    if (match && !found.includes(match[1])) found.push(match[1]);
  }
  return found;
}

export function isWebsiteService(slug) {
  return Object.prototype.hasOwnProperty.call(WEBSITE_PHOTO_SERVICES, String(slug || ''));
}

/** "Round Rock" -> "round-rock"; the same slug the city pages use. */
export function websiteCitySlug(cityName) {
  const slug = String(cityName || '').trim().toLowerCase()
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return /^[a-z0-9-]{2,40}$/.test(slug) ? slug : null;
}

// Terms version 2026-10-20 added the photo-use clause (section 8): photos of
// completed work may appear on the website with identifying details left out,
// and the customer can opt out. Bookings made under an earlier version were
// promised "not used in public marketing without separate permission", so
// their photos are never used.
export const PHOTO_USE_TERMS_FROM = '2026-10-20';

/**
 * May this booking's completion photos be used on the website?
 * { allowed, reason }: reason is 'terms', 'earlier_terms', or 'opted_out'.
 */
export function photoUseForBooking(booking = {}) {
  if (booking.website_photo_opt_out_at) return { allowed: false, reason: 'opted_out' };
  const accepted = String(booking.customer_terms_version || '').slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(accepted) && accepted >= PHOTO_USE_TERMS_FROM) return { allowed: true, reason: 'terms' };
  return { allowed: false, reason: 'earlier_terms' };
}

// What the owner confirms for every photo before it goes into the collection.
export const WEBSITE_PHOTO_CHECKLIST = Object.freeze([
  'No people or faces',
  'No house number, street sign, mail, or documents',
  'No family photos, screens with personal information, or license plates',
]);

export function websitePhotoPath(service, evidenceId, contentType = 'image/jpeg') {
  const ext = /png/i.test(contentType) ? 'png' : /webp/i.test(contentType) ? 'webp' : 'jpg';
  return `${service}/${evidenceId}.${ext}`;
}

/**
 * Remove embedded metadata (EXIF with GPS location, XMP, comments, text) from
 * an image before its public copy is written. The website and the Easer app
 * re-encode photos before upload, which drops metadata, but the server stores
 * whatever bytes it receives, so the public copy is cleaned here regardless.
 * Pixels are untouched. Returns { ok, buffer } or { ok: false, reason }.
 */
export function stripImageMetadata(input, contentType = '') {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const type = String(contentType).toLowerCase();
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return stripJpeg(buf);
  if (buf.length > 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return stripPng(buf);
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return stripWebp(buf);
  return { ok: false, reason: `unsupported_image_type${type ? `:${type}` : ''}` };
}

// JPEG: drop APP1-APP15 (EXIF, XMP, ICC-free vendor data) and COM segments;
// keep APP0 (JFIF) and every coding segment; copy the scan data unchanged.
function stripJpeg(buf) {
  const parts = [buf.slice(0, 2)];
  let i = 2;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) return { ok: false, reason: 'jpeg_malformed' };
    const marker = buf[i + 1];
    if (marker === 0xd9) { parts.push(buf.slice(i, i + 2)); i += 2; break; }
    if (marker === 0xda) { parts.push(buf.slice(i)); i = buf.length; break; }
    if (marker >= 0xd0 && marker <= 0xd7) { parts.push(buf.slice(i, i + 2)); i += 2; continue; }
    const length = buf.readUInt16BE(i + 2);
    if (length < 2 || i + 2 + length > buf.length) return { ok: false, reason: 'jpeg_malformed' };
    const drop = (marker >= 0xe1 && marker <= 0xef) || marker === 0xfe;
    if (!drop) parts.push(buf.slice(i, i + 2 + length));
    i += 2 + length;
  }
  return { ok: true, buffer: Buffer.concat(parts) };
}

// PNG: drop EXIF and text chunks; keep everything else, CRCs included.
function stripPng(buf) {
  const DROP = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME']);
  const parts = [buf.slice(0, 8)];
  let i = 8;
  while (i + 12 <= buf.length) {
    const length = buf.readUInt32BE(i);
    const type = buf.toString('ascii', i + 4, i + 8);
    const end = i + 12 + length;
    if (end > buf.length) return { ok: false, reason: 'png_malformed' };
    if (!DROP.has(type)) parts.push(buf.slice(i, end));
    i = end;
    if (type === 'IEND') break;
  }
  return { ok: true, buffer: Buffer.concat(parts) };
}

// WebP: drop EXIF and XMP chunks, clear their VP8X flags, fix the RIFF size.
function stripWebp(buf) {
  const parts = [];
  let i = 12;
  while (i + 8 <= buf.length) {
    const type = buf.toString('ascii', i, i + 4);
    const size = buf.readUInt32LE(i + 4);
    const end = i + 8 + size + (size % 2);
    if (i + 8 + size > buf.length) return { ok: false, reason: 'webp_malformed' };
    if (type !== 'EXIF' && type !== 'XMP ') {
      const chunk = Buffer.from(buf.slice(i, Math.min(end, buf.length)));
      if (type === 'VP8X' && chunk.length > 8) chunk[8] &= ~0x0c;
      parts.push(chunk);
    }
    i = end;
  }
  const body = Buffer.concat(parts);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(body.length + 4, 4);
  header.write('WEBP', 8, 'ascii');
  return { ok: true, buffer: Buffer.concat([header, body]) };
}
