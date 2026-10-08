# Dispatch Review

Status: Phase 8 review, no runtime changes
As of: 2026-09-24

## Current Ownership

- Dispatch orchestration: `api/booking/_dispatch-internal.js`.
- Eligibility and safety: `api/booking/_dispatch-safety.js` and readiness helpers.
- Owner assignment: `api/booking/assign.js` and `api/owner/dispatch-all.js`.
- Easer offer acceptance/decline: booking accept/decline routes.
- Automatic dispatch: `api/cron/auto-dispatch.js`.
- Offer expiry: `api/cron/expire-offers.js`.
- Database concurrency: dispatch RPCs and guarded assignment updates.

## Confirmed Invariants

- Automatic dispatch requires payment readiness stronger than owner manual advance-booking assignment.
- Easer readiness, market, skills, availability, crew, and suspension rules are checked before offers.
- Offer acceptance uses atomic database protection so two Easers cannot both win the same booking.
- Assignment history and reassignment are preserved through booking/activity/offer records.
- Expired offers do not become accepted assignments.
- Owner assignment and automatic dispatch are intentionally separate commands.

## Remaining Contract Gaps

- `bookings.dispatch_status` and `dispatch_offers.offer_status` need a formal cross-axis registry and projection rules.
- The same assignment-version/idempotency contract should be proven across owner assignment, Easer acceptance, reassignment, and auto-dispatch.
- No complete three-role dispatch E2E scenario exists in the repository.
- Owner manual assignment with a saved card must remain isolated from automatic dispatch payment rules.

## Smallest Next Test

A dispatch race contract test should run two acceptance attempts against one offer/booking and prove:

- exactly one assignment succeeds;
- the losing attempt receives a truthful no-longer-available result;
- assignment history contains one active assignment;
- only one assignment notification set is emitted;
- payment/readiness state is unchanged by the losing attempt.
