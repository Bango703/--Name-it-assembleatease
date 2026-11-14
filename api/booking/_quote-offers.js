// Private Easer price offers on custom quotes (owner, 2026-11-12: the hybrid
// marketplace). The ONE owner of:
//   - the offer statuses (migration 129 CHECK lists the same values),
//   - how an Easer's price becomes the customer's quote (fee on top),
//   - what an Easer may see of a quote request before it is theirs.
//
// The flow:
//   1. Owner asks for prices on a custom quote that has not been priced.
//      The Easers who could be offered the job (findEligibleEasers, the same
//      rule as job offers) are invited, privately.
//   2. Each Easer enters what they want to earn, the hours and the crew size.
//      Nobody sees anyone else's number. The customer sees none of them.
//   3. The owner picks one. api/owner/quote-approve.js prices the customer's
//      quote from it here, so the platform fee sits on top of the Easer's
//      number, and the customer gets one AssembleAtEase quote as before.
//   4. When the customer approves, dispatch offers the job to that Easer first
//      (bookings.preferred_easer_ids). They still accept it in the app.
//
// Off unless PRIVATE_EASER_OFFERS_ENABLED=true. Off, nothing changes anywhere.

import { getPlatformFeePct, computeBookingSplit, SALES_TAX_RATE, DISPATCH_OFFER_STATUS } from '../_source-of-truth.js';

export const QUOTE_OFFER_STATUS = Object.freeze({
  INVITED: 'invited',
  SUBMITTED: 'submitted',
  WITHDRAWN: 'withdrawn',
  SELECTED: 'selected',
  NOT_SELECTED: 'not_selected',
  CLOSED: 'closed',
});
export const QUOTE_OFFER_STATUSES = Object.freeze(Object.values(QUOTE_OFFER_STATUS));

/** How long invited Easers have to answer. */
export const QUOTE_OFFER_RESPONSE_HOURS = 24;
/** At most this many Easers are asked on one quote. */
export const QUOTE_OFFER_MAX_INVITES = 8;
/** Earnings an Easer may enter, in cents (migration 129 CHECK). */
export const QUOTE_OFFER_MIN_EARNINGS_CENTS = 2000;
export const QUOTE_OFFER_MAX_EARNINGS_CENTS = 1500000;
export const QUOTE_OFFER_MAX_HOURS = 24;
export const QUOTE_OFFER_MAX_CREW = 4;
export const QUOTE_OFFER_NOTE_MAX = 500;

export function privateEaserOffersEnabled(env = process.env) {
  return String(env.PRIVATE_EASER_OFFERS_ENABLED || '').toLowerCase() === 'true';
}

/**
 * The customer's quote for an Easer's price. The platform fee sits on top:
 * the subtotal is the smallest amount whose canonical split (computeBookingSplit)
 * pays the Easer at least what they asked. Tax is added on the subtotal.
 * The Easer is paid from the same split at completion, so the number they
 * entered is the number they earn.
 */
export function customerQuoteForEarnings(earningsCents, { isMember = false } = {}) {
  const earnings = Number(earningsCents);
  if (!Number.isInteger(earnings) || earnings <= 0) throw new Error('earnings must be a positive whole number of cents');
  const feePct = getPlatformFeePct(isMember);
  let subtotalCents = Math.ceil(earnings * 100 / (100 - feePct));
  for (let guard = 0; guard < 5; guard++) {
    const fee = Math.round(subtotalCents * feePct / 100);
    if (subtotalCents - fee >= earnings) break;
    subtotalCents += 1;
  }
  const taxCents = Math.round(subtotalCents * SALES_TAX_RATE);
  const totalCents = subtotalCents + taxCents;
  const split = computeBookingSplit(totalCents, isMember, { taxCents });
  if (split.assemblerDueCents < earnings) throw new Error('quote does not cover the Easer price');
  return {
    feePct,
    subtotalCents,
    taxCents,
    totalCents,
    platformFeeCents: split.platformFeeCents,
    easerEarningsCents: split.assemblerDueCents,
  };
}

