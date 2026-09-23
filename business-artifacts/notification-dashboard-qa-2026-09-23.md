# Notification and dashboard correction QA — September 23, 2026

Local implementation receipt for audit findings N05–N07 and the owner delivery-state presentation needed by the notification safety changes. Worktree: `C:\Users\tgbiz\aae-notification-fixes-20260923`.

**Not deployed. No production records, live provider messages, payment actions, or Stripe lookups were used for this QA.** This receipt does not certify the current live dashboard or notification delivery.

## Changes and business impact

- Market supply reads the complete canonical readiness field projection, including consent, opt-out, application decision, refund holds and closure state. The readiness business rules themselves are unchanged.
- Approved profiles, ready-when-online profiles, online profiles, pending submitted applications and waitlist prospects are distinct server-owned lists. Every displayed market/summary count opens the exact records counted. Approved profiles no longer inflate pending applications. Applied waitlist entries no longer remain waiting prospects.
- Demand copy says “Most requested services,” “No requests recorded yet,” and “Requested ZIPs.” Supply is explicitly grouped by home city and does not certify travel coverage for any particular appointment. Texas booking availability remains unchanged.
- The owner AI receives up to 30 upcoming jobs and 15 recent financial jobs, plus bounded unknown-date records. It receives date, arrival window, job timezone, reference, assignment/acceptance and per-job financial context. Every context includes snapshot time and list limits. Missing rows must not be interpreted as no booking existing.
- Expected job economics use the existing canonical split and financial-summary helpers and require a current assignment fee snapshot. Stored credits and promised bonuses are included through those helpers. Actuals come from the existing ledger-first finance rows. Unknown costs remain unknown; processing estimates, taxes, Easer liabilities, payout state, transfer state, bank payout state and overhead exclusions are explicit. Flagged test rows are excluded; unflagged historical rows are not described as verified commercial demand.
- Haiku 4.5, the 600-token response setting and the prior chat-memory behavior are preserved.
- Owner roster payout capability says “Enabled” or “Not enabled,” separately from actual payout. Active-account status is distinct from current job readiness. Stored tiers have an explanation and recorded grace-start context; no tier was changed.
- Manual booking-details resend shows last sent/delivered times and recent notices before the owner sends. It disables concurrent clicks, reuses the same request UUID after an ambiguous retry and labels an already-sent response as a previous send. Neutral email copy comes from the root-owned resend API.
- Owner timelines distinguish queued, accepted, deferred, uncertain, cancelled, failed and delivered events. Uncertain delivery requires provider review before another send. Cancelling further notification delivery does not claim to cancel the booking. New delivery states never become a generic “notification sent” event.
- Live Ops includes uncertain delivery; cases carry the appropriate owner action; usage reports keep deferred/uncertain/cancelled separate from known outbound sends. All browser-facing log readers retain explicit projections excluding private send payloads, claim tokens and booking snapshots.
- Required-action campaign rows show pending channels and channels whose delivery needs review. Requeue failures do not stay falsely labelled “Queued.” Email broadcast/test UI distinguishes sent, already sent, queued, failed/review and unprocessed outcomes.

## PASS / WARNING / FAIL

| Perspective / workflow | Result | Evidence |
|---|---|---|
| Customer manual details resend | PASS locally | Actual handler with fake persistence/provider: owner auth, preview without mutation, stable request ID, duplicate/concurrent prevention, neutral actual email builder, token compare-and-set and provider-failure handling. |
| Easer readiness / consent / holds | PASS locally | Exact market projection exercises ready, offline, no consent, opt-out, decision in flight, refund and closure blockers. No readiness rule weakened. |
| Owner market counts / copy | PASS locally | Counts equal server list lengths; production inline renderers show exact names and corrected empty-state/demand wording. |
| Owner AI upcoming job | PASS locally | September 24 fixture reaches the actual mocked Anthropic request, including reference and canonical estimate; model and response budget remain unchanged. |
| Owner financial interpretation | PASS locally | Tests separate expected earnings from collected money and transfer from bank payout; missing price/assignment/processing data does not become invented profit. |
| Owner delivery-state visibility | PASS locally | Actual activity handler rejects unauthorized access, renders new statuses/actions and excludes poisoned internal payload/claim/snapshot fields. |
| Manual resend UI | PASS locally | Real click branch with mock fetch: preview cancellation sends nothing, concurrent click does nothing, retry retains UUID, known duplicate does not claim a new send. |
| Desktop/mobile presentation | PASS for local fixture | Browser rendered actual market functions and owner CSS at desktop and 390 × 844. Expanding the ready count displayed exactly three fictional records; mobile had no horizontal overflow or clipped controls. Viewport restored and browser tab closed after inspection. |
| Stripe/payment/payout execution | WARNING — outside this local test | Financial read/presentation only; no live Stripe validation or money mutation performed. Canonical pricing, split, payout and readiness calculations unchanged. |
| Production notification delivery | WARNING — not validated | Release/migration deployment and real delivery verification remain separate root-owned release steps. |

