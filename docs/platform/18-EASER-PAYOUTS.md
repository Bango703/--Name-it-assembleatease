# Easer Earnings and Payouts

Status: target contract
As of: 2026-09-24

```text
completion verified
  -> earning created
  -> earned
  -> payable
  -> payout queued
  -> processing
  -> paid
```

Blocking states:

```text
payout hold
provider failure
Connect not payout-ready
dispute
damage review
evidence review
reconciliation mismatch
```

Rules:

- Earnings freeze from verified completion and assignment snapshots.
- Easer must have a payout-enabled Stripe Connect account before payout release.
- Captured customer payment is not the same as Easer payout.
- Stripe transfer is not the same as bank payout.
- Payout retries require idempotency and provider reconciliation.
- Manual adjustments require permission, reason, before/after values, and audit.
