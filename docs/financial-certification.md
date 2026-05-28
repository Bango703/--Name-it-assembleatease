# Financial Certification Semantics

## Scope

This document defines the production certification rules for payout and capture reconciliation.

## Payout Ledger Semantics

- `payout_ledger` records actual Easer payout events only.
- `payout_ledger` is not a full capture ledger for all completed/captured bookings.
- A completed/captured booking with `payout_status = pending` does not require a `payout_ledger` row.
- A `payout_ledger` row is required when `payout_status = paid`.

## Payout Subset Certification Rules

The payout certification checks are evaluated on the paid subset:

1. Every booking with `payout_status = paid` has exactly one `payout_ledger` row.
2. No duplicate `payout_ledger` rows exist for the same `booking_id`.
3. For paid bookings, booking payout values match the `payout_ledger` evidence:
   - `bookings.payout_amount == payout_ledger.payout_amount`
   - `bookings.platform_revenue == payout_ledger.platform_revenue`
   - `bookings.amount_charged == payout_ledger.amount_charged`

## Non-Requirements (By Design)

- Completed/captured bookings that are not yet paid are valid without `payout_ledger` rows.
- Missing `payout_ledger` rows for pending payouts are not reconciliation failures.

## Reporting Model

- Owner payouts, revenue, and monitor endpoints use a ledger-first model with booking fallback.
- Ledger evidence is authoritative for paid rows.
- Booking-derived values are used for pending rows until payout is recorded.

## Related Files

- `api/migrations/010_payout_ledger.sql`
- `api/booking/payout.js`
- `api/owner/_finance-ledger.js`
- `api/owner/payouts.js`
- `api/owner/revenue.js`
- `api/owner/monitor.js`