# Notification and dashboard fixes: release receipt

Release preparation: branch `fix/notification-dashboard-20260923` in `C:\Users\tgbiz\aae-notification-fixes-20260923`, updated to `cadab8e1` (same application tree as the tested base). On September 23 the user explicitly authorized push and deployment after validation. This receipt records the reviewed scope and database gate; the pull request and production deployment record carry final publication status.

## What changed and why

- N01: staffing, no-show and arrival workflows record success only after provider acceptance or verified prior success. Workflow leases and appointment-state checks protect retries. Owner messages distinguish an informed customer from a failed notice.
- N02-N04: a shared delivery ledger replaces mixed-channel lookup and unguarded sender calls. A stable event key protects each appointment, recipient and channel. Prior-day email starts at 9 AM in the service time zone; day-of SMS is approximately two hours before the window, with early quiet-hour targets skipped. Routine messages use 8 AM-8 PM delivery, at least four hours between interruptions, and at most two routine email/SMS sends in a rolling 24 hours. Urgent job, payment and safety events remain immediate. Prior successful legacy records are honored.
- N05/M01: market supply reads every canonical readiness input and normalizes profiles like the Easer roster. Reporting joins bookings and unique Easers by the existing canonical ZIP service areas, preserves unconfigured/missing locations, pages all supply, and exposes unavailable data as Unknown. Approved, Eligible and Availability on are separate explained subsets with matching people lists. The complete area list refreshes after Easer changes, on focus, and every 30 seconds while visible; stale responses cannot overwrite newer data. Terminal assignment counts and overly broad booking retry collapsing are corrected. See [market reconciliation evidence](market-demand-reconciliation-2026-09-23.md).
- N06: the owner AI receives bounded upcoming jobs, return visits, recent financial records, snapshot time and missing-data limits. Estimates use existing canonical calculations and current assignment snapshots; estimates, recorded finance, transfers and bank payouts remain distinct. The configured model and response budget are unchanged.
- N07: neutral resend language, current appointment details, clear arrival window/timezone, real booking/job CTAs, readable payout capability labels and tier/grace explanations. Stored tiers were not changed to match a visual assumption.
- N08: reviews, follow-ups, required-action announcements, broadcasts, tier/coaching notices and business inquiries use honest delivery outcomes. Tier/coaching cooldown markers advance only after verified acceptance; tier rules and transitions remain unchanged. Reviews stop after two requests, normally on days 2 and 7. Current preferences, unresolved cases, completed actions and booking state are rechecked before delayed sends. Manual resends expose recent sends and resist double clicks, request replay and competing unresolved requests.
- Delivery failures remain owner-visible. A pending/deferred send never counts as a successful duplicate. Email retries reuse their original provider request and idempotency key. SMS with an uncertain provider outcome is held for review rather than automatically sent again. Sensitive queued payloads are service-only and excluded from owner response projections.
- Dispatch-offer retries expire with the actual offer and repair only that offer round's notification-history projection after acceptance. Identical reassignment SMS messages now share the existing email's one-hour repeat protection. Access-code delivery retries check the latest unused code and expire early. Rotated/rolled-back onboarding links and changed Easer status invalidate stale queued content. Financial and authentication decision rules themselves were not changed.

## Validation and practical limits