The browser fixture is generated by `node scripts/test-notification-dashboard-fixes.mjs --fixture` at `tmp/notification-dashboard-fixture.html`. It uses fictional data and extracted production rendering functions/CSS. It is not a live authenticated dashboard test. Subsequent copy refinements retain the tested layout and are covered by the renderer assertions.

## Validation commands

All of the following passed locally after their relevant changes:

- `node scripts/test-notification-dashboard-fixes.mjs`
- `node scripts/test-notification-owner-visibility.mjs`
- `node scripts/test-booking-details-send-safety.mjs`
- `node scripts/test-readiness-select-parity.mjs`
- `node scripts/test-ai-intelligence-data.mjs`
- `node scripts/test-owner-ai-memory.mjs`
- `node scripts/test-owner-demand-damage-discount-and-texas-content.mjs`
- `node scripts/test-owner-dashboard-audit.mjs`
- `node scripts/test-easer-roster-view.mjs`
- `node scripts/test-owner-cases-test-bookings.mjs`
- `node scripts/test-self-diagnosed-failures.mjs`

Changed JavaScript modules passed `node --check`; production owner inline scripts are parsed by the new dashboard guard. The root integration pass owns the whole launch gate and the shared notification modules, migration and cron coverage.

## Exact dashboard/visibility scope

New runtime helpers:

- `api/_easer-readiness-select.js`
- `api/_notification-display.js`
- `api/owner/_monitor-jobs.js`

Updated runtime/UI files:

- `api/owner/market-demand.js`
- `api/owner/monitor.js`
- `api/booking/activity.js`
- `api/owner/live-ops.js`
- `api/owner/cases.js`
- `api/owner/email-usage-report.js`
- `api/owner/voice-calls.js`
- `owner/index.html`
- `owner/email.html`
- `owner/assets/cases.js`

New/updated guards:

- `scripts/test-notification-dashboard-fixes.mjs`
- `scripts/test-notification-owner-visibility.mjs`
- `scripts/test-booking-details-send-safety.mjs`
- `scripts/test-readiness-select-parity.mjs`
- `scripts/test-owner-ai-memory.mjs`
- `scripts/test-owner-dashboard-audit.mjs`
- `scripts/test-owner-demand-damage-discount-and-texas-content.mjs`

The root-owned `api/owner/resend-booking-details.js` is exercised by the resend guard. The shared scheduling/sender/retry modules and migration are intentionally documented in the main release receipt rather than duplicated here.

## Final email browser QA

PASS locally: rendered the actual exported `buildReminderEmail` for customer and Easer, plus `buildStatusEmail` HTML captured from the actual mocked resend handler. Reviewed desktop screenshots and exact 390 CSS-pixel mobile screenshots; every document had `scrollWidth <= innerWidth`, readable date/arrival-window rows, visible CTA and no horizontal overflow. A further mobile return-visit preview showed Monday, September 28, 2026, 1 PM-3 PM Mountain Time and the recorded remaining work. Ordinary September 24 fixtures showed Central Time. Browser viewport was restored and the fixture tab closed.

CTA hrefs were inspected from the rendered DOM: customer reminder uses the canonical `/track` link with fixture reference/email/token; Easer reminder uses `/assembler/my-assignments`; captured resend uses the test handler's `/track` target and fixture token. No live links were opened. Images were replaced with an embedded transparent fixture image to avoid external resource requests; production markup, layout and copy were otherwise retained. This is browser rendering QA, not Gmail/Outlook delivery or real-link authorization certification.

The email fixtures can be regenerated with `node scripts/test-booking-details-send-safety.mjs --fixture`, writing four local files under `tmp/notification-email-*.html`. No production credentials or provider sends are used. The return-date/timezone check revealed and fixed a remaining resend-copy gap: resend now selects canonical return-visit fields, uses operational date/time, formats the arrival window with Central/Mountain Time and the address through the existing helper, and shows recorded remaining work. An unscheduled return states `To be scheduled`, rather than repeating the original appointment. Idempotency, token and sending logic were unchanged by this final copy correction. The actual-handler guard covers these cases and source-query dependencies; it and the notification-owner-visibility guard passed again afterward, as did syntax and diff checks.

## Remaining limits

- Per-job AI figures are bounded, recorded snapshots, not a fresh Stripe reconciliation or a full operating-profit statement.
- Market evidence is based on profile home city, not a newly verified travel territory.
- Tier grace explanations use the stored grace-start record; this change neither recalculates tiers nor validates unflagged historical jobs as real work.
- Existing whole-platform test guards that inspect the old shared sender source need root integration against the new shared notification-policy module; local dashboard behavior tests do not replace that gate.

No commit, push or deployment was performed by this workstream. Pricing, fee rates, payouts, payment execution, contractor eligibility and stored tier values were not changed.
