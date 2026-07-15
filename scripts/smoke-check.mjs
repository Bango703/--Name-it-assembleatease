import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { normalizeChatRoute, sanitizeReplyLinks } from '../api/chat.js';
import { applyPromotionToPricing, resolveBookingPromotion } from '../api/_promotions.js';
import { businessIdentity, governanceConfig } from './lib/site-governance.mjs';

const files = [
  'api/booking.js',
  'api/booking/promo-preview.js',
  'api/promo.js',
  'api/owner/promo.js',
  'api/booking-confirmed.js',
  'api/booking/complete.js',
  'api/booking/assembler-complete.js',
  'api/booking/payout.js',
  'api/booking/refund.js',
  'api/assembler/apply.js',
  'api/chat.js',
  'api/owner/site-chat.js',
  'api/assembler/stripe-webhook.js',
  'api/cron/auto-blog.js',
];

for (const file of files) {
  execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
}

const normalizedBookingRoute = normalizeChatRoute('/book?service=Furniture+Assembly');
if (normalizedBookingRoute !== '/book') {
  throw new Error(`Chat should normalize booking query links to /book; got ${normalizedBookingRoute}`);
}

const normalizedBlogRoute = normalizeChatRoute('https://www.assembleatease.com/blog/ikea-assembly-cost-austin');
if (normalizedBlogRoute !== '/blog/ikea-assembly-cost-austin') {
  throw new Error(`Chat should preserve real blog links; got ${normalizedBlogRoute}`);
}

const sanitizedFallbackReply = sanitizeReplyLinks('Start here: /services/tv-mounting and pricing lives at https://www.assembleatease.com/pricing.');
if (!sanitizedFallbackReply.includes('/book') || !sanitizedFallbackReply.includes('/pricing')) {
  throw new Error(`Chat should rewrite unknown internal links to real routes; got ${sanitizedFallbackReply}`);
}

const staleCopyChecks = [
  {
    file: 'api/booking/payout.js',
    blocked: ['Payout Sent', 'we sent a payout', "you've been paid"],
  },
  {
    file: 'terms.html',
    blocked: ['always uses Stripe Connect', 'non-refundable $30 application fee'],
  },
];

for (const check of staleCopyChecks) {
  const text = readFileSync(check.file, 'utf8').toLowerCase();
  for (const phrase of check.blocked) {
    if (text.includes(phrase.toLowerCase())) {
      throw new Error(`Stale launch-risk copy found in ${check.file}: ${phrase}`);
    }
  }
}

const homepage = readFileSync('index.html', 'utf8');
if (!homepage.includes('/assets/js/site-promo.js')) {
  throw new Error('Homepage must load the shared promo script');
}
if (!homepage.includes('id="new-customer-offer"')) {
  throw new Error('Homepage must expose the promo mount point');
}
if (homepage.includes('promo=WELCOME25')) {
  throw new Error('Homepage should no longer hardcode a specific promo code in booking links');
}
const homepageGuides = homepage.match(/<section class="guides-section guides-section--alt" id="guides">([\s\S]*?)<\/section>/)?.[1];
if (!homepageGuides) throw new Error('Homepage guides section not found');

const homepageGuideCount = (homepageGuides.match(/class="guide-card"/g) || []).length;
if (homepageGuideCount < 6 || homepageGuideCount % 2 !== 0) {
  throw new Error(`Homepage guides must use an even count of at least 6 cards; found ${homepageGuideCount}`);
}

const homepageGuideImages = [...homepageGuides.matchAll(/<img[^>]+src="([^"]+)"/g)].map((match) => match[1]);
const duplicateGuideImage = homepageGuideImages.find((src, index) => homepageGuideImages.indexOf(src) !== index);
if (duplicateGuideImage) {
  throw new Error(`Homepage guides must not reuse the same image: ${duplicateGuideImage}`);
}

const customerReviewsSection = homepage.match(/<section class="section section-alt" id="reviews">([\s\S]*?)<\/script>/)?.[1];
if (!customerReviewsSection) throw new Error('Homepage customer reviews section not found');

