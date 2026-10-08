# Source of Truth Registry

Status: inventory and target contract, documentation-only
As of: 2026-09-24

## Rules

- Provider status is not automatically platform accounting truth.
- UI state is never authoritative.
- Cached projections must be reconciled against their source.
- Historical financial and quote values are immutable snapshots.
- Corrections use reversal plus replacement entries, not silent mutation.

## Current Authority Map

| Concern | Authoritative source | Projection/readers |
|---|---|---|
| Actor identity | Supabase Auth plus profile identity record | App sessions and owner/Easer/customer views |
| Customer ownership | Auth identity, verified guest token, booking ownership rules | Customer booking and message routes |
| Booking commercial state | Booking row plus guarded transition/RPC behavior | Owner, customer, Easer views |
| Assignment history | Assignment fields, dispatch offers, activity history | Dispatch and job views |
| Pricing | Stored booking quote/snapshot and source-of-truth pricing helpers | Booking, finance, Easer earnings |
| Payment provider state | Stripe PaymentIntent/Charge/Refund/Dispute | Booking payment status and reconciliation records |
| Ledger/accounting | Financial audit and ledger domain records | Finance dashboards and reports |
| Easer earning | Frozen completion/assignment earning snapshot | Easer earnings and payout calculations |
| Payout transfer | Stripe Connect transfer plus payout records | Easer and owner payout views |
| Evidence | `booking_evidence` plus storage object metadata | Owner review and customer-approved photo surfaces |
| Message content | Message records | Email/SMS/push notifications |
| Notification delivery | Notification logs, delivery events, provider callbacks | Owner notification and delivery views |
| Audit history | Activity logs, operational events, financial audit | Timeline and system health views |

## Known Migration Direction

The current system still stores several projections on bookings for compatibility. New work must not introduce another competing source. Before moving data into dedicated domains, prove equivalence with read-only comparisons and contract tests.

## Required Future Commands

- `canAssignBooking`
- `canAcceptOffer`
- `canStartExecution`
- `canSubmitCompletion`
- `canVerifyCompletion`
- `canCapturePayment`
- `canCreateEarning`
- `canReleasePayout`
- `canExposeContact`
- `canSendNotification`

## Duplicate or Conflicting Paths Requiring Equivalence Tests

### Refunds

- Booking refund path: `api/booking/refund.js` and `_stripe-refund-truth.js`.
- Owner/manual payment path: `api/owner/refund-manual-payment.js`, `_manual-stripe-refund.js`, and `_manual-payment-truth.js`.

These lanes represent different payment sources, but shared Stripe validation rules must not drift.

### Payment recovery

- Shared classification: `api/booking/_pending-payment-recovery.js`.
- Customer recovery: `api/booking/payment-recovery.js`.
- Owner continuation link: `api/owner/send-payment-continuation.js`.
- Scheduled authorization: `api/cron/authorize-scheduled-payments.js`.
- Active/advance reauthorization: `api/cron/reauth-payments.js`.
- Owner retry: `api/owner/retry-authorization.js`.
- Owner reconciliation: `api/owner/reconcile-payment-authorization.js`.

Owner reconciliation is a separate direct booking-state repair path and requires equivalence tests against scheduled authorization behavior.

### Evidence

Evidence validation is duplicated across booking upload, owner historical upload, and owner on-behalf upload. The storage and identity model is shared conceptually, but the validation implementation should eventually be extracted behind one adapter after tests prove equivalence.

### Payouts

Automatic Connect release, owner manual payout, and Easer instant payout are distinct money movements. Guards currently prevent overlap; future work must preserve the distinction between earnings, Stripe transfers, bank payouts, and manual records.
