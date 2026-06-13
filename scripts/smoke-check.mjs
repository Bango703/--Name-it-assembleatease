import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const files = [
  'api/booking.js',
  'api/booking-confirmed.js',
  'api/booking/complete.js',
  'api/booking/assembler-complete.js',
  'api/booking/payout.js',
  'api/booking/refund.js',
  'api/assembler/apply.js',
  'api/assembler/stripe-webhook.js',
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

const faviconSvg = readFileSync('images/favicon.svg', 'utf8');
if (/<text\b/i.test(faviconSvg) || />\s*AE\s*</i.test(faviconSvg)) {
  throw new Error('Favicon must use the logo mark, not plain AE text');
}

console.log('Smoke checks passed');