| Perspective / workflow | Result | Evidence |
|---|---|---|
| Customer | PASS, offline | Current-date wording, quiet hours, opt-outs, stale/changed booking cancellation, review/follow-up stops, safe manual resend, no failed-send success activity. |
| Easer | PASS, offline | Independent channel dedupe, accepted-assignment/version checks, maximum two arrival nudges with 30-minute spacing, readiness projection, exact production SMS length tests. |
| Owner | PASS, offline/browser fixture | Supply counts drill down to matching records; AI sees future jobs; delivery statuses and private payload exclusions verified; desktop and 390-pixel dashboard checks. |
| Payment / payout regression | PASS, offline | Existing full launch checks cover payment, refund, cancellation, payout, fee and financial-source consistency. No new Stripe transaction was initiated. |
| Delivery reservation SQL | PASS, isolated PostgreSQL | Migration replay, service-only RPC permissions, leases, separate channels, legacy dedupe/caps, frozen retry payload, expiry, uncertain SMS, four-hour spacing and two-per-day cap. PGlite uses a single connection; it verifies SQL behavior but does not substitute for a production multi-connection load test. |
| Production column compatibility | PASS, read-only GET verification | Deployment checks use GET with limit 0, not HEAD: HEAD can report an empty response for an absent table. Required new ledger, lease, announcement and broadcast columns are present. No customer records were changed by these checks. |
| Market reconciliation | PASS, read-only production + offline/browser fixtures | New local handler reconciled all 11 production Easer profiles and the five eligible regional records. More than 1,000 profiles, source failures, refresh races, complete-area display, and desktop/390 px expanded lists pass. Not a deployed owner-endpoint test. |
| Database release gate | PASS, production | Missing prerequisite migration 046 and then migration 096 were applied. All five protected tables have RLS; anonymous/authenticated privileges are denied, service privileges present; all three RPCs are available. A real reservation returned deferred inside a rolled-back transaction, with no provider call. |
| Live provider delivery | WARNING | Offline tests and schema verification do not prove a future cron event or recipient delivery. Verify natural production events without unsolicited test messages. |

The complete `npm run test:launch` passed again after the market follow-up, with all eleven new behavioral suites included. All 58 changed JavaScript files passed `node --check`; 776 inline blocks across 427 pages passed the inline syntax guard. Focused tests were rerun for subsequent narrow corrections. `git diff --check` passed. Expected injected provider/database failures in behavioral tests are assertions, not live incidents.

The SQL test uses a temporary developer tool installation outside the application dependency tree:

```powershell
node scripts/test-notification-policy-sql.mjs C:\Users\tgbiz\aae-notification-test-tools\node_modules\@electric-sql\pglite\dist\index.js
```

