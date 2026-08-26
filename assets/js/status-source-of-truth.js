/**
 * Browser mirror of api/_source-of-truth.js status enums.
 *
 * There is no bundler here, so front-end pages cannot import the server module.
 * Before this file existed they each restated the status strings by hand —
 * owner/index.html and track.html carried all 9 booking statuses, assembler
 * pages carried subsets — with nothing tying any of them to the server. A status
 * renamed or added on the server would silently leave four pages behind.
 *
 * This is the ONE place a front-end page gets a status string, and
 * scripts/audit-source-of-truth.mjs fails the build if these lists stop matching
 * api/_source-of-truth.js. Keep them byte-identical to the server enums.
 */
window.AAE_STATUS = {
  // Booking lifecycle — mirrors BOOKING_STATUS.
  BOOKING: {
    PENDING:     'pending',
    CONFIRMED:   'confirmed',
    EN_ROUTE:    'en_route',
    ARRIVED:     'arrived',
    IN_PROGRESS: 'in_progress',
    COMPLETED:   'completed',
    CANCELLED:   'cancelled',
    DECLINED:    'declined',
    REFUNDED:    'refunded',
  },

  // Work is underway; the customer has a pro committed to them.
  ACTIVE_BOOKING: ['confirmed', 'en_route', 'arrived', 'in_progress'],

  // Nothing further happens to a booking in one of these.
  TERMINAL_BOOKING: ['completed', 'cancelled', 'declined', 'refunded'],

  // Dispatch offer lifecycle — mirrors DISPATCH_OFFER_STATUS.
  DISPATCH_OFFER: {
    SENT:       'sent',
    ACCEPTED:   'accepted',
    DECLINED:   'declined',
    EXPIRED:    'expired',
    CANCELLED:  'cancelled',
    SUPERSEDED: 'superseded',
  },

  // Easer account status (profiles.status).
  EASER_ACCOUNT: {
    PENDING:     'pending',
    ACTIVE:      'active',
    SUSPENDED:   'suspended',
    DEACTIVATED: 'deactivated',
    REJECTED:    'rejected',
  },

  // Easer application status (profiles.application_status). 'waitlist' is a
  // legacy value preserved by migration 069 and written by nothing today.
  EASER_APPLICATION: {
    PAYMENT_PENDING: 'payment_pending',
    APPLIED:         'applied',
    APPROVED:        'approved',
    REJECTED:        'rejected',
  },

  // Easer tiers eligible to receive work.
  ACTIVE_EASER_TIERS: ['starter', 'professional', 'elite'],
};

// Convenience: every legal booking status, for validation.
window.AAE_STATUS.ALL_BOOKING = Object.keys(window.AAE_STATUS.BOOKING)
  .map(function (k) { return window.AAE_STATUS.BOOKING[k]; });

/**
 * Money RATES the front end is allowed to display. Mirrors api/_source-of-truth.js.
 *
 * These are DISPLAY ONLY — the server calculates every real amount. But stating a
 * rate in fixed copy ("Sales tax (8.25%)") means a rate change silently leaves the
 * page lying to the customer, so the number is read from here and the audit fails
 * if it stops matching the server.
 */
window.AAE_RATES = {
  SALES_TAX_RATE: 0.0825,
  PLATFORM_FEE_PCT: { MEMBER: 25, NON_MEMBER: 30 },
};

// "8.25" — for inline copy like "Sales tax (8.25%)".
window.AAE_RATES.salesTaxPctLabel = function () {
  return String(+(window.AAE_RATES.SALES_TAX_RATE * 100).toFixed(4));
};
