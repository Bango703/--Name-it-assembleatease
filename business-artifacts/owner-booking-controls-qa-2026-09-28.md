# Owner booking controls: audit and release verification

Scope: the September 28 customer-notification, accepted-job reassignment, tier-alignment, payment-incident and aging-authorization reports. Based on main `004e2b2f`, in an isolated checkout. This is a focused fix report; the requested exhaustive platform UX/IA crawl is still incomplete.

## Audit before code

| Severity | Confirmed problem | Business impact | Smallest safe correction |
| --- | --- | --- | --- |
| P1 | Owner edit uses `notifyCustomer || scheduleChanged`, overriding explicit false. | Unwanted customer mail; the checkbox cannot be trusted. | Honor false for both sends and missing-address warnings; keep necessary Easer schedule acceptance independent. |
| P1 | Accepted-job Reassign only reveals a selector populated for unassigned jobs. | Empty/stale replacement choices can strand a handoff. | Refresh eligible choices, exclude the current Easer, retain selection only for the same reviewed assignment, reject stale submissions. |
| P0 | Legacy lead crew rows can confer access after another Easer becomes the current lead; active crew allocations are not safely redistributed by ordinary assignment. | Prior Easer can retain booking access; changing crew ownership can misrepresent money owed. | Lead access follows the current booking assignment; only active helpers use crew fallback. Refuse reassignment with active crew allocations in both API and an atomic database guard. Do not rewrite earnings. |
| P2 | Live Ops reserves only 62px for a Professional badge; pills vary in width. | Ragged alignment and mobile scanning problems. | One 7.25rem tier badge/column width with existing responsive layout. |
| P1 | The incident panel displays failed capture history without later completed/captured truth. | A recovered attempt appears to need financial intervention. | Classify only a matching later completion as recovered; retain the original error in collapsed history and fetch fresh booking details. Unknowns and active locks remain unresolved. |
| P0 | A real upcoming authorized booking has an unknown saved deadline and is skipped by the renewal query. | The job can outlive its card hold, stranding payment/completion. | Discover unknown deadlines, validate Stripe ownership/amount/mode, record only the verified deadline with conditional guards, and use the existing renewal decision and protected execution path. |
| P1 | Reminders still send an independent warning based on authorization age. | Duplicate and potentially stale financial instructions. | Retire the age-only digest; retain actual-deadline monitoring, renewal failures and owner actions. |

Customer, Easer, Owner, Payments, Security, Operations, QA and Content Design perspectives were used for the findings. Customer messages remain plain language; owner-only diagnostics retain exact technical causes in history. No newly invented bank problem is presented to a customer.

## Source of truth and live reads

Read-only production checks verified that the reported capture incident's current linked Stripe payment succeeded, matches the booking amount/currency/identity, and the booking completed after the failed attempt. No charge or payout was initiated for verification. The earlier failure record is preserved.

The upcoming booking's linked Stripe hold is currently capturable and matches the booking. Its actual deadline occurs before the canonical completion buffer, while its saved deadline is null. The revised candidate query includes this record. The two currently accepted online bookings have no crew rows; their ordinary reassignment flow is eligible for the UI fix, subject to existing payment/readiness checks.

