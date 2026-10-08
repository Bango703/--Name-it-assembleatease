# Event and Outbox Boundary Review

Status: Phase 6 review, documentation-only
As of: 2026-09-24

## Current State

AssembleAtEase currently has several durable event/log mechanisms:

- `activity_logs`: booking and owner-visible timeline history.
- `financial_event_audit`: financial operation audit and provider reconciliation.
- `operational_events`: system/route/provider operational failures and call events.
- `notification_log`: notification intent/send status.
- `email_provider_events`: email delivery provider events.
- `cron_log`: scheduled worker outcomes.
- `notification_leases`: notification retry/lease coordination.
- Stripe webhook event claiming/finalization: provider dedupe and financial event handling.

## Confirmed Gap

There is no verified general transactional outbox/inbox model covering all domain events and downstream work. Notification leases and provider event claims solve narrower problems; they are not a replacement for an outbox.

## Safety Rule

Do not introduce a general outbox by wrapping existing writes ad hoc. First define:

```text
same database transaction:
  domain mutation
  domain event
  outbox record
```

Then prove the worker can:

- claim work safely
- retry safely
- deduplicate delivery
- record provider uncertainty
- dead-letter after bounded retries
- preserve owner-visible failure state

## Current Provider Boundaries

- Stripe has signature verification and event claims before financial handling.
- Telnyx webhooks verify signatures and handle delivery/voice events through separate handlers.
- Resend uses provider signature verification and delivery event reconciliation.

These provider-specific inbox/claim paths must remain intact while an outbox is designed.

## First Safe Contract Test

Before implementation, add a contract test that proves a proposed outbox command has exactly one domain mutation, one event identity, one outbox identity, and idempotent replay behavior. Do not migrate existing controllers until that test and rollback strategy exist.
