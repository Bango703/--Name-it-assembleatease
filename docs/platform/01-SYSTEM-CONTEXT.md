# AssembleAtEase System Context

Status: architecture registry, documentation-only
As of: 2026-09-24

## Product

AssembleAtEase is a multi-sided home-services marketplace connecting customers with Easers, operated through an Owner Console.

## Actors

- Public/customer: discovers services, creates bookings, tracks work, communicates, pays, requests support, and reviews.
- Easer: applies, completes readiness, receives offers, accepts assignments, executes jobs, uploads evidence, communicates, earns, and receives payouts.
- Owner: operates dispatch, customer support, finance, evidence review, payout review, quality, and system recovery.
- System: cron jobs, provider webhooks, workers, notifications, reconciliation, and audit processes.

## Runtime Boundaries

```text
Public and customer HTML + JavaScript
  -> Vercel serverless API routes
  -> Supabase Postgres/Auth/Storage
  -> Stripe, Telnyx, Resend, Redis, Web Push, Anthropic, Geoapify
```

## Current Repository Shape

- Public/customer surfaces: repository-root HTML and `track.html`.
- Easer surfaces: `assembler/`.
- Owner surface: `owner/`.
- API and domain helpers: `api/`.
- Scheduled jobs: `api/cron/`, registered in `vercel.json`.
- Database migrations and RPC definitions: `api/migrations/`.
- Tests: `scripts/test-*.mjs`.

## Canonical Provider Boundaries

- Stripe: payment intents, capture, refunds, disputes, Stripe Connect, identity.
- Telnyx: SMS, voice, call control, AI voice intake.
- Resend: transactional email and delivery webhooks.
- Supabase: database, authentication-adjacent data access, and private evidence storage.
- Upstash Redis: rate limiting.
- Web Push: Easer device notifications.

## Non-Goals During Registry Phase

- No route moves.
- No behavior changes.
- No schema changes.
- No provider configuration changes.
- No deletion of legacy paths.
- No assumptions about masked production environment values.
