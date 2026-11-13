/**
 * Partner pipeline: the one owner of its rules.
 *
 * Referral partners (leasing offices, property managers, movers, realtors,
 * furniture stores) are worked through stages. Every value, the follow-up rule
 * and the booking link live here; the owner panel renders what this module
 * returns, and migration 104 checks the same values.
 *
 * Bookings per partner are not stored on the partner. They are counted from
 * bookings.booking_attribution, where the partner's link left utm_source=partner
 * and utm_campaign=<ref_code>. One fact, one place.
 */
import crypto from 'node:crypto';
import { chicagoDateIso, BOOKING_STATUS, computeBookingSplitFromSnapshot, computeBookingFinancialSummary } from './_source-of-truth.js';

export const PARTNER_STAGES = Object.freeze([
  { id: 'to_contact', label: 'To contact' },
  { id: 'contacted', label: 'Contacted' },
  { id: 'interested', label: 'Interested' },
  { id: 'partner', label: 'Partner' },
  { id: 'not_a_fit', label: 'Not a fit' },
]);
export const PARTNER_KINDS = Object.freeze([
  { id: 'property_manager', label: 'Property manager', template: 'A' },
  { id: 'apartment', label: 'Apartment community', template: 'A' },
  { id: 'mover', label: 'Moving company', template: 'C' },
  { id: 'realtor', label: 'Real estate office', template: 'B' },
  { id: 'furniture', label: 'Furniture store', template: 'D' },
]);
export const PARTNER_SOURCES = Object.freeze(['google_maps', 'manual']);

const STAGE_IDS = new Set(PARTNER_STAGES.map(s => s.id));
const KIND_IDS = new Set(PARTNER_KINDS.map(k => k.id));
const CLOSED_STAGES = new Set(['partner', 'not_a_fit']);

/** Outreach kit: 10 quality contacts a week, each followed up once after 4 to 5 days. */
export const WEEKLY_CONTACT_TARGET = 10;
export const FOLLOW_UP_DAYS = 5;
const HISTORY_LIMIT = 50;

export const PARTNER_UTM_SOURCE = 'partner';
const SITE = 'https://www.assembleatease.com';

const REF_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export const REF_CODE = /^[a-z0-9]{6}$/;

export function newRefCode(random = crypto.randomBytes) {
  const bytes = random(6);
  let out = '';
  for (let i = 0; i < 6; i++) out += REF_ALPHABET[bytes[i] % REF_ALPHABET.length];
  return out;
}

/** The link a partner hands out. Move-in partners open the move-in bundle; stores open booking. */
export function partnerBookingLink(partner) {
  const params = new URLSearchParams();
  if (partner.kind !== 'furniture') params.set('bundle', 'move-in-ready');
  params.set('utm_source', PARTNER_UTM_SOURCE);
  params.set('utm_medium', 'referral');
  params.set('utm_campaign', partner.ref_code);
  return `${SITE}/book?${params.toString()}`;
}

