// The AI assistant connector's tools (api/mcp.js serves them).
//
// Owner, 2026-11-17: "LETS GO WITH THE BOARD DECISION. LETS BUILD IT OUT AND
// FULLY TEST", after the board ruled that AssembleAtEase should be bookable
// from inside Claude, ChatGPT and other AI assistants the way TaskRabbit,
// Thumbtack and Angi are. docs/decisions/2026-11-17-ai-assistant-channel.md.
//
// Every tool READS. None creates a booking, holds a card, sends a message or
// writes a customer record. Booking and payment happen on assembleatease.com
// through the links these tools return (ChatGPT requires checkout on our own
// domain; Claude rejects connectors that move money), so the card hold, the
// terms the customer accepts and the server's own re-pricing stay exactly
// where they are.
//
// Nothing here owns a fact. Each answer is read from the module that does:
//   items, prices, bundles     assets/js/booking-source-of-truth.js (api/_pricing.js)
//   totals                     calculateBookingPricing, the engine api/booking.js charges with
//   search                     assets/js/catalog-search.js, the booking page's own rule
//   dates and arrival windows  api/booking/_booking-window.js, _booking-slots.js
//   where we work              api/_source-of-truth.js
//   policies, contact, hours   api/_public-facts.js, shared with llms.txt
// scripts/test-mcp-server.mjs fails if any answer disagrees with its owner.

import { calculateBookingPricing, getBookingCatalog } from './_pricing.js';
import { catalogSearch } from './_catalog-search.js';
import { trueFromPrice } from '../scripts/lib/catalog-prices.mjs';
import { bookingWindow, validateBookingWindowDate } from './booking/_booking-window.js';
import { BOOKING_TIME_SLOTS, openBookingSlots } from './booking/_booking-slots.js';
import {
  AUTOMATIC_DISPATCH_ZIP_PREFIXES, AUTOMATIC_DISPATCH_ZIPS, SALES_TAX_RATE, SAME_DAY_FEE_CENTS,
  SERVICE_CALL_ZONES, getServiceCallZone, isSameDayServiceEnabled, sameDayFeeForAppointment,
} from './_source-of-truth.js';
import { bookingFacts, factSentence, organization } from './_public-facts.js';

export const SITE = 'https://www.assembleatease.com';

// Which assistant a booking link came from. utm_source on every link; the
// booking keeps it (api/_attribution.js) and the owner's acquisition report
// shows these bookings as the "AI assistant" channel.
export const ASSISTANT_SOURCES = Object.freeze(['claude', 'chatgpt', 'gemini', 'ai_assistant']);
export const ASSISTANT_MEDIUM = 'ai_assistant';

// The catch-all service is the custom-quote flow, not a list of priced items.
const QUOTE_SERVICE = 'Other';
const MAX_ESTIMATE_LINES = 20;
const MAX_QTY = 99;
const MAX_SEARCH_RESULTS = 15;
const MAX_QUERY_LENGTH = 120;

// One Texas ZIP in each service-call zone, so a price can be stated before the
// customer gives an address: the engine prices each zone and the answer says
// whether the zones differ. scripts/test-mcp-server.mjs fails if a sample stops
// landing in its zone or a zone is added without one.
export const ZONE_SAMPLE_ZIPS = Object.freeze({
  austin_core: '78701',
  near_suburb: '78660',
  texas_statewide: '75201',
});

export class ToolInputError extends Error {}

const READ_ONLY = Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });

function tool(name, title, description, inputSchema) {
  return Object.freeze({ name, title, description, inputSchema, annotations: Object.freeze({ title, ...READ_ONLY }) });
}

function serviceNames(catalog) {
  return Object.keys(catalog.subcategories || {}).filter((name) => name !== QUOTE_SERVICE);
}

