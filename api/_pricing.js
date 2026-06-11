import { readFileSync } from 'fs';
import { join } from 'path';
import vm from 'vm';
import { getServiceCallFeeCents, getServiceCallZone } from './_source-of-truth.js';

export const TX_TAX_RATE = 0.0825;

let catalogCache = null;

export function getBookingCatalog() {
  if (catalogCache) return catalogCache;

  const sourcePath = join(process.cwd(), 'assets', 'js', 'booking-source-of-truth.js');
  const source = readFileSync(sourcePath, 'utf8');
  const sandbox = { window: {} };
  vm.runInNewContext(source, sandbox, { filename: sourcePath, timeout: 1000 });
  catalogCache = sandbox.window.AAE_BOOKING_SOURCE || { subcategories: {} };
  return catalogCache;
}

export function calculateBookingPricing({ services, itemsByService, zip }) {
  const catalog = getBookingCatalog();
  const serviceSet = new Set((Array.isArray(services) ? services : []).map(cleanKey).filter(Boolean));
  const catalogByService = buildCatalogIndex(catalog);

  let itemSubtotalCents = 0;
  let baseItemSubtotalCents = 0;
  let addonItemSubtotalCents = 0;
  let discountableItemCount = 0;
  const servicesWithPricedItems = new Set();
  const normalizedItems = {};
  const invalidItems = [];
  let hasCustomQuote = false;

  for (const serviceName of serviceSet) {
    const serviceCatalog = catalogByService.get(cleanKey(serviceName));
    const submittedItems = Array.isArray(itemsByService?.[serviceName]) ? itemsByService[serviceName] : [];
    normalizedItems[serviceName] = [];

    if (!serviceCatalog) {
      invalidItems.push(`${serviceName}: unknown service`);
      continue;
    }

    for (const submitted of submittedItems) {
      const itemName = cleanKey(submitted?.name);
      if (!itemName) continue;

      const catalogItem = serviceCatalog.items.get(itemName);
      if (!catalogItem) {
        invalidItems.push(`${serviceName}: ${submitted?.name || 'unknown item'}`);
        continue;
      }

      const qty = clampInt(submitted?.qty, 1, 99, 1);
      const unitPriceCents = catalogItem.customQuote ? 0 : dollarsToCents(catalogItem.price);
      const lineTotal = unitPriceCents * qty;
      if (catalogItem.customQuote) hasCustomQuote = true;
      itemSubtotalCents += lineTotal;
      if (!catalogItem.customQuote && unitPriceCents > 0) {
        if (catalogItem.addon === true) {
          addonItemSubtotalCents += lineTotal;
        } else {
          baseItemSubtotalCents += lineTotal;
        }
        discountableItemCount += qty;
        servicesWithPricedItems.add(serviceName);
      }

      normalizedItems[serviceName].push({
        name: catalogItem.name,
        group: catalogItem.group,
        qty,
        price: catalogItem.price,
        priceMax: catalogItem.priceMax || 0,
        addon: catalogItem.addon === true,
        customQuote: catalogItem.customQuote === true,
        unitPriceCents,
        lineTotal,
      });
    }
  }

  const discountPct = servicesWithPricedItems.size >= 2
    ? (discountableItemCount >= 6 ? 15 : discountableItemCount >= 3 ? 10 : 0)
    : 0;
  const discountCents = Math.round(itemSubtotalCents * discountPct / 100);
  const discountedItemSubtotalCents = Math.max(0, itemSubtotalCents - discountCents);
  const callZone = itemSubtotalCents > 0 ? getServiceCallZone(zip) : null;
  const serviceCallFeeCents = itemSubtotalCents > 0 ? getServiceCallFeeCents(zip) : 0;
  const normalizedServiceCallFeeCents = serviceCallFeeCents == null ? 0 : serviceCallFeeCents;
  const taxableSubtotalCents = discountedItemSubtotalCents + normalizedServiceCallFeeCents;
  const taxCents = Math.round(taxableSubtotalCents * TX_TAX_RATE);
  const totalCents = taxableSubtotalCents + taxCents;

  return {
    itemSubtotalCents,
    discountPct,
    discountCents,
    discountedItemSubtotalCents,
    taxableSubtotalCents,
    serviceCallFeeCents: normalizedServiceCallFeeCents,
    callZone,
    taxCents,
    totalCents,
    hasCustomQuote,
    baseItemSubtotalCents,
    addonItemSubtotalCents,
    hasPricedBaseItem: baseItemSubtotalCents > 0,
    hasPricedAddonItem: addonItemSubtotalCents > 0,
    isAddonOnly: addonItemSubtotalCents > 0 && baseItemSubtotalCents === 0,
    normalizedItems,
    invalidItems,
  };
}

function buildCatalogIndex(catalog) {
  const byService = new Map();
  for (const [serviceName, groups] of Object.entries(catalog.subcategories || {})) {
    const service = { name: serviceName, items: new Map() };
    for (const group of groups || []) {
      for (const item of group.items || []) {
        service.items.set(cleanKey(item.name), { ...item, group: group.group });
      }
    }
    byService.set(cleanKey(serviceName), service);
  }
  return byService;
}

function cleanKey(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[‐‑‒–—―]/g, '-')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .trim()
    .replace(/\s+/g, ' ');
}

function dollarsToCents(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : 0;
}

function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
