# AssembleAtEase Production Safety Baseline

Status: inventory-only baseline
As of: 2026-09-24

This document records the verified starting point before architecture registries or refactors. It does not authorize behavior changes.

## Repository State

- Repository: `Handyman-marketplace`
- Working branch during baseline: `upload-size-fix`
- `main` includes merge commit `9e47cb23` (`upload-size-fix` merged into `main` and pushed)
- Working tree contains uncommitted changes. They are intentionally preserved and are not part of this baseline as deployed code.
- Current local edits include payment recovery, reauthorization, evidence labeling, inbound call routing, customer-facing payment email copy, generated service pages, owner UI, and generated output. Do not reset, clean, or overwrite them without explicit approval.

## Production Deployment

Verified through Vercel inspection:

- Target: Production
- Status: `Ready`
- Deployment: `dpl_9EYGUD32FBemGPnfPy3aKCSww2L8`
- Production aliases: `https://www.assembleatease.com`, `https://assembleatease.com`
- Deployment created: 2026-09-24

The deployment source commit was not inferred from the inspection output. Do not assume uncommitted local changes are live.

## Runtime Surfaces

- Customer/public pages: repository-root HTML, `track.html`, booking/payment recovery routes, customer message and booking APIs.
- Easer app: `assembler/` and `api/assembler/`.
- Owner console: `owner/` and `api/owner/`.
- Serverless API: `api/`.
- Scheduled jobs: `api/cron/` registered in `vercel.json`.

## Scheduled Jobs

Verified in `vercel.json`:

- notification retries
- offer expiry
- automatic dispatch
- review requests
- Easer announcements
- stale booking checks
- no-show checks
- arrival nudges
- unassigned escalation
- Stripe reconciliation
- quote orphan alerts
- operations alerts
- tier checks
- booking reminders
- daily and weekly summaries
- scheduled payment authorization
- payment reauthorization
- payout release
- AssembleCash expiry
- follow-up
- stranded-booking alerts
- auto-blog and auto-social jobs

Do not change cron schedules while doing architecture inventory without a separate review.

## Webhooks and Providers

Verified webhook handlers:

- Stripe: `api/assembler/stripe-webhook.js`
- Stripe legacy alias: `api/webhook/stripe-identity.js`
- Telnyx SMS: `api/webhooks/telnyx.js`
- Telnyx voice history: `api/webhooks/telnyx-voice.js`
- Telnyx call control: `api/webhooks/telnyx-call-control.js`
- Resend: `api/webhooks/resend.js`

Providers in use:

- Stripe / Stripe Connect
- Telnyx
- Resend
- Supabase Postgres and Storage
- Upstash Redis
- Web Push
- Anthropic
- Geoapify
- HubSpot and Buffer, feature-gated where applicable

## Database and Migration Baseline

- Migration directory: `api/migrations/`
- Verified migration files: 100
- Number collisions exist at `091` and `095`; migration tooling must not assume one file per number.
- Recent migration: `096_notification_delivery_policy.sql`.
- The applied production migration version was not directly queried in this read-only baseline. Verify it before migration-dependent changes.

## Safety-Critical Invariants

Do not break these while reorganizing:

- Customer contact release timing and relay leakage protection.
- Automatic dispatch payment gating.
- Stripe webhook signature verification and event idempotency.
- Separation of payment captured, Easer earnings, Stripe transfer, and bank payout.
- Evidence private-by-default behavior.
- Owner versus Easer actor identity and on-behalf-of evidence labeling.
- Payment authorization deadlines and active-job reauthorization.
- Completion blocked until payment is capturable for positive-price jobs.
- Payout blocked by unresolved dispute, evidence, damage, or reconciliation holds.
- Notification consent, opt-out, retry, and delivery truth.

## Verification Gaps

These remain explicitly unverified and must not be guessed:

- Applied production migration state.
- Exact production values of masked Vercel secrets and feature flags.
- A complete three-role production-like E2E run.
- A staging environment equivalent to production.
- Live synthetic coverage for Stripe, Telnyx, Resend, and payout recovery.
- Whether migration 096 has been approved and applied in production.

## Change Rule

Until this baseline is reviewed:

1. Do not move or delete runtime files.
2. Do not change database schema.
3. Do not alter provider configuration.
4. Do not change cron schedules or webhook URLs.
5. Do not merge uncommitted work into architecture refactors.
6. Add documentation and read-only registries first.
7. Validate every later change with a focused test and a deployment check.
