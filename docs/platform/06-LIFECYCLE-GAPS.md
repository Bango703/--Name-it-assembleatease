# Lifecycle Contract Gaps

Status: Phase 5 review, no runtime changes beyond tests/docs
As of: 2026-09-24

## Resolved Registry Drift

- `declined` is a reachable terminal booking status.
- `refunded` is currently a payment/refund outcome, not a reachable `bookings.status` transition.
- `deposit_paid` and `offline_recorded` are payment states.
- `bookings.dispatch_status` and `dispatch_offers.offer_status` are separate axes.
- `payout_review_status` is a separate payout hold/review axis.
- Evidence currently uses records and review fields; a persisted evidence state machine is a target.

## Intentional Overrides

- Owner completion may use supplied-on-behalf-of evidence and serves as a recovery path when an Easer cannot complete the workflow.
- Owner reassignment can reset active execution to a fresh assignment under explicit owner controls.
- Owner assignment may staff a future booking with a saved card while automatic dispatch requires stronger payment readiness.

## Remaining Review Items

- Owner completion accepts active statuses broadly while Easer completion reserves `in_progress`; preserve this as an explicit override contract.
- Refund and payout routes perform money-adjacent mutations without all transitions passing through the booking workflow engine; validate their own financial locks and audit contracts.
- `pipeline_stage` duplicates booking status in some execution paths; determine whether it is a projection or remove it only after equivalence proof.
- No full three-role lifecycle E2E test exists yet.

## Regression Proof

- `scripts/test-booking-state-reachability.mjs` verifies the current booking graph and terminal states.