function addDays(iso, days) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Monday of the current week, Central time. */
export function weekStartIso(now = new Date()) {
  const today = chicagoDateIso(now);
  const dow = (new Date(today + 'T12:00:00Z').getUTCDay() + 6) % 7;
  return addDays(today, -dow);
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
function isRealDate(v) { return DATE.test(v) && !Number.isNaN(Date.parse(v + 'T00:00:00Z')) && new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v; }

function cleanText(value, max) {
  if (value == null) return null;
  const s = String(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  return s ? s.slice(0, max) : null;
}
function cleanUrl(value) {
  const s = cleanText(value, 300);
  if (!s) return null;
  try { const u = new URL(s); return ['http:', 'https:'].includes(u.protocol) ? u.toString() : null; } catch { return null; }
}
function cleanEmail(value) {
  const s = cleanText(value, 160);
  return s && /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(s) ? s.toLowerCase() : null;
}

/**
 * Validate an owner-added partner. Returns { value } or { error } with a reason
 * the owner can act on.
 */
export function validateNewPartner(body = {}) {
  const name = cleanText(body.name, 120);
  if (!name) return { error: 'Enter the business name.' };
  if (!KIND_IDS.has(body.kind)) return { error: 'Choose what kind of partner this is.' };
  if (body.website && !cleanUrl(body.website)) return { error: 'The website must start with http:// or https://.' };
  if (body.email && !cleanEmail(body.email)) return { error: 'That email address is not valid.' };
  return {
    value: {
      name, kind: body.kind, source: 'manual',
      city: cleanText(body.city, 60), phone: cleanText(body.phone, 40),
      website: cleanUrl(body.website), email: cleanEmail(body.email),
      address: cleanText(body.address, 200),
    },
  };
}

/**
 * Apply an owner edit to a partner row. The follow-up rule lives here:
 * the first time a partner is marked contacted, the contact date is recorded
 * and, unless a follow-up is already set, one is scheduled FOLLOW_UP_DAYS out.
 * Partner and Not a fit close the follow-up.
 */
export function applyPartnerUpdate(current, body = {}, now = new Date()) {
  const today = chicagoDateIso(now);
  const patch = {};
  const events = [];

  if (body.stage !== undefined) {
    if (!STAGE_IDS.has(body.stage)) return { error: 'Unknown stage.' };
    if (body.stage !== current.stage) {
      patch.stage = body.stage;
      events.push({ at: now.toISOString(), event: 'stage', from: current.stage, to: body.stage });
      if (body.stage === 'contacted') {
        patch.last_contacted_on = today;
        if (!current.first_contacted_on) patch.first_contacted_on = today;
        if (!current.follow_up_on && body.followUpOn === undefined) patch.follow_up_on = addDays(today, FOLLOW_UP_DAYS);
      }
      if (CLOSED_STAGES.has(body.stage) && body.followUpOn === undefined) patch.follow_up_on = null;
    }
  }
  if (body.followUpOn !== undefined) {
    if (body.followUpOn === null || body.followUpOn === '') patch.follow_up_on = null;
    else if (isRealDate(body.followUpOn)) patch.follow_up_on = body.followUpOn;
    else return { error: 'Follow-up date must be a real date.' };
  }
  if (body.notes !== undefined) {
    if (body.notes !== null && typeof body.notes !== 'string') return { error: 'Notes must be text.' };
    patch.notes = cleanText(body.notes, 4000);
  }
  if (body.loggedContact === true) {
    patch.last_contacted_on = today;
    if (!current.first_contacted_on) patch.first_contacted_on = today;
    if (!CLOSED_STAGES.has(patch.stage || current.stage) && body.followUpOn === undefined) patch.follow_up_on = addDays(today, FOLLOW_UP_DAYS);
    events.push({ at: now.toISOString(), event: 'contact' });
  }
  if (!Object.keys(patch).length) return { error: 'Nothing to change.' };
  if (events.length) patch.history = [...(Array.isArray(current.history) ? current.history : []), ...events].slice(-HISTORY_LIMIT);
  patch.updated_at = now.toISOString();
  return { patch };
}

/**
 * Bookings per partner, counted from the booking record. Test bookings and
 * bookings without this partner's code are not counted.
 */
export function countPartnerBookings(bookings = []) {
  const byCode = new Map();
  for (const b of bookings) {
    if (b?.is_test_booking) continue;
    const attr = b?.booking_attribution || {};
    if (String(attr.utmSource || '').toLowerCase() !== PARTNER_UTM_SOURCE) continue;
    const code = String(attr.utmCampaign || '').trim().toLowerCase();
    if (!REF_CODE.test(code)) continue;
    const entry = byCode.get(code) || { bookings: 0, completed: 0, refs: [] };
    entry.bookings += 1;
    if (b.status === BOOKING_STATUS.COMPLETED) entry.completed += 1;
    if (entry.refs.length < 20 && b.ref) entry.refs.push(b.ref);
    byCode.set(code, entry);
  }
  return byCode;
}

/**
 * Server-decided lists. The panel's counts are the lengths of these lists;
 * it never filters for itself.
 */
export function summarizePartners(rows = [], now = new Date()) {
  const today = chicagoDateIso(now);
  const weekStart = weekStartIso(now);
  return {
    total: rows.length,
    weeklyTarget: WEEKLY_CONTACT_TARGET,
    contactedThisWeek: rows.filter(r => r.last_contacted_on && r.last_contacted_on >= weekStart).map(r => r.id),
    followUpDue: rows.filter(r => r.follow_up_on && r.follow_up_on <= today && !CLOSED_STAGES.has(r.stage)).map(r => r.id),
    weekStart,
    today,
  };
}

/** Shape a stored row for the owner panel. */
export function projectPartner(row, counts) {
  const c = counts?.get(row.ref_code) || { bookings: 0, completed: 0, refs: [] };
  return {
    id: row.id, refCode: row.ref_code, source: row.source, name: row.name, kind: row.kind,
    category: row.category, city: row.city, address: row.address, phone: row.phone, email: row.email,
    website: row.website, mapsUrl: row.maps_url, social: Array.isArray(row.social) ? row.social : [],
    rating: row.rating == null ? null : Number(row.rating), reviewCount: row.review_count, rank: row.rank,
    stage: row.stage, notes: row.notes, followUpOn: row.follow_up_on,
    firstContactedOn: row.first_contacted_on, lastContactedOn: row.last_contacted_on,
    history: Array.isArray(row.history) ? row.history : [],
    bookingLink: partnerBookingLink(row),
    bookings: c.bookings, completedJobs: c.completed, bookingRefs: c.refs,
    account: projectAccount(row),
    updatedAt: row.updated_at,
  };
}

// ── Partner accounts (migration 129) ────────────────────────────────────────
// A partner can be made an account: a private booking code that gives the
// account discount through the normal booking checkout (resolved on the server
// in api/_promotions.js), and preferred Easers who are offered its jobs first
// (bookings.preferred_easer_ids, read by dispatch). Billing is the normal card
// checkout: the partner pays per job. Off unless COMMERCIAL_ACCOUNTS_ENABLED=true.

export const ACCOUNT_STATUSES = Object.freeze(['active', 'paused']);
export const ACCOUNT_MAX_DISCOUNT_PCT = 20;
export const ACCOUNT_MAX_PREFERRED_EASERS = 5;
export const ACCOUNT_CODE = /^P[A-Z0-9]{7}$/;
const ACCOUNT_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export function commercialAccountsEnabled(env = process.env) {
  return String(env.COMMERCIAL_ACCOUNTS_ENABLED || '').toLowerCase() === 'true';
}

export function newAccountCode(random = crypto.randomBytes) {
  const bytes = random(7);
  let out = 'P';
  for (let i = 0; i < 7; i++) out += ACCOUNT_ALPHABET[bytes[i] % ACCOUNT_ALPHABET.length];
  return out;
}

/** The link an account books with: its code applies its pricing at checkout. */
export function accountBookingLink(row) {
  if (!row?.account_code) return null;
  const params = new URLSearchParams();
  params.set('promo', row.account_code);
  params.set('utm_source', PARTNER_UTM_SOURCE);
  params.set('utm_medium', 'account');
  params.set('utm_campaign', row.ref_code);
  return `${SITE}/book?${params.toString()}`;
}

function projectAccount(row) {
  if (!row || row.account_status == null) return null;
  return {
    status: row.account_status,
    code: row.account_code || null,
    discountPct: Number(row.account_discount_pct || 0),
    preferredEaserIds: Array.isArray(row.account_preferred_easer_ids) ? row.account_preferred_easer_ids : [],
    startedAt: row.account_started_at || null,
    link: accountBookingLink(row),
  };
}

/**
 * Turn a partner into an account, or change one. Returns {patch} or {error}.
 * body: {status: 'active'|'paused', discountPct, preferredEaserIds}
 */
export function validateAccountUpdate(current = {}, body = {}, now = new Date()) {
  const status = String(body.status || '');
  if (!ACCOUNT_STATUSES.includes(status)) return { error: 'Choose active or paused.' };
  const discountPct = Math.round(Number(body.discountPct ?? current.account_discount_pct ?? 0) * 10) / 10;
  if (!Number.isFinite(discountPct) || discountPct < 0 || discountPct > ACCOUNT_MAX_DISCOUNT_PCT) {
    return { error: `Account pricing is 0% to ${ACCOUNT_MAX_DISCOUNT_PCT}% off the catalog.` };
  }
  const ids = Array.isArray(body.preferredEaserIds) ? [...new Set(body.preferredEaserIds.map(String))] : (current.account_preferred_easer_ids || []);
  if (ids.length > ACCOUNT_MAX_PREFERRED_EASERS) return { error: `Choose up to ${ACCOUNT_MAX_PREFERRED_EASERS} preferred Easers.` };
  if (ids.some(id => !UUID_RE.test(id))) return { error: 'One of the preferred Easers was not recognised. Refresh and choose again.' };
  const becomingAccount = current.account_status == null;
  const history = Array.isArray(current.history) ? current.history.slice(-(HISTORY_LIMIT - 1)) : [];
  history.push({ at: now.toISOString(), event: becomingAccount ? 'account_opened' : `account_${status}`, discountPct });
  return {
    patch: {
      account_status: status,
      account_discount_pct: discountPct,
      account_preferred_easer_ids: ids,
      ...(becomingAccount ? { account_started_at: now.toISOString() } : {}),
      ...(current.account_code ? {} : { account_code: newAccountCode() }),
      ...(becomingAccount && current.stage !== 'partner' ? { stage: 'partner' } : {}),
      history,
      updated_at: now.toISOString(),
    },
  };
}

/**
 * An account's jobs, from the bookings tagged with it. Money is reported for
 * completed jobs only, from the canonical split on the amount actually charged.
 */
export function summarizeAccountBookings(rows = [], { month = null } = {}) {
  const out = { month, jobs: 0, completed: 0, open: 0, cancelled: 0, unpaidCompleted: 0,
    chargedCents: 0, refundedCents: 0, taxCents: 0, platformFeeCents: 0, easerPayCents: 0,
    processingFeeCents: 0, netEstimateCents: 0, estimatedFeeJobs: 0, lastBookedAt: null, bookings: [] };
  rows.forEach(b => {
    if (b.is_test_booking || (month && chicagoDateIso(new Date(b.created_at)).slice(0, 7) !== month)) return;
    out.jobs += 1;
    out.bookings.push({ id: b.id, ref: b.ref, status: b.status, paymentStatus: b.payment_status });
    if (!out.lastBookedAt || b.created_at > out.lastBookedAt) out.lastBookedAt = b.created_at;
    if (b.status === BOOKING_STATUS.COMPLETED) out.completed += 1;
    else if ([BOOKING_STATUS.CANCELLED, BOOKING_STATUS.DECLINED, BOOKING_STATUS.REFUNDED].includes(b.status)) out.cancelled += 1;
    else out.open += 1;
    const paid = ['captured', 'partially_refunded', 'refunded', 'cancellation_fee_captured'].includes(b.payment_status)
      || (b.source === 'owner_manual' && b.payment_status === 'offline_recorded'
        && b.payment_collected === true && b.payment_collected_at && b.payment_collected_by);
    if (!paid || b.amount_charged == null) {
      if (b.status === BOOKING_STATUS.COMPLETED) out.unpaidCompleted += 1;
      return;
    }
    const split = computeBookingSplitFromSnapshot({
      amountChargedCents: b.amount_charged, taxCents: b.tax_amount || 0,
      feePct: b.easer_fee_pct_snapshot, assemblecashRedeemedCents: b.assemblecash_redeemed_cents || 0,
      reviewRewardDiscountCents: b.review_reward_discount_cents || 0, giftCardAppliedCents: b.gift_card_applied_cents || 0,
    });
    const finance = computeBookingFinancialSummary({
      amountChargedCents: b.amount_charged, totalPriceCents: 0, taxAmountCents: b.tax_amount || 0,
      refundAmountCents: b.refund_amount || 0, stripeFeeCents: b.stripe_fee,
      assemblerDueCents: b.assembler_due ?? (b.status === BOOKING_STATUS.CANCELLED ? (b.cancellation_easer_due_cents || 0) : split.assemblerDueCents),
      payoutAmountCents: b.payout_amount || 0, easerBonusCents: b.easer_bonus_cents || 0,
      easerReimbursementCents: b.easer_reimbursement_cents || 0, giftCardAppliedCents: b.gift_card_applied_cents || 0,
    });
    out.chargedCents += finance.grossChargedCents;
    out.refundedCents += finance.refundedCents;
    out.taxCents += finance.taxCollectedCents;
    out.platformFeeCents += finance.platformFeeCents;
    out.easerPayCents += finance.easerCostCents;
    out.processingFeeCents += finance.processingFeeCents;
    out.netEstimateCents += finance.platformGrossCents;
    if (!finance.processingFeeIsActual) out.estimatedFeeJobs += 1;
  });
  return out;
}

/** A Google Maps seed lead, as stored. */
export function seedRow(lead, refCode) {
  return {
    ref_code: refCode, place_id: lead.id, source: 'google_maps', name: cleanText(lead.name, 120),
    kind: KIND_IDS.has(lead.kind) ? lead.kind : null, category: cleanText(lead.category, 80),
    city: cleanText(lead.city, 60), address: cleanText(lead.address, 200), phone: cleanText(lead.phone, 40),
    email: cleanEmail(lead.email), website: cleanUrl(lead.website), maps_url: cleanUrl(lead.maps),
    social: (lead.social || []).map(cleanUrl).filter(Boolean).slice(0, 3),
    rating: typeof lead.rating === 'number' ? lead.rating : null,
    review_count: Number.isInteger(lead.reviews) ? lead.reviews : null, rank: Number.isInteger(lead.rank) ? lead.rank : null,
  };
}

export function isMissingPartnerTable(error) {
  return error?.code === 'PGRST205' || error?.code === '42P01' || /partner_leads/i.test(String(error?.message || '')) && /does not exist|could not find the table/i.test(String(error?.message || ''));
}
