import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import {
  computeBookingFinancialSummary,
  computeBookingSplitFromSnapshot,
  computeCancellationFee,
  isActiveInstantBookingZip,
} from '../api/_source-of-truth.js';
import { hasEffectiveEaserMembership } from '../api/_easer-membership.js';
import { getEaserReadiness } from '../api/_easer-readiness.js';
import { CONTRACTOR_AGREEMENT_VERSION } from '../api/_assembler-onboarding.js';
import { canTransitionBookingStatus } from '../api/booking/_workflow-engine.js';
import { redactAssignmentCustomerData } from '../api/booking/my-assignments.js';
import {
  deriveGuestMutationToken,
  guestMutationTokenHash,
  safeTokenHashMatch,
} from '../api/_payment-security.js';
import { formatUsPhone, normalizeUsPhone } from '../api/_phone.js';
import { getBookingCatalog } from '../api/_pricing.js';
import { customerOwnsBooking } from '../api/booking/_customer-booking-auth.js';

function source(file) {
  return readFileSync(file, 'utf8');
}

assert.equal(normalizeUsPhone('512-555-0123'), '+15125550123');
assert.equal(normalizeUsPhone('+1 512-555-0123'), '+15125550123');
assert.equal(normalizeUsPhone('1'), null, 'A one-digit phone must never create or strand a booking');
assert.equal(normalizeUsPhone('(737) 555-0100'), '+17375550100');
assert.equal(formatUsPhone('+1 737 555 0100'), '737-555-0100');
assert.equal(normalizeUsPhone('512-555-012'), null);

assert.equal(customerOwnsBooking({ customer_id: 'customer-1', customer_email: 'same@example.com' }, { id: 'customer-1', email: 'same@example.com' }), true);
assert.equal(customerOwnsBooking({ customer_id: 'customer-2', customer_email: 'same@example.com' }, { id: 'customer-1', email: 'same@example.com' }), false, 'A bound booking must never fall back to email ownership');
assert.equal(customerOwnsBooking({ customer_id: null, customer_email: ' Legacy@Example.com ' }, { id: 'customer-1', email: 'legacy@example.com' }), true, 'Legacy unbound bookings may use exact normalized email ownership');
assert.equal(customerOwnsBooking({ customer_id: null, customer_email: 'other@example.com' }, { id: 'customer-1', email: 'legacy@example.com' }), false);

assert.equal(isActiveInstantBookingZip('78701'), true);
assert.equal(isActiveInstantBookingZip('78664'), true);
assert.equal(isActiveInstantBookingZip('78801'), false, 'A broad Texas prefix must not create a far-away instant booking');
assert.equal(isActiveInstantBookingZip('78601'), false, 'Only verified Central Texas ZIPs may book instantly');

process.env.EASER_MEMBERSHIP_ENABLED = 'false';
assert.equal(hasEffectiveEaserMembership({ has_membership: true }), false, 'A stale database flag must not grant launch discounts or priority');

const bookingCatalog = getBookingCatalog();
function catalogItem(service, name) {
  for (const group of bookingCatalog.subcategories?.[service] || []) {
    const item = (group.items || []).find(candidate => candidate.name === name);
    if (item) return item;
  }
  throw new Error(`Missing booking catalog item: ${service} / ${name}`);
}

function moneyRange(items) {
  const starts = items.map(item => Number(item.price));
  const ends = items.map(item => Number(item.priceMax || item.price));
  const low = Math.min(...starts);
  const high = Math.max(...ends);
  return low === high ? `$${low}` : `$${low}–$${high}`;
}

// Financial truth: tax is excluded from the payout basis; platform-funded
// AssembleCash is added back so the Easer is not underpaid.
const split = computeBookingSplitFromSnapshot({
  amountChargedCents: 14_000,
  taxCents: 1_000,
  assemblecashRedeemedCents: 2_000,
  isMember: false,
});
assert.deepEqual(split, {
  totalCents: 14_000,
  taxCents: 1_000,
  pretaxCollectedCents: 13_000,
  payoutBaseCents: 15_000,
  feePct: 30,
  protectedPlatformFeeCents: 4_500,
  platformFeeCents: 2_500,
  assemblerDueCents: 10_500,
  assemblecashRedeemedCents: 2_000,
});