const displayedReviewCount = Number(customerReviewsSection.match(/(\d+)\s+Google reviews/)?.[1] || 0);
const customerReviewCount = (customerReviewsSection.match(/{b:"/g) || []).length;
if (!displayedReviewCount || displayedReviewCount !== customerReviewCount) {
  throw new Error(`Homepage Google review count must match carousel cards; displayed ${displayedReviewCount}, found ${customerReviewCount}`);
}

const faviconSvg = readFileSync('images/favicon.svg', 'utf8');
if (/<text\b/i.test(faviconSvg) || />\s*AE\s*</i.test(faviconSvg)) {
  throw new Error('Favicon must use the logo mark, not plain AE text');
}

const marketingDesktopCss = readFileSync('assets/css/marketing-desktop.css', 'utf8');
if (!marketingDesktopCss.includes('.nav-book-pill{display:inline-flex}')) {
  throw new Error('Desktop marketing CSS must show the shared nav-book-pill CTA');
}

// Favicons must be valid, correctly-formatted files. The old /favicon.ico was a
// JPEG renamed .ico, which Google rejects (generic globe in search results).
// Regenerate with: python scripts/make-favicons.py
const faviconIco = readFileSync('favicon.ico');
if (faviconIco.length < 4 || faviconIco.readUInt32LE(0) !== 0x00010000) {
  throw new Error('favicon.ico must be a real ICO file (magic 00 00 01 00), not a renamed JPEG/PNG');
}
for (const iconPng of ['images/favicon-96.png', 'images/apple-touch-icon.png', 'images/icon-192.png', 'images/icon-512.png']) {
  if (!existsSync(iconPng)) throw new Error(`Missing favicon asset (run scripts/make-favicons.py): ${iconPng}`);
  if (readFileSync(iconPng).subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    throw new Error(`Favicon asset must be a real PNG: ${iconPng}`);
  }
}

const trustStrip = homepage.match(/<div class="trust-strip">([\s\S]*?)<\/div>\s*<\/div>/)?.[1];
if (!trustStrip) throw new Error('Homepage mobile trust strip not found');

const trustItemCount = (trustStrip.match(/class="trust-item"/g) || []).length;
if (trustItemCount !== 4) {
  throw new Error(`Homepage mobile trust strip should use 4 even trust items; found ${trustItemCount}`);
}

if (!homepageGuides.includes('class="guides-scroll-dots"')) {
  throw new Error('Homepage blog carousel must include mobile swipe cue dots');
}

const desktopServiceCardCount = (homepage.match(/class="svc5-card"/g) || []).length;
if (desktopServiceCardCount < 6 || desktopServiceCardCount % 2 !== 0) {
  throw new Error(`Homepage desktop services must use an even count of at least 6 cards; found ${desktopServiceCardCount}`);
}

if (!homepage.includes('href="/assembler/apply"')) {
  throw new Error('Homepage must include Become an Easer entry point');
}

const soraWidgetCount = (homepage.match(/<!-- AAE Help Chat/g) || []).length;
if (soraWidgetCount !== 1) {
  throw new Error(`Homepage should include exactly one Sora chat widget; found ${soraWidgetCount}`);
}
if (!homepage.includes('/api/chat')) {
  throw new Error('Homepage Sora widget must call /api/chat');
}
if (!homepage.includes('>Sora<')) {
  throw new Error('Homepage Sora widget should display the Sora assistant name');
}
if (!homepage.includes('conversationId:chatContext.conversationId') || !homepage.includes("CHAT_CONVERSATION_KEY='aae-chat-conversation-id-v1'")) {
  throw new Error('Homepage Sora widget must send a stable conversation ID for owner chat capture');
}

const ownerDashboard = readFileSync('owner/index.html', 'utf8');
if (!ownerDashboard.includes('/api/owner/site-chat') || !ownerDashboard.includes('Website Chat Inbox')) {
  throw new Error('Owner dashboard must expose the website chat inbox');
}
if (!ownerDashboard.includes('/api/owner/promo') || !ownerDashboard.includes('Promo Control')) {
  throw new Error('Owner dashboard must expose live promo controls');
}
const reportRowsStart = ownerDashboard.indexOf('var rows = allBookings.map(function(b)');
const reportRowsEnd = ownerDashboard.indexOf('var reportDate =', reportRowsStart);
const reportRows = ownerDashboard.slice(reportRowsStart, reportRowsEnd);
if (reportRowsStart < 0 || reportRowsEnd < 0
    || !reportRows.includes('esc(b.customer_name)')
    || !reportRows.includes('esc(b.service)')) {
  throw new Error('Owner financial report must escape customer-controlled names and services');
}

const bookingPage = readFileSync('book.html', 'utf8');
if (!bookingPage.includes('id="s5-promo-code"') || !bookingPage.includes('/api/booking/promo-preview') || !bookingPage.includes('/api/promo')) {
  throw new Error('Booking flow must expose promo code verification before confirmation');
}
const pricingPage = readFileSync('pricing.html', 'utf8');
const bundlesPage = readFileSync('bundles.html', 'utf8');
const furniturePflugervillePage = readFileSync('furniture-assembly-pflugerville-tx.html', 'utf8');
if (!furniturePflugervillePage.includes('/assets/js/site-promo.js')) {
  throw new Error('Service pages must load the shared promo script');
}
if (!furniturePflugervillePage.includes('beds, dressers, desks, tables, and IKEA builds')) {
  throw new Error('Furniture assembly city pages must use the stronger local-intent SEO description');
}
if (!bundlesPage.includes('id="bn-grid"')) {
  throw new Error('Bundles page must expose the bundle catalog mount point');
}
if (!bundlesPage.includes('renderBundleCatalog')) {
  throw new Error('Bundles page must render the full bundle catalog');
}
if (!bundlesPage.includes('/book?bundle=')) {
  throw new Error('Bundles page should deep-link each bundle card into booking');
}

const cityServiceFiles = readdirSync('.').filter((name) =>
  /^(furniture-assembly|tv-mounting|smart-home-installation|fitness-equipment-assembly|office-furniture-assembly|playset-assembly)-.*-tx\.html$/.test(name),
);
const flagshipAustinPages = governanceConfig.services.flagshipAustinPages || [];
const balancedPricingClassByCount = new Map([
  [1, 'pricing-grid--1'],
  [2, 'pricing-grid--2'],
  [3, 'pricing-grid--3'],
  [4, 'pricing-grid--4'],
  [5, 'pricing-grid--5'],
  [6, 'pricing-grid--6'],
  [7, 'pricing-grid--7'],
  [8, 'pricing-grid--8'],
]);
const MAX_COMMON_JOBS = 4;

function decodeHtmlEntities(text) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&rsquo;/g, "'")
    .replace(/&mdash;/g, '-')
    .replace(/&#39;/g, "'")
    .replace(/&#8217;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function normalizeVisibleText(text) {
  return decodeHtmlEntities(String(text || '').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function collectClassTexts(html, className) {
  const classMatcher = new RegExp(`<[^>]*class="[^"]*\\b${className}\\b[^"]*"[^>]*>([\\s\\S]*?)<\\/[^>]+>`, 'gi');
  return [...html.matchAll(classMatcher)]
    .map((match) => normalizeVisibleText(match[1]))
    .filter(Boolean);
}

function findDuplicateLabel(groups) {
  const seen = new Map();
  for (const [groupName, values] of groups) {
    for (const value of values) {
      if (seen.has(value)) {
        return { value, firstGroup: seen.get(value), secondGroup: groupName };
      }
      seen.set(value, groupName);
    }
  }
  return null;
}

for (const file of cityServiceFiles) {
  const html = readFileSync(file, 'utf8');
  if (!html.includes('id="city-pricing"')) continue;

  const pricingSection = html.match(/<section id="city-pricing"[\s\S]*?<\/section>/)?.[0];
  if (!pricingSection) {
    throw new Error(`City pricing section missing in ${file}`);
  }

  const pricingGridMatch = pricingSection.match(/<div class="pricing-grid ([^"]+)" data-pricing-count="(\d+)">/);
  if (!pricingGridMatch) {
    throw new Error(`City pricing grid must declare a balanced layout class and pricing count in ${file}`);
  }

  const [, classList, pricingCountText] = pricingGridMatch;
  const pricingCount = Number(pricingCountText);
  const expectedLayoutClass = balancedPricingClassByCount.get(pricingCount);
  if (!expectedLayoutClass) {
    throw new Error(`Define a balanced city pricing layout for ${pricingCount} cards before shipping ${file}`);
  }

  if (!classList.split(/\s+/).includes(expectedLayoutClass)) {
    throw new Error(`City pricing grid in ${file} should use ${expectedLayoutClass} for ${pricingCount} cards; found "${classList}"`);
  }

  const actualPriceCardCount = (pricingSection.match(/class="price-card(?:\s|")/g) || []).length;
  if (actualPriceCardCount !== pricingCount) {
    throw new Error(`City pricing count mismatch in ${file}: data-pricing-count says ${pricingCount}, found ${actualPriceCardCount} cards`);
  }
  if (actualPriceCardCount > MAX_COMMON_JOBS) {
    throw new Error(`City service page ${file} should show at most ${MAX_COMMON_JOBS} common jobs; found ${actualPriceCardCount}`);
  }

  const duplicateCityProofLabel = findDuplicateLabel([
    ['hero points', collectClassTexts(html, 'city-hero-point')],
    ['pricing band', collectClassTexts(html, 'pricing-band-point')],
    ['proof cards', collectClassTexts(html, 'city-proof-title')],
  ]);
  if (duplicateCityProofLabel) {
    throw new Error(
      `City service page ${file} repeats proof label "${duplicateCityProofLabel.value}" across ${duplicateCityProofLabel.firstGroup} and ${duplicateCityProofLabel.secondGroup}`,
    );
  }
}

for (const file of flagshipAustinPages) {
  const html = readFileSync(file, 'utf8');
  if (!html.includes('class="fa-hero"')) {
    throw new Error(`Flagship Austin page should render the flagship hero template: ${file}`);
  }
  if (!html.includes('class="fa-price-shell"')) {
    throw new Error(`Flagship Austin page should render the flagship pricing template: ${file}`);
  }
  if (html.includes('class="city-hero"')) {
    throw new Error(`Flagship Austin page should not be overwritten by the city template: ${file}`);
  }
  const flagshipMenuCount = (html.match(/class="fa-menu-row"/g) || []).length;
  if (flagshipMenuCount > MAX_COMMON_JOBS) {
    throw new Error(`Flagship Austin page ${file} should show at most ${MAX_COMMON_JOBS} common jobs; found ${flagshipMenuCount}`);
  }

  const duplicateFlagshipProofLabel = findDuplicateLabel([
    ['pricing footer', collectClassTexts(html, 'fa-price-point')],
    ['booking notes', collectClassTexts(html, 'fa-mini-fact-title')],
  ]);
  if (duplicateFlagshipProofLabel) {
    throw new Error(
      `Flagship Austin page ${file} repeats proof label "${duplicateFlagshipProofLabel.value}" across ${duplicateFlagshipProofLabel.firstGroup} and ${duplicateFlagshipProofLabel.secondGroup}`,
    );
  }
}

const sitemap = readFileSync('sitemap.xml', 'utf8');
const robots = readFileSync('robots.txt', 'utf8');

const serviceFromBlock = bookingPage.match(/var SVC_FROM = \{([\s\S]*?)\};/)?.[1] || '';
const serviceStartPrices = Object.fromEntries(
  [...serviceFromBlock.matchAll(/'([^']+)'\s*:\s*'From \$(\d+)/g)].map((match) => [match[1], Number(match[2])]),
);
if (Object.keys(serviceStartPrices).length !== 6) {
  throw new Error(`Booking page should expose 6 service start prices; found ${Object.keys(serviceStartPrices).length}`);
}

const pricingTitleToService = {
  'Furniture Assembly': 'Furniture Assembly',
  'TV &amp; Mounting': 'Mounting & Hanging',
  'Smart Home': 'Smart Home',
  'Fitness Equipment': 'Fitness Equipment',
  'Outdoor &amp; Playsets': 'Outdoor & Playsets',
  'Office Assembly': 'Office Assembly',
};
const displayedPricingStarts = new Map();
for (const match of pricingPage.matchAll(/<article class="price-card">([\s\S]*?)<\/article>/g)) {
  const card = match[1];
  const title = card.match(/<div class="price-title">([^<]+)<\/div>/)?.[1];
  const price = Number(card.match(/<div class="price-from"><span>From<\/span><strong>\$(\d+)<\/strong><\/div>/)?.[1]);
  if (title && price) displayedPricingStarts.set(pricingTitleToService[title] || title, price);
}
for (const [service, startPrice] of Object.entries(serviceStartPrices)) {
  const displayedPrice = displayedPricingStarts.get(service);
  if (displayedPrice !== startPrice) {
    throw new Error(`Pricing page mismatch for ${service}: displayed ${displayedPrice}, booking starts at ${startPrice}`);
  }
}

const pricingJsonBlocks = [...pricingPage.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((match) => JSON.parse(match[1]));
const pricingWebPageSchema = pricingJsonBlocks.find((block) => block['@type'] === 'WebPage');
if (!pricingWebPageSchema) throw new Error('Pricing page WebPage JSON-LD schema missing');
for (const serviceSchema of pricingWebPageSchema.mainEntity || []) {
  const serviceName =
    serviceSchema.name === 'Outdoor and Playset Assembly'
      ? 'Outdoor & Playsets'
      : serviceSchema.name === 'Smart Home Installation'
        ? 'Smart Home'
        : serviceSchema.name;
  if (!serviceStartPrices[serviceName]) continue;
  const schemaPrice = Number(serviceSchema.offers?.price);
  if (schemaPrice !== serviceStartPrices[serviceName]) {
    throw new Error(`Pricing JSON-LD mismatch for ${serviceName}: schema ${schemaPrice}, booking starts at ${serviceStartPrices[serviceName]}`);
  }
}
if (pricingJsonBlocks.some((block) => {
  const types = Array.isArray(block['@type']) ? block['@type'] : [block['@type']];
  return types.includes('LocalBusiness') || types.includes('HomeAndConstructionBusiness');
})) {
  throw new Error('Pricing page must not create a duplicate LocalBusiness entity');
}
for (const serviceSchema of pricingWebPageSchema.mainEntity || []) {
  if (serviceSchema.provider?.['@id'] !== 'https://www.assembleatease.com/#organization') {
    throw new Error(`Pricing Service must use the shared Organization provider: ${serviceSchema.name}`);
  }
}

const sitemapUrls = [...sitemap.matchAll(/<loc>https:\/\/www\.assembleatease\.com\/(.*?)<\/loc>/g)].map((match) => match[1] || '');
const routeToFile = (route) => {
  if (route === '') return 'index.html';
  const candidates = [
    route.endsWith('.html') ? route : `${route}.html`,
    `${route}/index.html`,
  ];
  return candidates.find((candidate) => existsSync(candidate)) || candidates[0];
};
const sitemapFiles = sitemapUrls.map(routeToFile);
for (let index = 0; index < sitemapUrls.length; index += 1) {
  if (!existsSync(sitemapFiles[index])) {
    throw new Error(`Sitemap URL missing local file: /${sitemapUrls[index]} -> ${sitemapFiles[index]}`);
  }
  const page = readFileSync(sitemapFiles[index], 'utf8');
  if (/name="robots"[^>]+noindex/i.test(page)) {
    throw new Error(`Sitemap should not submit noindex page: ${sitemapFiles[index]}`);
  }
}
if (!robots.includes('Allow: /assembler/apply') || !robots.includes('Disallow: /assembler/')) {
  throw new Error('robots.txt should allow /assembler/apply while blocking private /assembler/ routes');
}

const publicHtmlFiles = [
  ...readdirSync('.').filter((name) => name.endsWith('.html')),
  ...readdirSync('blog').filter((name) => name.endsWith('.html')).map((name) => `blog/${name}`),
  ...sitemapFiles,
];
const uniquePublicHtmlFiles = [...new Set(publicHtmlFiles)];

const requiredPublicFooterLinks = [
  `href="${businessIdentity.mailtoHref}"`,
  'href="/track"',
  'href="/business"',
  'href="/assembler/apply"',
  'href="/privacy"',
  'href="/terms"',
];

const footerServicePageLinks = [
  'href="/furniture-assembly-austin-tx"',
  'href="/tv-mounting-austin-tx"',
  'href="/smart-home-installation-austin-tx"',
  'href="/fitness-equipment-assembly-austin-tx"',
  'href="/office-furniture-assembly-austin-tx"',
  'href="/playset-assembly-austin-tx"',
];

const footerBookingLinks = [
  'href="/book?service=Furniture+Assembly"',
  'href="/book?service=Mounting+%26+Hanging"',
  'href="/book?service=Smart+Home"',
  'href="/book?service=Fitness+Equipment"',
  'href="/book?service=Office+Assembly"',
  'href="/book?service=Outdoor+%26+Playsets"',
];

for (const file of uniquePublicHtmlFiles) {
  const html = readFileSync(file, 'utf8');
  if (!html.includes('<meta name="description"')) {
    throw new Error(`Public page missing meta description: ${file}`);
  }
  if (!html.includes('<link rel="canonical"')) {
    throw new Error(`Public page missing canonical: ${file}`);
  }
  if (!html.includes('<meta property="og:title"')) {
    throw new Error(`Public page missing og:title: ${file}`);
  }
  if (!html.includes('/assets/js/cookie-consent.js')) {
    throw new Error(`Public page missing shared cookie consent script: ${file}`);
  }
  if (!/id="cookie-banner"/i.test(html)) {
    throw new Error(`Public page missing shared cookie banner: ${file}`);
  }
  if (!html.includes('/favicon.ico')) {
    throw new Error(`Public page missing /favicon.ico link: ${file}`);
  }
  if (!html.includes('href="/images/favicon.svg"')) {
    throw new Error(`Public page missing SVG favicon link: ${file}`);
  }
  if (/rel="(?:icon|apple-touch-icon)"[^>]*logo\.jpg/i.test(html)) {
    throw new Error(`Public page links a JPEG as a favicon (use /favicon.ico + PNG): ${file}`);
  }
  if (/visit minimum/i.test(html)) {
    throw new Error(`Public page still mentions visit minimum: ${file}`);
  }
  if (/priceRange"\s*:\s*"104"/.test(html)) {
    throw new Error(`Public page has malformed priceRange 104: ${file}`);
  }
  if (/<text\b/i.test(html) || />\s*AE\s*</i.test(html)) {
    throw new Error(`Public page should not use plain AE text mark: ${file}`);
  }
  if (html.includes('mobileNav') && !html.includes('href="/assembler/apply"')) {
    throw new Error(`Mobile nav missing Become an Easer: ${file}`);
  }
  if (!html.includes('<footer class="footer">')) continue;
  const footer = html.match(/<footer class="footer">([\s\S]*?)<\/footer>/)?.[0] || '';
  if (!footer) throw new Error(`Public footer missing in ${file}`);
  for (const required of requiredPublicFooterLinks) {
    if (!footer.includes(required)) {
      throw new Error(`Public footer missing ${required} in ${file}`);
    }
  }
  if (file !== 'business.html' && !footer.includes(`href="${businessIdentity.telHref}"`)) {
    throw new Error(`Public footer missing ${businessIdentity.telHref} in ${file}`);
  }
  const hasServicePageFooter = footerServicePageLinks.every((href) => footer.includes(href));
  const hasBookingFooter = footerBookingLinks.every((href) => footer.includes(href));
  if (!hasServicePageFooter && !hasBookingFooter) {
    throw new Error(`Public footer missing a complete service-link pattern in ${file}`);
  }
  const privacyLinkCount = (footer.match(/href="\/privacy"/g) || []).length;
  const termsLinkCount = (footer.match(/href="\/terms"/g) || []).length;
  if (privacyLinkCount !== 1 || termsLinkCount !== 1) {
    throw new Error(`Public footer should include one legal link row only in ${file}`);
  }
}

const fakePricing = {
  discountedItemSubtotalCents: 12900,
  itemSubtotalCents: 12900,
  discountCents: 0,
  serviceCallFeeCents: 2500,
  taxCents: 1271,
  totalCents: 16671,
  hasPricedBaseItem: true,
};

const fakeSb = {
  from(table) {
    if (table === 'site_marketing_settings') {
      return {
        select() {
          return {
            eq() {
              return {
                maybeSingle: async () => ({
                  data: {
                    id: 1,
                    promo_enabled: true,
                    promo_code: 'WELCOME25',
                    promo_title: 'New Customer Offer',
                    promo_label: '$25 off your first booking',
                    promo_discount_cents: 2500,
                    first_booking_only: true,
                  },
                  error: null,
                }),
              };
            },
          };
        },
      };
    }
    if (table === 'bookings') {
      return {
        select() {
          return {
            ilike: async () => ({ count: 0, error: null }),
          };
        },
      };
    }
    throw new Error(`Unexpected fake table lookup: ${table}`);
  },
};

const promo = await resolveBookingPromotion({
  promoCode: 'WELCOME25',
  email: 'new@example.com',
  pricing: fakePricing,
  isQuoteRequest: false,
  sb: fakeSb,
});

if (!promo.applied || promo.discountCents !== 2500) {
  throw new Error(`Expected WELCOME25 to apply for a first-time booking; got ${JSON.stringify(promo)}`);
}

const adjusted = applyPromotionToPricing(fakePricing, promo);
if (adjusted.totalCents !== 13964 || adjusted.promoDiscountCents !== 2500) {
  throw new Error(`Promo pricing mismatch; got ${JSON.stringify(adjusted)}`);
}

console.log('Smoke checks passed');
