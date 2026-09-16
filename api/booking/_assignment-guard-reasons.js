// ─── Assignment guard reasons ────────────────────────────────────────────────
//
// The database trigger guard_booking_easer_closure_assignment refuses an
// assignment for ten different reasons and raises each with ERRCODE 23514.
// assign.js caught that code and reported ONE sentence for all of them:
//
//   "The booking or Easer readiness changed before assignment."
//
// An owner assigning a healthy pro to an advance booking was told the PRO's
// readiness had changed, when the actual reason — sitting in the error the
// server already had — was that the customer's scheduled card hold was not
// taken yet. The message named the wrong party and the wrong problem.
//
// Article 16: never invent a cause; show the server's reason, or say the reason
// is unknown. Also: never show a raw parser or driver error to the owner. So
// this translates only messages this repo RAISEs itself, and anything else
// falls through to an honest "reason unknown".
//
// Every entry here is a RAISE EXCEPTION string from api/migrations/. If a
// migration adds another, add it here too or the owner gets the generic text.

const GUARD_REASONS = Object.freeze([
  {
    match: 'Customer payment must be verified before assignment or acceptance',
    code: 'CUSTOMER_PAYMENT_NOT_VERIFIED',
    owner: "The customer's payment is not in an assignable state yet. This is the customer's payment, not the Easer's payout setup.",
  },
  {
    match: 'Customer payment must be authorized before work begins',
    code: 'PAYMENT_NOT_AUTHORIZED_FOR_WORK',
    owner: "The customer's card hold has not been taken yet, so this job cannot start. The Easer can stay assigned; the hold runs a few days before the appointment.",
  },
  {
    match: 'Saved-card assignment requires its saved Stripe payment method',
    code: 'SAVED_CARD_MISSING',
    owner: 'This booking is marked card saved but has no saved payment method, so there is nothing to authorize before the visit. Reconcile it against Stripe first.',
  },
  {
    match: 'Authorized assignment requires its linked Stripe PaymentIntent',
    code: 'PAYMENT_INTENT_MISSING',
    owner: 'This booking is marked authorized but carries no Stripe PaymentIntent. Reconcile it against Stripe before assigning.',
  },
  {
    match: 'Deposit assignment requires a valid paid deposit and linked Stripe PaymentIntent',
    code: 'DEPOSIT_INVALID',
    owner: 'This booking is marked deposit paid, but the deposit or its Stripe intent is missing or invalid. Reconcile it against Stripe before assigning.',
  },
  {
    match: 'A zero-dollar booking cannot be assigned outside an explicit simulation',
    code: 'BOOKING_TOTAL_ZERO',
    owner: 'This booking has a $0 total. Price it before assigning an Easer.',
  },
  {
    match: 'A negative-price booking cannot be assigned',
    code: 'BOOKING_TOTAL_NEGATIVE',
    owner: 'This booking has a negative total and cannot be assigned. Correct the price first.',
  },
  {
    match: 'Assigned Easer is not ready and eligible for jobs',
    code: 'EASER_NOT_READY',
    owner: 'That Easer is not currently ready for jobs. Open their profile to see which requirement is outstanding.',
  },
  {
    match: 'A closure-held Easer cannot receive or retain a live assignment',
    code: 'EASER_CLOSURE_HELD',
    owner: 'That Easer has an account closure in progress and cannot take live work. Assign someone else, or resolve the closure first.',
  },
  {
    match: 'Assigned Easer profile not found',
    code: 'EASER_PROFILE_MISSING',
    owner: 'That Easer account could not be found. Refresh the roster and try again.',
  },
]);

/**
 * Translate a database guard failure into something the owner can act on.
 * @returns {{code:string, message:string, matched:boolean}}
 */
export function describeAssignmentGuardFailure(dbError) {
  const raw = String(dbError?.message || '');
  for (const reason of GUARD_REASONS) {
    if (raw.includes(reason.match)) {
      return { code: reason.code, message: reason.owner, matched: true };
    }
  }
  // A genuine race — the row changed under the write — rather than a guard.
  if (dbError?.code === '40001') {
    return {
      code: 'BOOKING_CHANGED_DURING_ASSIGNMENT',
      message: 'This booking changed while the assignment was being saved. Refresh and try again.',
      matched: true,
    };
  }
  // Say so, rather than inventing a cause (Article 16).
  return {
    code: 'EASER_ASSIGNMENT_BLOCKED',
    message: 'The assignment was refused and the reason was not recognised. Refresh and try again; if it keeps happening, check the booking timeline.',
    matched: false,
  };
}
