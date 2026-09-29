# Booking Lifecycle

Status: target contract
As of: 2026-09-24

```text
DRAFT
 -> QUOTE_READY
 -> PAYMENT_READY
 -> CONFIRMED
 -> ACTIVE
 -> COMPLETED
 -> CLOSED
```

Branches:

```text
DRAFT -> ABANDONED
CONFIRMED -> CANCELLED
ACTIVE -> INTERRUPTED
ACTIVE -> CANCELLED_EXCEPTION
COMPLETED -> REWORK
COMPLETED -> DISPUTED
```

Separate machines:

- booking lifecycle
- dispatch lifecycle
- execution lifecycle
- payment lifecycle
- evidence/review lifecycle
- earnings lifecycle
- payout lifecycle

Booking status does not become `refunded` for a normal Stripe refund today. Refund outcome belongs to payment/refund state; `declined` is a reachable terminal booking status. The state registry is the source for the current implementation until a dedicated booking-closure policy is introduced.

No controller may infer one machine's state from another machine's status alone.
