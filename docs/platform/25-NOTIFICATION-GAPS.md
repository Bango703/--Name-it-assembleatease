# Notification Orchestration Gaps

Status: Phase 7 review, no runtime changes
As of: 2026-09-24

## Centralized Enforcement

- SMS consent and opt-out: `api/_sms.js`.
- Reservation/dedupe/claim/settlement: `api/_notification-policy.js` and migration 096.
- Email transport shell and provider acceptance: `api/_email.js`.
- SMS transport and provider acceptance: `api/_sms.js`.
- Push transport: `api/_push.js`.
- Retry eligibility: `api/_notification-retry-eligibility.js` and `api/cron/notification-retries.js`.
- Send governor: `api/_send-governor.js`.
- Provider delivery truth: signed Resend and Telnyx webhooks.

## Remaining Drift

1. Notification type taxonomy is maintained in JavaScript policy sets, email priority sets, SQL migration 096 compatibility logic, and documentation.
2. The notification registry lists fewer types than current callers emit.
3. Template keys and versions are target concepts but are not consistently stored by callers.
4. Arrival nudge leases and notification reservation claims are separate mechanisms with different scopes; keep them separate unless a replacement proves equivalent.

## Smallest Safe Contract

Before template extraction or controller changes, add a pure taxonomy parity check that compares:

- notification types used by callers
- JavaScript routine/priority classification
- SQL compatibility classification
- registry entries

The test must fail on unregistered types or classification disagreement. It must not send live notifications.
