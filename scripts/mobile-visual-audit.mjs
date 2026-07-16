#!/usr/bin/env node

/**
 * Repeatable, read-only customer and Easer responsive audit.
 *
 * Usage:
 *   node scripts/mobile-visual-audit.mjs
 *
 * Optional environment variables:
 *   AAE_AUDIT_BASE_URL=http://127.0.0.1:4173
 *   AAE_AUDIT_SCREENSHOTS=1
 *   AAE_AUDIT_OUTPUT=.tmp-mobile-audit/results.json
 *   AAE_AUDIT_SCREENSHOT_DIR=.tmp-mobile-audit/screens
 *   AAE_AUDIT_QUICK=1
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (m) => m.slice(1))), '..');
const baseUrl = (process.env.AAE_AUDIT_BASE_URL || 'http://127.0.0.1:4173').replace(/\/$/, '');
const outputSetting = process.env.AAE_AUDIT_OUTPUT || '.tmp-mobile-audit/results.json';
const outputPath = path.isAbsolute(outputSetting) ? outputSetting : path.resolve(repoRoot, outputSetting);
const screenshotSetting = process.env.AAE_AUDIT_SCREENSHOT_DIR || path.join(path.dirname(outputPath), 'screens');
const screenshotRoot = path.isAbsolute(screenshotSetting) ? screenshotSetting : path.resolve(repoRoot, screenshotSetting);
const takeScreenshots = process.env.AAE_AUDIT_SCREENSHOTS === '1';
const quick = process.env.AAE_AUDIT_QUICK === '1';

function locatePlaywright() {
  const candidates = [];
  if (process.env.PLAYWRIGHT_MODULE_PATH) candidates.push(process.env.PLAYWRIGHT_MODULE_PATH);
  candidates.push('playwright');

  const npmCache = path.join(process.env.LOCALAPPDATA || '', 'npm-cache', '_npx');
  if (fs.existsSync(npmCache)) {
    for (const entry of fs.readdirSync(npmCache)) {
      candidates.push(path.join(npmCache, entry, 'node_modules', 'playwright'));
    }
  }

  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch {}
  }
  throw new Error('Playwright was not found. Install it or set PLAYWRIGHT_MODULE_PATH.');
}

function locateChromium(chromium) {
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    path.join(process.env.LOCALAPPDATA || '', 'ms-playwright'),
  ].filter(Boolean);

  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const dirs = fs.readdirSync(root)
      .filter((name) => /^chromium-\d+$/.test(name))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const dir of dirs) {
      const executable = path.join(root, dir, 'chrome-win64', 'chrome.exe');
      if (fs.existsSync(executable)) return executable;
    }
  }
  return chromium.executablePath();
}

const { chromium } = locatePlaywright();
const executablePath = locateChromium(chromium);

const requestedWidths = (process.env.AAE_AUDIT_WIDTHS || '')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value > 0);
const widths = requestedWidths.length
  ? requestedWidths
  : (quick ? [320, 390, 899, 900] : [320, 360, 390, 430, 768, 820, 899, 900]);
const ownerPages = [
  { id: 'owner-liveops', path: '/owner/index.html', group: 'owner-auth', ownerView: 'liveops', menu: true },
  { id: 'owner-today', path: '/owner/index.html', group: 'owner-auth', ownerView: 'today', menu: true },
  { id: 'owner-bookings', path: '/owner/index.html', group: 'owner-auth', ownerView: 'bookings', ownerSelectBooking: 'owner-payment-recovery', ownerDamageReviewBooking: 'owner-completed-damage-hold', ownerRefundRecoveryBooking: 'owner-completed-refund-recovery', menu: true },
  { id: 'owner-customers', path: '/owner/index.html', group: 'owner-auth', ownerView: 'customers', menu: true },
  { id: 'owner-market-demand', path: '/owner/index.html', group: 'owner-auth', ownerView: 'market-demand', menu: true },
  { id: 'owner-reviews', path: '/owner/index.html', group: 'owner-auth', ownerView: 'reviews', menu: true },
  { id: 'owner-marketing', path: '/owner/index.html', group: 'owner-auth', ownerView: 'marketing', menu: true },
  { id: 'owner-analytics', path: '/owner/index.html', group: 'owner-auth', ownerView: 'analytics', menu: true },
  { id: 'owner-intelligence', path: '/owner/index.html', group: 'owner-auth', ownerView: 'intelligence', menu: true },
  { id: 'owner-assemblers', path: '/owner/index.html', group: 'owner-auth', ownerView: 'assemblers', menu: true },
  { id: 'owner-waitlist', path: '/owner/index.html', group: 'owner-auth', ownerView: 'waitlist', menu: true },
];

const ownerViewEndpoints = {
  liveops: ['/api/owner/live-ops'],
  today: [],
  bookings: ['/api/booking/message', '/api/booking/activity', '/api/booking/notes'],
  customers: [],
  'market-demand': ['/api/owner/market-demand'],
  reviews: ['/api/owner/reviews'],
  marketing: ['/api/owner/promo', '/api/owner/social-automation'],
  analytics: ['/api/owner/financial-dashboard', '/api/owner/tax-report', '/api/owner/payouts'],
  intelligence: ['/api/owner/site-chat'],
  assemblers: ['/api/assembler/list'],
  waitlist: ['/api/owner/waitlist'],
};

const ownerViewTitles = {
  liveops: 'Live Operations',
  today: "Today's Schedule",
  bookings: 'Bookings',
  customers: 'Customers',
  'market-demand': 'Market Demand',
  reviews: 'Customer Reviews',
  marketing: 'Marketing',
  analytics: 'Financials',
  intelligence: 'AI Intelligence',
  assemblers: 'Easers',
  waitlist: 'Easer Waitlist',
};

const pages = [...(quick ? [
  { id: 'home', path: '/index.html', group: 'customer', menu: true },
  { id: 'book', path: '/book.html', group: 'customer', menu: false },
  { id: 'pricing', path: '/pricing.html', group: 'customer', menu: true },
  { id: 'locations', path: '/locations.html', group: 'customer', menu: true },
  { id: 'dallas-furniture', path: '/furniture-assembly-dallas-tx.html', group: 'customer', menu: true },
  { id: 'houston-furniture', path: '/furniture-assembly-houston-tx.html', group: 'customer', menu: true },
  { id: 'san-antonio-tv', path: '/tv-mounting-san-antonio-tx.html', group: 'customer', menu: true },
  { id: 'fort-worth-office', path: '/office-furniture-assembly-fort-worth-tx.html', group: 'customer', menu: true },
  { id: 'el-paso-fitness', path: '/fitness-equipment-assembly-el-paso-tx.html', group: 'customer', menu: true },
  { id: 'apply', path: '/assembler/apply.html', group: 'easer-public', menu: false },
  { id: 'easer-home', path: '/assembler/index.html', group: 'easer-auth', menu: false },
  { id: 'easer-jobs', path: '/assembler/my-assignments.html', group: 'easer-auth', menu: false },
  { id: 'easer-payouts', path: '/assembler/payouts.html', group: 'easer-auth', menu: false },
  { id: 'easer-profile', path: '/assembler/profile.html', group: 'easer-auth', menu: false },
] : [
  { id: 'home', path: '/index.html', group: 'customer', menu: true },
  { id: 'book', path: '/book.html', group: 'customer', menu: false },
  { id: 'pricing', path: '/pricing.html', group: 'customer', menu: true },
  { id: 'bundles', path: '/bundles.html', group: 'customer', menu: true },
  { id: 'setup-club', path: '/setup-club.html', group: 'customer', menu: true },
  { id: 'assemblecash', path: '/assemblecash.html', group: 'customer', menu: true },
  { id: 'business', path: '/business.html', group: 'customer', menu: true },
  { id: 'locations', path: '/locations.html', group: 'customer', menu: true },
  { id: 'track', path: '/track.html', group: 'customer', menu: true },
  { id: 'about', path: '/about.html', group: 'customer', menu: true },
  { id: 'contact', path: '/contact.html', group: 'customer', menu: true },
  { id: 'terms', path: '/terms.html', group: 'customer', menu: true },
  { id: 'privacy', path: '/privacy.html', group: 'customer', menu: true },
  { id: 'furniture-service', path: '/furniture-assembly-austin-tx.html', group: 'customer', menu: true },
  { id: 'dallas-furniture', path: '/furniture-assembly-dallas-tx.html', group: 'customer', menu: true },
  { id: 'houston-furniture', path: '/furniture-assembly-houston-tx.html', group: 'customer', menu: true },
  { id: 'san-antonio-tv', path: '/tv-mounting-san-antonio-tx.html', group: 'customer', menu: true },
  { id: 'fort-worth-office', path: '/office-furniture-assembly-fort-worth-tx.html', group: 'customer', menu: true },
  { id: 'el-paso-fitness', path: '/fitness-equipment-assembly-el-paso-tx.html', group: 'customer', menu: true },
  { id: 'tv-service', path: '/tv-mounting-austin-tx.html', group: 'customer', menu: true },
  { id: 'fitness-service', path: '/fitness-equipment-assembly-austin-tx.html', group: 'customer', menu: true },
  { id: 'smart-home-service', path: '/smart-home-installation-austin-tx.html', group: 'customer', menu: true },
  { id: 'office-service', path: '/office-furniture-assembly-austin-tx.html', group: 'customer', menu: true },
  { id: 'playset-service', path: '/playset-assembly-austin-tx.html', group: 'customer', menu: true },
  { id: 'blog-index', path: '/blog/index.html', group: 'customer', menu: true },
  { id: 'blog-article', path: '/blog/ikea-assembly-cost-austin.html', group: 'customer', menu: true },
  { id: 'apply', path: '/assembler/apply.html', group: 'easer-public', menu: false },
  { id: 'agreement', path: '/assembler/contractor-agreement.html', group: 'easer-public', menu: false },
  { id: 'identity', path: '/assembler/verify-identity.html', group: 'easer-auth', menu: false },
  { id: 'login', path: '/auth/login.html', group: 'auth-public', menu: false },
  { id: 'signup-alias', path: '/auth/signup.html', group: 'auth-public', menu: false },
  { id: 'forgot-password', path: '/auth/forgot-password.html', group: 'auth-public', menu: false },
  { id: 'reset-password', path: '/auth/reset-password.html#access_token=mock&type=recovery', group: 'auth-recovery', menu: false },
  { id: 'set-password', path: '/auth/set-password.html#access_token=mock&type=recovery', group: 'auth-recovery', menu: false },
  { id: 'easer-home', path: '/assembler/index.html', group: 'easer-auth', menu: false },
  { id: 'easer-jobs', path: '/assembler/my-assignments.html', group: 'easer-auth', menu: false },
  { id: 'easer-payouts', path: '/assembler/payouts.html', group: 'easer-auth', menu: false },
  { id: 'easer-profile', path: '/assembler/profile.html', group: 'easer-auth', menu: false },
]), ...ownerPages];

const now = Date.now();
const iso = (deltaMs) => new Date(now + deltaMs).toISOString();
const dateOnly = (deltaDays) => new Date(now + deltaDays * 86400000).toISOString().slice(0, 10);
const mockBookings = [
  {
    id: 'job-live-1', ref: 'AAE-240713', status: 'in_progress', service: 'Furniture Assembly',
    description: 'Two bookcases and one six-drawer dresser', details: 'Please use the side entrance. Parking is available in the driveway.',
    date: dateOnly(0), time: '2:00 PM', address: '1207 South Congress Avenue, Austin, TX 78704',
    city: 'Austin', state: 'TX', zip: '78704', customer_name: 'Alex Morgan', customer_phone: '+15125550144',
    customer_email: 'alex.morgan@example.com', assembler_accepted_at: iso(-7200000), en_route_at: iso(-5400000),
    checked_in_at: iso(-3600000), job_started_at: iso(-1800000), assembler_due: 14625, payout_status: 'pending',
    _pay_estimate_lo: 14625, _pay_estimate_hi: 14625,
    _booking_items: [{ service_name: 'Bookcase assembly', quantity: 2 }, { service_name: 'Dresser assembly', quantity: 1 }],
  },
  {
    id: 'job-offer-1', ref: 'AAE-240714', status: 'confirmed', service: 'TV Mounting',
    description: 'Mount one 65-inch television on drywall', date: dateOnly(1), time: '10:30 AM',
    _is_pending_offer: true, _offer_token: 'mock-offer-token', _offer_location: 'South Austin, TX 78745',
    _offer_expires_at: iso(3600000), _pay_estimate_lo: 11250, _pay_estimate_hi: 12850,
    _booking_items: [{ service_name: 'TV mounting up to 70 inches', quantity: 1 }],
  },
  {
    id: 'job-upcoming-1', ref: 'AAE-240715', status: 'confirmed', service: 'Fitness Equipment Assembly',
    date: dateOnly(3), time: '9:00 AM', address: '501 West 5th Street, Austin, TX 78701',
    city: 'Austin', state: 'TX', zip: '78701', assembler_due: 17375, _pay_estimate_lo: 17375, _pay_estimate_hi: 17375,
    _booking_items: [{ service_name: 'Treadmill assembly', quantity: 1 }],
  },
  {
    id: 'job-complete-1', ref: 'AAE-240701', status: 'completed', service: 'Office Furniture Assembly',
    date: dateOnly(-12), time: '1:00 PM', completed_at: iso(-10 * 86400000), assembler_accepted_at: iso(-13 * 86400000),
    assembler_due: 18450, payout_status: 'paid', paid_out_at: iso(-8 * 86400000), payment_status: 'captured',
    _booking_items: [{ service_name: 'Standing desk assembly', quantity: 2 }],
  },
  {
    id: 'job-cancel-1', ref: 'AAE-240630', status: 'cancelled', service: 'Smart Home Setup',
    date: dateOnly(-14), cancelled_at: iso(-13 * 86400000), cancellation_easer_due_cents: 3500,
    cancellation_easer_payout_status: 'pending', payout_status: 'pending',
  },
];

const mockOwnerBookings = [
  {
    id: 'owner-payment-recovery', ref: 'AAE-250714', status: 'pending', service: 'Furniture Assembly',
    description: 'Assemble one wardrobe and a six-drawer dresser', details: 'Gate code is 2468. Customer asked for shoe covers.',
    date: dateOnly(0), time: '11:30 AM', address: '2401 East 6th Street, Austin, TX 78702',
    customer_name: 'Morgan Ellis', customer_email: 'morgan.ellis@example.com', customer_phone: '+15125550108',
    total_price: 18950, subtotal: 17500, tax_amount: 1450, payment_status: 'failed',
    stripe_payment_intent_id: 'pi_mock_payment_recovery', payout_status: 'unpaid', source: 'online',
    created_at: iso(-3 * 3600000), has_unread_customer_msg: true, unread_message_count: 2,
    messages: [{ count: 2 }],
  },
  {
    id: 'owner-quote-request', ref: 'AAE-250715', status: 'pending', service: 'Custom Quote',
    description: 'Garage storage wall and workbench assembly', details: 'Customer uploaded measurements and product links.',
    date: dateOnly(2), time: '1:00 PM', address: '8700 Shoal Creek Boulevard, Austin, TX 78757',
    customer_name: 'Avery Johnson', customer_email: 'avery.johnson@example.com', customer_phone: '+15125550136',
    total_price: 0, subtotal: 0, tax_amount: 0, payment_status: 'card_saved', payout_status: 'unpaid',
    source: 'online', created_at: iso(-95 * 60000), unread_message_count: 0,
  },
  {
    id: 'owner-confirmed-unassigned', ref: 'AAE-250716', status: 'confirmed', service: 'TV Mounting',
    description: 'Mount one 65-inch television above a media console', date: dateOnly(1), time: '9:00 AM',
    address: '310 Bowie Street, Austin, TX 78703', customer_name: 'Taylor Brooks',
    customer_email: 'taylor.brooks@example.com', customer_phone: '+15125550174', total_price: 22900,
    subtotal: 21159, tax_amount: 1741, payment_status: 'authorized', stripe_payment_intent_id: 'pi_mock_authorized',
    payout_status: 'unpaid', payout_mode_snapshot: 'manual', needs_manual_dispatch: true, dispatch_attempt: 2,
    source: 'online', created_at: iso(-18 * 3600000), unread_message_count: 0,
  },
  {
    id: 'owner-in-progress', ref: 'AAE-250713', status: 'in_progress', service: 'Fitness Equipment Assembly',
    description: 'Assemble treadmill and adjustable bench', date: dateOnly(0), time: '2:00 PM',
    address: '501 West 5th Street, Austin, TX 78701', customer_name: 'Casey Nguyen',
    customer_email: 'casey.nguyen@example.com', customer_phone: '+15125550191', total_price: 28475,
    subtotal: 26305, tax_amount: 2170, payment_status: 'authorized', payout_status: 'unpaid',
    payout_mode_snapshot: 'manual', assembler_id: 'easer-owner-1', assembler_name: 'Jordan Rivera',
    assembler_phone: '+15125550192', assembler_tier: 'professional', assembler_rating: 4.9,
    assembler_accepted_at: iso(-4 * 3600000), en_route_at: iso(-3 * 3600000), checked_in_at: iso(-2 * 3600000),
    job_started_at: iso(-90 * 60000), has_unread_easer_msg: true, unread_message_count: 1,
    messages: [{ count: 1 }], source: 'online', created_at: iso(-2 * 86400000),
  },
  {
    id: 'owner-completed-payable', ref: 'AAE-250701', status: 'completed', service: 'Office Furniture Assembly',
    description: 'Two standing desks and four task chairs', date: dateOnly(-10), time: '10:00 AM',
    address: '600 Congress Avenue, Austin, TX 78701', customer_name: 'Morgan Ellis',
    customer_email: 'morgan.ellis@example.com', customer_phone: '+15125550108', total_price: 22000,
    subtotal: 20323, tax_amount: 1677, amount_charged: 22000, payment_status: 'captured',
    stripe_payment_intent_id: 'pi_mock_captured', payout_status: 'pending', payout_mode_snapshot: 'manual',
    assembler_id: 'easer-owner-1', assembler_name: 'Jordan Rivera', assembler_phone: '+15125550192',
    assembler_tier: 'professional', assembler_rating: 4.9, assembler_due: 14300,
    completed_at: iso(-9 * 86400000), review_requested_at: iso(-8 * 86400000),
    source: 'online', created_at: iso(-12 * 86400000), unread_message_count: 0,
    financial_summary: {
      grossChargedCents: 22000, refundAmountCents: 0, netChargedCents: 22000,
      taxCollectedCents: 1677, processingFeeCents: 668, easerCostCents: 14300, platformGrossCents: 5355,
    },
  },
  {
    id: 'owner-completed-damage-hold', ref: 'AAE-250629', status: 'completed', service: 'Furniture Assembly',
    description: 'Assemble a dining table, six chairs, and a sideboard', date: dateOnly(-15), time: '12:30 PM',
    address: '1701 South Lamar Boulevard, Austin, TX 78704', customer_name: 'Cameron Reed',
    customer_email: 'cameron.reed@example.com', customer_phone: '+15125550149', total_price: 24735,
    subtotal: 22849, tax_amount: 1886, amount_charged: 24735, payment_status: 'captured',
    stripe_payment_intent_id: 'pi_mock_damage_hold', payout_status: 'pending', payout_mode_snapshot: 'manual',
    assembler_id: 'easer-owner-1', assembler_name: 'Jordan Rivera', assembler_phone: '+15125550192',
    assembler_tier: 'professional', assembler_rating: 4.9, assembler_due: 16078,
    damage_review_status: 'review_required', damage_claim_opened_at: iso(-13 * 86400000),
    evidence_requested_at: iso(-14 * 86400000), completed_at: iso(-14 * 86400000),
    source: 'online', created_at: iso(-17 * 86400000), unread_message_count: 0,
    financial_summary: {
      grossChargedCents: 24735, refundAmountCents: 0, netChargedCents: 24735,
      taxCollectedCents: 1886, processingFeeCents: 747, easerCostCents: 16078, platformGrossCents: 6024,
    },
  },
  {
    id: 'owner-completed-refund-hold', ref: 'AAE-250628', status: 'completed', service: 'Smart Home Setup',
    description: 'Doorbell, thermostat, and two indoor cameras', date: dateOnly(-16), time: '3:30 PM',
    address: '1900 Simond Avenue, Austin, TX 78723', customer_name: 'Riley Carter',
    customer_email: 'riley.carter@example.com', customer_phone: '+15125550157', total_price: 19800,
    subtotal: 18291, tax_amount: 1509, amount_charged: 16800, payment_status: 'partially_refunded',
    refund_amount: 3000, payout_status: 'pending', payout_mode_snapshot: 'manual', payout_review_status: 'review_required',
    assembler_id: 'easer-owner-2', assembler_name: 'Sam Patel', assembler_phone: '+15125550163',
    assembler_tier: 'starter', assembler_rating: 4.7, assembler_due: 11880,
    completed_at: iso(-15 * 86400000), source: 'online', created_at: iso(-18 * 86400000), unread_message_count: 0,
    financial_summary: {
      grossChargedCents: 19800, refundAmountCents: 3000, netChargedCents: 16800,
      taxCollectedCents: 1280, processingFeeCents: 604, easerCostCents: 11880, platformGrossCents: 3036,
    },
  },
  {
    id: 'owner-completed-refund-recovery', ref: 'AAE-250627', status: 'completed', service: 'Office Furniture Assembly',
    description: 'Assemble a conference table and eight task chairs', date: dateOnly(-17), time: '11:00 AM',
    address: '701 Brazos Street, Austin, TX 78701', customer_name: 'Riley Carter',
    customer_email: 'riley.carter@example.com', customer_phone: '+15125550157', total_price: 21600,
    subtotal: 19954, tax_amount: 1646, amount_charged: 21600, payment_status: 'partially_refunded',
    refund_amount: 4000, refund_id: 're_mock_partial', stripe_payment_intent_id: 'pi_mock_refund_recovery',
    payout_status: 'pending', payout_mode_snapshot: 'manual', payout_review_status: 'review_required',
    assembler_id: 'easer-owner-2', assembler_name: 'Sam Patel', assembler_phone: '+15125550163',
    assembler_tier: 'starter', assembler_rating: 4.7, assembler_due: 12960,
    financial_operation_key: 'refund:owner:owner-completed-refund-recovery:total:21600',
    financial_operation_type: 'refund_owner', financial_operation_started_at: iso(-2 * 3600000),
    financial_reconciliation_required_at: iso(-90 * 60000),
    financial_reconciliation_reason: 'Stripe completed part of the requested full refund. Resume from this booking to recheck aggregate Stripe truth.',
    completed_at: iso(-16 * 86400000), source: 'online', created_at: iso(-19 * 86400000), unread_message_count: 0,
    financial_summary: {
      grossChargedCents: 21600, refundAmountCents: 4000, netChargedCents: 17600,
      taxCollectedCents: 1341, processingFeeCents: 626, easerCostCents: 12960, platformGrossCents: 2673,
    },
  },
  {
    id: 'owner-cancelled-fee', ref: 'AAE-250626', status: 'cancelled', service: 'Furniture Assembly',
    description: 'Late cancellation after Easer assignment', date: dateOnly(-18), time: '8:30 AM',
    address: '4301 Bull Creek Road, Austin, TX 78731', customer_name: 'Drew Simmons',
    customer_email: 'drew.simmons@example.com', customer_phone: '+15125550182', total_price: 15900,
    payment_status: 'cancellation_fee_captured', cancellation_fee_cents: 5000, cancellation_easer_due_cents: 3500,
    payout_status: 'pending', payout_mode_snapshot: 'manual', assembler_id: 'easer-owner-2',
    assembler_name: 'Sam Patel', assembler_phone: '+15125550163', assembler_tier: 'starter',
    cancelled_at: iso(-18 * 86400000), source: 'online', created_at: iso(-20 * 86400000), unread_message_count: 0,
  },
];

const mockOwnerEasers = [
  {
    id: 'easer-owner-1', role: 'assembler', full_name: 'Jordan Rivera', email: 'jordan.rivera@example.com',
    phone: '+15125550192', city: 'Austin', state: 'TX', zip: '78704', tier: 'professional', status: 'active',
    application_status: 'approved', identity_verified: true, id_verification_status: 'verified', is_available: true,
    rating: 4.9, review_count: 17, completed_jobs: 42, total_earned: 128450, created_at: iso(-180 * 86400000),
    contractor_agreement_signed_at: iso(-180 * 86400000), contractor_agreement_version: '2026-07-13',
    stripe_connect_account_id: null, stripe_connect_onboarding_complete: false, stripe_connect_details_submitted: false,
    stripe_connect_charges_enabled: false, stripe_connect_payouts_enabled: false, payout_method_preference: 'ach',
    readiness: { isReady: true, finalStatus: 'READY FOR JOBS', missingItems: [] },
  },
  {
    id: 'easer-owner-2', role: 'assembler', full_name: 'Sam Patel', email: 'sam.patel@example.com',
    phone: '+15125550163', city: 'Austin', state: 'TX', zip: '78745', tier: 'starter', status: 'active',
    application_status: 'approved', identity_verified: true, id_verification_status: 'verified', is_available: false,
    rating: 4.7, review_count: 6, completed_jobs: 13, total_earned: 48200, created_at: iso(-75 * 86400000),
    contractor_agreement_signed_at: iso(-75 * 86400000), contractor_agreement_version: '2026-07-13',
    stripe_connect_account_id: null, stripe_connect_onboarding_complete: false, stripe_connect_details_submitted: false,
    stripe_connect_charges_enabled: false, stripe_connect_payouts_enabled: false, payout_method_preference: 'zelle',
    readiness: { isReady: false, finalStatus: 'NOT READY', missingItems: ['Go online when ready for jobs'] },
  },
  {
    id: 'easer-owner-3', role: 'assembler', full_name: 'Jamie Lee', email: 'jamie.lee@example.com',
    phone: '+15125550129', city: 'Round Rock', state: 'TX', zip: '78664', tier: null, status: 'pending',
    application_status: 'pending', identity_verified: false, id_verification_status: 'pending', is_available: false,
    rating: null, review_count: 0, completed_jobs: 0, total_earned: 0, created_at: iso(-4 * 86400000),
    contractor_agreement_signed_at: iso(-4 * 86400000), contractor_agreement_version: '2026-07-13',
    stripe_connect_account_id: null, stripe_connect_onboarding_complete: false, stripe_connect_details_submitted: false,
    stripe_connect_charges_enabled: false, stripe_connect_payouts_enabled: false, payout_method_preference: null,
  },
];

const mockOwnerWaitlist = {
  entries: [
    { id: 'wait-1', name: 'Alexis Green', email: 'alexis.green@example.com', phone: '+15125550167', city: 'Austin', state: 'TX', zip: '78748', status: 'pending', created_at: iso(-5 * 86400000) },
    { id: 'wait-2', name: 'Chris Walker', email: 'chris.walker@example.com', phone: '+15125550145', city: 'Pflugerville', state: 'TX', zip: '78660', status: 'invited', invite_sent_at: iso(-2 * 86400000), invite_expires_at: iso(5 * 86400000), created_at: iso(-12 * 86400000) },
    { id: 'wait-3', name: 'Devon Price', email: 'devon.price@example.com', phone: '+15125550131', city: 'Round Rock', state: 'TX', zip: '78664', status: 'applied', created_at: iso(-20 * 86400000) },
  ],
  stats: { total: 3, pending: 1, invited: 1, applied: 1, approved: 0, rejected: 0 },
};

const mockOwnerMarketDemand = {
  setupNeeded: false,
  summary: { activeMarkets: 1, emergingMarkets: 2, marketRequests: 7, marketConversionRate: 0.286, easerSupplyByMarket: 3, totalPotentialRevenue: 164500 },
  topMarkets: [
    { market: 'Round Rock, TX', isActiveMarket: false, activationStatus: 'READY TO REVIEW', requestCount: 4, potentialRevenue: 97500, approvedEasers: 1, demandToSupplyRatio: 4, topServices: [{ service: 'Furniture Assembly', count: 3 }, { service: 'TV Mounting', count: 1 }], requestedZips: ['78664', '78665'], easerApplications: 2, waitlistEasers: 1 },
    { market: 'Cedar Park, TX', isActiveMarket: false, activationStatus: 'WATCH', requestCount: 3, potentialRevenue: 67000, approvedEasers: 0, demandToSupplyRatio: 3, topServices: [{ service: 'Fitness Equipment Assembly', count: 2 }, { service: 'Playset Assembly', count: 1 }], requestedZips: ['78613'], easerApplications: 0, waitlistEasers: 1 },
  ],
  requests: [
    { requestRef: 'MR-260714-01', customerName: 'Quinn Harris', customerEmail: 'quinn.harris@example.com', city: 'Round Rock', state: 'TX', zip: '78664', requestedService: 'Furniture Assembly', requestedDate: dateOnly(5), desiredTime: 'Morning', estimatedRevenue: 24500, status: 'new' },
    { requestRef: 'MR-260713-02', customerName: 'Parker Young', customerEmail: 'parker.young@example.com', city: 'Cedar Park', state: 'TX', zip: '78613', requestedService: 'Fitness Equipment Assembly', requestedDate: dateOnly(7), desiredTime: 'Afternoon', estimatedRevenue: 31500, status: 'watch' },
  ],
};

const mockOwnerReviews = {
  reviews: [
    { id: 'review-1', customer_name: 'Morgan Ellis', service: 'Office Furniture Assembly', rating: 5, body: 'Careful work, clear updates, and everything was cleaned up before the Easer left.', approved: true, created_at: iso(-8 * 86400000) },
    { id: 'review-2', customer_name: 'Riley Carter', service: 'Smart Home Setup', rating: 4, body: 'The setup works well and the handoff was easy to understand.', approved: true, created_at: iso(-14 * 86400000) },
    { id: 'review-3', customer_name: 'Taylor Brooks', service: 'TV Mounting', rating: 5, body: 'Professional, on time, and the television is level.', approved: false, created_at: iso(-2 * 86400000) },
  ],
};

const mockOwnerPromo = {
  settings: {
    promoEnabled: true, firstBookingOnly: true, promoCode: 'AUSTIN15', promoTitle: 'Austin first-booking offer',
    promoLabel: '$15 off your first booking', promoDiscountType: 'amount', promoDiscountDollars: 15,
    promoDiscountPct: 0, setupNeeded: false,
  },
  publicPromo: { code: 'AUSTIN15', label: '$15 off your first booking' },
  performance: {
    available: true, redemptions: 6, totalDiscountCents: 9000, totalRevenueCents: 126450,
    recentBookings: [
      { ref: 'AAE-250701', customerName: 'Morgan Ellis', promoDiscountCents: 1500, totalPrice: 22000 },
      { ref: 'AAE-250628', customerName: 'Riley Carter', promoDiscountCents: 1500, totalPrice: 19800 },
    ],
  },
};

const mockOwnerSocialAutomation = {
  snapshot: {
    enabled: true,
    channels: [
      { key: 'facebook', displayName: 'Facebook', descriptor: 'Austin service updates', lane: 'Local services and booking intent', ready: true, queuedCount: 5, targetQueued: 5, deficit: 0, recentSentCount: 3, recentErrorCount: 0, postingSlotsPerWeek: 3, nextDueAt: iso(20 * 3600000), missing: [], queuePaused: false },
      { key: 'googleBusiness', displayName: 'Google Business Profile', descriptor: 'Austin local discovery', lane: 'Local proof and service education', ready: true, queuedCount: 3, targetQueued: 4, deficit: 1, recentSentCount: 2, recentErrorCount: 0, postingSlotsPerWeek: 2, nextDueAt: iso(28 * 3600000), missing: [], queuePaused: false },
      { key: 'linkedin', displayName: 'LinkedIn', descriptor: 'Founder and operations voice', lane: 'Founder updates', ready: false, queuedCount: 0, targetQueued: 0, deficit: 0, recentSentCount: 0, recentErrorCount: 0, postingSlotsPerWeek: 0, nextDueAt: null, missing: ['Buffer channel ID'], queuePaused: false },
    ],
  },
};

const mockOwnerFinancialDashboard = {
  summary: {
    completedJobs: 18, customerRevenue: 426750, salesTaxCollected: 32531, processingFees: 12675,
    easerPayouts: 277388, platformGrossProfit: 104156, estimatedNetOperatingProfit: 64156,
    grossProfitPerJob: 5786, cac: 2100, activeEasers: 2,
  },
  executiveOverview: {
    completedJobs: 18, totalCustomerRevenue: 426750, averageJobValue: 23708,
    platformGrossProfit: 104156, platformGrossProfitPerCompletedJob: 5786, estimatedNetOperatingProfit: 64156,
    addOnAttachmentRate: 0.333, addOnAttachmentRateSource: 'actual_booking_items', averageAddOnValue: 4200,
    bundleAttachRate: 0.167, assemblecashLiabilityCents: 12450, repeatCustomerRate: 0.222,
    refundReworkRate: 0.056, activeEasers: 2,
  },
  assumptions: { reserveRate: 0.05, annualOperatingExpensesCents: 480000, processingRate: 0.029, processingFixedCents: 30 },
  reconciliation: { legacyRows: 0, ledgerBackedRows: 18, cancellationEarningRows: 1 },
  serviceProfitability: [
    { serviceName: 'Furniture Assembly', completedJobs: 8, revenue: 184000, baseServiceRevenue: 158000, addOnRevenue: 26000, averageTicket: 23000, processingFees: 5576, easerPayouts: 119600, platformGrossProfit: 44750, platformGrossPerJob: 5594, reworkRefundReserve: 9200, netContributionEstimate: 35550, recommendedAction: 'Keep' },
    { serviceName: 'TV Mounting', completedJobs: 5, revenue: 118750, baseServiceRevenue: 106750, addOnRevenue: 12000, averageTicket: 23750, processingFees: 3594, easerPayouts: 77188, platformGrossProfit: 28701, platformGrossPerJob: 5740, reworkRefundReserve: 5938, netContributionEstimate: 22763, recommendedAction: 'Keep' },
    { serviceName: 'Smart Home Setup', completedJobs: 5, revenue: 124000, baseServiceRevenue: 112000, addOnRevenue: 12000, averageTicket: 24800, processingFees: 3505, easerPayouts: 80600, platformGrossProfit: 30705, platformGrossPerJob: 6141, reworkRefundReserve: 6200, netContributionEstimate: 24505, recommendedAction: 'Keep' },
  ],
  expansionReadiness: {
    ready: false, status: 'NOT READY FOR EXPANSION', completedJobs: 18, customerRating: 4.9, reviewCount: 14,
    activeEasers: 2, estimatedOperatingProfit: 64156, refundRate: 0.056, reworkRate: 0,
    checks: [
      { label: 'First 25 completed Austin jobs', passed: false, display: '18 / 25' },
      { label: 'Customer rating', passed: true, display: '4.90 / 5' },
      { label: 'Active Easer coverage', passed: true, display: '2 ready' },
      { label: 'Positive operating estimate', passed: true, display: '$641.56' },
    ],
  },
  ledger: [
    { ref: 'AAE-250701', customerName: 'Morgan Ellis', easerName: 'Jordan Rivera', service: 'Office Furniture Assembly', status: 'completed', eventType: 'completed_job', customerRevenue: 22000, processingFee: 668, easerPayout: 14300, platformGrossProfit: 5355, dataSource: 'ledger', eventAt: iso(-9 * 86400000), completedAt: iso(-9 * 86400000), date: dateOnly(-10) },
    { ref: 'AAE-250628', customerName: 'Riley Carter', easerName: 'Sam Patel', service: 'Smart Home Setup', status: 'completed', eventType: 'completed_job', customerRevenue: 16800, processingFee: 604, easerPayout: 11880, platformGrossProfit: 3036, dataSource: 'ledger', eventAt: iso(-15 * 86400000), completedAt: iso(-15 * 86400000), date: dateOnly(-16) },
    { ref: 'AAE-250626', customerName: 'Drew Simmons', easerName: 'Sam Patel', service: 'Furniture Assembly', status: 'cancelled', eventType: 'cancellation_earnings', customerRevenue: 5000, processingFee: 175, easerPayout: 3500, platformGrossProfit: 1325, dataSource: 'ledger', eventAt: iso(-18 * 86400000), date: dateOnly(-18) },
  ],
  contractorTax: {
    available: true, year: new Date().getFullYear(), countNeeding1099: 1,
    easers: [
      { name: 'Jordan Rivera', ytdPaidCents: 68450, payoutCount: 8, needs1099: true },
      { name: 'Sam Patel', ytdPaidCents: 23100, payoutCount: 3, needs1099: false },
    ],
  },
  clawbacks: { totalOwedCents: 0, count: 0, items: [] },
};

const mockOwnerTaxReport = {
  periods: [
    { period: `${new Date().getFullYear()}-Q2`, taxableSalesCents: 394219, taxCollectedCents: 32531, taxRefundedCents: 229, netLiabilityCents: 32302, statePortionCents: 24406, localPortionCents: 7896, remittedCents: 20000, outstandingCents: 12302 },
  ],
  totals: { taxableSalesCents: 394219, taxCollectedCents: 32531, taxRefundedCents: 229, netLiabilityCents: 32302, remittedCents: 20000, outstandingCents: 12302 },
  remittancesAvailable: true,
  remittances: [{ date_remitted: dateOnly(-30), filing_period: `${new Date().getFullYear()}-Q2`, amount_cents: 20000, reference: 'TX-COMP-1042', notes: 'Partial quarterly remittance' }],
};

const mockOwnerPayouts = {
  easers: [
    { assembler_id: 'easer-owner-1', assembler_name: 'Jordan Rivera', assembler_tier: 'professional', email: 'jordan.rivera@example.com', phone: '+15125550192', payout_method_preference: 'ach', jobs: 8, total_owed: 82750, total_paid: 68450, total_pending: 14300, total_payable: 14300, total_on_hold: 0, last_earning_date: dateOnly(-9), account_closure_status: null, unpaid_jobs: [{ id: 'owner-completed-payable', ref: 'AAE-250701', disposition: 'payable' }] },
    { assembler_id: 'easer-owner-2', assembler_name: 'Sam Patel', assembler_tier: 'starter', email: 'sam.patel@example.com', phone: '+15125550163', payout_method_preference: 'zelle', jobs: 4, total_owed: 38480, total_paid: 23100, total_pending: 15380, total_payable: 3500, total_on_hold: 11880, last_earning_date: dateOnly(-15), account_closure_status: null, unpaid_jobs: [{ id: 'owner-cancelled-fee', ref: 'AAE-250626', disposition: 'payable' }, { id: 'owner-completed-refund-hold', ref: 'AAE-250628', disposition: 'on_hold' }] },
  ],
  totals: { jobs: 12, cancellation_earnings: 1, total_owed: 121230, total_paid: 91550, total_pending: 29680, total_payable: 17800, total_on_hold: 11880 },
};

const mockOwnerSiteChat = {
  hours: 48,
  summary: { conversations: 2, totalMessages: 7 },
  conversations: [
    {
      conversationId: 'chat-owner-1', visitorLabel: 'Visitor 4821', pagePath: '/furniture-assembly-austin-tx',
      paths: ['/furniture-assembly-austin-tx', '/pricing'], userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) Mobile',
      startedAt: iso(-4 * 3600000), lastAt: iso(-3 * 3600000), messageCount: 4, userMessageCount: 2, assistantMessageCount: 2,
      preview: 'Can you assemble a wardrobe this Saturday?',
      messages: [
        { role: 'user', body: 'Can you assemble a wardrobe this Saturday?', createdAt: iso(-4 * 3600000) },
        { role: 'assistant', body: 'You can check current appointment options in the booking flow. The final price is shown before confirmation.', createdAt: iso(-4 * 3600000 + 30000) },
        { role: 'user', body: 'Do I need to move it into the room first?', createdAt: iso(-3 * 3600000 - 60000) },
        { role: 'assistant', body: 'Please have the unopened boxes in the assembly area when possible, with enough room for safe work.', createdAt: iso(-3 * 3600000) },
      ],
    },
    {
      conversationId: 'chat-owner-2', visitorLabel: 'Visitor 1954', pagePath: '/tv-mounting-austin-tx', paths: ['/tv-mounting-austin-tx'],
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', startedAt: iso(-20 * 3600000), lastAt: iso(-20 * 3600000 + 120000),
      messageCount: 3, userMessageCount: 2, assistantMessageCount: 1, preview: 'Does the mounting price include the bracket?',
      messages: [
        { role: 'user', body: 'Does the mounting price include the bracket?', createdAt: iso(-20 * 3600000) },
        { role: 'assistant', body: 'Mounting service and optional add-ons are itemized before you confirm the booking.', createdAt: iso(-20 * 3600000 + 30000) },
        { role: 'user', body: 'Thanks, I will check the booking page.', createdAt: iso(-20 * 3600000 + 120000) },
      ],
    },
  ],
};

const mockOwnerLiveOps = {
  generatedAt: iso(0),
  summary: {
    totalActive: 3, pendingPayment: 1, quoteNeedsPricing: 1, quoteAwaitingApproval: 0, quoteAuthorizationPending: 0,
    pendingOther: 0, unassigned: 0, awaitingDispatch: 0, offersExpired: 0, needsManual: 1, awaitingAcceptance: 0,
    enRoute: 0, arrived: 0, inProgress: 1, alertCount: 4, criticalAlerts: 2, runtimeErrors: 1,
    failedNotifications: 1, unnotifiedActiveOffers: 0, recentDamageReports: 0, workflowMismatches: 0,
    paymentStateMismatches: 0, unreadyEasers: 1, cronErrors: 0, onlineEasers: 1, freeEasers: 0, todayJobs: 2,
  },
  alerts: [
    { type: 'today_unassigned', severity: 'critical', ref: 'AAE-250716', bookingId: 'owner-confirmed-unassigned', message: 'AAE-250716 is authorized but still needs an Easer assignment.', action: 'dispatch' },
    { type: 'payment_failed_recovery', severity: 'high', ref: 'AAE-250714', bookingId: 'owner-payment-recovery', message: 'AAE-250714 has a failed card authorization and a customer message waiting.', action: 'review_timeline' },
    { type: 'quote_needs_pricing', severity: 'medium', ref: 'AAE-250715', bookingId: 'owner-quote-request', message: 'AAE-250715 is a custom quote with a saved card and needs owner pricing.', action: 'review_timeline' },
  ],
  unassigned: [], awaitingDispatch: [], offersExpired: [], needsManual: [mockOwnerBookings[2]],
  awaitingAcceptance: [], enRoute: [], arrived: [], inProgress: [mockOwnerBookings[3]], pendingConfirm: [],
  pendingPayment: [mockOwnerBookings[0]], quoteNeedsPricing: [mockOwnerBookings[1]], quoteAwaitingApproval: [],
  quoteAuthorizationPending: [], pendingOther: [], paymentStateMismatches: [],
  todaySchedule: [mockOwnerBookings[0], mockOwnerBookings[3]],
  onlineEasers: [{ ...mockOwnerEasers[0], status: 'working', booking_stage: 'in_progress' }], offlineCount: 1,
  recentFailures: [
    { kind: 'notification', severity: 'medium', title: 'Customer payment reminder email failed', detail: 'The booking remains available for owner follow-up; email did not change payment state.', bookingId: 'owner-payment-recovery', recipient: 'morgan.ellis@example.com', notificationType: 'payment_continuation', ownerAction: 'Use the booking timeline and retry after confirming the address.', when: iso(-90 * 60000) },
    { kind: 'runtime', severity: 'high', title: 'Auto-dispatch retry recorded', detail: 'One dispatch run exhausted eligible Easers and moved the booking to manual assignment.', meta: 'AAE-250716', ownerAction: 'Review eligible Easers and assign manually.', when: iso(-2 * 3600000) },
  ],
  damageReports: [], partial: false, warnings: [],
};

const mockProfile = {
  id: 'easer-mock-1', role: 'assembler', full_name: 'Jordan Rivera', email: 'jordan.rivera@example.com',
  phone: '+15125550192', city: 'Austin', state: 'TX', zip: '78704', profile_photo: null,
  tier: 'professional', status: 'active', application_status: 'approved', identity_verified: true,
  is_available: true, rating: 4.9, review_count: 17, completed_jobs: 42, total_earned: 128450,
  contractor_agreement_signed_at: '2026-07-13T14:00:00.000Z', contractor_agreement_version: '2026-07-13',
  code_of_conduct_agreed_at: '2026-07-13T14:00:00.000Z', created_at: '2026-01-12T12:00:00.000Z',
  application_fee_paid: true, application_fee_waived: false, fee_waived_by_owner: false,
  account_closure_status: null,
};

// Realistic launch-mode readiness: manual payouts are enabled, so Connect is
// intentionally not required and must not block a fully approved Easer.
const mockManualPayoutReadiness = {
  connectRequired: false,
  applicationSubmitted: true,
  contractorAgreementAccepted: true,
  codeOfConductAccepted: true,
  agreementVersion: '2026-07-13',
  agreementCurrent: true,
  identityVerified: true,
  ownerApproved: true,
  tierEligible: true,
  available: true,
  phoneAvailable: true,
  applicationFeeStatusKnown: true,
  applicationFeeSatisfied: true,
  accountClosureStatus: null,
  accountClosureBlocking: false,
  connectStarted: false,
  connectVerified: false,
  connectComplete: false,
  payoutsEnabled: false,
  chargesEnabled: false,
  requirementsDueCount: 0,
  disabledReason: null,
  verificationError: null,
  tier: 'professional',
  currentAgreementVersion: '2026-07-13',
  missingItems: [],
  isReady: true,
  finalStatus: 'READY FOR JOBS',
};

function mockBootstrap(profileInput) {
  const profile = JSON.parse(JSON.stringify(profileInput));
  const user = { id: profile.id, email: profile.email };
  const session = { access_token: 'mock-access-token', expires_at: Math.floor(Date.now() / 1000) + 7200, user };

  function shouldBePublicAuth() {
    return /^\/auth\/(?:login|forgot-password|signup)/.test(location.pathname);
  }

  function resultFor(table, one) {
    if (table === 'profiles') return one ? profile : [profile];
    return one ? null : [];
  }

  function query(table) {
    const state = { one: false };
    const builder = {
      select() { return builder; }, eq() { return builder; }, neq() { return builder; }, in() { return builder; },
      not() { return builder; }, is() { return builder; }, gt() { return builder; }, gte() { return builder; },
      lt() { return builder; }, lte() { return builder; }, ilike() { return builder; }, or() { return builder; },
      order() { return builder; }, range() { return builder; }, limit() { return builder; }, update() { return builder; },
      insert() { return builder; }, upsert() { return builder; }, delete() { return builder; },
      single() { state.one = true; return Promise.resolve({ data: resultFor(table, true), error: null }); },
      maybeSingle() { state.one = true; return Promise.resolve({ data: resultFor(table, true), error: null }); },
      then(resolve, reject) { return Promise.resolve({ data: resultFor(table, state.one), error: null, count: 0 }).then(resolve, reject); },
      catch(reject) { return Promise.resolve({ data: resultFor(table, state.one), error: null, count: 0 }).catch(reject); },
    };
    return builder;
  }

  const client = {
    auth: {
      async getSession() { return { data: { session: shouldBePublicAuth() ? null : session }, error: null }; },
      async refreshSession() { return { data: { session }, error: null }; },
      async getUser() { return { data: { user }, error: null }; },
      async signOut() { return { error: null }; },
      async signInWithPassword() { return { data: { session, user }, error: null }; },
      async resetPasswordForEmail() { return { data: {}, error: null }; },
      async updateUser() { return { data: { user }, error: null }; },
      onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; },
    },
    from: query,
    async rpc() { return { data: [profile], error: null }; },
    channel() { return { on() { return this; }, subscribe() { return this; }, unsubscribe() {} }; },
    removeChannel() {},
    storage: { from() { return { async upload() { return { data: {}, error: null }; }, getPublicUrl() { return { data: { publicUrl: '' } }; } }; } },
  };

  Object.defineProperty(window, '__AAE_MOCK_CLIENT__', { value: client, configurable: false });
  window.supabaseClient = client;
  try { localStorage.setItem('cookie-consent', 'declined'); } catch {}
}

async function configureContext(context) {
  await context.addInitScript(mockBootstrap, mockProfile);
  const resolvedDamageReviewBookingIds = new Set();
  const reconciledRefundBookingIds = new Set();

  // Serve repository files directly so the audit is deterministic even when a
  // lightweight development server is slow or does not support clean URLs.
  await context.route(`${baseUrl}/**`, async (route) => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.pathname.startsWith('/api/') || requestUrl.pathname === '/config.js') {
      await route.fallback();
      return;
    }

    let relativePath = decodeURIComponent(requestUrl.pathname).replace(/^\/+/, '');
    if (!relativePath || relativePath.endsWith('/')) relativePath += 'index.html';
    let filePath = path.resolve(repoRoot, relativePath);
    if (!path.extname(filePath) && fs.existsSync(filePath + '.html')) filePath += '.html';

    const withinRepo = filePath === repoRoot || filePath.startsWith(repoRoot + path.sep);
    if (!withinRepo || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      await route.continue();
      return;
    }

    const contentTypes = {
      '.css': 'text/css; charset=utf-8',
      '.html': 'text/html; charset=utf-8',
      '.ico': 'image/x-icon',
      '.jpeg': 'image/jpeg',
      '.jpg': 'image/jpeg',
      '.js': 'application/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.mjs': 'application/javascript; charset=utf-8',
      '.png': 'image/png',
      '.svg': 'image/svg+xml',
      '.webp': 'image/webp',
      '.xml': 'application/xml; charset=utf-8',
    };
    await route.fulfill({
      status: 200,
      contentType: contentTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      body: fs.readFileSync(filePath),
    });
  });

  await context.route(`${baseUrl}/config.js`, async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.supabaseClient = window.__AAE_MOCK_CLIENT__; window.supabase = window.supabase || { createClient: function(){ return window.__AAE_MOCK_CLIENT__; } };' });
  });

  // Python's basic static server does not emulate production clean URLs.
  await context.route(`${baseUrl}/assembler/apply`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: fs.readFileSync(path.join(repoRoot, 'assembler', 'apply.html')),
    });
  });

  await context.route('**/api/**', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    let payload = { ok: true };
    let explicitMock = true;

    if (pathname === '/api/booking/my-assignments') {
      payload = { bookings: mockBookings, meta: { warnings: [] } };
    } else if (pathname === '/api/booking/list') {
      payload = {
        bookings: mockOwnerBookings.map((booking) => {
          let current = booking;
          if (resolvedDamageReviewBookingIds.has(booking.id)) {
            current = {
              ...current,
              damage_review_status: 'resolved',
              damage_reviewed_at: iso(0),
              damage_reviewed_by: 'owner-visual-audit',
              damage_review_notes: 'Reviewed the saved damage evidence and documented the owner decision.',
            };
          }
          if (reconciledRefundBookingIds.has(booking.id)) {
            current = {
              ...current,
              payment_status: 'refunded',
              refund_amount: 21600,
              refunded_at: iso(0),
              financial_operation_key: null,
              financial_operation_type: null,
              financial_operation_started_at: null,
              financial_reconciliation_required_at: null,
              financial_reconciliation_reason: null,
              payout_review_status: 'review_required',
              financial_summary: {
                ...current.financial_summary,
                refundAmountCents: 21600,
                netChargedCents: 0,
                taxCollectedCents: 0,
                platformGrossCents: -13586,
              },
            };
          }
          return current;
        }),
        meta: { warnings: [] },
      };
    } else if (pathname === '/api/booking/assemblers') {
      payload = { assemblers: mockOwnerEasers.filter((easer) => easer.status === 'active') };
    } else if (pathname === '/api/booking/message') {
      payload = { messages: [
        { id: 'message-owner-1', sender: 'customer', recipient_type: 'owner', body: 'My card was declined. Can you send me a secure link so I can finish the booking?', created_at: iso(-45 * 60000) },
        { id: 'message-owner-2', sender: 'owner', recipient_type: 'customer', body: 'Yes. I will verify the booking and send the secure payment continuation link.', created_at: iso(-30 * 60000) },
      ] };
    } else if (pathname === '/api/booking/activity') {
      payload = { activity: [
        { event_type: 'booking_created', description: 'Booking request created; payment authorization not completed.', actor_name: 'Customer', actor_type: 'customer', created_at: iso(-3 * 3600000) },
        { event_type: 'notification_sent', description: 'Booking received email delivered.', actor_name: 'System', actor_type: 'system', created_at: iso(-3 * 3600000 + 30000), _source: 'notification', _status: 'sent' },
        { event_type: 'notification_sent', description: 'Payment continuation email delivery failed and needs owner follow-up.', actor_name: 'System', actor_type: 'system', created_at: iso(-90 * 60000), _source: 'notification', _status: 'failed' },
      ] };
    } else if (pathname === '/api/booking/notes') {
      payload = { notes: [{ id: 'note-owner-1', note: 'Customer asked for a secure payment continuation link. Verify the linked PaymentIntent before sending.', author: 'Owner', created_at: iso(-25 * 60000) }] };
    } else if (pathname === '/api/booking/evidence') {
      payload = { evidence: [], total: 0 };
    } else if (pathname === '/api/booking/dispatch-log') {
      payload = { offers: [] };
    } else if (pathname === '/api/booking/payout-review' && request.method() === 'POST') {
      const submitted = request.postDataJSON() || {};
      const damageBookingExists = mockOwnerBookings.some((booking) => booking.id === submitted.bookingId);
      if (submitted.decision === 'resolve_damage_review'
          && damageBookingExists
          && String(submitted.notes || '').trim().length >= 10) {
        resolvedDamageReviewBookingIds.add(submitted.bookingId);
        payload = {
          success: true,
          bookingId: submitted.bookingId,
          decision: submitted.decision,
          damageReviewStatus: 'resolved',
          paymentSent: false,
        };
      } else {
        payload = { error: 'Mock damage review request did not satisfy the required server contract' };
      }
    } else if (pathname === '/api/booking/refund' && request.method() === 'POST') {
      const submitted = request.postDataJSON() || {};
      const refundRecoveryBookingId = 'owner-completed-refund-recovery';
      const exactRecoveryRequest = submitted.bookingId === refundRecoveryBookingId
        && Object.keys(submitted).length === 1;
      if (exactRecoveryRequest) {
        reconciledRefundBookingIds.add(refundRecoveryBookingId);
        payload = {
          success: true,
          reconciled: true,
          cumulativeRefundAmount: 21600,
          paymentStatus: 'refunded',
          rewardsReconciliationRequired: false,
          clawbackReconciliationRequired: false,
          reconciliationRequired: false,
          financialReconciliationRequired: false,
        };
      } else {
        payload = { error: 'Mock refund recovery request must contain only the server-owned booking identifier' };
      }
    } else if (pathname === '/api/owner/session') {
      payload = { token: 'mock-owner-session-token', expiresIn: 3600 };
    } else if (pathname === '/api/owner/live-ops') {
      payload = mockOwnerLiveOps;
    } else if (pathname === '/api/owner/reviews') {
      payload = mockOwnerReviews;
    } else if (pathname === '/api/owner/promo') {
      payload = mockOwnerPromo;
    } else if (pathname === '/api/owner/social-automation') {
      payload = mockOwnerSocialAutomation;
    } else if (pathname === '/api/owner/financial-dashboard') {
      payload = mockOwnerFinancialDashboard;
    } else if (pathname === '/api/owner/tax-report') {
      payload = mockOwnerTaxReport;
    } else if (pathname === '/api/owner/payouts') {
      payload = mockOwnerPayouts;
    } else if (pathname === '/api/owner/site-chat') {
      payload = mockOwnerSiteChat;
    } else if (pathname === '/api/assembler/membership') {
      payload = { active: false, status: 'inactive' };
    } else if (pathname === '/api/assembler/readiness') {
      payload = { readiness: mockManualPayoutReadiness };
    } else if (pathname === '/api/assembler/payout-preference') {
      if (request.method() === 'POST') {
        const submitted = request.postDataJSON()?.preference || 'ach';
        payload = { ok: true, preference: submitted };
      } else {
        payload = { preference: 'ach', allowed: ['ach', 'zelle', 'paypal', 'check'] };
      }
    } else if (pathname === '/api/assembler/list') {
      const stats = { total: 3, pending: 1, active: 2, suspended: 0, rejected: 0, starter: 1, professional: 1, elite: 0, connectRequired: false };
      payload = { assemblers: mockOwnerEasers, stats, summary: { total: 3, dispatchEligible: 1 } };
    } else if (pathname === '/api/owner/waitlist') {
      payload = mockOwnerWaitlist;
    } else if (pathname === '/api/owner/market-demand') {
      payload = mockOwnerMarketDemand;
    } else if (pathname === '/api/assembler/reviews') {
      payload = { reviews: [
        { rating: 5, comment: 'Clear communication and careful work.', customerWouldRehire: true, createdAt: iso(-20 * 86400000), customerFirstName: 'Taylor' },
        { rating: 5, comment: 'Arrived prepared and completed everything neatly.', customerWouldRehire: true, createdAt: iso(-45 * 86400000), customerFirstName: 'Casey' },
      ] };
    } else if (pathname === '/api/config/public-key') {
      payload = { publishableKey: 'pk_test_mock_mobile_audit' };
    } else if (pathname === '/api/market-demand') {
      payload = { requests: [], counts: {}, total: 0 };
    } else if (/promo|offer/.test(pathname)) {
      payload = { active: false, offer: null };
    } else {
      explicitMock = false;
    }

    const ownerSensitiveFallback = !explicitMock && (
      pathname.startsWith('/api/owner/')
      || pathname.startsWith('/api/booking/')
      || pathname === '/api/booking'
    );
    const status = ownerSensitiveFallback ? 501 : 200;
    if (ownerSensitiveFallback) payload = { error: `Unmocked owner-audit API: ${request.method()} ${pathname}` };
    await route.fulfill({
      status,
      headers: { 'x-aae-audit-mock': explicitMock ? 'explicit' : 'fallback' },
      contentType: 'application/json',
      body: JSON.stringify(payload),
    });
  });

  await context.route('https://js.stripe.com/**', (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.Stripe=function(){return {elements:function(){return {create:function(){return {mount:function(){},on:function(){}}}}}}};' }));
  await context.route('https://js-na2.hs-scripts.com/**', (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));
  await context.route('https://www.googletagmanager.com/**', (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));
  await context.route('https://fonts.googleapis.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await context.route('https://fonts.gstatic.com/**', (route) => route.abort('blockedbyclient'));
}

function dedupe(items, keyFn) {
  const seen = new Set();
  return items.filter((item) => {
    const key = keyFn(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function collectLayout(page, width) {
  return page.evaluate((viewportWidth) => {
    const visible = (el) => {
      let node = el;
      while (node && node.nodeType === Node.ELEMENT_NODE) {
        const ancestorStyle = getComputedStyle(node);
        if (ancestorStyle.display === 'none' || ancestorStyle.visibility === 'hidden' || Number(ancestorStyle.opacity) === 0) return false;
        node = node.parentElement;
      }
      const cs = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) !== 0 && rect.width > 0 && rect.height > 0;
    };
    const selector = (el) => {
      if (el.id) return '#' + CSS.escape(el.id);
      let value = el.tagName.toLowerCase();
      if (el.classList.length) value += '.' + [...el.classList].slice(0, 3).map((name) => CSS.escape(name)).join('.');
      return value;
    };
    const rectData = (el) => {
      const r = el.getBoundingClientRect();
      return { selector: selector(el), left: Math.round(r.left * 10) / 10, right: Math.round(r.right * 10) / 10, top: Math.round(r.top * 10) / 10, bottom: Math.round(r.bottom * 10) / 10, width: Math.round(r.width * 10) / 10, height: Math.round(r.height * 10) / 10 };
    };
    const hasHorizontalScroller = (el) => {
      let node = el.parentElement;
      while (node && node !== document.body) {
        const cs = getComputedStyle(node);
        if (/(auto|scroll)/.test(cs.overflowX) && node.scrollWidth > node.clientWidth + 1) return true;
        node = node.parentElement;
      }
      return false;
    };
    const isInactiveOffCanvasControl = (el) => {
      const ownerSidebar = el.closest('#sidebar');
      return !!(ownerSidebar && !ownerSidebar.classList.contains('open') && innerWidth <= 900);
    };

    const html = document.documentElement;
    const body = document.body;
    const all = [...body.querySelectorAll('*')].filter(visible);
    const documentOverflow = Math.max(html.scrollWidth, body.scrollWidth) - html.clientWidth;

    const clippedContent = all.filter((el) => {
      if (/^(SCRIPT|STYLE|LINK|META|SOURCE|PATH|DEFS)$/.test(el.tagName)) return false;
      if (el.closest('#rv-track')) return false;
      if (isInactiveOffCanvasControl(el)) return false;
      const r = el.getBoundingClientRect();
      if (r.left >= -1 && r.right <= viewportWidth + 1) return false;
      if (hasHorizontalScroller(el)) return false;
      const directText = [...el.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
      const interactive = el.matches('a[href],button,input,select,textarea,[role="button"]');
      const replaced = /^(IMG|VIDEO|IFRAME|CANVAS)$/.test(el.tagName);
      return directText || interactive || replaced;
    }).slice(0, 20).map(rectData);

    const fixedClipping = all.filter((el) => {
      if (isInactiveOffCanvasControl(el)) return false;
      const cs = getComputedStyle(el);
      if (!['fixed', 'sticky'].includes(cs.position)) return false;
      const r = el.getBoundingClientRect();
      return r.left < -1 || r.right > viewportWidth + 1 || (cs.position === 'fixed' && (r.top < -1 || r.bottom > innerHeight + 1));
    }).slice(0, 20).map(rectData);

    const actionSelector = [
      'button', 'input[type="button"]', 'input[type="submit"]', 'input[type="reset"]', 'select', 'textarea',
      '[role="button"]', 'a.btn', 'a.e-btn', 'a.nav-book-pill', '.nav-mobile a',
      'a.easer-nav-item', 'a[class*="cta"]', 'a[class*="action"]', 'a[class*="pill"]'
    ].join(',');
    const smallTargets = viewportWidth <= 899 ? [...body.querySelectorAll(actionSelector)]
      .filter(visible)
      .filter((el) => {
        if (el.matches('input[type="hidden"]')) return false;
        const r = el.getBoundingClientRect();
        return r.width < 43.5 || r.height < 43.5;
      })
      .slice(0, 30)
      .map(rectData) : [];

    const smallInputFonts = viewportWidth <= 430 ? [...body.querySelectorAll('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]),select,textarea')]
      .filter(visible)
      .map((el) => ({ selector: selector(el), fontSize: parseFloat(getComputedStyle(el).fontSize) }))
      .filter((item) => item.fontSize < 15.9) : [];

    const oddPatterns = [
      { name: 'not-a-number', regex: /(?:\$\s*)?NaN\b/i },
      { name: 'undefined', regex: /\bundefined\b/i },
      { name: 'invalid-date', regex: /Invalid Date/i },
      { name: 'infinity', regex: /\bInfinity\b/i },
      { name: 'object-string', regex: /\[object Object\]/i },
      { name: 'raw-iso-date', regex: /\b20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}/ },
      { name: 'currency-overprecision', regex: /\$\s*-?\d[\d,]*\.\d{3,}\b/ },
      { name: 'double-currency-symbol', regex: /\$\s*\$/ },
      { name: 'negative-zero-currency', regex: /(?:-\$|\$-)0\.00\b/ },
      { name: 'raw-us-phone', regex: /\b1?[2-9]\d{2}[2-9]\d{6}\b/ },
      { name: 'mojibake', regex: /(?:Ã.|Â[^\s]|â(?:€|€™|€œ|€¢|€¦|—|–)|ï¿½|ðŸ)/ },
    ];
    const visibleText = (body.innerText || '').replace(/\s+/g, ' ').trim();
    const oddText = oddPatterns.filter((entry) => entry.regex.test(visibleText)).map((entry) => entry.name);

    const navAlignment = [];
    for (const nav of body.querySelectorAll('.nav-inner,.easer-header,.easer-nav')) {
      if (!visible(nav)) continue;
      const navRect = nav.getBoundingClientRect();
      const center = navRect.top + navRect.height / 2;
      for (const child of [...nav.children].filter(visible)) {
        const r = child.getBoundingClientRect();
        const delta = Math.abs((r.top + r.height / 2) - center);
        if (delta > 5 && getComputedStyle(nav).alignItems === 'center') {
          navAlignment.push({ selector: selector(child), delta: Math.round(delta * 10) / 10 });
        }
      }
    }

    return {
      documentWidth: { client: html.clientWidth, scroll: Math.max(html.scrollWidth, body.scrollWidth), overflow: documentOverflow },
      clippedContent,
      fixedClipping,
      smallTargets,
      smallInputFonts,
      oddText,
      navAlignment: navAlignment.slice(0, 20),
      title: document.title,
      finalPath: location.pathname + location.search + location.hash,
    };
  }, width);
}

async function collectExperienceChecks(page, spec, width, observedApis) {
  const apiObserved = (method, endpoint) => observedApis.some((item) => item.method === method && item.path === endpoint && item.status === 200);
  const checks = {};

  if (spec.id === 'home' && width <= 430) {
    checks.homeChatLauncher = await page.evaluate(() => {
      window.scrollTo(0, 0);
      const el = document.getElementById('aae-chat-btn');
      if (!el) return { required: true, pass: false, reason: 'Launcher is missing', scrollY: window.scrollY };
      const style = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const visible = style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number(style.opacity) !== 0
        && r.width > 0
        && r.height > 0;
      const inViewport = r.left >= -1 && r.right <= innerWidth + 1 && r.top >= -1 && r.bottom <= innerHeight + 1;
      const fixed = style.position === 'fixed';
      const scrollY = Math.round(window.scrollY);
      return {
        required: true,
        pass: visible && inViewport && fixed && scrollY === 0,
        visible,
        inViewport,
        fixed,
        scrollY,
        ariaLabel: el.getAttribute('aria-label') || '',
        bounds: { left: r.left, right: r.right, top: r.top, bottom: r.bottom },
      };
    });
  }

  if (spec.id === 'easer-home') {
    const state = await page.evaluate(() => {
      const label = document.getElementById('avail-label');
      const checklist = document.getElementById('onboarding-checklist');
      const alert = document.getElementById('page-alert');
      return {
        availabilityLabel: label?.textContent?.trim() || '',
        checklistCompleted: checklist?.dataset?.completed || '',
        checklistVisible: !!checklist && getComputedStyle(checklist).display !== 'none',
        alertText: alert && getComputedStyle(alert).display !== 'none' ? alert.textContent.trim() : '',
      };
    });
    const requestObserved = apiObserved('GET', '/api/assembler/readiness');
    checks.manualPayoutReadiness = {
      required: true,
      pass: requestObserved
        && state.availabilityLabel === 'Online'
        && state.checklistCompleted === 'true'
        && !state.checklistVisible
        && !state.alertText,
      requestObserved,
      mockMode: 'manual_payout',
      connectRequired: false,
      expectedFinalStatus: 'READY FOR JOBS',
      ...state,
    };
  }

  if (spec.id === 'easer-payouts') {
    const state = await page.evaluate(() => {
      const select = document.getElementById('payout-preference');
      const help = document.querySelector('.payout-preference-help');
      return {
        selectedPreference: select?.value || '',
        availablePreferences: select ? [...select.options].map((option) => option.value).filter(Boolean) : [],
        manualPayoutExplained: /preferred method|confirm the details/i.test(help?.textContent || ''),
      };
    });
    const requestObserved = apiObserved('GET', '/api/assembler/payout-preference');
    checks.payoutPreference = {
      required: true,
      pass: requestObserved
        && state.selectedPreference === 'ach'
        && ['ach', 'zelle', 'paypal', 'check'].every((value) => state.availablePreferences.includes(value))
        && state.manualPayoutExplained,
      requestObserved,
      ...state,
    };
  }

  if (spec.group === 'owner-auth') {
    if (spec.ownerDamageReviewBooking) {
      try {
        const paymentRecoveryBaseline = await page.evaluate(() => {
          const pageText = (document.body.innerText || '').replace(/\s+/g, ' ').trim();
          const detail = document.getElementById('detail-panel');
          return {
            detailOpen: !!detail && detail.classList.contains('open'),
            formattedPhoneVisible: /\b512-555-0108\b/.test(pageText),
            paymentRecoveryMessageVisible: /My card was declined\. Can you send me a secure link/i.test(pageText),
            unreadEaserMessageVisible: /Easer message/i.test(document.getElementById('bookings-list')?.innerText || ''),
          };
        });
        const damageBookingId = spec.ownerDamageReviewBooking;
        const damageDetailResponses = (ownerViewEndpoints.bookings || []).map((endpoint) => page.waitForResponse((candidate) => {
          const url = new URL(candidate.url());
          return candidate.request().method() === 'GET' && url.pathname === endpoint;
        }, { timeout: 5000 }).catch(() => null));
        const damageCard = page.locator(`.booking-card[data-id="${damageBookingId}"]`);
        await damageCard.waitFor({ state: 'visible', timeout: 5000 });
        await damageCard.click();
        await Promise.all(damageDetailResponses);
        await page.locator(`#detail-actions [data-action="damage-review"][data-id="${damageBookingId}"]`).waitFor({ state: 'visible', timeout: 5000 });
        const initialState = await page.evaluate((bookingId) => {
          const visible = (element) => {
            if (!element) return false;
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return style.display !== 'none'
              && style.visibility !== 'hidden'
              && Number(style.opacity) !== 0
              && rect.width > 0
              && rect.height > 0;
          };
          const actions = document.getElementById('detail-actions');
          const resolveButton = actions?.querySelector(`[data-action="damage-review"][data-id="${CSS.escape(bookingId)}"]`);
          const payoutButton = actions?.querySelector('[data-action="payout"]');
          return {
            detailText: (actions?.innerText || '').replace(/\s+/g, ' ').trim(),
            damageHoldVisible: /Damage payout hold:/i.test(actions?.innerText || ''),
            resolveActionVisible: visible(resolveButton),
            payoutActionVisible: visible(payoutButton),
          };
        }, damageBookingId);

        const resolveButton = page.locator(`#detail-actions [data-action="damage-review"][data-id="${damageBookingId}"]`);
        await resolveButton.waitFor({ state: 'visible', timeout: 5000 });
        await resolveButton.click();
        await page.locator('#reason-modal.open').waitFor({ state: 'visible', timeout: 5000 });

        const modalState = await page.evaluate(() => {
          const overlay = document.getElementById('reason-modal');
          const modal = overlay?.querySelector('.modal');
          const title = document.getElementById('reason-modal-title')?.textContent?.trim() || '';
          const description = document.getElementById('reason-modal-desc')?.textContent?.replace(/\s+/g, ' ').trim() || '';
          const textarea = document.getElementById('reason-text');
          const confirm = document.getElementById('reason-confirm');
          const cancel = document.getElementById('reason-cancel');
          const rect = modal?.getBoundingClientRect();
          const controlBounds = [textarea, confirm, cancel].filter(Boolean).map((element) => {
            const bounds = element.getBoundingClientRect();
            return {
              id: element.id,
              width: Math.round(bounds.width * 10) / 10,
              height: Math.round(bounds.height * 10) / 10,
              left: Math.round(bounds.left * 10) / 10,
              right: Math.round(bounds.right * 10) / 10,
              top: Math.round(bounds.top * 10) / 10,
              bottom: Math.round(bounds.bottom * 10) / 10,
              fontSize: Math.round(parseFloat(getComputedStyle(element).fontSize) * 10) / 10,
            };
          });
          return {
            open: !!overlay && overlay.classList.contains('open'),
            title,
            description,
            placeholder: textarea?.getAttribute('placeholder') || '',
            confirmText: confirm?.textContent?.trim() || '',
            requiredNoteWording: /required review note/i.test(textarea?.getAttribute('placeholder') || ''),
            noPaymentWording: /does not send an Easer payout/i.test(description)
              && /refund the customer/i.test(description)
              && /change the server-calculated earnings/i.test(description),
            modalInViewport: !!rect
              && rect.left >= -1
              && rect.right <= innerWidth + 1
              && rect.top >= -1
              && rect.bottom <= innerHeight + 1,
            modalBounds: rect ? {
              left: Math.round(rect.left * 10) / 10,
              right: Math.round(rect.right * 10) / 10,
              top: Math.round(rect.top * 10) / 10,
              bottom: Math.round(rect.bottom * 10) / 10,
              width: Math.round(rect.width * 10) / 10,
              height: Math.round(rect.height * 10) / 10,
            } : null,
            controlBounds,
            controlsInViewport: controlBounds.every((bounds) => bounds.left >= -1
              && bounds.right <= innerWidth + 1
              && bounds.top >= -1
              && bounds.bottom <= innerHeight + 1),
            mobileInputFontSafe: innerWidth > 430
              || controlBounds.filter((bounds) => bounds.id === 'reason-text').every((bounds) => bounds.fontSize >= 15.9),
            mobileButtonTargetsSafe: innerWidth > 899
              || controlBounds.filter((bounds) => bounds.id !== 'reason-text').every((bounds) => bounds.width >= 43.5 && bounds.height >= 43.5),
          };
        });

        const reviewNote = 'Reviewed the saved damage evidence and documented the owner decision.';
        await page.locator('#reason-text').fill(reviewNote);
        const resolveResponsePromise = page.waitForResponse((candidate) => {
          const url = new URL(candidate.url());
          return candidate.request().method() === 'POST' && url.pathname === '/api/booking/payout-review';
        }, { timeout: 5000 });
        const reloadResponsePromise = page.waitForResponse((candidate) => {
          const url = new URL(candidate.url());
          return candidate.request().method() === 'GET' && url.pathname === '/api/booking/list';
        }, { timeout: 5000 });
        await page.locator('#reason-confirm').click();
        const [resolveResponse, reloadResponse] = await Promise.all([resolveResponsePromise, reloadResponsePromise]);
        await page.locator('#reason-modal').waitFor({ state: 'hidden', timeout: 5000 });
        await page.waitForFunction((bookingId) => {
          const detail = document.getElementById('detail-panel');
          const actions = document.getElementById('detail-actions');
          return !!detail
            && detail.classList.contains('open')
            && !!actions?.querySelector(`[data-action="payout"][data-id="${CSS.escape(bookingId)}"]`);
        }, damageBookingId, { timeout: 5000 });
        await page.waitForTimeout(250);

        let submittedBody = null;
        try { submittedBody = resolveResponse.request().postDataJSON(); } catch {}
        const finalState = await page.evaluate((bookingId) => {
          const detail = document.getElementById('detail-panel');
          const actions = document.getElementById('detail-actions');
          const toast = document.getElementById('toast');
          return {
            modalClosed: !document.getElementById('reason-modal')?.classList.contains('open'),
            detailOpen: !!detail && detail.classList.contains('open'),
            damageHoldVisible: /Damage payout hold:/i.test(actions?.innerText || ''),
            resolveActionVisible: !!actions?.querySelector(`[data-action="damage-review"][data-id="${CSS.escape(bookingId)}"]`),
            payoutActionVisible: !!actions?.querySelector(`[data-action="payout"][data-id="${CSS.escape(bookingId)}"]`),
            successToastVisible: !!toast
              && toast.classList.contains('show')
              && toast.classList.contains('success')
              && /Damage review resolved; no payment was sent/i.test(toast.textContent || ''),
          };
        }, damageBookingId);

        const requestContractValid = submittedBody?.bookingId === damageBookingId
          && submittedBody?.decision === 'resolve_damage_review'
          && submittedBody?.notes === reviewNote;
        const resolveRequestSucceeded = resolveResponse.status() === 200
          && resolveResponse.headers()['x-aae-audit-mock'] === 'explicit';
        const bookingsReloaded = reloadResponse.status() === 200
          && reloadResponse.headers()['x-aae-audit-mock'] === 'explicit';
        checks.damageReviewWorkflow = {
          required: true,
          pass: initialState.damageHoldVisible
            && paymentRecoveryBaseline.detailOpen
            && paymentRecoveryBaseline.formattedPhoneVisible
            && paymentRecoveryBaseline.paymentRecoveryMessageVisible
            && paymentRecoveryBaseline.unreadEaserMessageVisible
            && initialState.resolveActionVisible
            && !initialState.payoutActionVisible
            && modalState.open
            && modalState.title === 'Resolve Damage Payout Hold'
            && modalState.confirmText === 'Resolve Damage Review'
            && modalState.requiredNoteWording
            && modalState.noPaymentWording
            && modalState.modalInViewport
            && modalState.controlsInViewport
            && modalState.mobileInputFontSafe
            && modalState.mobileButtonTargetsSafe
            && requestContractValid
            && resolveRequestSucceeded
            && bookingsReloaded
            && finalState.modalClosed
            && finalState.detailOpen
            && !finalState.damageHoldVisible
            && !finalState.resolveActionVisible
            && finalState.payoutActionVisible
            && finalState.successToastVisible,
          damageBookingId,
          paymentRecoveryBaseline,
          initialState,
          modalState,
          submittedBody,
          requestContractValid,
          resolveRequestSucceeded,
          resolveResponseStatus: resolveResponse.status(),
          bookingsReloaded,
          reloadResponseStatus: reloadResponse.status(),
          finalState,
        };
      } catch (error) {
        checks.damageReviewWorkflow = {
          required: true,
          pass: false,
          error: error.message,
        };
      }
    }

    if (spec.ownerRefundRecoveryBooking) {
      try {
        const refundBookingId = spec.ownerRefundRecoveryBooking;
        const refundDetailResponses = (ownerViewEndpoints.bookings || []).map((endpoint) => page.waitForResponse((candidate) => {
          const url = new URL(candidate.url());
          return candidate.request().method() === 'GET' && url.pathname === endpoint;
        }, { timeout: 5000 }).catch(() => null));
        const refundCard = page.locator(`.booking-card[data-id="${refundBookingId}"]`);
        await refundCard.waitFor({ state: 'visible', timeout: 5000 });
        await refundCard.click();
        await Promise.all(refundDetailResponses);
        await page.locator(`#detail-actions [data-action="refund-recovery"][data-id="${refundBookingId}"]`).waitFor({ state: 'visible', timeout: 5000 });

        const initialState = await page.evaluate((bookingId) => {
          const visible = (element) => {
            if (!element) return false;
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return style.display !== 'none'
              && style.visibility !== 'hidden'
              && Number(style.opacity) !== 0
              && rect.width > 0
              && rect.height > 0;
          };
          const actions = document.getElementById('detail-actions');
          const actionsText = (actions?.innerText || '').replace(/\s+/g, ' ').trim();
          const recoveryButton = actions?.querySelector(`[data-action="refund-recovery"][data-id="${CSS.escape(bookingId)}"]`);
          const visibleButtons = [...(actions?.querySelectorAll('button') || [])].filter(visible);
          return {
            actionsText,
            financialHoldVisible: /Financial hold:/i.test(actionsText),
            stripeTruthNoticeVisible: /server rechecks aggregate Stripe truth first/i.test(actionsText)
              && /remaining portion of the already-requested full refund/i.test(actionsText),
            visibleActionCount: visibleButtons.length,
            visibleActionLabels: visibleButtons.map((button) => button.textContent?.replace(/\s+/g, ' ').trim() || ''),
            recoveryActionVisible: visible(recoveryButton),
            recoveryActionLabel: recoveryButton?.textContent?.replace(/\s+/g, ' ').trim() || '',
            ordinaryRefundActionVisible: visible(actions?.querySelector('[data-action="refund"]')),
            payoutActionVisible: visible(actions?.querySelector('[data-action="payout"]')),
            payoutReviewActionVisible: visible(actions?.querySelector('[data-action="payout-review"]')),
            passwordResetActionVisible: visible(actions?.querySelector('button[onclick*="sendResetPassword"]')),
          };
        }, refundBookingId);

        const recoveryButton = page.locator(`#detail-actions [data-action="refund-recovery"][data-id="${refundBookingId}"]`);
        await recoveryButton.click();
        await page.locator('#reason-modal.open').waitFor({ state: 'visible', timeout: 5000 });

        const modalState = await page.evaluate(() => {
          const visible = (element) => {
            if (!element) return false;
            const style = getComputedStyle(element);
            const bounds = element.getBoundingClientRect();
            return style.display !== 'none'
              && style.visibility !== 'hidden'
              && Number(style.opacity) !== 0
              && bounds.width > 0
              && bounds.height > 0;
          };
          const overlay = document.getElementById('reason-modal');
          const modal = overlay?.querySelector('.modal');
          const title = document.getElementById('reason-modal-title')?.textContent?.trim() || '';
          const description = document.getElementById('reason-modal-desc')?.textContent?.replace(/\s+/g, ' ').trim() || '';
          const textarea = document.getElementById('reason-text');
          const confirm = document.getElementById('reason-confirm');
          const cancel = document.getElementById('reason-cancel');
          const rect = modal?.getBoundingClientRect();
          const controls = [textarea, confirm, cancel].filter(Boolean);
          const controlBounds = controls.map((element) => {
            const bounds = element.getBoundingClientRect();
            return {
              id: element.id,
              width: Math.round(bounds.width * 10) / 10,
              height: Math.round(bounds.height * 10) / 10,
              left: Math.round(bounds.left * 10) / 10,
              right: Math.round(bounds.right * 10) / 10,
              top: Math.round(bounds.top * 10) / 10,
              bottom: Math.round(bounds.bottom * 10) / 10,
              fontSize: Math.round(parseFloat(getComputedStyle(element).fontSize) * 10) / 10,
            };
          });
          const expectedDescription = 'The server will recheck Stripe before doing anything. If the earlier full-refund request did not finish, this may issue only its remaining amount. It cannot create a payout.';
          const amountInputs = [...(overlay?.querySelectorAll('input') || [])]
            .filter((element) => visible(element) && /amount|refund/i.test(`${element.id} ${element.name} ${element.placeholder}`));
          return {
            open: !!overlay && overlay.classList.contains('open'),
            title,
            description,
            descriptionExact: description === expectedDescription,
            stripeTruthFirstWording: /server will recheck Stripe before doing anything/i.test(description)
              && /earlier full-refund request did not finish/i.test(description)
              && /only its remaining amount/i.test(description),
            noPayoutWording: /cannot create a payout/i.test(description),
            placeholder: textarea?.getAttribute('placeholder') || '',
            reasonInitiallyBlank: (textarea?.value || '') === '',
            confirmText: confirm?.textContent?.trim() || '',
            visibleAmountInputCount: amountInputs.length,
            modalInViewport: !!rect
              && rect.left >= -1
              && rect.right <= innerWidth + 1
              && rect.top >= -1
              && rect.bottom <= innerHeight + 1,
            modalBounds: rect ? {
              left: Math.round(rect.left * 10) / 10,
              right: Math.round(rect.right * 10) / 10,
              top: Math.round(rect.top * 10) / 10,
              bottom: Math.round(rect.bottom * 10) / 10,
              width: Math.round(rect.width * 10) / 10,
              height: Math.round(rect.height * 10) / 10,
            } : null,
            controlBounds,
            controlsInViewport: controlBounds.every((bounds) => bounds.left >= -1
              && bounds.right <= innerWidth + 1
              && bounds.top >= -1
              && bounds.bottom <= innerHeight + 1),
            mobileInputFontSafe: innerWidth > 430
              || controlBounds.filter((bounds) => bounds.id === 'reason-text').every((bounds) => bounds.fontSize >= 15.9),
            mobileButtonTargetsSafe: innerWidth > 899
              || controlBounds.filter((bounds) => bounds.id !== 'reason-text').every((bounds) => bounds.width >= 43.5 && bounds.height >= 43.5),
          };
        });

        const refundResponsePromise = page.waitForResponse((candidate) => {
          const url = new URL(candidate.url());
          return candidate.request().method() === 'POST' && url.pathname === '/api/booking/refund';
        }, { timeout: 5000 });
        const reloadResponsePromise = page.waitForResponse((candidate) => {
          const url = new URL(candidate.url());
          return candidate.request().method() === 'GET' && url.pathname === '/api/booking/list';
        }, { timeout: 5000 });
        await page.locator('#reason-confirm').click();
        const [refundResponse, reloadResponse] = await Promise.all([refundResponsePromise, reloadResponsePromise]);
        await page.locator('#reason-modal').waitFor({ state: 'hidden', timeout: 5000 });
        await page.waitForFunction((bookingId) => {
          const detail = document.getElementById('detail-panel');
          const actions = document.getElementById('detail-actions');
          return !!detail
            && detail.classList.contains('open')
            && !!actions?.querySelector(`[data-action="payout-review"][data-id="${CSS.escape(bookingId)}"]`);
        }, refundBookingId, { timeout: 5000 });
        await page.waitForTimeout(250);

        let submittedBody = null;
        let responsePayload = null;
        try { submittedBody = refundResponse.request().postDataJSON(); } catch {}
        try { responsePayload = await refundResponse.json(); } catch {}
        const finalState = await page.evaluate((bookingId) => {
          const visible = (element) => {
            if (!element) return false;
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return style.display !== 'none'
              && style.visibility !== 'hidden'
              && Number(style.opacity) !== 0
              && rect.width > 0
              && rect.height > 0;
          };
          const detail = document.getElementById('detail-panel');
          const actions = document.getElementById('detail-actions');
          const actionsText = (actions?.innerText || '').replace(/\s+/g, ' ').trim();
          const toast = document.getElementById('toast');
          const visibleButtons = [...(actions?.querySelectorAll('button') || [])].filter(visible);
          return {
            modalClosed: !document.getElementById('reason-modal')?.classList.contains('open'),
            detailOpen: !!detail && detail.classList.contains('open'),
            financialHoldVisible: /Financial hold:/i.test(actionsText),
            recoveryActionVisible: visible(actions?.querySelector(`[data-action="refund-recovery"][data-id="${CSS.escape(bookingId)}"]`)),
            ordinaryRefundActionVisible: visible(actions?.querySelector('[data-action="refund"]')),
            payoutActionVisible: visible(actions?.querySelector('[data-action="payout"]')),
            payoutReviewActionVisible: visible(actions?.querySelector(`[data-action="payout-review"][data-id="${CSS.escape(bookingId)}"]`)),
            visibleActionLabels: visibleButtons.map((button) => button.textContent?.replace(/\s+/g, ' ').trim() || ''),
            successToastVisible: !!toast
              && toast.classList.contains('show')
              && toast.classList.contains('success')
              && /Refund workflow reconciled/i.test(toast.textContent || ''),
          };
        }, refundBookingId);

        const requestKeys = submittedBody && typeof submittedBody === 'object' ? Object.keys(submittedBody) : [];
        const requestContractValid = submittedBody?.bookingId === refundBookingId
          && requestKeys.length === 1
          && !requestKeys.some((key) => /amount|refund|payout/i.test(key));
        const responseContractSafe = responsePayload?.success === true
          && responsePayload?.reconciled === true
          && responsePayload?.cumulativeRefundAmount === 21600
          && responsePayload?.paymentStatus === 'refunded'
          && responsePayload?.rewardsReconciliationRequired === false
          && responsePayload?.clawbackReconciliationRequired === false
          && responsePayload?.reconciliationRequired === false
          && responsePayload?.financialReconciliationRequired === false;
        const refundRequestSucceeded = refundResponse.status() === 200
          && refundResponse.headers()['x-aae-audit-mock'] === 'explicit';
        const bookingsReloaded = reloadResponse.status() === 200
          && reloadResponse.headers()['x-aae-audit-mock'] === 'explicit';
        checks.refundReconciliationWorkflow = {
          required: true,
          pass: initialState.financialHoldVisible
            && initialState.stripeTruthNoticeVisible
            && initialState.visibleActionCount === 1
            && initialState.recoveryActionVisible
            && initialState.recoveryActionLabel === 'Resume / Reconcile Refund'
            && !initialState.ordinaryRefundActionVisible
            && !initialState.payoutActionVisible
            && !initialState.payoutReviewActionVisible
            && !initialState.passwordResetActionVisible
            && modalState.open
            && modalState.title === 'Resume / Reconcile Refund'
            && modalState.descriptionExact
            && modalState.stripeTruthFirstWording
            && modalState.noPayoutWording
            && modalState.placeholder === 'Reason (optional)'
            && modalState.reasonInitiallyBlank
            && modalState.confirmText === 'Recheck and Resume'
            && modalState.visibleAmountInputCount === 0
            && modalState.modalInViewport
            && modalState.controlsInViewport
            && modalState.mobileInputFontSafe
            && modalState.mobileButtonTargetsSafe
            && requestContractValid
            && responseContractSafe
            && refundRequestSucceeded
            && bookingsReloaded
            && finalState.modalClosed
            && finalState.detailOpen
            && !finalState.financialHoldVisible
            && !finalState.recoveryActionVisible
            && !finalState.ordinaryRefundActionVisible
            && !finalState.payoutActionVisible
            && finalState.payoutReviewActionVisible
            && finalState.successToastVisible,
          refundBookingId,
          initialState,
          modalState,
          submittedBody,
          requestContractValid,
          responsePayload,
          responseContractSafe,
          refundRequestSucceeded,
          refundResponseStatus: refundResponse.status(),
          bookingsReloaded,
          reloadResponseStatus: reloadResponse.status(),
          finalState,
        };
      } catch (error) {
        checks.refundReconciliationWorkflow = {
          required: true,
          pass: false,
          error: error.message,
        };
      }
    }

    const state = await page.evaluate((ownerView) => {
      const visible = (element) => {
        if (!element) return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
      };
      const gate = document.getElementById('login-gate');
      const layout = document.getElementById('layout');
      const list = document.getElementById('bookings-list');
      const activeView = document.getElementById(ownerView + '-view');
      const activeText = (activeView?.innerText || '').replace(/\s+/g, ' ').trim();
      const markerSelectors = {
        liveops: '#ops-alerts-bar .alert-row, #ops-today > *',
        today: '#today-list > *',
        bookings: '#bookings-list .booking-card',
        customers: '#cust-tbody tr',
        'market-demand': '#md-top-markets > *, #md-requests-tbody tr',
        reviews: '#reviews-list > *',
        marketing: '#mk-recent-body tr, #mk-social-body tr',
        analytics: '#an-ledger-body tr, #an-payout-body tr, #tax-body tr',
        intelligence: '#site-chat-list .site-chat-row',
        assemblers: '#asm-tbody tr',
        waitlist: '#wl-tbody tr',
      };
      const markerSelector = markerSelectors[ownerView] || '';
      const detail = document.getElementById('detail-panel');
      const pageText = (document.body.innerText || '').replace(/\s+/g, ' ').trim();
      return {
        loginGateVisible: !!gate && getComputedStyle(gate).display !== 'none',
        dashboardVisible: !!layout && getComputedStyle(layout).display !== 'none',
        bookingListSettled: !!list && !/loading bookings/i.test(list.textContent || ''),
        activeViewVisible: visible(activeView),
        activeViewTextLength: activeText.length,
        activeViewLoading: /\bLoading(?:\.\.\.|…|\s+(?:bookings|reviews|financial|demand|market|waitlist|Easers|website|social|conversation|promo))/i.test(activeText),
        activeViewFailure: /Failed to load|could not be loaded|could not verify|Unmocked owner-audit API/i.test(activeText),
        dataMarkerCount: markerSelector ? activeView?.querySelectorAll(markerSelector).length || 0 : 0,
        topbarTitle: document.querySelector('.topbar-title')?.textContent?.trim() || '',
        detailOpen: !!detail && detail.classList.contains('open') && visible(detail),
        bookingCardHasExactCents: [...document.querySelectorAll('#bookings-list .booking-card')].some((card) => /\$189\.50\b/.test(card.innerText || '')),
        customerSpendHasExactCents: /\$409\.50\b/.test(document.getElementById('customers-view')?.innerText || ''),
        customerAverageHasExactCents: /\$249\.09\b/.test(document.getElementById('customers-view')?.innerText || ''),
        financialGrossRendered: /\$4,267\.50\b/.test(document.getElementById('analytics-view')?.innerText || ''),
        formattedPhoneVisible: /\b512-555-0108\b/.test(pageText),
        paymentRecoveryMessageVisible: /My card was declined\. Can you send me a secure link/i.test(pageText),
        unreadEaserMessageVisible: /Easer message/i.test(document.getElementById('bookings-list')?.innerText || ''),
      };
    }, spec.ownerView || 'bookings');
    const sessionObserved = apiObserved('POST', '/api/owner/session');
    const bookingsObserved = apiObserved('GET', '/api/booking/list');
    const expectedEndpoints = ownerViewEndpoints[spec.ownerView] || [];
    const missingEndpoints = expectedEndpoints.filter((endpoint) => !apiObserved('GET', endpoint));
    const fallbackApis = observedApis.filter((item) => item.mock === 'fallback' && (
      item.path.startsWith('/api/owner/') || item.path.startsWith('/api/booking/') || item.path === '/api/booking'
    ));
    const failedApiResponses = observedApis.filter((item) => item.status >= 400);
    const basePass = sessionObserved
      && bookingsObserved
      && !state.loginGateVisible
      && state.dashboardVisible
      && state.bookingListSettled
      && state.activeViewVisible
      && state.activeViewTextLength > 40
      && state.dataMarkerCount > 0
      && state.topbarTitle === ownerViewTitles[spec.ownerView]
      && !state.activeViewLoading
      && !state.activeViewFailure
      && missingEndpoints.length === 0
      && fallbackApis.length === 0
      && failedApiResponses.length === 0;
    const viewSpecificPass = spec.ownerView === 'bookings'
      ? spec.ownerDamageReviewBooking
        ? state.detailOpen
          && checks.damageReviewWorkflow?.pass
          && (!spec.ownerRefundRecoveryBooking || checks.refundReconciliationWorkflow?.pass)
        : state.detailOpen
          && state.bookingCardHasExactCents
          && state.formattedPhoneVisible
          && state.paymentRecoveryMessageVisible
          && state.unreadEaserMessageVisible
      : spec.ownerView === 'customers'
        ? state.customerSpendHasExactCents && state.customerAverageHasExactCents && state.formattedPhoneVisible
        : spec.ownerView === 'analytics'
          ? state.financialGrossRendered
          : true;
    checks.ownerDashboard = {
      required: true,
      pass: basePass && viewSpecificPass,
      sessionObserved,
      bookingsObserved,
      expectedEndpoints,
      missingEndpoints,
      fallbackApis,
      failedApiResponses,
      basePass,
      viewSpecificPass,
      ownerView: spec.ownerView,
      ...state,
    };
  }

  return checks;
}

async function auditPage(context, spec, width) {
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];
  const observedApis = [];

  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const locationUrl = message.location()?.url || '';
    const text = message.text();
    if (/fonts\.gstatic\.com|ERR_BLOCKED_BY_CLIENT/.test(locationUrl + ' ' + text)) return;
    consoleErrors.push({ text, url: locationUrl });
  });
  page.on('pageerror', (error) => pageErrors.push(error.stack || error.message));
  page.on('response', (response) => {
    const requestUrl = new URL(response.url());
    if (!requestUrl.pathname.startsWith('/api/')) return;
    observedApis.push({
      method: response.request().method(),
      path: requestUrl.pathname,
      status: response.status(),
      mock: response.headers()['x-aae-audit-mock'] || 'external',
    });
  });
  page.on('requestfailed', (request) => {
    const url = request.url();
    if (/fonts\.gstatic\.com/.test(url)) return;
    if (/\/images\/favicon\.svg(?:\?|$)/.test(url) && request.failure()?.errorText === 'net::ERR_ABORTED') return;
    failedRequests.push({ url, error: request.failure()?.errorText || 'failed' });
  });

  let responseStatus = 0;
  let navigationError = null;
  try {
    const response = await page.goto(baseUrl + spec.path, { waitUntil: 'domcontentloaded', timeout: 30000 });
    responseStatus = response?.status() || 0;
    if (spec.group === 'owner-auth') {
      const ownerSessionResponse = page.waitForResponse((candidate) => {
        const url = new URL(candidate.url());
        return candidate.request().method() === 'POST' && url.pathname === '/api/owner/session';
      }, { timeout: 5000 }).catch(() => null);
      const ownerBookingsResponse = page.waitForResponse((candidate) => {
        const url = new URL(candidate.url());
        return candidate.request().method() === 'GET' && url.pathname === '/api/booking/list';
      }, { timeout: 5000 }).catch(() => null);
      await page.locator('#login-pw').fill('mock-visual-audit-password');
      await page.locator('#login-btn').click();
      await page.locator('#layout').waitFor({ state: 'visible', timeout: 5000 });
      await Promise.all([ownerSessionResponse, ownerBookingsResponse]);
      await page.locator('#bookings-list .booking-card').first().waitFor({ state: 'visible', timeout: 5000 });

      if (spec.ownerView && spec.ownerView !== 'bookings') {
        const endpointResponses = (ownerViewEndpoints[spec.ownerView] || []).map((endpoint) => page.waitForResponse((candidate) => {
          const url = new URL(candidate.url());
          return candidate.request().method() === 'GET' && url.pathname === endpoint;
        }, { timeout: 5000 }).catch(() => null));
        await page.evaluate((view) => {
          const link = document.querySelector(`.sidebar-nav a[data-view="${view}"]`);
          if (!link) throw new Error(`Owner view navigation is missing: ${view}`);
          link.click();
        }, spec.ownerView);
        await page.locator(`#${spec.ownerView}-view`).waitFor({ state: 'visible', timeout: 5000 });
        await Promise.all(endpointResponses);
      }

      if (spec.ownerSelectBooking) {
        const detailResponses = (ownerViewEndpoints.bookings || []).map((endpoint) => page.waitForResponse((candidate) => {
          const url = new URL(candidate.url());
          return candidate.request().method() === 'GET' && url.pathname === endpoint;
        }, { timeout: 5000 }).catch(() => null));
        const card = page.locator(`.booking-card[data-id="${spec.ownerSelectBooking}"]`);
        await card.waitFor({ state: 'visible', timeout: 5000 });
        await card.click();
        await page.locator('#detail-panel').waitFor({ state: 'visible', timeout: 5000 });
        await Promise.all(detailResponses);
      }
      await page.waitForTimeout(350);
    } else {
      await page.waitForTimeout(spec.group === 'easer-auth' ? 450 : 200);
    }
  } catch (error) {
    navigationError = error.message;
  }

  let menu = null;
  if (!navigationError && spec.menu && spec.group === 'owner-auth' && width <= 900) {
    const menuButton = page.locator('#mobile-menu-btn');
    if (await menuButton.count() && await menuButton.isVisible()) {
      try {
        await menuButton.click();
        await page.waitForFunction(() => {
          const sidebar = document.getElementById('sidebar');
          return !!sidebar && Math.abs(sidebar.getBoundingClientRect().left) < 0.5;
        }, null, { timeout: 1200 }).catch(() => null);
        menu = await page.evaluate(() => {
          const sidebar = document.getElementById('sidebar');
          const overlay = document.getElementById('sidebar-overlay');
          if (!sidebar || !overlay) return { present: false };
          const r = sidebar.getBoundingClientRect();
          const links = [...sidebar.querySelectorAll('a')].filter((link) => {
            const rect = link.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          }).map((link) => {
            const rect = link.getBoundingClientRect();
            return { text: link.textContent.trim(), width: Math.round(rect.width * 10) / 10, height: Math.round(rect.height * 10) / 10 };
          });
          return {
            present: true,
            open: sidebar.classList.contains('open') && overlay.classList.contains('open'),
            clipped: r.left < -1 || r.right > innerWidth + 1 || r.top < -1 || r.bottom > innerHeight + 1,
            bounds: { left: r.left, right: r.right, top: r.top, bottom: r.bottom },
            smallLinks: links.filter((link) => link.width < 43.5 || link.height < 43.5),
          };
        });
        await page.locator('#sidebar-overlay').click({ position: { x: Math.max(1, width - 5), y: 5 } });
        await page.waitForTimeout(240);
      } catch (error) {
        menu = { present: true, open: false, error: error.message };
      }
    } else {
      menu = { present: false };
    }
  } else if (!navigationError && spec.menu && width <= 899) {
    const hamburger = page.locator('#hamburger');
    if (await hamburger.count() && await hamburger.isVisible()) {
      try {
        await hamburger.click();
        await page.waitForTimeout(80);
        menu = await page.evaluate(() => {
          const button = document.getElementById('hamburger');
          const panel = document.getElementById('mobileNav');
          if (!button || !panel) return { present: false };
          const r = panel.getBoundingClientRect();
          const links = [...panel.querySelectorAll('a')].filter((link) => {
            const rect = link.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          }).map((link) => {
            const rect = link.getBoundingClientRect();
            return { text: link.textContent.trim(), width: Math.round(rect.width * 10) / 10, height: Math.round(rect.height * 10) / 10, left: Math.round(rect.left * 10) / 10, right: Math.round(rect.right * 10) / 10 };
          });
          return {
            present: true,
            open: panel.classList.contains('open') && getComputedStyle(panel).display !== 'none',
            ariaExpanded: button.getAttribute('aria-expanded'),
            bounds: { left: r.left, right: r.right, top: r.top, bottom: r.bottom },
            clipped: r.left < -1 || r.right > innerWidth + 1 || r.bottom > innerHeight + 1,
            smallLinks: links.filter((link) => link.width < 43.5 || link.height < 43.5),
          };
        });
        await page.keyboard.press('Escape');
        await hamburger.evaluate((element) => element.blur());
        await page.waitForTimeout(40);
      } catch (error) {
        menu = { present: true, open: false, error: error.message };
      }
    } else {
      menu = { present: false };
    }
  }

  const experienceChecks = navigationError ? {} : await collectExperienceChecks(page, spec, width, observedApis);
  const layout = navigationError ? null : await collectLayout(page, width);
  const shouldScreenshot = takeScreenshots && (
    [320, 390, 768, 900].includes(width)
    && (spec.group === 'owner-auth'
      || ['home', 'book', 'pricing', 'locations', 'dallas-furniture', 'houston-furniture', 'san-antonio-tv', 'fort-worth-office', 'el-paso-fitness', 'apply', 'login', 'easer-home', 'easer-jobs', 'easer-payouts', 'easer-profile'].includes(spec.id))
  );
  let screenshot = null;
  let screenshotError = null;
  if (shouldScreenshot) {
    fs.mkdirSync(screenshotRoot, { recursive: true });
    screenshot = path.join(screenshotRoot, `${spec.id}-${width}.png`);
    try {
      await page.screenshot({ path: screenshot, fullPage: true, timeout: 8000 });
    } catch (error) {
      screenshotError = error.message;
      screenshot = null;
    }
  }

  await page.close();
  return {
    id: spec.id,
    path: spec.path,
    group: spec.group,
    ownerView: spec.ownerView || null,
    width,
    responseStatus,
    navigationError,
    layout,
    menu,
    consoleErrors: dedupe(consoleErrors, (item) => item.text + item.url).slice(0, 20),
    pageErrors: [...new Set(pageErrors)].slice(0, 20),
    failedRequests: dedupe(failedRequests, (item) => item.url).slice(0, 20),
    observedApis: dedupe(observedApis, (item) => item.method + item.path + item.status),
    experienceChecks,
    screenshot: screenshot ? path.relative(repoRoot, screenshot) : null,
    screenshotError,
  };
}

async function main() {
  const browser = await chromium.launch({ headless: true, executablePath });
  let results = [];

  try {
    const auditWidth = async (width) => {
      const widthResults = [];
      const context = await browser.newContext({
        viewport: { width, height: width <= 430 ? 900 : 1000 },
        deviceScaleFactor: 1,
        reducedMotion: 'reduce',
        locale: 'en-US',
        timezoneId: 'America/Chicago',
      });
      await configureContext(context);

      for (const spec of pages) {
        const result = await auditPage(context, spec, width);
        widthResults.push(result);
        const issueCount = (result.navigationError ? 1 : 0)
          + (result.responseStatus >= 400 ? 1 : 0)
          + (result.layout?.documentWidth.overflow > 1 ? 1 : 0)
          + (result.layout?.clippedContent.length || 0)
          + (result.layout?.fixedClipping.length || 0)
          + (result.layout?.smallTargets.length || 0)
          + (result.layout?.smallInputFonts.length || 0)
          + (result.layout?.oddText.length || 0)
          + (result.menu && (!result.menu.open || result.menu.clipped || result.menu.smallLinks?.length) ? 1 : 0)
          + Object.values(result.experienceChecks || {}).filter((check) => check.required && !check.pass).length
          + result.consoleErrors.length
          + result.pageErrors.length
          + result.failedRequests.length
          + result.observedApis.filter((item) => item.status >= 400).length
          + result.observedApis.filter((item) => item.mock === 'fallback' && result.group === 'owner-auth').length
          + (result.screenshotError ? 1 : 0);
        process.stderr.write(`${issueCount ? 'CHECK' : 'PASS '} ${String(width).padStart(3)} ${spec.id}\n`);
      }

      await context.close();
      return widthResults;
    };

    const concurrency = Math.max(1, Math.min(4, Number(process.env.AAE_AUDIT_CONCURRENCY || 4)));
    for (let offset = 0; offset < widths.length; offset += concurrency) {
      const batch = widths.slice(offset, offset + concurrency);
      const batchResults = await Promise.all(batch.map(auditWidth));
      results.push(...batchResults.flat());
    }
    results.sort((a, b) => a.width - b.width || pages.findIndex((page) => page.id === a.id) - pages.findIndex((page) => page.id === b.id));
  } finally {
    await browser.close();
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    baseUrl,
    widths,
    pages: pages.length,
    checks: results.length,
    navigationFailures: results.filter((r) => r.navigationError || r.responseStatus >= 400).length,
    documentOverflow: results.filter((r) => r.layout?.documentWidth.overflow > 1).length,
    clippedContent: results.filter((r) => r.layout?.clippedContent.length).length,
    fixedClipping: results.filter((r) => r.layout?.fixedClipping.length).length,
    smallTargets: results.filter((r) => r.layout?.smallTargets.length).length,
    smallInputFonts: results.filter((r) => r.layout?.smallInputFonts.length).length,
    oddText: results.filter((r) => r.layout?.oddText.length).length,
    menuFailures: results.filter((r) => r.menu && (!r.menu.open || r.menu.clipped || r.menu.smallLinks?.length)).length,
    experienceFailures: results.filter((r) => Object.values(r.experienceChecks || {}).some((check) => check.required && !check.pass)).length,
    consoleErrors: results.filter((r) => r.consoleErrors.length).length,
    pageErrors: results.filter((r) => r.pageErrors.length).length,
    failedRequests: results.filter((r) => r.failedRequests.length).length,
    apiResponseFailures: results.filter((r) => r.observedApis.some((item) => item.status >= 400)).length,
    ownerMockFallbacks: results.filter((r) => r.group === 'owner-auth' && r.observedApis.some((item) => item.mock === 'fallback')).length,
    screenshotFailures: results.filter((r) => r.screenshotError).length,
  };

  const report = { summary, results };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  const displayOutputPath = path.relative(repoRoot, outputPath).startsWith('..') ? outputPath : path.relative(repoRoot, outputPath);
  process.stdout.write(`Detailed results: ${displayOutputPath}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
