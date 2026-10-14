import { getBookingCatalog } from '../_pricing.js';
import { bookingWindow } from './_booking-window.js';
import { BOOKING_TIME_SLOTS, todayOpenBookingSlots } from './_booking-slots.js';
import { CUSTOMER_TERMS_VERSION, PRIVACY_NOTICE_VERSION } from '../_legal-consent.js';

/**
 * GET /api/booking/catalog — what a native booking screen offers, read from the
 * same catalog api/_pricing.js prices against (assets/js/booking-source-of-truth.js).
 * Prices here are display only: api/booking.js re-prices every item by name.
 */
export default function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const catalog = getBookingCatalog();
  const window = bookingWindow();
  const today = todayOpenBookingSlots();

  const services = Object.entries(catalog.subcategories || {}).map(([name, groups]) => ({
    name,
    // The lowest main-item price, for "From $X" on the service tile.
    from_cents: fromCents(groups),
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

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    services,
    bundles,
    slots: BOOKING_TIME_SLOTS,
    first_date: window.firstDate,
    last_date: window.lastDate,
    today: today.today,
    today_open_slots: today.slots,
    terms_version: CUSTOMER_TERMS_VERSION,
    privacy_notice_version: PRIVACY_NOTICE_VERSION,
  });
}

function fromCents(groups) {
  const prices = (groups || []).flatMap(group => group.items || [])
    .filter(item => !item.addon && !item.customQuote && Number(item.price) > 0)
    .map(item => Math.round(Number(item.price) * 100));
  return prices.length ? Math.min(...prices) : null;
}
