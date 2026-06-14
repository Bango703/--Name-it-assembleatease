import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';

const files = [
  'api/booking.js',
  'api/booking-confirmed.js',
  'api/booking/complete.js',
  'api/booking/assembler-complete.js',
  'api/booking/payout.js',
  'api/booking/refund.js',
  'api/assembler/apply.js',
  'api/assembler/stripe-webhook.js',
  'api/cron/auto-blog.js',
];

for (const file of files) {
  execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
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

const benefitsSection = homepage.match(/<section class="benefits-section" id="why-us">([\s\S]*?)<\/section>/)?.[1];
if (!benefitsSection) throw new Error('Homepage benefits section not found');

const benefitLabels = [...benefitsSection.matchAll(/<div class="benefit-label">([^<]+)<\/div>/g)].map((match) => match[1]);
if (benefitLabels.length % 2 !== 0) {
  throw new Error(`Homepage benefits carousel must have matching duplicate sets; found ${benefitLabels.length} cards`);
}

const benefitSetSize = benefitLabels.length / 2;
if (benefitSetSize < 6 || benefitSetSize % 2 !== 0) {
  throw new Error(`Homepage benefits must use an even visible set of at least 6 cards; found ${benefitSetSize}`);
}

const benefitFirstSet = benefitLabels.slice(0, benefitSetSize).join('|');
const benefitSecondSet = benefitLabels.slice(benefitSetSize).join('|');
if (benefitFirstSet !== benefitSecondSet) {
  throw new Error('Homepage benefits duplicate set must match the first set for smooth mobile scrolling');
}

const publicHtmlFiles = [
  ...readdirSync('.').filter((name) => name.endsWith('.html')),
  ...readdirSync('blog').filter((name) => name.endsWith('.html')).map((name) => `blog/${name}`),
];

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

for (const file of publicHtmlFiles) {
  const html = readFileSync(file, 'utf8');
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
