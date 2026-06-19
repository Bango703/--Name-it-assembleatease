import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { normalizeChatRoute, sanitizeReplyLinks } from '../api/chat.js';

const files = [
  'api/booking.js',
  'api/booking-confirmed.js',
  'api/booking/complete.js',
  'api/booking/assembler-complete.js',
  'api/booking/payout.js',
  'api/booking/refund.js',
  'api/assembler/apply.js',
  'api/chat.js',
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

const bookingPage = readFileSync('book.html', 'utf8');
const pricingPage = readFileSync('pricing.html', 'utf8');
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
if (!pricingPage.includes('"priceRange":"$$"')) {
  throw new Error('Pricing LocalBusiness priceRange should be $$');
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
  'href="tel:+17372906129"',
  'href="mailto:service@assembleatease.com"',
  'href="/furniture-assembly-austin-tx"',
  'href="/tv-mounting-austin-tx"',
  'href="/smart-home-installation-austin-tx"',
  'href="/fitness-equipment-assembly-austin-tx"',
  'href="/office-furniture-assembly-austin-tx"',
  'href="/playset-assembly-austin-tx"',
  'href="/track"',
  'href="/business"',
  'href="/assembler/apply"',
  'href="/privacy"',
  'href="/terms"',
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
  if (footer.includes('/book?service=')) {
    throw new Error(`Public footer should link to real service pages, not booking query links, in ${file}`);
  }
  const privacyLinkCount = (footer.match(/href="\/privacy"/g) || []).length;
  const termsLinkCount = (footer.match(/href="\/terms"/g) || []).length;
  if (privacyLinkCount !== 1 || termsLinkCount !== 1) {
    throw new Error(`Public footer should include one legal link row only in ${file}`);
  }
}

console.log('Smoke checks passed');
