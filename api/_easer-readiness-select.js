// Projection for callers that cannot load the complete profile. Keep this in
// parity with getEaserReadiness and its fee/closure helpers (guarded by tests).
// This defines data dependencies only; _easer-readiness.js owns every rule.
export const EASER_READINESS_FIELDS = Object.freeze([
  'tier', 'status', 'application_status', 'is_available', 'phone',
  'identity_verified', 'contractor_agreement_signed_at', 'contractor_agreement_version',
  'code_of_conduct_agreed_at', 'sms_consent_at', 'sms_opted_out_at',
  'application_fee_paid', 'payment_confirmed', 'application_fee_waived', 'fee_waived_by_owner',
  'application_decision_key', 'application_fee_refunded', 'application_fee_refunded_cents',
  'application_fee_refund_pending_cents', 'application_fee_refund_review_required_at',
  'account_closure_status', 'stripe_connect_account_id',
]);
