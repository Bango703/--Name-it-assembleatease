# Disaster Recovery

Status: target contract
As of: 2026-09-24

## Required Plans

- database backup frequency and retention
- storage backup and evidence recovery
- restore procedure and verification
- provider outage mode
- webhook replay and reconciliation
- outbox/worker resume behavior
- credential rotation
- incident owner and escalation path
- customer/Easer communication during outage

## Financial Safety

During an outage:

- do not claim payment success without provider truth
- do not create duplicate payment, refund, or payout operations
- preserve pending operations and locks
- surface owner-visible reconciliation state
- resume from idempotency and provider lookup

RPO, RTO, restore testing, and incident drills remain to be formally recorded.
