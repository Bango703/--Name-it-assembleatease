# Notification Policy Engine

Status: target contract mapped to current policy helpers
As of: 2026-09-24

A notification is derived from a domain event, audience, policy, template, channel, and delivery contract.

```text
event
 -> audience policy
 -> consent and preference check
 -> template version
 -> dedupe key
 -> outbox/delivery intent
 -> provider
 -> delivery callback
 -> reconciliation
```

Policy decision fields:

```text
event_type
audience
allowed_channels
blocked_channels
consent_required
template_key
template_version
dedupe_key
priority
fallback
owner_alert_rule
```

Rules:

- Transactional booking, operational Easer, support, owner-system, and marketing messages are separate categories.
- SMS requires valid phone, recorded consent where required, and no opt-out.
- Provider acceptance is not delivery; delivery callbacks update delivery truth.
- Duplicate events do not create duplicate sends.
- Customer templates contain only customer-safe copy.
- Notification failure never silently changes booking or payment truth.

## Current Orchestration Review

Centralized and protected today:

- SMS consent and opt-out in `_sms.js`.
- Notification reservation and delivery settlement in `_notification-policy.js` and migration 096.
- Email and SMS provider delivery truth through signed webhooks.
- Retry eligibility and send-volume governance through dedicated helpers.

Remaining taxonomy drift:

- Notification type classification is maintained in JavaScript policy sets, email priority sets, migration 096 SQL compatibility logic, and this registry.
- Many real notification types are not yet listed in the catalog.
- Template identity/version fields are declared by the target model but are not consistently persisted by current callers.

First safe improvement: add taxonomy-parity tests before changing send behavior or extracting templates.