/** Validate what an Easer submits. Returns {ok, value} or {ok:false, error}. */
export function validateOfferSubmission(body = {}) {
  const earningsCents = Math.round(Number(body.earningsDollars) * 100);
  if (!Number.isFinite(earningsCents) || earningsCents < QUOTE_OFFER_MIN_EARNINGS_CENTS || earningsCents > QUOTE_OFFER_MAX_EARNINGS_CENTS) {
    return { ok: false, error: `Enter what you want to earn, between $${QUOTE_OFFER_MIN_EARNINGS_CENTS / 100} and $${(QUOTE_OFFER_MAX_EARNINGS_CENTS / 100).toLocaleString('en-US')}.` };
  }
  const hours = Number(body.hours);
  if (!Number.isFinite(hours) || hours < 0.5 || hours > QUOTE_OFFER_MAX_HOURS || !Number.isInteger(hours * 2)) {
    return { ok: false, error: `Enter the hours on site, between 0.5 and ${QUOTE_OFFER_MAX_HOURS}.` };
  }
  const crewSize = Number(body.crewSize);
  if (!Number.isInteger(crewSize) || crewSize < 1 || crewSize > QUOTE_OFFER_MAX_CREW) {
    return { ok: false, error: `Choose a crew of 1 to ${QUOTE_OFFER_MAX_CREW}.` };
  }
  const note = String(body.note || '').trim().slice(0, QUOTE_OFFER_NOTE_MAX);
  return { ok: true, value: { earningsCents, hours, crewSize, note: note || null } };
}

/**
 * Contact details removed from customer text shown to an Easer before the job
 * is theirs (owner, 2026-10-22: nobody takes customers off-platform). Phone
 * numbers, email addresses, links and handles become "[removed]".
 */