export function toolDefinitions(catalog = getBookingCatalog()) {
  const services = serviceNames(catalog);
  return [
    tool('list_services', 'List services and prices',
      'Lists AssembleAtEase home-setup services in Texas (furniture assembly, TV and wall mounting, smart home, fitness equipment, outdoor and playsets, office assembly) with each service\'s starting price, its popular items, the room-setup bundles and a booking link for each. Read-only.',
      { type: 'object', properties: {}, additionalProperties: false }),
    tool('search_services', 'Search for a job',
      'Finds catalog items that match keywords for a job, such as "dresser", "TV wall mount" or "treadmill", and returns each item\'s fixed price and a booking link. Read-only.',
      {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 1, maxLength: MAX_QUERY_LENGTH, description: 'What needs doing, in a few words, for example "queen bed frame" or "mount a TV".' },
          service: { type: 'string', enum: services, description: 'Only search this service.' },
        },
        required: ['query'],
        additionalProperties: false,
      }),
    tool('estimate_price', 'Price a job',
      'Prices catalog items with the engine AssembleAtEase checkout uses: each item, any multi-service discount, the service-call fee, Texas sales tax and the total. Returns a booking link with the items already in the cart. Item names must match the catalog exactly, as search_services and list_services return them. Does not book or charge anything.',
      {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            minItems: 1,
            maxItems: MAX_ESTIMATE_LINES,
            items: {
              type: 'object',
              properties: {
                service: { type: 'string', enum: services, description: 'The service the item belongs to.' },
                item: { type: 'string', minLength: 1, maxLength: 160, description: 'The exact catalog item name.' },
                quantity: { type: 'integer', minimum: 1, maximum: MAX_QTY, default: 1 },
              },
              required: ['service', 'item'],
              additionalProperties: false,
            },
          },
        },
        required: ['items'],
        additionalProperties: false,
      }),
    tool('get_appointment_times', 'Check appointment times',
      'Returns the dates AssembleAtEase takes bookings for and the two-hour arrival windows the booking page offers, with the windows still open on a given date. Read-only; it does not hold a time.',
      {
        type: 'object',
        properties: {
          date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'A date as YYYY-MM-DD (Central time). Leave out for today.' },
        },
        additionalProperties: false,
      }),
    tool('get_service_area', 'Check where we work',
      'Describes where AssembleAtEase takes bookings in Texas, including the ZIP codes where a pro is matched automatically and what happens elsewhere in Texas. Read-only.',
      { type: 'object', properties: {}, additionalProperties: false }),
    tool('get_booking_policies', 'Read booking policies',
      'Returns AssembleAtEase booking terms: when the card is charged, the cancellation fee rules, how custom quotes work, who the pros are, and the phone number, email and support hours. Read-only.',
      { type: 'object', properties: {}, additionalProperties: false }),
  ];
}

// ── shared helpers ─────────────────────────────────────────────────────────

export function dollars(cents) {
  const n = Math.round(Number(cents) || 0);
  return `$${(n / 100).toFixed(2)}`;
}

function wholeDollars(value) {
  const n = Number(value) || 0;
  return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
}

function itemPrice(item) {
  if (item.customQuote) return 'Custom quote';
  return wholeDollars(item.price);
}

/** A booking page link, tagged with the assistant and the tool that made it. */
export function bookingUrl({ source = 'ai_assistant', toolName, service, item, bundle, cart } = {}) {
  const url = new URL('/book', SITE);
  if (bundle) url.searchParams.set('bundle', bundle);
  else if (Array.isArray(cart) && cart.length) {
    for (const line of cart) url.searchParams.append('add', `${line.service}|${line.item}|${line.quantity}`);
  } else if (service) {
    url.searchParams.set('service', service);
    if (item) url.searchParams.set('item', item);
  }
  url.searchParams.set('utm_source', ASSISTANT_SOURCES.includes(source) ? source : 'ai_assistant');
  url.searchParams.set('utm_medium', ASSISTANT_MEDIUM);
  if (toolName) url.searchParams.set('utm_campaign', `mcp_${toolName}`);
  return url.toString();
}

function facts(catalog) {
  return bookingFacts({ org: organization(), services: serviceNames(catalog) });
}

function catalogItems(catalog, onlyService) {
  const rows = [];
  for (const [service, groups] of Object.entries(catalog.subcategories || {})) {
    if (service === QUOTE_SERVICE) continue;
    if (onlyService && service !== onlyService) continue;
    for (const group of groups || []) {
      for (const item of group.items || []) rows.push({ service, group: group.group, item });
    }
  }
  return rows;
}