Stripe defines the per-charge `capture_before` field as the actual authorization expiry. The implementation continues to use that field rather than a fixed number of days. [Stripe documentation](https://docs.stripe.com/payments/place-a-hold-on-a-payment-method).

## Blast radius

- Owner booking update notification preference; no customer send or retry entry when explicitly disabled.
- Owner assignment selector and expected-assignment concurrency guard; replacement Easer still accepts before starting work.
- Crew access and assignment safety guard; existing owed/paid amounts are preserved, and active crew handoffs require explicit review.
- Owner tier presentation and recovered incident history/drilldown.
- Authorization candidate discovery, verified deadline projection, and actionable owner notices. Existing authorization creation/recovery, cancellation of the replaced hold, financial locks and idempotency remain the execution path.
- No service prices, tax rates, fee splits, capture amounts, refunds or payout calculations change. No provider messages or live financial actions are sent as tests.

## Verification

Focused behavior tests execute actual handlers/renderers with isolated database/provider fakes, including false/true/omitted notification choice, save and send failures, stale assignment races, helper/lead authorization, unknown Stripe deadline inspection, healthy repeat scans, priority/paging, conditional deadline writes, recovery locks, owner-alert deduplication, incident-source failures and stale booking caches.

Browser checks use actual owner markup, CSS and rendering functions with fictional data and network blocked. Measured CSS widths are 1440, 768 and 375 pixels. Tier pills align with no text clipping; accepted-job replacement choices appear; refresh preserves the selected replacement; empty/failed lookup states explain the blocker. This is scoped fixture verification, not a completed authenticated end-to-end production handoff.

| Perspective/check | Result | Evidence and limit |
| --- | --- | --- |
| Customer notification preference | PASS | Actual-handler tests cover explicit false, true, omitted preference, no-op and failed saves. No live customer messages sent. |
| Easer handoff and access | PASS | Accepted/in-progress selector fixtures, stale-assignment tests and former-lead/helper access regressions. Existing crew allocations explicitly require review. |
| Owner incident and tier presentation | PASS | Actual renderers and fresh-detail tests; browser checks at 1440/768/375 CSS pixels. |
| Payment monitoring | PASS | Read-only Stripe evidence, unknown-deadline inspection, conditional-write/race, priority/paging, recovery and stale-notification tests. No live money actions performed. |
| Full launch suite | PASS | `npm run test:launch` exited 0, including lint and inline scripts across 427 pages. Final retry-worker changes also passed a focused rerun and scoped lint. |
| Syntax and diff hygiene | PASS | All 21 changed/new JavaScript files pass `node --check`; `git diff --check` passes. |
| Database guard | PASS | Actual migration SQL runs and replays in isolated PGlite, including hidden crew rows and role permissions. This is not a multi-session stress test. |
| Production renewal cycle | WARNING | Must observe the next scheduled run after deployment; no mutating cron is invoked as a test. |
| Exhaustive UX/IA/accessibility audit | WARNING | Still open; scoped browser verification does not satisfy that separate audit. |

Migration 098 was applied to production before the API release. The editor SQL was read back and its normalized SHA-256 matched the versioned file (`ca3a27ec6bc057dedf1dfa497d5f5ce5d7469d0424b62954799d9d6818f41d1d`). Catalog verification confirms migration 98 recorded, trigger enabled, security-definer with fixed search path, anonymous/authenticated execution denied and service-role execution allowed. No booking, crew or financial records were backfilled. CI and code-deployment receipts are recorded in the release PR.

## Exact release file manifest

```text
api/_notification-retry-eligibility.js
api/booking/_assignment-guard-reasons.js
api/booking/_crew.js
api/booking/assign.js
api/booking/easer-status.js
api/booking/message.js
api/booking/my-assignments.js
api/booking/upload-evidence.js
api/cron/reauth-payments.js
api/cron/reminders.js
api/migrations/101_guard_crew_assignment_handoff.sql
api/owner/edit-booking.js
api/owner/live-ops.js
business-artifacts/backlog.md
business-artifacts/owner-booking-controls-qa-2026-09-28.md
owner/assets/owner.css
owner/index.html
package.json
scripts/test-crew-handoff-access.mjs
scripts/test-crew-handoff-sql.mjs
scripts/test-notification-retries.mjs
scripts/test-owner-accepted-reassignment.mjs
scripts/test-owner-edit-notification-preference.mjs
scripts/test-reauth-candidate-inspection.mjs
scripts/test-reauth-payment-safety.mjs
scripts/test-reminder-cadence.mjs
scripts/test-self-diagnosed-failures.mjs
```

## Remaining boundaries

- A replacement notification does not contact the prior Easer; the handoff confirmation directs the owner to contact that person and settle any work already performed.
- Active crew earnings cannot be reassigned by this single-Easer action. The server gives an explicit crew-review reason instead of modifying pay.
- Unknown, missing or contradictory payment evidence remains a review item, never automatic proof of recovery.
- Production cron execution after release must be observed separately; no live renewal is manually invoked as a test.
- The full-platform UX/IA inventory and responsive/accessibility audit remain open; this report does not claim exhaustive coverage.

## Deployment and rollback

Apply the versioned, additive crew-assignment guard first, then merge only the scoped files after checks pass. The release is reversible by reverting the code commit. Keep the protective database guard in place during a code rollback; removing it requires a separately reviewed migration.