export function scrubContactDetails(text) {
  return String(text || '')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[removed]')
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, '[removed]')
    .replace(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g, '[removed]')
    .replace(/(?:^|\s)@[A-Za-z0-9_]{3,}/g, ' [removed]')
    .replace(/\b\d{1,6}\s+(?:[A-Za-z0-9.'-]+\s+){0,5}(?:street|st|road|rd|avenue|ave|drive|dr|lane|ln|court|ct|boulevard|blvd|way|place|pl|trail|trl)\b\.?/gi, '[removed]')
    .replace(/\b(?:gate|door|access|entry)\s*(?:code|pin)\s*[:#-]?\s*\S+/gi, '[removed]')
    .trim();
}

/**
 * Is this offer still open for the Easer to answer? Invited or submitted, the
 * quote not yet priced from an offer, and the response window not passed.
 */
export function offerOpenForEaser(offer, now = Date.now()) {
  if (![QUOTE_OFFER_STATUS.INVITED, QUOTE_OFFER_STATUS.SUBMITTED].includes(offer?.status)) return false;
  return Date.parse(offer.respond_by) > now;
}

/** One word for the Easer about where their offer stands. */
export function offerStatusForEaser(offer, now = Date.now()) {
  if (offer.status === QUOTE_OFFER_STATUS.SELECTED) return 'chosen';
  if (offer.status === QUOTE_OFFER_STATUS.NOT_SELECTED || offer.status === QUOTE_OFFER_STATUS.CLOSED) return 'closed';
  if (offer.status === QUOTE_OFFER_STATUS.WITHDRAWN) return 'withdrawn';
  if (!offerOpenForEaser(offer, now)) return offer.status === QUOTE_OFFER_STATUS.SUBMITTED ? 'sent' : 'missed';
  return offer.status === QUOTE_OFFER_STATUS.SUBMITTED ? 'sent' : 'open';
}

// The catalog's placeholder line on a custom quote says nothing about the work.
const CUSTOM_QUOTE_PLACEHOLDER = /describe your project in the notes/i;

// Booking states after which a chosen price can no longer become this Easer's job.
const ENDED_BOOKING_STATUSES = new Set(['cancelled', 'declined', 'refunded', 'completed']);

/** The quote is still taking Easer prices (the same test the write path applies). */
function takingPrices(offer, booking, now) {
  return offerOpenForEaser(offer, now) && booking.status === 'pending'
    && !booking.selected_quote_offer_id && !booking.quote_approved_at && !booking.stripe_payment_intent_id;
}

/**
 * Where this price request stands for the Easer, decided here so the page
 * renders one server answer (contract invariant 1). `jobOffer` is this
 * Easer's latest dispatch offer on the booking, when there is one.
 *   open              no price yet, still taking prices
 *   sent              price in, still taking prices (the Easer may change it)
 *   in_review         price in, the window closed, no quote sent yet
 *   with_customer     this price was chosen and sent; the customer is deciding
 *   customer_approved the customer approved; the job offer has not reached this Easer yet
 *   job_offered       the job is offered to this Easer and can be accepted now
 *   offer_ended       the job was offered to this Easer and the offer ended unaccepted
 *   job_yours         this Easer has the job
 *   job_taken         another Easer has the job
 *   not_chosen        another price was chosen
 *   closed | withdrawn | missed
 */
export function easerRequestStage(offer = {}, booking = {}, now = Date.now(), jobOffer = null) {
  if (offer.status === QUOTE_OFFER_STATUS.SELECTED) {
    if (booking.assembler_id) return booking.assembler_id === offer.easer_id ? 'job_yours' : 'job_taken';
    if (ENDED_BOOKING_STATUSES.has(booking.status)) return 'closed';
    if (booking.quote_approved_at) {
      if (jobOffer?.offer_status === DISPATCH_OFFER_STATUS.SENT && Date.parse(jobOffer.expires_at) > now) return 'job_offered';
      return jobOffer ? 'offer_ended' : 'customer_approved';
    }
    if (booking.quote_expires_at && Date.parse(booking.quote_expires_at) <= now) return 'closed';
    return 'with_customer';
  }
  if (offer.status === QUOTE_OFFER_STATUS.NOT_SELECTED) return 'not_chosen';
  if (offer.status === QUOTE_OFFER_STATUS.WITHDRAWN) return 'withdrawn';
  if (offer.status === QUOTE_OFFER_STATUS.CLOSED) return 'closed';
  const open = takingPrices(offer, booking, now);
  if (offer.status === QUOTE_OFFER_STATUS.SUBMITTED) return open ? 'sent' : 'in_review';
  return open ? 'open' : 'missed';
}

/**
 * What an Easer sees of a quote request: the work and roughly where and when.
 * Never the customer's name, email, phone or street address, and never the
 * customer's price.
 */

export function quoteRequestForEaser(offer, booking = {}, groups = [], jobOffer = null, now = Date.now()) {
  // loadBookingItems groups: [{label, items:[{name, quantity, isAddOn, addOnName}]}]
  const items = [];
  (groups || []).forEach(group => (group.items || []).forEach(item => {
    if (CUSTOM_QUOTE_PLACEHOLDER.test(String(item.name || ''))) return;
    items.push({ name: item.isAddOn && item.addOnName ? `${item.name}: ${item.addOnName}` : item.name, quantity: item.quantity });
  }));
  const stage = easerRequestStage(offer, booking, now, jobOffer);
  return {
    offerId: offer.id,
    service: booking.service || 'Custom job',
    city: booking.service_city || null,
    zip: booking.service_zip || null,
    date: booking.date || null,
    time: booking.time || null,
    // Only the owner's reviewed work scope is released before assignment.
    // Customer free text can contain names, addresses and access instructions;
    // a regex cannot prove it safe to release.
    details: scrubContactDetails(booking.quote_offer_scope || ''),
    items: items.map(item => ({
      name: scrubContactDetails(item.name).slice(0, 160),
      quantity: Number(item.quantity) > 0 ? Number(item.quantity) : 1,
    })).filter(item => item.name),
    respondBy: offer.respond_by,
    invitedAt: offer.invited_at || null,
    status: offerStatusForEaser(offer),
    stage,
    // ZIP-level area only; the street address is released when the job is accepted.
    areaMapUrl: booking.service_zip ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(booking.service_zip)}` : null,
    // The job, once it is offered to or accepted by this Easer.
    jobId: ['job_offered', 'job_yours'].includes(stage) ? booking.id : null,
    jobOfferExpiresAt: stage === 'job_offered' ? jobOffer.expires_at : null,
    quoteExpiresAt: stage === 'with_customer' ? (booking.quote_expires_at || null) : null,
    canRespond: takingPrices(offer, booking, now),
    yourOffer: offer.earnings_cents != null ? {
      earningsCents: offer.earnings_cents,
      hours: offer.hours != null ? Number(offer.hours) : null,
      crewSize: offer.crew_size,
      note: offer.note || null,
      submittedAt: offer.submitted_at,
    } : null,
  };
}

/**
 * Where the Easer prices on one quote stand, for the owner's bookings list
 * and booking view. Counted from the offers themselves, never stored.
 */
export function summarizeQuoteOffers(rows = [], now = Date.now()) {
  const out = { asked: 0, priced: 0, waiting: 0, selected: false };
  rows.forEach(row => {
    out.asked += 1;
    if (row.status === QUOTE_OFFER_STATUS.SELECTED) { out.selected = true; out.priced += 1; }
    else if (row.status === QUOTE_OFFER_STATUS.SUBMITTED) out.priced += 1;
    else if (row.status === QUOTE_OFFER_STATUS.INVITED && Date.parse(row.respond_by) > now) out.waiting += 1;
  });
  return out;
}