function sameText(a, b) {
  return String(a || '').normalize('NFKC').replace(/[‐‑‒–—―]/g, '-').replace(/[“”]/g, '"').replace(/[‘’]/g, "'")
    .trim().replace(/\s+/g, ' ').toLowerCase()
    === String(b || '').normalize('NFKC').replace(/[‐‑‒–—―]/g, '-').replace(/[“”]/g, '"').replace(/[‘’]/g, "'")
      .trim().replace(/\s+/g, ' ').toLowerCase();
}

function resultLine({ service, group, item }, source, toolName) {
  return {
    service,
    group,
    item: item.name,
    price: itemPrice(item),
    addOn: item.addon === true,
    customQuote: item.customQuote === true,
    bookingUrl: item.customQuote
      ? bookingUrl({ source, toolName, service: QUOTE_SERVICE })
      : bookingUrl({ source, toolName, service, item: item.name }),
  };
}

function customQuote(catalog, source, toolName) {
  return {
    description: `Anything not in the catalog is priced by custom quote: ${facts(catalog).customQuotes}`,
    bookingUrl: bookingUrl({ source, toolName, service: QUOTE_SERVICE }),
  };
}

function requireObject(args) {
  if (args == null) return {};
  if (typeof args !== 'object' || Array.isArray(args)) throw new ToolInputError('Arguments must be an object.');
  return args;
}

function rejectUnknownKeys(args, allowed) {
  const extra = Object.keys(args).filter((key) => !allowed.includes(key));
  if (extra.length) throw new ToolInputError(`Unknown argument${extra.length > 1 ? 's' : ''}: ${extra.join(', ')}. Allowed: ${allowed.length ? allowed.join(', ') : 'none'}.`);
}

// ── tools ──────────────────────────────────────────────────────────────────

function listServices(args, { catalog, source }) {
  rejectUnknownKeys(requireObject(args), []);
  const services = serviceNames(catalog).map((name) => {
    const groups = catalog.subcategories[name] || [];
    const bookable = groups.flatMap((g) => g.items || []).filter((i) => !i.customQuote && !i.addon && i.price > 0);
    const from = trueFromPrice(groups);
    return {
      service: name,
      startingPrice: from == null ? 'Custom quote' : wholeDollars(from),
      bookableItems: bookable.length,
      popular: bookable.filter((i) => i.popular).map((i) => ({ item: i.name, price: wholeDollars(i.price) })),
      bookingUrl: bookingUrl({ source, toolName: 'list_services', service: name }),
    };
  });
  const bundles = (catalog.bundles || []).filter((b) => b.active !== false)
    .sort((a, b) => (a.displayOrder || 0) - (b.displayOrder || 0))
    .map((bundle) => {
      const included = (bundle.included || []).map((ref) => ({ service: ref.service, item: ref.name }));
      const pricing = priceLines(included.map((l) => ({ ...l, quantity: 1 })));
      return {
        bundle: bundle.name,
        outcome: bundle.outcome,
        includes: included.map((l) => l.item),
        itemsSubtotal: dollars(pricing.itemSubtotalCents),
        multiServiceDiscount: pricing.discountCents > 0 ? { percent: pricing.discountPct, amount: `-${dollars(pricing.discountCents)}` } : null,
        priceNote: 'Before the service-call fee and Texas sales tax.',
        bookingUrl: bookingUrl({ source, toolName: 'list_services', bundle: bundle.slug }),
      };
    });
  return {
    services,
    bundles,
    customQuote: customQuote(catalog, source, 'list_services'),
    prices: factSentence(facts(catalog), 'prices'),
  };
}

