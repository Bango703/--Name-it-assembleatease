import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

const [
  ownerUi,
  reviewApi,
  cronReviewApi,
  emailHelpers,
  reviewPage,
  vercelConfig,
  broadcastHelpers,
  broadcastUi,
  envExample,
  privacyPolicy,
  terms,
] = await Promise.all([
  read('owner/index.html'),
  read('api/review-request.js'),
  read('api/cron/review-request.js'),
  read('api/_email.js'),
  read('review.html'),
  read('vercel.json'),
  read('api/_broadcast.js'),
  read('owner/email.html'),
  read('.env.example'),
  read('privacy.html'),
  read('terms.html'),
]);

// Every completed booking with a customer email is review-eligible, regardless
// of whether payment came through online checkout or the owner-manual workflow.
assert.match(reviewApi, /b\.status !== 'completed'/);
assert.match(reviewApi, /!b\.customer_email/);
assert.doesNotMatch(reviewApi, /owner_manual|source\s*[!=]=|payment_status/);
assert.match(ownerUi, /b\.status === 'completed'[\s\S]*?Resend Review Request[\s\S]*?Request Review/);

// Owner and automatic requests both lead to the secure platform review first.
// Google remains an optional second step only after the platform review submits.
assert.match(reviewApi, /href="\$\{reviewUrl\}"/);
assert.match(cronReviewApi, /href="\$\{internalReviewUrl\}"[\s\S]*?>Review Your Service</);
assert.doesNotMatch(cronReviewApi, /GOOGLE_REVIEW_URL|googleReviewUrl|Leave a Google Review/);
const completionReviewCopy = emailHelpers.slice(emailHelpers.indexOf('export function buildReviewCta'));
assert.doesNotMatch(completionReviewCopy, /GOOGLE_REVIEW_URL|g\.page|Leave a Google review/);
assert.match(reviewPage, /Also Leave a Google Review/);

// The private owner shell must not remain stale across deployments.
const vercel = JSON.parse(vercelConfig);
for (const path of ['/owner', '/owner/index.html']) {
  const rule = vercel.headers.find(item => item.source === path);
  assert.ok(rule, `Missing cache rule for ${path}`);
  const cache = rule.headers.find(header => header.key.toLowerCase() === 'cache-control');
  assert.match(cache?.value || '', /no-store/);
}

// Transactional customer, Easer, and owner-operation email footers reflect the
// statewide service area. Marketing broadcasts are intentionally excluded:
// CAN-SPAM requires the owner's real physical postal address there.
const transactionalEmailFiles = [
  'api/_email.js',
  'api/booking.js',
  'api/booking-confirmed.js',
  'api/business-inquiry.js',
  'api/contact.js',
  'api/review-request.js',
  'api/cron/review-request.js',
  'api/cron/followup.js',
  'api/cron/reauth-payments.js',
  'api/cron/reminders.js',
  'api/cron/stale-booking.js',
  'api/cron/daily-summary.js',
  'api/cron/weekly-summary.js',
  'api/assembler/apply.js',
  'api/assembler/update.js',
  'api/assembler/stripe-webhook.js',
  'api/booking/assign.js',
  'api/booking/message.js',
  'api/booking/payout.js',
  'api/owner/add-easer.js',
  'api/owner/request-evidence.js',
  'api/owner/waitlist.js',
];

for (const path of transactionalEmailFiles) {
  const source = await read(path);
  assert.doesNotMatch(source, /Austin,\s*(?:TX|Texas)|Austin headquarters/i, `${path} still has Austin-only email branding`);
}

assert.match(emailHelpers, /Serving customers across Texas/);
assert.match(reviewApi, /Serving customers across Texas/);
assert.match(cronReviewApi, /Serving customers across Texas/);

const purchasedMailbox = /ASSEMBLEATEASE LLC, 9169 W State St #3847, Garden City, ID 83714/;
assert.match(broadcastHelpers, purchasedMailbox);
assert.match(broadcastUi, purchasedMailbox);
assert.match(envExample, purchasedMailbox);
assert.doesNotMatch(broadcastHelpers, /AssembleAtEase LLC, Austin, TX 78701/);
for (const legalPage of [privacyPolicy, terms]) {
  assert.match(legalPage, /9169 W State St #3847, Garden City, ID 83714/);
  assert.match(legalPage, /Service area: Texas/);
}

console.log('Review eligibility, destination, cache, and statewide email consistency checks passed.');
