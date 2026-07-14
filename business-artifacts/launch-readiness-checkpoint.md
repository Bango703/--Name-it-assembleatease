# AssembleAtEase Launch Readiness Checkpoint

Last updated: 2026-07-13

## Objective

Prepare the customer platform, Easer app, owner operations, payment controls, and SEO architecture for a safe first launch while keeping the company technically ready to add verified markets beyond Austin.

## Launch constraints

- Austin and the surrounding Central Texas service area remain the only currently verified operating market.
- The public brand may be national, but pages must not claim service in a market until pricing, tax, Easer supply, support, and dispatch coverage are verified there.
- Stripe Connect remains disabled.
- Easer membership billing is not being implemented in this launch cycle.
- Manual Easer payouts remain the launch model and must be recorded in the payout ledger.
- `TEXAS_TAX_CONFIGURATION_APPROVED` remains an owner-controlled launch gate.
- Owner credential rotation remains an owner-controlled launch gate.
- No deployment, push, live-data mutation, or live payment action is authorized by this checkpoint.

## Baseline

- Branch: `main`
- Baseline commit: `457a74e fix(launch): harden marketplace operations and payments`
- Customer responsive regression: PASS at 320, 360, 390, 430, 768, 820, 899, and 900 px.
- Existing launch test suite: PASS before Easer remediation.
- API syntax check: PASS for 140 API files before Easer remediation.
- Easer audit: FAIL due to confirmed onboarding, authorization, dispatch, completion, payout, and privacy P0 issues.

## Preserved unrelated worktree entries

The following pre-existing work is outside this remediation and must not be staged, reverted, or overwritten:

- `api/migrations/014_booking_evidence.sql`
- `business-artifacts/page-governance/*`
- deleted `commit_file.js`
- deleted `parent_file.js`

## Checkpoints

1. Baseline and scope recorded.
2. Easer onboarding, identity, authorization, and privacy controls.
3. Dispatch acceptance, decline, drop, and escalation integrity.
4. Completion timing, evidence, capture, earnings, cancellation, refund, and payout integrity.
5. Easer UI, mobile layout, readiness, notifications, menus, and wording.
6. National-brand and verified-local-market SEO architecture.
7. Full customer, Easer, owner, security, payment, SEO, accessibility, and responsive regression.
8. Owner-run environment/SQL checklist and first-25-jobs operating plan.

## Required checkpoint evidence

Each completed checkpoint must record:

- exact files changed;
- business truth affected;
- migrations or environment requirements;
- automated tests added or updated;
- customer, Easer, owner, and Stripe test outcomes where applicable;
- remaining warnings or blockers.

## Expansion rule

Adding a new market requires all of the following before its local pages become indexable or booking becomes available:

- verified service ZIP codes and pricing;
- applicable tax configuration and approval;
- sufficient approved Easer coverage;
- dispatch and customer-support ownership;
- cancellation, refund, damage, and payout operations;
- unique local page content and real local proof;
- sitemap inclusion and Search Console monitoring.

## Completed remediation evidence

### Checkpoint 2: Easer onboarding, identity, authorization, and privacy

Status: PASS in automated regression.

- The server owns the exact application fee, founding waiver, consent version, payment state, identity state, approval state, and readiness result.
- PaymentIntent continuation is bound to the applicant, customer, profile, amount, currency, metadata, and signed continuation token; webhook recovery covers interrupted browser returns and 3DS.
- Rejected paid applications refund the application fee, and refunded or unpaid fees cannot satisfy readiness.
- Manual-payout readiness does not require Stripe Connect. Easer membership is explicitly disabled and cannot change the launch fee tier.
- Customer/Easer messages, profile data, assignment data, and onboarding actions require authenticated ownership or an authorized owner role.

