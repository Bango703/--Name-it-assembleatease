import { getSupabase } from '../_supabase.js';
import { loadBookingItems } from './_booking-items.js';
import {
  hasCurrentEaserAgreement,
  requireAssignedWorkEaser,
  respondWithEaserAccessError,
} from '../_easer-access.js';
import { hasEffectiveEaserMembership } from '../_easer-membership.js';
import {
  BOOKING_STATUS,
  DISPATCH_OFFER_STATUS,
  ACTIVE_BOOKING_STATUSES,
  VISIBLE_ASSIGNMENT_STATUSES,
  computeBookingSplitFromSnapshot,
  SALES_TAX_RATE,
} from '../_source-of-truth.js';
import { isOwnerManualLiveFlow } from '../_owner-easer.js';
import { evaluateEaserAppointmentGate } from './_appointment-gates.js';

const EASER_JOB_STAGES = Object.freeze(['en_route', 'arrived', 'in_progress']);

const SAFE_OFFER_CITIES = new Map([
  ['austin', 'Austin'],
  ['bee cave', 'Bee Cave'],
  ['buda', 'Buda'],
  ['cedar park', 'Cedar Park'],
  ['dripping springs', 'Dripping Springs'],
  ['georgetown', 'Georgetown'],
  ['hutto', 'Hutto'],
  ['kyle', 'Kyle'],
  ['lakeway', 'Lakeway'],
  ['leander', 'Leander'],
  ['manor', 'Manor'],
  ['pflugerville', 'Pflugerville'],
  ['round rock', 'Round Rock'],
  ['sunset valley', 'Sunset Valley'],
  ['west lake hills', 'West Lake Hills'],
]);

const INTERNAL_FINANCIAL_FIELDS = [
  'amount_charged',
  'same_day_fee_cents',
  'same_day_easer_bonus_cents',
  'platform_fee',
  'platform_fee_pct',
  'payment_status',
  'refund_amount',
  'refunded_at',
  'payout_status',
  'payout_mode_snapshot',
  'payout_review_status',
  'paid_out_at',
  'payout_notes',
  'stripe_transfer_status',
  'stripe_transfer_created_at',
  'stripe_bank_payout_status',
  'stripe_bank_payout_paid_at',
  'total_price',
  'tax_amount',
  'assemblecash_redeemed_cents',
  'cancellation_fee',
  'cancellation_easer_due_cents',
  'cancellation_easer_payout_status',
  'easer_fee_snapshot_easer_id',
  'easer_fee_pct_snapshot',
  'easer_estimated_due_snapshot',
];

export function deriveOfferLocation(address) {
  const parts = String(address || '')
    .split(',')
    .map(part => part.trim())
    .filter(Boolean);
  if (!parts.length) return 'Austin-area service zone';

  if (/^(?:USA|US|United States)$/i.test(parts.at(-1))) parts.pop();

  let city = '';
  let zip = '';
  const stateZip = String(parts.at(-1) || '').match(/^(?:TX|Texas)\s+(\d{5})(?:-\d{4})?$/i);
  if (stateZip) {
    city = String(parts.at(-2) || '').trim();
    zip = stateZip[1];
  } else if (/^\d{5}(?:-\d{4})?$/.test(String(parts.at(-1) || ''))
      && /^(?:TX|Texas)$/i.test(String(parts.at(-2) || ''))) {
    zip = String(parts.at(-1)).slice(0, 5);
    city = String(parts.at(-3) || '').trim();
  }

  const safeCity = SAFE_OFFER_CITIES.get(city.toLowerCase());
  if (!safeCity || !zip) return 'Austin-area service zone';
  return `${safeCity}, TX ${zip}`;
}

export function redactAssignmentCustomerData(bookings = []) {
  return bookings.map(booking => {
    const hasOpenReturnVisit = booking.status === BOOKING_STATUS.COMPLETED
      && booking.return_visit_required === true;
    const maySeeOperationalContact = Boolean(
      booking.assembler_accepted_at
      && (ACTIVE_BOOKING_STATUSES.includes(booking.status) || hasOpenReturnVisit)
    );
    if (!maySeeOperationalContact) {
      booking.customer_name = null;
      booking.customer_phone = null;
      booking.customer_email = null;
      booking.address = null;
      booking.details = null;
    }
    if (!ACTIVE_BOOKING_STATUSES.includes(booking.status)) booking.assignment_token = null;
    return booking;
  });
}

