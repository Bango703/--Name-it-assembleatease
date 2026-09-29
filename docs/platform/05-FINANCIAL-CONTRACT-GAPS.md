# Financial Contract Gaps

Status: Phase 4 review, no runtime changes
As of: 2026-09-24

## Confirmed Financial Rules

- `computeBookingSplitFromSnapshot` is the canonical split calculation.
- Tax is excluded from the Easer payout base.
- Platform-funded AssembleCash redemption is added back to payout basis.
- Completion blocks positive-price jobs without authorized/deposit/captured payment.
- Automatic payout requires Connect mode, pending payout, captured payment, no reconciliation hold, no unresolved dispute/damage review, and the payout hold window.
- Easer earnings are snapshotted from assignment/completion data.

## Contract Gaps Requiring Tests Before Refactor

### Completion transition asymmetry

- Owner completion permits any active booking status through `api/booking/complete.js`.
- Easer completion reserves only `in_progress` through `api/booking/assembler-complete.js`.
- This asymmetry is intentional: owner completion is an override/recovery path when an Easer has execution or evidence issues.
- The override must remain explicit, permissioned, audited, evidence-backed, and payment-gated; it must not become a general bypass.
- Required contract test: owner override can complete a valid active booking with acceptable supplied evidence, while Easer completion remains assignment-scoped and stricter.

### Payment truth and payout truth

The following remain separate and must stay separate:

```text
payment captured
Easer earning created
payout eligible
Stripe transfer created
bank payout completed
```

### Connect configuration

The payout release cron fails closed when Connect is disabled or Stripe is unavailable. Production flag values remain masked and must be verified through an approved operational check before changing payout assumptions.

### Required Phase 4 contract tests

- split arithmetic with tax and AssembleCash
- completion with authorized payment
- completion blocked after authorization expiry
- capture timeout/unknown result reconciliation
- duplicate completion idempotency
- payout blocked by evidence/dispute/reconciliation hold
- payout transfer idempotency
- Connect account capability failure
- owner versus Easer completion status parity