It runs the actual migration against an in-memory PostgreSQL instance and synthetic base tables. Application dependencies were not changed. See the [PGlite documentation](https://pglite.dev/docs/) for its in-memory PostgreSQL API. Email's frozen request/key behavior follows [Resend's documented idempotency contract](https://resend.com/changelog/idempotency-keys); this code stops automated retries before that retention window ends.

Detailed evidence: [initial audit and recovered context](notification-and-dashboard-audit-2026-09-23.md), [operational timing QA](notification-operations-qa-2026-09-23.md), [dashboard and visual QA](notification-dashboard-qa-2026-09-23.md).

## What was not changed

Service pricing, tax rules, platform/Easer splits, capture, refunds, payout execution, stored tiers, contractor readiness rules, AI model choice and payment authorization schedules are unchanged. Assignment/reschedule edits reset notification counters inside existing compare-and-set mutations. The separate checkout's fitness-gallery work and other unrelated dirty files were not included or modified. No real customer/Easer message was sent during implementation or testing.

## Database rollout evidence

The first migration 096 attempt rolled back atomically because production lacked all three migration 046 tables and its schema marker. Applied the existing `046_customer_broadcast_email.sql` prerequisite, then reran the exact reviewed 096 successfully. Migration 046 creates empty suppression, affirmative-opt-in and broadcast audit tables; it does not invent consent, backfill customers or send messages. Independent actual 046-to-096 PostgreSQL replay passed before release.

The pasted 096 SQL matched normalized SHA-256 `83af09cf1ab756ea0c1c5e5e61a58fe4ecd7787582bbdf9ca6a42460b74d4a6b`. Production GET probes verified both schema markers and all required new columns. Catalog queries verified service-only table/function access. There were zero active legacy staffing records carrying success stamps, so no historical notice reconciliation was needed.

## Deployment gate

1. Review the exact file manifest below and the focused diff from this isolated branch. Do not deploy the unrelated main-checkout changes.
2. Database gate completed under explicit production authorization: prerequisite 046 and migration 096 are applied; columns, service-only permissions and RPC availability verified. The existing code can operate with the additive schema; the new sender deliberately refuses an unprotected send if the RPC is missing. **Do not publish the new sender before the migration.**
3. Publish this reviewed branch and verify the existing reminder schedules plus the new ten-minute `notification-retries` cron. Verify successful real events through existing provider/delivery logs without creating unsolicited extra test messages.
4. Inspect any legacy staffing success stamp that lacks a notification log against provider records before rollout. Historical provider acceptance lost before logging cannot be reconstructed from a marker alone; blindly retrying such a historical record can repeat an old message.
5. Verify the specific September 24 appointment and San Antonio supply through the deployed dashboard. Confirm actual future reminder delivery, acceptance/delivery distinction and no repeated Easer email.

Rollback: redeploying old application code is schema-compatible, but restores the original duplicate-send and false-success defects. Do not use rollback as permission to replay uncertain sends. Review queued delivery records and current booking state before any manual follow-up.

Repository authorization boundary: `AGENTS.md` requires explicit push/deployment authorization. The user provided it with "once good please push and deploy" on September 23. Backlog items remain in progress until application publication and live verification are complete.

## Exact file manifest

The following paths are the scoped local changes, including this receipt, tests and audit evidence. No unrelated checkout files are included.

<!-- GENERATED_FILE_MANIFEST -->
69 scoped files:

- `api/_easer-readiness-select.js`
- `api/_email.js`
- `api/_market-area.js`
- `api/_notification-display.js`
- `api/_notification-policy.js`
- `api/_notification-retry-eligibility.js`
- `api/_postjob-notifications.js`
- `api/_review-email.js`
- `api/_send-governor.js`
- `api/_sms.js`
- `api/assemblecash/request-code.js`
- `api/booking/_appt-date.js`
- `api/booking/_dispatch-internal.js`
- `api/booking/activity.js`
- `api/booking/assign.js`
- `api/booking/reschedule.js`
- `api/business-inquiry.js`
- `api/cron/easer-announcements.js`
- `api/cron/easer-arrival-nudge.js`
- `api/cron/followup.js`
- `api/cron/no-show-check.js`
- `api/cron/notification-retries.js`
- `api/cron/reminders.js`
- `api/cron/review-request.js`
- `api/cron/tier-check.js`
- `api/cron/unassigned-escalation.js`
- `api/migrations/096_notification_delivery_policy.sql`
- `api/owner/_monitor-jobs.js`
- `api/owner/announcement-adoption.js`
- `api/owner/broadcast.js`
- `api/owner/cases.js`
- `api/owner/email-usage-report.js`
- `api/owner/live-ops.js`
- `api/owner/market-demand.js`
- `api/owner/monitor.js`
- `api/owner/resend-booking-details.js`
- `api/owner/voice-calls.js`
- `business-artifacts/backlog.md`
- `business-artifacts/market-demand-reconciliation-2026-09-23.md`
- `business-artifacts/notification-and-dashboard-audit-2026-09-23.md`
- `business-artifacts/notification-dashboard-qa-2026-09-23.md`
- `business-artifacts/notification-fixes-release-2026-09-23.md`
- `business-artifacts/notification-operations-qa-2026-09-23.md`
- `owner/assets/cases.js`
- `owner/email.html`
- `owner/index.html`
- `package.json`
- `scripts/test-booking-details-send-safety.mjs`
- `scripts/test-email-log-schema-tolerance.mjs`
- `scripts/test-final-mutation-safety.mjs`
- `scripts/test-market-area-reconciliation.mjs`
- `scripts/test-market-demand-refresh.mjs`
- `scripts/test-notification-dashboard-fixes.mjs`
- `scripts/test-notification-owner-visibility.mjs`
- `scripts/test-notification-policy-sql.mjs`
- `scripts/test-notification-policy.mjs`
- `scripts/test-notification-retries.mjs`
- `scripts/test-notification-volume.mjs`
- `scripts/test-operational-notification-truth.mjs`
- `scripts/test-operations-cases.mjs`
- `scripts/test-owner-ai-memory.mjs`
- `scripts/test-owner-dashboard-audit.mjs`
- `scripts/test-owner-demand-damage-discount-and-texas-content.mjs`
- `scripts/test-postjob-announcement-notifications.mjs`
- `scripts/test-readiness-select-parity.mjs`
- `scripts/test-reminder-cadence.mjs`
- `scripts/test-sms-message-length.mjs`
- `scripts/test-tier-notification-outcomes.mjs`
- `vercel.json`
