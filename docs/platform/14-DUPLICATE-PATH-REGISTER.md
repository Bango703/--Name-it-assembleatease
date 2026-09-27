# Duplicate Path and Equivalence Register

Status: Phase 3 inventory
As of: 2026-09-24

No path is removed until the replacement has equivalent tests and production-safe rollback.

## Refunds

- Primary booking refund: `api/booking/refund.js` + `_stripe-refund-truth.js`.
- Owner/manual payment refund: `api/owner/refund-manual-payment.js` + `_manual-stripe-refund.js` + `_manual-payment-truth.js`.
- Required equivalence: amount validation, livemode validation, refund pagination, remaining refundable amount, idempotency, audit, and reconciliation.

## Payment Recovery and Reauthorization

- Shared classifier: `api/booking/_pending-payment-recovery.js`.
- Customer secure recovery: `api/booking/payment-recovery.js`.
- Owner email initiator: `api/owner/send-payment-continuation.js`.
- Scheduled authorization: `api/cron/authorize-scheduled-payments.js`.
- Active/advance reauthorization: `api/cron/reauth-payments.js`.
- Owner retry: `api/owner/retry-authorization.js`.
- Owner repair: `api/owner/reconcile-payment-authorization.js`.
- Required equivalence: PaymentIntent validation, replacement intent metadata, active-job status preservation, idempotency, lock ownership, provider uncertainty, and customer-safe copy.

## Evidence Uploads

- Easer upload: `api/booking/upload-evidence.js`.
- Owner historical upload: `api/owner/upload-completion-evidence.js`.
- Owner on-behalf upload: `api/owner/supply-easer-evidence.js`.
- Shared truth: `booking_evidence` with uploader and `uploaded_on_behalf_of`.
- Required equivalence: MIME/magic-byte/size validation, private storage, cleanup on record failure, identity labeling, signed URL expiry, and audit.

## Payouts

- Automatic Connect release: `api/cron/release-payouts.js`.
- Owner manual record: `api/booking/payout.js`.
- Easer instant payout: `api/assembler/instant-payout.js`.
- Required equivalence: earning snapshot, payout hold, dispute/evidence holds, Connect readiness, transfer idempotency, bank-payout distinction, and audit.

## Dispatch

- Canonical internal dispatch: `api/booking/_dispatch-internal.js`.
- Safety/eligibility helpers: `api/booking/_dispatch-safety.js` and database RPCs.
- Owner entry: `api/owner/dispatch-all.js`.
- Cron entry: `api/cron/auto-dispatch.js`.
- Status: currently centralized by delegation; protect this boundary.

## Consolidation Rule

A duplicate path may be removed only after:

1. Both paths have equivalent scenario tests.
2. Provider and database writes are compared.
3. Audit and notification effects are compared.
4. Failure and retry behavior are compared.
5. The replacement is deployed and observed.
6. A rollback path exists.
