import { getBookingCatalog } from '../_pricing.js';
import { bookingWindow } from './_booking-window.js';
import { BOOKING_TIME_SLOTS, todayOpenBookingSlots } from './_booking-slots.js';
import { CUSTOMER_TERMS_VERSION, PRIVACY_NOTICE_VERSION } from '../_legal-consent.js';

/**
 * GET /api/booking/catalog — what a native booking screen offers, read from the
 * same catalog api/_pricing.js prices against (assets/js/booking-source-of-truth.js).
 * Prices here are display only: api/booking.js re-prices every item by name.
 */
/**
 * One real AssembleAtEase job photo per service (images/real-*, the owner's own
 * completed work), each used once. The catch-all service has none.
 */
const SERVICE_PHOTOS = Object.freeze({
  'Furniture Assembly': '/images/real-furniture-dresser-wood-640.webp',
  'Mounting & Hanging': '/images/real-tv-mount-console-640.webp',
  'Smart Home': '/images/real-smarthome-doorbell-adt-640.webp',
  'Outdoor & Playsets': '/images/real-outdoor-gazebo-356.webp',
  'Office Assembly': '/images/real-office-home-ldesk-640.webp',
  'Fitness Equipment': '/images/real-fitness-home-gym-640.webp',
});

export default function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const catalog = getBookingCatalog();
  const window = bookingWindow();
  const today = todayOpenBookingSlots();

  const services = Object.entries(catalog.subcategories || {}).map(([name, groups]) => ({
    name,
    // The lowest main-item price, for "From $X" on the service tile.
    from_cents: fromCents(groups),
    photo: SERVICE_PHOTOS[name] || null,
    groups: (groups || []).map(group => ({
      name: group.group,
      items: (group.items || []).map(item => ({
        name: item.name,
        price_cents: item.customQuote ? 0 : Math.max(0, Math.round(Number(item.price || 0) * 100)),
        add_on: item.addon === true,
        custom_quote: item.customQuote === true,
        popular: item.popular === true,
      })),
    })),
  }));

  const bundles = (catalog.bundles || [])
    .filter(bundle => bundle.active)
    .sort((a, b) => (a.displayOrder || 0) - (b.displayOrder || 0))
    .map(bundle => ({
      slug: bundle.slug,
      name: bundle.name,
      outcome: bundle.outcome,
      included: (bundle.included || []).map(line => ({ service: line.service, name: line.name })),
    }));

  const season = activeSeason(catalog);

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    services,
    bundles,
    season,
    slots: BOOKING_TIME_SLOTS,
    first_date: window.firstDate,
    last_date: window.lastDate,
    today: today.today,
    today_open_slots: today.slots,
    terms_version: CUSTOMER_TERMS_VERSION,
    privacy_notice_version: PRIVACY_NOTICE_VERSION,
  });
}

/**
 * The season whose MM-DD window holds today's date in Central time, with only the
 * items that exist in the catalog as bookable main items. Null when none matches.
 */
export function activeSeason(catalog, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(now);
  const part = type => parts.find(p => p.type === type).value;
  const year = Number(part('year'));
  const today = `${part('month')}-${part('day')}`;
  const season = (catalog.seasons || []).find(s => s.from <= today && today <= s.to);
  if (!season) return null;
  const bookable = new Set();
  for (const [service, groups] of Object.entries(catalog.subcategories || {})) {
    for (const group of groups || []) {
      for (const item of group.items || []) {
        if (!item.addon && !item.customQuote && Number(item.price) > 0) bookable.add(`${service}|${item.name}`);
      }
    }
  }
  const items = (season.items || [])
    .filter(line => bookable.has(`${line.service}|${line.name}`))
    .map(line => ({ service: line.service, name: line.name }));
  if (!items.length) return null;
  const [month, day] = season.to.split('-').map(Number);
  // A season written to end Feb 29 ends Feb 28 in a year without one.
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const through = `${MONTHS[month - 1]} ${month === 2 && day === 29 && !leap ? 28 : day}`;
  return { slug: season.slug, title: season.title, symbol: season.symbol || null, through, items };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function fromCents(groups) {
  const prices = (groups || []).flatMap(group => group.items || [])
    .filter(item => !item.addon && !item.customQuote && Number(item.price) > 0)
    .map(item => Math.round(Number(item.price) * 100));
  return prices.length ? Math.min(...prices) : null;
}
