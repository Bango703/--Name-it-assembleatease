// Facebook posts that sell, built from what is true today rather than written by
// the AI: a service with its real starting price and a real job photo, the
// first-booking offer only while it is switched on in the owner dashboard (with a
// link that applies the code), and AssembleCash. Blog tips still run between them.
//
// Owner, 2026-10-21: "all Facebook gets is the same old post." With 18 articles and
// two posts a day, the blog ran out in nine days and the same guides went out again
// and again, every one of them a link to an article and none to a booking.

import { getBookingCatalog } from './_pricing.js';
import { getPublicPromotion } from './_promotions.js';
import { ASSEMBLECASH } from './_assemblecash.js';

const ORIGIN = 'https://www.assembleatease.com';

// One week of Facebook. An offer day without a live offer becomes a service day.
export const FACEBOOK_ROTATION = ['service', 'blog', 'offer', 'blog', 'service', 'assemblecash', 'blog'];

// The catalog key, how it is said in a post, and a real job photo (images/real-*).
const SERVICES = [
  { key: 'Furniture Assembly', name: 'Furniture assembly', image: 'real-furniture-dresser-wood-1000.webp',
    lines: ['Beds, dressers, wardrobes, desks and shelving, built level and tight.',
      'Flat-pack from IKEA, Wayfair, Amazon or anywhere else, put together by a pro who brings the tools.'] },
  { key: 'Mounting & Hanging', name: 'TV mounting', image: 'real-tv-mount-console-1200.webp',
    lines: ['Your TV mounted level, at the height you choose.',
      'TVs, soundbars, mirrors and art, mounted level on the wall you pick.'] },
  { key: 'Smart Home', name: 'Smart home setup', image: 'real-smarthome-doorbell-vivint-1024.webp',
    lines: ['Smart thermostats, locks, doorbells, cameras and hubs set up, connected and working before we leave.',
      'Smart locks, cameras and video doorbells installed and paired to your phone.'] },
  { key: 'Office Assembly', name: 'Office furniture assembly', image: 'real-office-home-ldesk-1200.webp',
    lines: ['Standing desks, office chairs, filing cabinets and workstations, assembled and ready for Monday.',
      'Home office or a whole floor of workstations, assembled and placed where you want them.'] },
  { key: 'Fitness Equipment', name: 'Fitness equipment assembly', image: 'real-fitness-home-gym-1200.webp',
    lines: ['Treadmills, bikes, racks and home gyms, assembled and checked before your first workout.',
      'Home gym equipment built and set up in the room you train in.'] },
  { key: 'Outdoor & Playsets', name: 'Outdoor and playset assembly', image: 'real-outdoor-gazebo-356.webp',
    lines: ['Playsets, gazebos, patio furniture and trampolines, assembled on site.',
      'Patio sets, gazebos and backyard playsets, built where they will stand.'] },
];

function utmLink(path, campaign) {
  const url = new URL(path, ORIGIN);
  url.searchParams.set('utm_source', 'facebook');
  url.searchParams.set('utm_medium', 'social');
  url.searchParams.set('utm_campaign', campaign);
  return url.href;
}

/** Cheapest independently bookable item per service, the same rule as check-service-from-prices. */
export function fromPrice(serviceKey, catalog = getBookingCatalog()) {
  let best = null;
  for (const group of catalog?.subcategories?.[serviceKey] || []) {
    for (const item of group.items || []) {
      if (item.addon || item.customQuote || !(item.price > 0)) continue;
      if (best === null || item.price < best) best = item.price;
    }
  }
  return best;
}

export function dayNumber(now = new Date()) {
  return Math.floor(now.getTime() / 86400000);
}

/** What Facebook gets today: 'service' | 'blog' | 'offer' | 'assemblecash'. */
export function facebookSlotKind({ now = new Date(), promoSettings } = {}) {
  const kind = FACEBOOK_ROTATION[dayNumber(now) % FACEBOOK_ROTATION.length];
  if (kind === 'offer' && !getPublicPromotion(promoSettings)) return 'service';
  return kind;
}

export function servicePost({ now = new Date(), catalog } = {}) {
  const d = dayNumber(now);
  const service = SERVICES[Math.floor(d / 2) % SERVICES.length];
  const price = fromPrice(service.key, catalog);
  if (!price) return null;
  const line = service.lines[d % service.lines.length];
  const url = utmLink(`/book?service=${encodeURIComponent(service.key)}`, 'service_spotlight');
  const text = `${service.name}, from $${price}.\n\n${line}\n\nSee the price for your items and book online. You pay once the job is done.\n${url}`;
  return { kind: 'service', title: service.name, url, text, imageUrl: `${ORIGIN}/images/${service.image}`, altText: `${service.name} completed by AssembleAtEase` };
}

export function offerPost({ promoSettings, now = new Date() } = {}) {
  const promo = getPublicPromotion(promoSettings);
  if (!promo) return null;
  const url = utmLink(`/book?promo=${encodeURIComponent(promo.code)}`, 'offer');
  const first = promo.firstBookingOnly ? ' on your first booking' : '';
  const label = String(promo.label || '').replace(/\.$/, '');
  const service = SERVICES[dayNumber(now) % SERVICES.length];
  const text = `${label}${label.toLowerCase().includes('first') ? '' : first}.\n\nFurniture assembly, TV mounting, smart home setup and more. Book from this link and code ${promo.code} is applied at checkout.\n${url}`;
  return { kind: 'offer', title: promo.title || 'Offer', url, text, imageUrl: `${ORIGIN}/images/${service.image}`, altText: `${service.name} completed by AssembleAtEase` };
}

export function assembleCashPost() {
  const url = utmLink('/assemblecash', 'assemblecash');
  const cap = ASSEMBLECASH.MAX_REDEEM_CENTS / 100;
  const text = `Every completed booking earns ${ASSEMBLECASH.EARN_RATE_PCT}% back in AssembleCash.\n\nIt comes off your next setup, up to $${cap} a booking. It is credit toward future bookings, not cash.\n${url}`;
  return { kind: 'assemblecash', title: 'AssembleCash', url, text, imageUrl: `${ORIGIN}/images/real-furniture-dresser-white-1200.webp`, altText: 'Dresser assembled by AssembleAtEase' };
}

/** Today's non-blog Facebook post, or null when the slot is a blog day. */
export function facebookCampaignPost({ kind, promoSettings, now = new Date(), catalog } = {}) {
  if (kind === 'offer') return offerPost({ promoSettings, now }) || servicePost({ now, catalog });
  if (kind === 'assemblecash') return assembleCashPost();
  if (kind === 'service') return servicePost({ now, catalog });
  return null;
}
