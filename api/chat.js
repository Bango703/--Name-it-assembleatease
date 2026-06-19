import Anthropic from '@anthropic-ai/sdk';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rateLimit } from './_ratelimit.js';
import { getBookingCatalog } from './_pricing.js';
import { getServiceCallFeeCents } from './_source-of-truth.js';

function getServiceStartPrices() {
  const catalog = getBookingCatalog();
  const serviceStarts = {};
  for (const [serviceName, groups] of Object.entries(catalog.subcategories || {})) {
    if (serviceName === 'Other') continue;
    let min = Infinity;
    for (const group of groups || []) {
      for (const item of group.items || []) {
        const price = Number(item?.price || 0);
        if (item?.addon === true || item?.customQuote === true || price <= 0) continue;
        min = Math.min(min, price);
      }
    }
    if (Number.isFinite(min)) serviceStarts[serviceName] = min;
  }
  return serviceStarts;
}

const STARTS = getServiceStartPrices();
const SERVICE_CALL_FEE_DOLLARS = Math.round((getServiceCallFeeCents('78701') || 0) / 100);
const PRICING_LINE = [
  `Furniture from $${STARTS['Furniture Assembly'] || 69}`,
  `TV mounting from $${STARTS['Mounting & Hanging'] || 79}`,
  `Smart home from $${STARTS['Smart Home'] || 69}`,
  `Fitness equipment from $${STARTS['Fitness Equipment'] || 119}`,
  `Office furniture from $${STARTS['Office Assembly'] || 89}`,
  `Outdoor and playsets from $${STARTS['Outdoor & Playsets'] || 89}`,
].join(', ');

const ROOT_ROUTES = Object.freeze({
  book: '/book',
  pricing: '/pricing',
  blogs: '/blog',
  about: '/about',
  contact: '/contact',
  track: '/track',
});

function loadBlogRoutes() {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const blogDir = join(here, '..', 'blog');
    return new Set(
      readdirSync(blogDir)
        .filter((name) => name.endsWith('.html') && name !== 'index.html')
        .map((name) => `${ROOT_ROUTES.blogs}/${name.slice(0, -5)}`),
    );
  } catch {
    return new Set();
  }
}

const BLOG_ROUTES = loadBlogRoutes();
const TOP_LEVEL_ROUTE_SET = new Set(Object.values(ROOT_ROUTES));
const BLOG_ROUTE_LINE = BLOG_ROUTES.size
  ? `Available blog links: ${[...BLOG_ROUTES].sort().join(', ')}.`
  : 'If you mention a blog, use /blog.';

