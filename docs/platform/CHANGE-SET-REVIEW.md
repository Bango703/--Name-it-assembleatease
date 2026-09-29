# Current Change-Set Review

Status: review-only manifest
As of: 2026-09-24

## Group A: Payment, Finance, and Completion

```text
api/_source-of-truth.js
api/booking-confirmed.js
api/booking/_pending-payment-recovery.js
api/booking/assembler-complete.js
api/booking/complete.js
api/booking/payment-recovery.js
api/cron/reauth-payments.js
api/owner/refund-manual-payment.js
api/owner/send-payment-continuation.js
scripts/test-same-day-split-parity.mjs
```

Risk: high. These changes affect authorization recovery, capture readiness, split calculation, and refund audit state. Must remain a single reviewed financial change set.

## Group B: Evidence and Identity Display

```text
api/booking/evidence.js
owner/index.html
```

Risk: medium. Changes uploader/on-behalf-of display only; database evidence identity was already correct.

## Group C: Call Routing

```text
api/webhooks/telnyx-call-control.js
```

Risk: high. Adds booking-aware inbound routing and must have live synthetic call proof before being treated as production-ready.

## Group D: Architecture Documentation and Contract Tests

```text
docs/platform/**
scripts/test-booking-state-reachability.mjs
scripts/test-notification-taxonomy-parity.mjs
```

Risk: low runtime risk. Documentation and no-network tests only, except documentation must not be treated as proof of production rollout.

## Group E: Generated/content changes

```text
fitness-equipment-assembly-*-tx.html
scripts/build-flagship-service-pages.mjs
sitemap.xml
images/real-fitness-rogue-rack-angle.jpg
output/
```

Risk: separate from platform hardening. Do not bundle with payment, evidence, or call changes.

## Release Rule

Do not commit or deploy all groups together. Review, test, and release groups independently. Preserve the current production deployment as rollback reference until each group is approved.
