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

// What the owner confirms for every photo before it is published.
export const WEBSITE_PHOTO_CHECKLIST = Object.freeze([
  'No people or faces',
  'No house number, street sign, mail, or documents',
  'No family photos, screens with personal information, or license plates',
]);

export function websitePhotoPath(service, evidenceId, contentType = 'image/jpeg') {
  const ext = /png/i.test(contentType) ? 'png' : /webp/i.test(contentType) ? 'webp' : 'jpg';
  return `${service}/${evidenceId}.${ext}`;
}