Primary files: `api/_assembler-onboarding.js`, `api/_easer-access.js`, `api/_easer-application-fee.js`, `api/_easer-membership.js`, `api/_easer-readiness.js`, `api/_phone.js`, `api/assembler/apply.js`, `api/assembler/application-fee-finalize.js`, `api/assembler/application-fee-status.js`, `api/assembler/list.js`, `api/assembler/membership.js`, `api/assembler/stripe-webhook.js`, `api/assembler/update.js`, `api/assembler/verification-link.js`, `api/owner/add-easer.js`, `api/owner/resend-easer-onboarding.js`, `api/webhook/stripe-identity.js`, `assembler/apply.html`, `assembler/contractor-agreement.html`, `assembler/index.html`, `assembler/profile.html`, and migration `034_easer_onboarding_and_message_security.sql`.

### Checkpoint 3: dispatch integrity

Status: PASS in automated regression.

- Offer acceptance, decline, expiry, reassignment, drop, and escalation use server-side authorization and safe state transitions.
- Acceptance cannot be replayed to steal an assigned job, and expired offers cannot be accepted.
- Customer gross is not presented as Easer pay; notifications and screens label exact estimated earnings.

Primary files: `api/booking/_dispatch-internal.js`, `api/booking/_dispatch-safety.js`, `api/booking/_easer-fee-snapshot.js`, `api/booking/accept-dispatch.js`, `api/booking/assign.js`, `api/booking/decline-dispatch.js`, `api/booking/drop-job.js`, `api/booking/my-assignments.js`, `api/cron/expire-offers.js`, `api/cron/stale-booking.js`, `assembler/my-assignments.html`, and migration `036_dispatch_state_safety.sql`.

### Checkpoint 4: financial, completion, cancellation, refund, and payout truth

Status: PASS in automated regression.

- Browser totals are rejected as financial truth; service prices, tax, total, platform fee, Easer earnings, cancellation fee, refunds, and payout records are server-derived.
- Appointment-time gates prevent premature on-the-way, arrival, and completion actions.
- Completion evidence and capture are separate, recoverable operations; operation reservations reduce duplicate capture, cancellation, refund, and payout risk.
- Stripe payment/capture/refund truth remains separate from manual Easer payout truth.
- Owner finance screens distinguish subtotal, tax, total charged, Stripe fee, platform fee, Easer earnings, refunds, payout status, and net estimate.

Primary files: `api/_source-of-truth.js`, `api/booking.js`, `api/booking/_appointment-gates.js`, `api/booking/_completion-evidence.js`, `api/booking/_financial-operation.js`, `api/booking/_stripe-booking-payment.js`, the booking completion/cancellation/refund/payout endpoints under `api/booking/`, `api/cron/release-payouts.js`, finance endpoints under `api/owner/`, `owner/index.html`, `track.html`, and migration `035_financial_completion_reservations.sql`.

### Checkpoint 5: customer/Easer layout, menus, and wording

Status: PASS in automated visual regression.

- Public, booking, authentication, and Easer navigation were aligned and made keyboard/mobile safe.
- Exact cents and grouped money values replace odd rounded amounts.
- Input sizing, tap targets, fixed elements, narrow tables/cards, agreement layout, earnings/payout wording, and responsive breakpoints were corrected.
- The customer booking flow explains service-area availability before payment and routes unsupported ZIP codes to demand intake without creating a booking or PaymentIntent.

Primary files: `assets/css/marketing.css`, `assets/css/marketing-desktop.css`, `assets/css/easer.css`, `assets/js/app.js`, `assets/js/aae-location.js`, `book.html`, public marketing/auth pages, Easer pages under `assembler/`, and `scripts/mobile-visual-audit.mjs`.

### Checkpoint 6: national brand with verified-market SEO

Status: PASS in automated governance and static integrity checks.

- Core brand pages describe a platform that can expand nationally without falsely claiming nationwide booking coverage.
- `locations.html` is the market directory and nationwide demand-intake entry point. Booking remains enabled only for verified Central Texas ZIP codes.
- The 72 current service/location pages use `Service` structured data supplied by the shared `Organization`; duplicate `LocalBusiness` entities were removed.
- Thin local content is not indexed. Canonicals, one-H1 structure, internal links, navigation, footer, sitemap, and JSON-LD are consistent.
- New local SEO pages must remain non-indexable until the expansion rule above is satisfied. No mass nationwide doorway pages were created.