function searchServices(args, { catalog, source }) {
  args = requireObject(args);
  rejectUnknownKeys(args, ['query', 'service']);
  const query = typeof args.query === 'string' ? args.query.trim().replace(/\s+/g, ' ') : '';
  if (!query) throw new ToolInputError('query is required: a few words describing the job, for example "dresser" or "mount a TV".');
  if (query.length > MAX_QUERY_LENGTH) throw new ToolInputError(`query is ${query.length} characters; keep it to ${MAX_QUERY_LENGTH} or fewer.`);
  const services = serviceNames(catalog);
  if (args.service != null && !services.includes(args.service)) {
    throw new ToolInputError(`service "${args.service}" is not one of: ${services.join(', ')}.`);
  }
  const search = catalogSearch();
  const rows = catalogItems(catalog, args.service).map((row, order) => ({
    ...row, order, text: search.searchText(row.service, row.group, row.item.name),
  }));

  // The booking page's rule: every word must start a word the item answers to.
  let match = 'all_words';
  let hits = rows.map((row) => ({ row, rank: search.rank(query, row.text) }))
    .filter((h) => h.rank !== -1)
    .sort((a, b) => a.rank - b.rank || a.row.order - b.row.order);
  // An assistant writes whole sentences ("mount a 65 inch TV over the
  // fireplace"). When no item answers to every word, the same rule is applied
  // word by word and items are ranked by how many words they answer to.
  if (!hits.length) {
    const wanted = search.queryWords(query);
    hits = rows.map((row) => ({ row, score: wanted.filter((word) => search.rank(word, row.text) !== -1).length }))
      .filter((h) => h.score > 0)
      .sort((a, b) => b.score - a.score || a.row.order - b.row.order);
    match = hits.length ? 'some_words' : 'none';
  }
  const results = hits.slice(0, MAX_SEARCH_RESULTS).map((h) => resultLine(h.row, source, 'search_services'));
  return {
    query,
    match,
    results,
    moreResults: Math.max(0, hits.length - results.length),
    addOns: results.some((r) => r.addOn) ? 'Items marked addOn are booked together with a main item, not on their own.' : undefined,
    customQuote: customQuote(catalog, source, 'search_services'),
  };
}

// Prices item lines with the checkout engine for one ZIP. Lines are
// { service, item, quantity }.
function priceLines(lines, zip = null) {
  const services = [];
  const itemsByService = {};
  for (const line of lines) {
    if (!itemsByService[line.service]) { itemsByService[line.service] = []; services.push(line.service); }
    itemsByService[line.service].push({ name: line.item, qty: line.quantity });
  }
  return calculateBookingPricing({ services, itemsByService, zip });
}