const summary = computeBookingFinancialSummary({
  amountChargedCents: 10_825,
  refundAmountCents: 5_412,
  taxAmountCents: 825,
  stripeFeeCents: 344,
  assemblerDueCents: 7_000,
});
assert.equal(summary.netChargedCents, 5_413);
assert.equal(summary.taxCollectedCents, 413);
assert.equal(summary.processingFeeIsActual, true);
assert.equal(summary.platformGrossCents, -2_344, 'Refunded jobs must retain the Easer liability instead of hiding a loss');

assert.deepEqual(
  computeCancellationFee({ serviceSubtotalCents: 20_000, hoursUntilAppointment: 30 }),
  { tier: 'free', feePct: 0, feeCents: 0, proTripCut: false },
);
assert.equal(computeCancellationFee({ serviceSubtotalCents: 20_000, hoursUntilAppointment: 8 }).feeCents, 2_000);
assert.equal(computeCancellationFee({ serviceSubtotalCents: 20_000, status: 'en_route' }).feeCents, 3_000);

const readyProfile = {
  application_status: 'approved',
  contractor_agreement_signed_at: '2026-07-12T12:00:00.000Z',
  contractor_agreement_version: CONTRACTOR_AGREEMENT_VERSION,
  code_of_conduct_agreed_at: '2026-07-12T12:00:00.000Z',
  identity_verified: true,
  status: 'active',
  tier: 'starter',
  is_available: true,
  phone: '+1 737 555 0100',
};
const manualReady = await getEaserReadiness(readyProfile, { connectRequired: false });
assert.equal(manualReady.isReady, true, 'Manual payout launch must not require Stripe Connect');
const invalidPhoneReadiness = await getEaserReadiness({ ...readyProfile, phone: '1234567' }, { connectRequired: false });
assert.equal(invalidPhoneReadiness.isReady, false, 'An invalid phone must never satisfy Easer job readiness');
assert.match(invalidPhoneReadiness.missingItems.join(' '), /valid 10-digit U\.S\. phone/i);
const staleAgreement = await getEaserReadiness({ ...readyProfile, contractor_agreement_version: 'old' }, { connectRequired: false });
assert.equal(staleAgreement.isReady, false);
assert.match(staleAgreement.missingItems.join(' '), /current contractor agreement/i);
const connectBlocked = await getEaserReadiness(readyProfile, { connectRequired: true, stripeAccount: null });
assert.equal(connectBlocked.isReady, false, 'Connect mode must fail closed without verified live account state');

assert.equal(canTransitionBookingStatus('confirmed', 'en_route'), true);
assert.equal(canTransitionBookingStatus('confirmed', 'arrived'), false);
assert.equal(canTransitionBookingStatus('arrived', 'completed'), false);
assert.equal(canTransitionBookingStatus('in_progress', 'completed'), true);

const [unaccepted, terminal] = redactAssignmentCustomerData([
  { status: 'confirmed', assembler_accepted_at: null, customer_name: 'Private', customer_email: 'private@example.com', customer_phone: '1', address: 'Private', details: 'Private', assignment_token: 'a' },
  { status: 'completed', assembler_accepted_at: '2026-07-12', customer_name: 'Private', customer_email: 'private@example.com', customer_phone: '1', address: 'Private', details: 'Private', assignment_token: 'b' },
]);
assert.equal(unaccepted.customer_email, null);
assert.equal(terminal.customer_email, null);
assert.equal(terminal.assignment_token, null);

process.env.GUEST_ACCESS_TOKEN_SECRET = 'g'.repeat(48);
const guestBooking = { id: '00000000-0000-4000-8000-000000000001', ref: 'AAE-TEST1234', customer_email: 'customer@example.com' };
const guestToken = deriveGuestMutationToken({ bookingId: guestBooking.id, ref: guestBooking.ref, email: guestBooking.customer_email });
const guestHash = guestMutationTokenHash(guestBooking);
assert.equal(safeTokenHashMatch(guestToken, guestHash), true);
assert.equal(safeTokenHashMatch(guestToken + 'x', guestHash), false);

process.env.OWNER_SESSION_SECRET = 's'.repeat(48);
process.env.OWNER_PASSWORD = 'owner-password-long-enough-for-local-test';
process.env.VERCEL_ENV = 'production';
const { createOwnerSessionToken, verifyOwner } = await import('../api/_email.js');
const session = createOwnerSessionToken();
assert.ok(session?.token);
assert.equal(verifyOwner({ headers: { authorization: `Bearer ${session.token}` } }), true);
assert.equal(verifyOwner({ headers: { 'x-owner-password': process.env.OWNER_PASSWORD }, body: {} }), false, 'Production password headers must be disabled');