/**
 * GET /api/booking/my-assignments
 * Returns bookings assigned to the authenticated assembler PLUS any open
 * dispatch offers sent to this Easer that haven't been accepted yet.
 * Requires Bearer JWT auth.
 */
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  res.setHeader('Cache-Control', 'private, no-store');

  const sb = getSupabase();
  const access = await requireAssignedWorkEaser(req, { supabase: sb });
  if (!access.ok) return respondWithEaserAccessError(res, access);
  const { user, profile: easerProfile, applicationFeeRefundHold } = access;
  const agreementCurrent = hasCurrentEaserAgreement(easerProfile);
  const warnings = [];

  function pushWarning(code, message) {
    warnings.push({ code, message });
  }

  const statusFilter = req.query?.status || null;
  const ACTIVE_STATUSES  = ACTIVE_BOOKING_STATUSES;
  const VISIBLE_STATUSES = VISIBLE_ASSIGNMENT_STATUSES;

  // Membership status comes from the same required profile read used for the
  // active/approved authorization decision, avoiding a second source of truth.
  const easerIsMember = hasEffectiveEaserMembership(easerProfile);
  // Canonical fee — must match the completion payout (assembler-complete.js) so the
  // dashboard estimate never overstates what the Pro will actually receive.

  // ── 1. Bookings assigned to this Easer ──────────────────────────────────
  let query = sb
    .from('bookings')
    .select('id, ref, source, service, customer_name, customer_phone, customer_email, date, time, return_visit_required, return_visit_date, return_visit_time, return_visit_completed_scope, return_visit_remaining_scope, address, details, status, assigned_at, assembler_accepted_at, completed_at, cancelled_at, checked_in_at, en_route_at, job_started_at, assembler_due, amount_charged, platform_fee, platform_fee_pct, payment_status, refund_amount, refunded_at, payout_status, payout_mode_snapshot, payout_review_status, paid_out_at, payout_notes, stripe_transfer_status, stripe_transfer_created_at, stripe_bank_payout_status, stripe_bank_payout_paid_at, assignment_token, total_price, tax_amount, assemblecash_redeemed_cents, evidence_requested_at, cancellation_fee, cancellation_easer_due_cents, cancellation_easer_payout_status, easer_fee_snapshot_easer_id, easer_fee_pct_snapshot, easer_estimated_due_snapshot, same_day_fee_cents, same_day_easer_bonus_cents')
    .eq('assembler_id', user.id)
    .order('assigned_at', { ascending: false });

  if (statusFilter) {
    query = VISIBLE_STATUSES.includes(statusFilter)
      ? query.eq('status', statusFilter)
      : query.in('status', VISIBLE_STATUSES);
  } else {
    query = query.in('status', VISIBLE_STATUSES);
  }

  const { data: assignedBookings, error } = await query;
  if (error) {
    console.error('My assignments error:', error);
    return res.status(500).json({ error: 'Failed to load assignments' });
  }

  // ── 2. Open dispatch offers not yet accepted — bookings not yet in the list ──
  // These are jobs dispatched to this Easer but assembler_id is still null
  // (or set to someone else). Without this, Easer can't see the job unless
  // they still have the email open.
  let openOffers = [];
  if (!agreementCurrent) {
    pushWarning(
      'current_agreement_required',
      'Review and accept the current contractor agreement before viewing or receiving new job offers.',
    );
  } else if (applicationFeeRefundHold) {
    pushWarning(
      'new_offers_paused',
      'New job offers are temporarily paused. Existing assigned work remains available. Contact support if you need help.',
    );
  } else try {
    const { data, error } = await sb
      .from('dispatch_offers')
      .select('booking_id, expires_at, token, dispatch_score')
      .eq('easer_id', user.id)
      .eq('offer_status', DISPATCH_OFFER_STATUS.SENT)
      .gt('expires_at', new Date().toISOString());
    if (error) throw error;
    openOffers = data || [];
  } catch (offerError) {
    console.error('My assignments open-offers warning:', offerError);
    pushWarning('open_offers_partial_failure', 'Some dispatch offers could not be loaded right now.');
  }

  const assignedIds = new Set((assignedBookings || []).map(b => b.id));
  const unacceptedOfferBookingIds = (openOffers || [])
    .map(o => o.booking_id)
    .filter(id => !assignedIds.has(id));

  let offerBookings = [];
  if (unacceptedOfferBookingIds.length > 0) {
    try {
      const { data, error } = await sb
        .from('bookings')
        .select('id, ref, service, date, time, status, total_price, tax_amount, assemblecash_redeemed_cents, address')
        .in('id', unacceptedOfferBookingIds)
        .eq('status', BOOKING_STATUS.CONFIRMED)
        .is('assembler_id', null);
      if (error) throw error;
      offerBookings = data || [];
    } catch (bookingError) {
      console.error('My assignments offer-booking warning:', bookingError);
      pushWarning('offer_bookings_partial_failure', 'Some pending offers could not be expanded into bookings.');
    }
  }

  // Build offer map for enrichment
  const offerMap = {};
  (openOffers || []).forEach(o => { offerMap[o.booking_id] = o; });

  // Enrich offer-only bookings — mark as pending offer, hide customer PII until accepted
  offerBookings.forEach(b => {
    b._is_pending_offer = true;
    b._offer_location = deriveOfferLocation(b.address);
    delete b.address;
    b.customer_name  = null;  // hide until accepted
    b.customer_phone = null;
    b.customer_email = null;
    if (offerMap[b.id]) {
      b._offer_expires_at = offerMap[b.id].expires_at;
      b._offer_token      = offerMap[b.id].token;
      b._offer_score      = offerMap[b.id].dispatch_score;
    }
  });

  // Enrich already-assigned bookings that haven't been accepted yet (legacy path)
  (assignedBookings || []).forEach(b => {
    if (!b.assembler_accepted_at && offerMap[b.id]) {
      b._offer_location    = deriveOfferLocation(b.address);
      b._offer_expires_at = offerMap[b.id].expires_at;
      b._offer_token      = offerMap[b.id].token;
      b._offer_score      = offerMap[b.id].dispatch_score;
    }
  });

  // Can this Easer refuse the job? An owner-assigned job has NO dispatch_offers
  // row (assign.js stores its token on the booking and nulls dispatch_token), so
  // _offer_token is undefined and the app used to leave the Decline button with
  // no click handler at all — a dead control on a job the Easer could not refuse.
  // Declinable is about the JOB's state, never about whether a token happens to
  // exist; the in-app request is authenticated, which is stronger than a token.
  (assignedBookings || []).forEach(b => {
    b._can_decline = !b.assembler_accepted_at && !b.financial_operation_key;
  });

  // Customer operational contact data is available only while an accepted job
  // is active. Pending/unaccepted assignments and terminal history are always
  // server-redacted so UI mistakes cannot expose retained customer PII.
  redactAssignmentCustomerData(assignedBookings || []);

  // For completed jobs where evidence was requested, flag whether evidence has been uploaded.
  // This lets the Easer dashboard show/hide the upload prompt without a separate API call.
  const evidenceRequestedIds = (assignedBookings || [])
    .filter(b => b.evidence_requested_at)
    .map(b => b.id);

  if (evidenceRequestedIds.length) {
    try {
      const { data: evidenceRows, error: evidenceError } = await sb
        .from('booking_evidence')
        .select('booking_id, created_at')
        .in('booking_id', evidenceRequestedIds)
        .eq('evidence_type', 'completion_photo')
        .eq('uploaded_by', user.id);
      if (evidenceError) throw evidenceError;
      const bookingById = new Map((assignedBookings || []).map(booking => [booking.id, booking]));
      const uploadedSet = new Set((evidenceRows || [])
        .filter(row => {
          const booking = bookingById.get(row.booking_id);
          return booking?.job_started_at
            && new Date(row.created_at).getTime() >= new Date(booking.job_started_at).getTime();
        })
        .map(row => row.booking_id));
      (assignedBookings || []).forEach(b => {
        if (b.evidence_requested_at) b._evidence_uploaded = uploadedSet.has(b.id);
      });
    } catch (evErr) {
      console.warn('my-assignments evidence check skipped:', evErr?.message || evErr);
    }
  }

  // ── 3. Merge and add pay estimates ──────────────────────────────────────
  const allBookings = [...offerBookings, ...(assignedBookings || [])];
  allBookings.forEach(booking => {
    booking._return_visit_open = booking.status === BOOKING_STATUS.COMPLETED
      && booking.return_visit_required === true;
    booking._can_self_drop = !isOwnerManualLiveFlow(booking, easerProfile);
    const appointmentDate = booking.return_visit_required ? booking.return_visit_date : booking.date;
    const appointmentTime = booking.return_visit_required ? booking.return_visit_time : booking.time;
    booking._stage_availability = Object.fromEntries(EASER_JOB_STAGES.map(stage => {
      const gate = evaluateEaserAppointmentGate({
        date: appointmentDate,
        time: appointmentTime,
        stage,
      });
      return [stage, {
        allowed: gate.allowed === true,
        code: gate.code || null,
        earliestAt: gate.earliestAt || null,
        earlyWindowMinutes: Number(gate.earlyWindowMinutes || 0),
      }];
    }));
    delete booking.source;
  });

  const bookingIds = allBookings.map(b => b.id).filter(Boolean);
  if (bookingIds.length) {
    try {
      // Same loader the owner uses, so the two roles can never see different
      // scope. No pricing: the Easer must not see customer money (Rule 3).
      const itemsByBooking = await loadBookingItems(bookingIds, { sb });
      allBookings.forEach(booking => {
        booking._booking_items = itemsByBooking.get(booking.id) || [];
      });
    } catch (bookingItemsLookupError) {
      console.error('My assignments booking-items warning:', bookingItemsLookupError);
      pushWarning('booking_scope_partial_failure', 'The exact item scope could not be loaded for some jobs.');
      allBookings.forEach(booking => {
        if (!Array.isArray(booking._booking_items)) booking._booking_items = [];
      });
    }
  }

  allBookings.forEach(b => {
    if (b.status === BOOKING_STATUS.COMPLETED && !b._return_visit_open) return;
    if (b._return_visit_open && Number(b.assembler_due || 0) > 0) {
      b._pay_estimate_lo = Number(b.assembler_due);
      b._pay_estimate_hi = Number(b.assembler_due);
      return;
    }
    const price = Number(b.amount_charged || b.total_price) || 0;
    if (price > 0) {
      // Same-day fee is additive — exclude it from the 30/70 base and add the
      // fixed rush bonus, exactly like completion, so the ESTIMATE matches PAYOUT.
      const sdFee = Math.max(0, Number(b.same_day_fee_cents || 0));
      const sdBonus = Math.min(sdFee, Math.max(0, Number(b.same_day_easer_bonus_cents || 0)));
      const sdTax = Math.round(sdFee * SALES_TAX_RATE);
      const rawCharged = b.amount_charged != null ? Number(b.amount_charged) : Number(b.total_price || 0);
      // Canonical split (tax excluded) — must match the completion payout exactly.
      const split = computeBookingSplitFromSnapshot({
        amountChargedCents: rawCharged - (sdFee + sdTax),
        taxCents: (b.tax_amount || 0) - sdTax,
        isMember: easerIsMember,
        feePct: b.easer_fee_snapshot_easer_id === user.id
          ? b.easer_fee_pct_snapshot
          : null,
        assemblecashRedeemedCents: b.assemblecash_redeemed_cents || 0,
      });
      const estimateDue = split.assemblerDueCents + sdBonus;
      b._pay_estimate_lo = estimateDue;
      b._pay_estimate_hi = estimateDue;
      if (sdBonus > 0) b._same_day_bonus_cents = sdBonus;
    } else if (b.total_price === 0 || b.total_price === null) {
      b._custom_quote = true; // signal to UI: price TBD
    }
  });

  // The Easer response carries only the user's earnings and job-operation truth.
  // Raw customer-payment, refund, review, fee, and Stripe-transfer fields remain
  // available to owner and financial workflows but never cross this boundary.
  allBookings.forEach(booking => {
    INTERNAL_FINANCIAL_FIELDS.forEach(field => { delete booking[field]; });
  });

  const response = {
    bookings: allBookings,
    access: {
      agreementCurrent,
      newOffersAllowed: agreementCurrent && !applicationFeeRefundHold,
    },
  };
  if (warnings.length > 0) {
    response.meta = {
      partial: true,
      warnings,
    };
  }

  return res.status(200).json(response);
}