function estimatePrice(args, { catalog, source }) {
  args = requireObject(args);
  rejectUnknownKeys(args, ['items']);
  if (!Array.isArray(args.items) || !args.items.length) {
    throw new ToolInputError('items is required: a list of { service, item, quantity } using exact catalog names from search_services or list_services.');
  }
  if (args.items.length > MAX_ESTIMATE_LINES) throw new ToolInputError(`items has ${args.items.length} lines; price up to ${MAX_ESTIMATE_LINES} at a time.`);
  const services = serviceNames(catalog);
  const all = catalogItems(catalog);
  const merged = new Map();
  args.items.forEach((raw, index) => {
    const at = `items[${index}]`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ToolInputError(`${at} must be an object with service, item and quantity.`);
    rejectUnknownKeys(raw, ['service', 'item', 'quantity']);
    if (!services.includes(raw.service)) throw new ToolInputError(`${at}.service "${raw.service ?? ''}" is not one of: ${services.join(', ')}.`);
    const quantity = raw.quantity == null ? 1 : raw.quantity;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QTY) throw new ToolInputError(`${at}.quantity must be a whole number from 1 to ${MAX_QTY}.`);
    const found = all.find((row) => row.service === raw.service && sameText(row.item.name, raw.item));
    if (!found) {
      const search = catalogSearch();
      const near = all.filter((row) => row.service === raw.service)
        .filter((row) => search.queryWords(String(raw.item || '')).some((word) => search.rank(word, search.searchText(row.service, row.group, row.item.name)) !== -1))
        .slice(0, 5).map((row) => row.item.name);
      throw new ToolInputError(`${at}.item "${raw.item ?? ''}" is not in ${raw.service}.${near.length ? ` Closest catalog items: ${near.join('; ')}.` : ' Use search_services to find the exact name.'}`);
    }
    const key = `${found.service}\u0000${found.item.name}`;
    const line = merged.get(key) || { service: found.service, item: found.item.name, quantity: 0, catalogItem: found.item };
    line.quantity = Math.min(MAX_QTY, line.quantity + quantity);
    merged.set(key, line);
  });
  const lines = Array.from(merged.values());

  const byZone = Object.keys(SERVICE_CALL_ZONES).map((zone) => ({ zone, pricing: priceLines(lines, ZONE_SAMPLE_ZIPS[zone]) }));
  const pricing = byZone[0].pricing;
  if (pricing.invalidItems.length) throw new ToolInputError(`These items could not be priced: ${pricing.invalidItems.join('; ')}.`);
  if (pricing.isAddonOnly) {
    throw new ToolInputError('Add-ons are booked together with a main item. Add a main item (an item without addOn) or request a custom quote.');
  }

  const quoteLines = lines.filter((l) => l.catalogItem.customQuote);
  const totals = byZone.map((z) => z.pricing.totalCents);
  const fees = byZone.map((z) => z.pricing.serviceCallFeeCents);
  const sameFee = Math.min(...fees) === Math.max(...fees);
  const notes = [];
  if (quoteLines.length) notes.push(`${quoteLines.map((l) => l.item).join('; ')} ${quoteLines.length > 1 ? 'are' : 'is'} priced by custom quote and not included in the total.`);
  if (!sameFee) notes.push('The service-call fee depends on the address; the total is shown for each case.');
  if (isSameDayServiceEnabled() && pricing.itemSubtotalCents > 0) notes.push(`A same-day appointment adds ${dollars(SAME_DAY_FEE_CENTS)} before tax.`);
  notes.push('The same total is shown at checkout before the booking is placed. Promo codes and gift cards are applied there.');

  const priced = pricing.itemSubtotalCents > 0;
  const result = {
    items: lines.map((l) => {
      const normalized = (pricing.normalizedItems[l.service] || []).find((n) => n.name === l.item);
      return {
        service: l.service,
        item: l.item,
        quantity: l.quantity,
        unitPrice: l.catalogItem.customQuote ? 'Custom quote' : dollars(normalized?.unitPriceCents ?? 0),
        lineTotal: l.catalogItem.customQuote ? 'Custom quote' : dollars(normalized?.lineTotal ?? 0),
        addOn: l.catalogItem.addon === true,
      };
    }),
    itemsSubtotal: dollars(pricing.itemSubtotalCents),
    multiServiceDiscount: pricing.discountCents > 0 ? { percent: pricing.discountPct, amount: `-${dollars(pricing.discountCents)}` } : null,
    serviceCallFee: priced ? (sameFee ? dollars(fees[0]) : byZone.map((z) => ({ area: SERVICE_CALL_ZONES[z.zone].label, fee: dollars(z.pricing.serviceCallFeeCents) }))) : dollars(0),
    salesTax: { rate: `${+(SALES_TAX_RATE * 100).toFixed(4)}%`, amount: dollars(pricing.taxCents) },
    total: sameFee ? dollars(totals[0]) : byZone.map((z) => ({ area: SERVICE_CALL_ZONES[z.zone].label, total: dollars(z.pricing.totalCents) })),
    totalCents: sameFee ? totals[0] : undefined,
    currency: 'USD',
    payment: factSentence(facts(catalog), 'payment'),
    notes,
    bookingUrl: priced
      ? bookingUrl({ source, toolName: 'estimate_price', cart: lines })
      : bookingUrl({ source, toolName: 'estimate_price', service: QUOTE_SERVICE }),
  };
  return result;
}