// Static launch guards catch route regressions that otherwise look harmless in
// isolated unit tests.
const legacyAccept = source('api/booking/accept.js');
assert.doesNotMatch(legacyAccept, /\.from\(['"]bookings['"]\)|\.update\(/, 'Legacy GET assignment route must never mutate state');
assert.match(legacyAccept, /status\(410\)/);

const trackApi = source('api/booking/track.js');
assert.match(trackApi, /safeTokenHashMatch/);
assert.match(trackApi, /email, ref, token/);

const ownerPage = source('owner/index.html');
assert.doesNotMatch(ownerPage, /x-owner-password|owner_pw|bulk-delete-btn/);
assert.match(ownerPage, /Authorization': 'Bearer/);
assert.match(ownerPage, /Quote sent for customer approval/);
assert.doesNotMatch(ownerPage, /Card authorized & booking confirmed|Finalize Quote & Authorize Card/);
assert.match(ownerPage, /id="new-booking-btn"/);
assert.match(ownerPage, /owner-create-booking-modal/);
assert.match(ownerPage, /\/api\/owner\/create-booking/);
assert.match(ownerPage, /<label[^>]*for="ae-phone"[^>]*>Phone \*<\/label>/);
assert.match(ownerPage, /id="ae-phone"[^>]*required/);
assert.match(ownerPage, /phoneDigits\.length !== 10/);
assert.match(ownerPage, /function hasValidUsPhone\(value\)/);
assert.match(ownerPage, /dispatchEligible[^;]*hasValidUsPhone\(a\.phone\)/);
assert.match(ownerPage, /chk\(hasValidUsPhone\(a\.phone\), 'Valid U\.S\. phone on file'\)/);
assert.match(ownerPage, /hasValidUsPhone\(w\.phone\)/);
assert.match(ownerPage, /Number\(d\.failed \|\| 0\) > 0 \? 'error' : 'success'/);

const browserApi = source('assets/js/api.js');
assert.doesNotMatch(browserApi, /\.from\(['"]bookings['"]\)/, 'Browser code must not query the bookings base table');
assert.doesNotMatch(browserApi, /\.from\(['"]reviews['"]\)/, 'Review reads and mutations must use the secured server APIs');
assert.doesNotMatch(browserApi, /\.from\(['"](?:jobs|bids)['"]\)/, 'The retired browser marketplace must not expose direct job or bid mutations');
assert.match(browserApi, /user\.id !== userId/);
assert.match(browserApi, /rpc\(['"]update_own_easer_profile['"]/);

const bookingApi = source('api/booking.js');
assert.match(bookingApi, /isActiveInstantBookingZip/);
assert.match(bookingApi, /MARKET_NOT_ACTIVE/);
assert.match(bookingApi, /formatUsPhone\(phone\)/);
const homePage = source('index.html');
assert.doesNotMatch(homePage, /p===['"]788['"]|786xx through 788xx/);
assert.equal((homePage.match(/<h1\b/gi) || []).length, 1, 'Homepage must expose one semantic H1 across responsive layouts');
assert.doesNotMatch(homePage, /Verified Google review|Real jobs in real spaces every week/);
const bookingFlowPage = source('book.html');
assert.equal((bookingFlowPage.match(/<h1\b/gi) || []).length, 1, 'Booking flow must expose one semantic H1');
assert.doesNotMatch(bookingFlowPage, /&#9989;/, 'Booking UI must not use emoji symbols');
assert.match(bookingFlowPage, /esc\(formatUsPhoneForDisplay\(phone\)\)/, 'Booking summary must display a dashed phone number');
assert.doesNotMatch(source('assembler/my-assignments.html'), /&#9888;/, 'Easer UI must not use emoji symbols');
assert.match(source('blog/furniture-assembly-steiner-ranch-austin-tx.html'), /name="robots" content="noindex, follow"/, 'Thin orphan content must not be indexed');
assert.doesNotMatch(source('locations.html'), /A national brand|built to serve customers across the United States/);
const contractorAgreement = source('assembler/contractor-agreement.html');
assert.doesNotMatch(contractorAgreement, /786xx through 788xx/);
const marketDemand = source('api/market-demand.js');
assert.doesNotMatch(marketDemand, /parseInt\(body\.totalCents/);
assert.match(marketDemand, /estimatedRevenue: 0/);
const easerWaitlist = source('api/waitlist.js');
assert.match(easerWaitlist, /normalizeUsPhone/);
assert.match(easerWaitlist, /formatUsPhone/);
assert.match(easerWaitlist, /US_STATE_CODES/);
assert.match(easerWaitlist, /database is the waitlist source of truth/i);
assert.doesNotMatch(easerWaitlist, /No upfront fees to join/i);
assert.doesNotMatch(easerWaitlist, /api\.resend\.com/, 'Waitlist email attempts must use the logged email helper');
assert.match(easerWaitlist, /status: saved\.status/);
const easerApplicationApi = source('api/assembler/apply.js');
assert.match(easerApplicationApi, /const cleanPhone = normalizeUsPhone\(phone\)/, 'Easer applications must normalize phone numbers server-side');
assert.match(easerApplicationApi, /formatUsPhone\(cleanPhone\)/, 'Owner application email must display a dashed phone number');
const easerApplicationPage = source('assembler/apply.html');
assert.match(easerApplicationPage, /formatUsPhoneForDisplay\(d\.phone\)/, 'Waitlist invite phone must be displayed with dashes');
assert.match(easerApplicationPage, /isValidUsPhoneForApplication\(data\.phone\)/, 'Easer application must reject invalid phones before fee processing');
assert.doesNotMatch(easerApplicationPage, /\[\\d\\s\(\)\.\-\]\{7,/,
  'Easer application must not use the old seven-character phone check');
const easerDashboard = source('assembler/index.html');
assert.match(easerDashboard, /done: hasValidUsPhone\(currentProfile\.phone\)/, 'Easer onboarding must not mark an invalid phone complete');
const easerProfilePage = source('assembler/profile.html');
assert.match(easerProfilePage, /label: ['"]Phone['"],\s+ok: normalizeUsPhone\(/, 'Profile completion must require a valid phone');
const phoneNudgeApi = source('api/owner/check-phones.js');
assert.match(phoneNudgeApi, /filter\(easer => !normalizeUsPhone\(easer\.phone\)\)/, 'Owner phone follow-up must include invalid legacy phones');
const businessInquiryApi = source('api/business-inquiry.js');
assert.match(businessInquiryApi, /const cleanPhone = rawPhone \? normalizeUsPhone\(rawPhone\) : null/);
assert.match(businessInquiryApi, /row\(['"]Phone['"], displayPhone\)/, 'Business lead email must display a dashed phone number');
const assignmentsPage = source('assembler/my-assignments.html');
assert.doesNotMatch(assignmentsPage, /from\(['"]messages['"]\)/, 'Easer messages must use the assignment-authorized API');
assert.match(assignmentsPage, /\/api\/booking\/message\?bookingId=/);
const membershipApi = source('api/assembler/membership.js');
assert.match(membershipApi, /Easer membership is not available at launch/);
const stripeWebhook = source('api/assembler/stripe-webhook.js');
assert.match(stripeWebhook, /metadata\?\.role !== ['"]assembler_membership['"]/, 'Non-Easer subscriptions must never grant Easer membership');
assert.match(stripeWebhook, /\.eq\(['"]role['"], ['"]assembler['"]\)/, 'Membership events must be restricted to Easer profiles');
const autoBlog = source('api/cron/auto-blog.js');
assert.match(autoBlog, /CRON_SECRET/);
assert.match(autoBlog, /AUTO_BLOG_PUBLISH_ENABLED/);
assert.match(autoBlog, /status\(401\)/);
for (const file of readdirSync('api/cron').filter(name => name.endsWith('.js') && !name.startsWith('_'))) {
  assert.match(source(`api/cron/${file}`), /CRON_SECRET/, `${file} must authenticate scheduled and direct requests`);
}
for (const file of ['auth/forgot-password.html', 'auth/reset-password.html', 'auth/set-password.html']) {
  assert.match(source(file), /name="robots" content="noindex, nofollow"/);
}

const migration31 = source('api/migrations/031_security_privilege_hardening.sql');
assert.match(migration31, /DROP POLICY IF EXISTS "users_can_update_own_profile"/);
assert.match(migration31, /update_own_easer_profile/);
const migration32 = source('api/migrations/032_payment_truth_and_customer_consent.sql');
assert.match(migration32, /quote_approved_at/);
assert.match(migration32, /stripe_bank_payout_status/);
const migration33 = source('api/migrations/033_launch_compliance_and_schema_state.sql');
assert.match(migration33, /REVOKE ALL ON TABLE public\.bookings FROM PUBLIC, anon, authenticated/);
assert.match(migration33, /platform_schema_state/);
assert.match(migration33, /easer_compliance_events/);

for (const file of ['api/booking/complete.js', 'api/booking/assembler-complete.js']) {
  const text = source(file);
  assert.match(text, /assembler_accepted_at/);
  assert.match(text, /CAPTURE_FAILED|capture failed/i);
}

// Public pricing pages must continue to agree with the booking catalog after a
// generator or flagship-page rebuild.
const servicePagePattern = /^(furniture-assembly|tv-mounting|smart-home-installation|fitness-equipment-assembly|playset-assembly|office-furniture-assembly)-[a-z-]+-tx\.html$/;
const servicePages = readdirSync('.').filter(file => servicePagePattern.test(file));
assert.equal(servicePages.length, 72, 'Expected all 72 Austin-area service pages');
const dresserRange = moneyRange([
  catalogItem('Furniture Assembly', 'Dresser (up to 6 drawers)'),
  catalogItem('Furniture Assembly', 'Dresser (7+ drawers / double)'),
]);
const paxPrice = moneyRange([catalogItem('Furniture Assembly', 'IKEA PAX wardrobe (single unit)')]);
const tvStart = moneyRange([catalogItem('Mounting & Hanging', 'TV up to 40" (standard wall)')]);
const playsetStart = moneyRange([catalogItem('Outdoor & Playsets', 'Swing set / backyard playset assembly')]).split('–')[0];
const rackPrice = moneyRange([catalogItem('Fitness Equipment', 'Power rack / squat rack')]);

for (const file of servicePages) {
  const html = source(file).replaceAll('&ndash;', '–');
  const jsonLdBlocks = [...html.matchAll(/<script\s+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)]
    .map((match) => JSON.parse(match[1]));
  const serviceEntity = jsonLdBlocks.find((entry) => entry?.['@type'] === 'Service');
  assert.ok(serviceEntity, `${file} must describe the page as a Service`);
  assert.equal(serviceEntity.provider?.['@id'], 'https://www.assembleatease.com/#organization', `${file} must use the shared Organization identity`);
  assert.equal(serviceEntity.url, `https://www.assembleatease.com/${file.slice(0, -5)}`);
  assert.ok(serviceEntity.areaServed?.name, `${file} must identify its verified market`);
  assert.equal(
    jsonLdBlocks.some((entry) => {
      const types = Array.isArray(entry?.['@type']) ? entry['@type'] : [entry?.['@type']];
      return types.includes('LocalBusiness') || types.includes('HomeAndConstructionBusiness');
    }),
    false,
    `${file} must not create a duplicate business entity`,
  );
  const canonicals = [...html.matchAll(/<link\s+rel=["']canonical["']\s+href=["']([^"']+)["'][^>]*>/gi)];
  assert.equal(canonicals.length, 1, `${file} must have one canonical URL`);
  assert.equal(canonicals[0][1], serviceEntity.url, `${file} canonical and Service URL must agree`);
  if (file.startsWith('furniture-assembly-')) {
    assert.ok(html.includes(dresserRange), `${file} must display catalog dresser pricing`);
    assert.ok(html.includes(paxPrice), `${file} must display catalog PAX pricing`);
  }
  if (file.startsWith('tv-mounting-')) assert.ok(html.includes(`From ${tvStart}`), `${file} must use the catalog TV start price`);
  if (file.startsWith('playset-assembly-')) assert.ok(html.includes(`From ${playsetStart}`), `${file} must use the catalog playset start price`);
  if (file.startsWith('fitness-equipment-assembly-')) {
    assert.ok(html.includes(rackPrice), `${file} must display catalog rack pricing`);
    assert.ok(!html.includes(`${rackPrice}+`), `${file} must not turn an exact catalog price into an open-ended price`);
  }
  if (!file.includes('-austin-tx.html')) {
    assert.doesNotMatch(html, />4\.9</);
    assert.doesNotMatch(html, /11 Google reviews/);
    assert.doesNotMatch(html, /&#9733;/);
    assert.match(html, /Reviewed service pros/);
  }
  assert.doesNotMatch(html, /1910 W Braker Ln/);
  assert.doesNotMatch(html, /entire Austin metro/i);
}

console.log('Launch regression checks passed');