function trimRouteNoise(route) {
  return String(route || '')
    .trim()
    .replace(/^https?:\/\/(?:www\.)?assembleatease\.com/i, '')
    .replace(/^[("'`]+/, '')
    .replace(/[)"'`]+$/, '')
    .replace(/[.,!?;:]+$/, '');
}

export function normalizeChatRoute(rawRoute) {
  const cleaned = trimRouteNoise(rawRoute);
  if (!cleaned || !cleaned.startsWith('/')) return null;

  const noHash = cleaned.split('#')[0] || cleaned;
  const pathOnly = (noHash.split('?')[0] || '').replace(/\/+$/, '') || '/';

  if (pathOnly === '/') return '/';
  if (pathOnly === ROOT_ROUTES.book || pathOnly.startsWith(`${ROOT_ROUTES.book}/`)) return ROOT_ROUTES.book;
  if (pathOnly === ROOT_ROUTES.pricing || pathOnly.startsWith(`${ROOT_ROUTES.pricing}/`)) return ROOT_ROUTES.pricing;
  if (pathOnly === ROOT_ROUTES.about || pathOnly.startsWith(`${ROOT_ROUTES.about}/`)) return ROOT_ROUTES.about;
  if (pathOnly === ROOT_ROUTES.contact || pathOnly.startsWith(`${ROOT_ROUTES.contact}/`)) return ROOT_ROUTES.contact;
  if (pathOnly === ROOT_ROUTES.track || pathOnly.startsWith(`${ROOT_ROUTES.track}/`)) return ROOT_ROUTES.track;
  if (pathOnly === ROOT_ROUTES.blogs) return ROOT_ROUTES.blogs;
  if (pathOnly.startsWith(`${ROOT_ROUTES.blogs}/`)) {
    return BLOG_ROUTES.has(pathOnly) ? pathOnly : ROOT_ROUTES.blogs;
  }

  return TOP_LEVEL_ROUTE_SET.has(pathOnly) ? pathOnly : null;
}

function fallbackRouteFor(rawRoute) {
  const lower = String(rawRoute || '').toLowerCase();
  if (lower.includes('/blog')) return ROOT_ROUTES.blogs;
  if (lower.includes('/pricing') || lower.includes('price')) return ROOT_ROUTES.pricing;
  if (lower.includes('/contact') || lower.includes('support') || lower.includes('refund')) return ROOT_ROUTES.contact;
  if (lower.includes('/track') || lower.includes('status')) return ROOT_ROUTES.track;
  if (lower.includes('/about')) return ROOT_ROUTES.about;
  return ROOT_ROUTES.book;
}

export function sanitizeReplyLinks(reply) {
  let text = String(reply || '');

  text = text.replace(/\[([^\]]+)\]\(((?:https?:\/\/(?:www\.)?assembleatease\.com)?\/[^\s)]+)\)/gi, (_, label, href) => {
    const route = normalizeChatRoute(href) || fallbackRouteFor(href);
    return `${label}: ${route}`;
  });

  text = text.replace(/https?:\/\/(?:www\.)?assembleatease\.com(\/[^\s<>()\]]*)/gi, (_, href) => {
    return normalizeChatRoute(href) || fallbackRouteFor(href);
  });

  text = text.replace(/(^|[\s(])((?:\/[A-Za-z0-9][^\s<>()\]]*))/g, (_, lead, href) => {
    const route = normalizeChatRoute(href) || fallbackRouteFor(href);
    return `${lead}${route}`;
  });

  return text.replace(/\s{2,}/g, ' ').trim();
}

// Public customer-facing assistant ("Sora"). Q&A + booking guidance only —
// it NEVER takes payment or creates bookings (it hands off to /book).
const SYSTEM = `You are Sora, the friendly assistant for AssembleAtEase — a professional home-assembly marketplace serving Austin, TX and the surrounding metro. You help website visitors with questions and getting booked.

WHAT WE DO: Furniture assembly, TV mounting and wall hanging, smart home setup, fitness equipment assembly, office furniture assembly, and outdoor/playset assembly.

PRICING (flat, per item): ${PRICING_LINE}. A flat $${SERVICE_CALL_FEE_DOLLARS} service-call fee and tax are added at checkout. The customer always sees the full total before they confirm. NEVER invent or guess a specific price beyond these "from" figures. If asked for an exact quote, explain it depends on the items and that the full total is shown in the booking flow, and point them to /book or /pricing.

SERVICE AREA: Austin and the surrounding metro (Round Rock, Cedar Park, Pflugerville, Lakeway and more). If someone seems outside the Austin metro, be honest that we may not serve them yet and invite them to check their ZIP in the booking flow.

PAYMENT: The customer's card is securely verified and held when they book, and they are only charged AFTER the job is completed. Checkout is secured by Stripe. Never ask for or accept card numbers or payment details in chat.

CANCELLATION: Free up to 24 hours before the appointment. Within 24 hours a small fee applies (10%, or 15% once a pro is on the way) — on the service price only, never tax, never the full amount.

TOOLS AND HARDWARE: Our pros bring all the TOOLS. The customer provides the item, its hardware, and any wall mount. We do NOT supply mounts or hardware. If they're unsure what fits, they can coordinate with their pro after booking. Never say we provide mounts or hardware.

PROS AND TRUST: Every pro is identity-verified and personally reviewed before their first job. We share the pro's photo, rating and job count before arrival.

BOOKING: To book, point them to /book (booking takes under 2 minutes). For pricing details, point them to /pricing.
REAL LINKS: Only use exact AssembleAtEase routes that already exist. Core routes: /book, /pricing, /blog, /about, /contact, /track. ${BLOG_ROUTE_LINE} If you are not completely sure of a deeper page, use /book, /pricing, or /blog instead of inventing a URL.

HOW TO RESPOND:
- Be warm and concise: 1 to 4 short sentences. Plain text only — no markdown, no bullet symbols, no emojis.
- Personality: sound calm, capable, and human. A little conversational is good. A little dry wit is okay when it feels natural. Never sound pushy, cheesy, or fake.
- Only discuss AssembleAtEase: its services, pricing, area, booking and policies. Politely decline anything off-topic and steer back.
- When helpful, include a plain link like /book or /pricing. Never make up a route, slug, or URL.
- For complaints, existing-booking issues, refunds, or anything you are unsure about, hand off to service@assembleatease.com or (737) 290-6129.
- Do not guarantee same-day; say it is "often available."
- Never make up facts, prices, or promises beyond what is stated here.`;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const key = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY_2;
  if (!key) {
    return res.status(503).json({ reply: 'Chat is unavailable right now — please email service@assembleatease.com or call (737) 290-6129, or book at /book.' });
  }

  // Rate limit by IP (fail-open if the limiter itself errors).
  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim() || 'unknown';
  const allowed = await rateLimit(ip, 'chat').catch(() => true);
  if (!allowed) {
    return res.status(429).json({ reply: "You're sending messages quickly — give me a few seconds, then try again." });
  }

  let { messages } = req.body || {};
  if (!Array.isArray(messages)) messages = [];
  const clean = messages
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content.slice(0, 1000) }))
    .slice(-12);
  if (!clean.length || clean[clean.length - 1].role !== 'user') {
    return res.status(400).json({ error: 'A user message is required.' });
  }

  try {
    const client = new Anthropic({ apiKey: key });
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 320,
      system: SYSTEM,
      messages: clean,
    });
    const reply = sanitizeReplyLinks(msg.content?.[0]?.text?.trim())
      || "Sorry, I didn't catch that — could you rephrase? You can also email service@assembleatease.com.";
    return res.status(200).json({ reply });
  } catch (e) {
    console.error('Sora chat error:', e);
    return res.status(500).json({ reply: "I'm having trouble right now. Please email service@assembleatease.com or call (737) 290-6129, or book directly at /book." });
  }
}
