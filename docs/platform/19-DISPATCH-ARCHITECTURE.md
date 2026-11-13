# Dispatch Architecture

Status: target contract mapped to current dispatch implementation
As of: 2026-11-13 (eligibility section re-verified against code)

```text
confirmed booking
 -> dispatch request
 -> eligibility filter
 -> candidate ranking
 -> offer
 -> accepted
 -> assignment
```

Eligibility, as implemented (checked 2026-11-13 in `findEligibleEasers`, `api/booking/_dispatch-internal.js`):

- active account, identity verified, tier, not closing (profile query)
- terms and readiness, including availability (`getEaserReadiness`)
- market match (`isSameServiceMarket`; fails open when either ZIP has no market)
- service and hours match from work preferences (`easerTakesBooking`; fails open when none are set)
- demo accounts only on test bookings
- daily job cap and no repeat offer to the same Easer (in `dispatchBooking`)
- payment readiness (`isBookingPaymentReadyForStaffing`)
- preferred Easers first when the booking has them (`selectOfferRecipients`)

Target, not yet implemented (see `docs/business-rules/dispatch-contract-v1.md`): distance or travel limits, crew and equipment requirements, time-overlap with confirmed jobs, reason codes for out-of-area, no supply and offers exhausted.

Geography: the job's ZIP comes from `bookingLocation(booking)` (stored `service_zip` first, then the address text). The four area rules that exist today are listed in `14-DUPLICATE-PATH-REGISTER.md` and `docs/decisions/2026-11-13-dispatch-contract-audit.md`.

Rules:

- Offers expire and are never silently accepted after expiry.
- Acceptance uses atomic compare-and-set.
- Assignment history is append-only.
- Reassignment creates a new assignment version.
- No eligible Easer creates an owner alert and recovery path.
- Automatic dispatch and owner manual assignment have separate payment rules.