function appointmentTimes(args, { now, source }) {
  args = requireObject(args);
  rejectUnknownKeys(args, ['date']);
  const window = bookingWindow(now);
  let date = window.firstDate;
  if (args.date != null) {
    const check = validateBookingWindowDate(args.date, now);
    if (typeof args.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(args.date) || check.code === 'INVALID_APPOINTMENT_DATE') {
      throw new ToolInputError(`date must be a real date written YYYY-MM-DD. Bookings are taken from ${window.firstDate} to ${window.lastDate}.`);
    }
    if (!check.ok) {
      throw new ToolInputError(`${args.date} is ${check.code === 'APPOINTMENT_IN_PAST' ? 'in the past' : 'outside the booking window'}. Bookings are taken from ${window.firstDate} to ${window.lastDate} (Central time).`);
    }
    date = check.requestedIso;
  }
  const open = openBookingSlots(date, now);
  const sameDayFee = sameDayFeeForAppointment(date, now);
  return {
    date,
    timeZone: 'America/Chicago',
    openArrivalWindows: open,
    allArrivalWindows: BOOKING_TIME_SLOTS.slice(),
    bookableFrom: window.firstDate,
    bookableUntil: window.lastDate,
    sameDayFee: sameDayFee > 0 ? `${dollars(sameDayFee)} before tax` : undefined,
    note: open.length
      ? 'The customer picks one of these arrival windows on the booking page.'
      : `No arrival windows are left on ${date}. Bookings are taken from ${window.firstDate} to ${window.lastDate}.`,
    bookingUrl: bookingUrl({ source, toolName: 'get_appointment_times' }),
  };
}

function serviceArea(args, { catalog, source }) {
  rejectUnknownKeys(requireObject(args), []);
  const f = facts(catalog);
  const fees = Array.from(new Set(Object.values(SERVICE_CALL_ZONES).map((z) => z.fee)));
  // Every sample must land in its zone; otherwise the fee statement below would not be the engine's.
  for (const [zone, zip] of Object.entries(ZONE_SAMPLE_ZIPS)) {
    if (getServiceCallZone(zip) !== zone) throw new Error(`ZONE_SAMPLE_ZIPS.${zone} (${zip}) is not in that zone`);
  }
  return {
    summary: factSentence(f, 'where'),
    state: 'Texas',
    automaticMatching: {
      zipPrefixes: AUTOMATIC_DISPATCH_ZIP_PREFIXES.slice(),
      zipCodes: AUTOMATIC_DISPATCH_ZIPS.slice(),
      description: 'A ZIP code that starts with one of zipPrefixes, or is listed in zipCodes, is in a core area.',
    },
    outsideTexas: 'Bookings are taken for Texas addresses only.',
    serviceCallFee: fees.length === 1
      ? `${dollars(fees[0])} on every booking, before tax.`
      : Object.values(SERVICE_CALL_ZONES).map((z) => `${z.label}: ${dollars(z.fee)}`).join('; '),
    bookingUrl: bookingUrl({ source, toolName: 'get_service_area' }),
  };
}

function bookingPolicies(args, { catalog, source }) {
  rejectUnknownKeys(requireObject(args), []);
  const f = facts(catalog);
  const org = organization();
  return {
    payment: factSentence(f, 'payment'),
    cancellation: factSentence(f, 'cancellation'),
    customQuotes: factSentence(f, 'customQuotes'),
    prices: factSentence(f, 'prices'),
    pros: f.pros,
    contact: factSentence(f, 'contact'),
    phone: org.telephone,
    email: org.email,
    termsUrl: `${SITE}/terms`,
    privacyUrl: `${SITE}/privacy`,
    bookingUrl: bookingUrl({ source, toolName: 'get_booking_policies' }),
  };
}

const HANDLERS = {
  list_services: listServices,
  search_services: searchServices,
  estimate_price: estimatePrice,
  get_appointment_times: appointmentTimes,
  get_service_area: serviceArea,
  get_booking_policies: bookingPolicies,
};

export function hasTool(name) {
  return Object.prototype.hasOwnProperty.call(HANDLERS, name);
}

/**
 * Runs one tool. Returns the MCP CallToolResult. Bad arguments come back as a
 * tool error the assistant can read and correct (isError: true), never as a
 * protocol error.
 */
export function callTool(name, args, { catalog = getBookingCatalog(), source = 'ai_assistant', now = new Date() } = {}) {
  if (!hasTool(name)) throw new Error(`Unknown tool: ${name}`);
  try {
    const structured = JSON.parse(JSON.stringify(HANDLERS[name](args, { catalog, source, now })));
    return { content: [{ type: 'text', text: JSON.stringify(structured) }], structuredContent: structured };
  } catch (error) {
    if (error instanceof ToolInputError) {
      return { content: [{ type: 'text', text: error.message }], isError: true };
    }
    throw error;
  }
}
