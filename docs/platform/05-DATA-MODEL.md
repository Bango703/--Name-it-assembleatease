# Data Model Registry

Status: target model mapped to current records
As of: 2026-09-24

## Identity

Current authority is Supabase Auth plus `profiles`. Target separates users, roles, permissions, and grants. Owner profiles that also act as Easers require explicit actor labeling.

## Core Aggregates

```text
customer -> addresses, contacts, preferences, bookings
Easer -> application, readiness, skills, areas, availability, documents, earnings
catalog -> services, options, pricing, complexity, crew, evidence rules
booking -> items, quote snapshot, address snapshot, schedule, assignment reference, execution reference
assignment -> offers, acceptance, reassignment history
execution -> status events, issues, evidence, completion review
payment -> provider intent, authorization, transaction, failure, refund, dispute
finance -> ledger entries, reconciliation, adjustments
communication -> conversations, messages, notification deliveries
system -> webhook inbox, outbox, idempotency, audit, scheduled and failed jobs
```

## Rules

- Current customer data is canonical in customer/profile records; booking contact and address data are immutable snapshots.
- Quotes and pricing snapshots cannot be rewritten by later catalog changes.
- Assignments and financial corrections are append-oriented history.
- Evidence records must distinguish uploader from `uploaded_on_behalf_of`.
- Provider records are linked by provider IDs but do not replace platform accounting truth.
