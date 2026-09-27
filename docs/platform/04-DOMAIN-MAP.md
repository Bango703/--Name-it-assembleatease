# AssembleAtEase Domain Map

Status: inventory, documentation-only
As of: 2026-09-24

## Domain Ownership

| Domain | Current implementation surface | Primary records and truth concerns |
|---|---|---|
| Identity | Supabase Auth and `profiles` | Actor identity and owner/Easer overlap require explicit actor labeling. |
| Customer | booking routes, customer booking/tracking routes | Customer ownership, contact release, and guest token security. |
| Easer | `api/assembler`, `assembler/`, readiness helpers | Application, readiness, availability, skills, Connect, SMS consent. |
| Catalog | pricing/source-of-truth helpers and service metadata | Service, market, pricing, complexity, crew, evidence requirements. |
| Booking | `api/booking`, top-level booking routes | Commercial agreement and lifecycle aggregate. |
| Dispatch | `_dispatch-internal.js`, offers, assignment routes | Eligibility, ranking, offers, acceptance races, reassignment. |
| Execution | check-in, status, completion, issue and evidence routes | En route, arrived, started, completion, review, rework. |
| Evidence | `booking/evidence.js`, upload routes, private storage | Evidence ownership, visibility, on-behalf-of identity, expiry. |
| Messaging | `booking/message.js` | Conversations are currently booking-centered and notification side effects are distributed. |
| Notifications | `_email.js`, `_sms.js`, `_push.js`, cron retry | Delivery truth, consent, retries, deduplication, provider callbacks. |
| Payments | Stripe helpers, booking payment routes, cron jobs | Authorization, reauthorization, capture, refund, dispute, recovery. |
| Finance | source-of-truth split, financial audit, owner finance routes | Ledger and reconciliation must remain distinct from provider truth. |
| Earnings | completion and assignment snapshots | Historical Easer earnings must remain frozen. |
| Payout | release-payouts cron, Connect helpers, owner payout routes | Transfer state is distinct from bank payout state. |
| Support | operations cases and messages | Case severity, ownership, SLA, evidence, resolution. |
| Audit | activity logs, operational events, financial audit | Human action, system event, provider event, and timeline are distinct concerns. |

## Cross-Domain Contracts

- Booking cannot complete a positive-price job without valid payment readiness.
- Dispatch cannot offer a job without payment and Easer readiness rules passing.
- Evidence cannot silently claim a different uploader than the actor who supplied it.
- Payout cannot release without frozen earnings, payout readiness, and no holds.
- Provider callbacks must be verified, deduplicated, and reconciled before state mutation.
- Customer-facing copy must translate internal states into plain action-oriented language.

## Target Direction

The target architecture adds explicit commands, queries, events, outbox records, provider adapters, and policy decisions around these domains. This registry is descriptive only; it does not move current files.

## Current Overlap Register

### P1: Refund truth has two stacks

- Platform booking refunds: `api/booking/refund.js` and `api/booking/_stripe-refund-truth.js`.
- Owner/manual payment refunds: `api/owner/refund-manual-payment.js`, `api/owner/_manual-stripe-refund.js`, and `api/owner/_manual-payment-truth.js`.

They protect different payment lanes, but duplicate provider validation. Future changes must prove both lanes remain equivalent where their rules overlap.

### P1: Payment recovery has multiple entry points

Shared recovery helpers exist in `api/booking/_pending-payment-recovery.js`, and owner retry reuses the scheduled authorization implementation. `api/owner/reconcile-payment-authorization.js` remains a separate direct booking-state repair path and requires contract equivalence testing.

### P2: Evidence validation is duplicated

MIME, magic-byte, and size validation appears in:

- `api/booking/upload-evidence.js`
- `api/owner/upload-completion-evidence.js`
- `api/owner/supply-easer-evidence.js`

Uploader versus `uploaded_on_behalf_of` identity is the intended model; validation duplication is the maintenance risk.

### P3: Payout has guarded write paths

Automatic payout release is in `api/cron/release-payouts.js`; owner manual payout is in `api/booking/payout.js`; Easer instant payout is a separate movement of already-transferred funds. Existing guards prevent double movement, but this should become one policy/command contract with regression tests.

### Confirmed centralized areas

- Dispatch eligibility and offers are centralized through `_dispatch-internal.js`, `_dispatch-safety.js`, and database RPC guards.
- Notification policy, retry eligibility, and send-volume governance are separate concerns rather than competing policy implementations.
- Activity, financial audit, and operations-case records are intentionally separate audit trails.