Primary files: `locations.html`, `index.html`, `about.html`, `business.html`, `contact.html`, `pricing.html`, `sitemap.xml`, 72 generated `*-assembly-*-tx.html` and `*-mounting-*-tx.html` service pages, selected blog pages, `scripts/build-flagship-service-pages.mjs`, `scripts/generate-location-pages.js`, `scripts/lib/page-governance.mjs`, `scripts/lib/public-nav.mjs`, `scripts/lib/public-footer.mjs`, and the public nav/footer sync scripts.

## SQL and environment requirements

The following migrations are required in Supabase for this remediation and must be applied in order if they are not already present:

1. `api/migrations/034_easer_onboarding_and_message_security.sql`
2. `api/migrations/035_financial_completion_reservations.sql`
3. `api/migrations/036_dispatch_state_safety.sql`

Required production gates:

- rotate/set `OWNER_PASSWORD` and `OWNER_SESSION_SECRET`;
- set a unique `GUEST_ACCESS_TOKEN_SECRET` of at least 32 characters;
- verify Stripe webhook secrets and successful delivery;
- set `TEXAS_TAX_CONFIGURATION_APPROVED=true` only after the tax configuration is professionally approved;
- keep `STRIPE_CONNECT_ENABLED=false` and `EASER_MEMBERSHIP_ENABLED=false` for launch;
- keep automatic blog publishing off until an explicit Buffer test is approved.

## Final validation performed

Run date: 2026-07-13 Central Time.

- `npm run test:launch`: PASS (smoke, operations truth, payment hardening, launch regression).
- Easer paid application/3DS/refund tests: PASS.
- Easer security checkpoint tests: PASS.
- Dispatch safety tests: PASS.
- Financial completion/reservation tests: PASS.
- Strict page governance: 118 PASS, 0 WARNING, 0 FAIL.
- Responsive/customer visual audit: 33 pages x 8 widths = 264 PASS; zero overflow, clipping, small tap targets, small input fonts, odd text, menu failures, console errors, page errors, or failed requests.
- JavaScript/module syntax: 189 PASS, 0 FAIL.
- Production dependency audit: 0 vulnerabilities.
- Repository UI emoji/entity scan: PASS.
- `git diff --check`: PASS.

## Final automated matrix

| Area | Result | Evidence |
| --- | --- | --- |
| Customer booking and unsupported-market handling | PASS | Launch and visual suites |
| Easer onboarding, identity, readiness, and privacy | PASS | Focused Easer suites |
| Owner visibility and financial labels | PASS | Launch/financial suites |
| Dispatch and assignment integrity | PASS | Dispatch safety suite |
| Capture, refund, cancellation, and payout controls | PASS | Payment/financial suites |
| Menus, mobile layout, and wording | PASS | 264 visual checks |
| SEO, schema, canonicals, sitemap, and page governance | PASS | 118 strict page checks |
| Dependency and source syntax | PASS | 0 vulnerabilities; 189 syntax checks |
| Live Supabase/Stripe production state | WARNING | Requires owner-run gates and real test-mode/live smoke evidence |
| Physical iPhone/Android hardware | WARNING | Automated browser widths pass; device-hardware pass remains external |

No automated FAIL remains. The warnings above cannot be truthfully removed in source code because they depend on production secrets, deployed migrations, tax approval, Stripe delivery, and physical devices.

## Deployment boundary

- No push, deployment, live-data mutation, Connect enablement, Easer membership enablement, or PayPal integration was performed.
- The pre-existing unrelated worktree entries listed above remain outside the remediation boundary and must be excluded from any remediation-only commit.
- Code is ready for a controlled deployment only after migrations 034-036 and the production environment gates are confirmed, followed by Stripe test-mode end-to-end proof and a post-deploy smoke test.
