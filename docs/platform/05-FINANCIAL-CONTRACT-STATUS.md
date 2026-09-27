# Financial Contract Status

Status: Phase 4 verification checkpoint
As of: 2026-09-24

## Passing Contract Areas

- Canonical split arithmetic and same-day owner/Easer parity.
- Easer payout truth and owner payout synchronization.
- Stripe Connect `payout.paid` linkage.
- Instant payout request shape and Stripe eligibility alignment.
- Aggregate refund truth across payment topology.
- Refund pagination and pending-refund capacity.
- Refund idempotency, lock rotation, and webhook ordering.
- Completion evidence privacy and owner/Easer role behavior.
- Financial operation locks and reauthorization safety.

## Remaining Financial Contract Work

- Add a full provider-unknown capture scenario with persisted reconciliation proof.
- Classify capture failures as technical unknown, customer action required, or provider declined so owner recovery matches Stripe truth.
- Add explicit payout transfer retry/idempotency scenario coverage.
- Verify production Connect mode and migration rollout through approved operational checks.
- Add owner rejection audit coverage for financial operations.
- Keep duplicate refund/manual-refund paths under equivalence testing before consolidation.

## Capture Failure Contract

```text
technical_unknown
	-> preserve financial lock
	-> reconcile Stripe before retry

customer_action_required
	-> send plain payment recovery message
	-> keep completion and payout blocked

provider_declined
	-> do not blindly retry
	-> request a new payment method or owner decision
```

The current completion path is fail-closed for all three outcomes. Classification and owner-facing action selection remain the next narrow improvement.

No broad financial refactor is justified while these existing protections pass. The next changes should be isolated contract additions or narrowly scoped policy fixes.
