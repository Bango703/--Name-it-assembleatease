# Payment Architecture

Status: target contract mapped to current Stripe implementation
As of: 2026-09-24

## Lifecycle

```text
payment_method_required -> ready -> authorized -> auth_expiring -> reauth_required -> capture_pending -> paid
                                                      \-> failed
paid -> refund_pending -> partial_refund/refunded
paid -> disputed
```

## Rules

- One authoritative PaymentIntent per booking/payment revision.
- Every Stripe write has an idempotency key.
- `requires_capture` is required before capture.
- Track `capture_before` explicitly.
- Authorization expiry triggers reauthorization before labor is completed.
- Unknown provider results require reconciliation, never a duplicate charge.
- Payment provider truth, ledger truth, earnings truth, and payout truth remain separate.
- Positive-price completion is blocked without valid payment readiness.
