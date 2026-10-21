// The booking catalog, read the same way by every script that quotes a price.
//
// assets/js/booking-source-of-truth.js is the only source of truth for what a
// service costs. scripts/check-service-from-prices.mjs proves the website's
// "From $NN" cards match it; scripts/generate-llms.mjs writes the prices AI
// assistants read. Both use these two functions, so the rule for "From" lives
// in one place.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, runInNewContext } from 'node:vm';

/** The whole front-end catalog (subcategories, bundles, service area...). */
export function loadBookingSource(root = process.cwd()) {
  const src = readFileSync(join(root, 'assets', 'js', 'booking-source-of-truth.js'), 'utf8');
  const sandbox = createContext({ window: {} });
  runInNewContext(src, sandbox);
  const source = sandbox.window.AAE_BOOKING_SOURCE;
  if (!source || !source.subcategories) {
    throw new Error('booking-source-of-truth.js did not expose window.AAE_BOOKING_SOURCE.subcategories');
  }
  return source;
}

/** Service name -> groups of priced items. */
export function loadCatalog(root = process.cwd()) {
  return loadBookingSource(root).subcategories;
}

// WHAT "FROM" MEANS, precisely: the cheapest item a customer can actually book
// as a job on its own.
//
//   - addon: true       excluded. "Floor leveling / placement support" ($59) is
//                       something you add to a treadmill build, not a visit you
//                       can book by itself. Advertising "Fitness from $59" would
//                       be wrong in the opposite direction.
//   - customQuote: true excluded. Priced at 0 pending a real quote; it is not a
//                       number anyone can be held to.
//   - price <= 0        excluded for the same reason.
/** Cheapest independently bookable item in a service, or null if quote-only. */
export function trueFromPrice(groups) {
  let best = null;
  for (const group of groups || []) {
    for (const item of group.items || []) {
      if (item.addon || item.customQuote) continue;
      if (!(item.price > 0)) continue;
      if (best === null || item.price < best) best = item.price;
    }
  }
  return best;
}
