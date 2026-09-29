# Easer requirements and availability: scoped audit and repair

## Executive summary

The owner roster and detail screen classified an otherwise qualified offline Easer as needing onboarding action. The detail view also mixed payout/tax setup into job eligibility and could paint a late readiness response over a different Easer. These are P1 owner-visibility defects. No new job-eligibility, payment, payout, approval, or availability policy is introduced.

At 2026-09-28 22:37 UTC, a read-only profiles SELECT found 12 Easer records and five stored-active Easers. All five passed actual job requirements. Four had availability on; one had availability off as the sole blocker. No active Easer had a setup blocker. All 22 canonical projection fields were present; no raw/normalized readiness discrepancy appeared in these live records. This is a point-in-time observation, not a promise of current availability or eligibility for a particular booking.

## PASS / WARNING / FAIL matrix

| Perspective / workflow | Result | Evidence |
|---|---|---|
| Owner: distinguish requirements from offline availability | PASS locally | Canonical server verdict, actual-handler tests and UI behavior tests |
| Easer: offline still blocks new offers under existing policy | PASS locally | Canonical availability option matrix and existing operations/dispatch regressions |
| Customer: booking/payment/notification behavior | Unchanged | No customer flow, sender or financial mutation changed; launch regressions required |
| Payout/tax status | PASS locally | Separate warnings; tax-only action cannot contradict canonical offer eligibility |
| Missing evidence / failed reads | PASS locally | Unverified presentation, retry action, no invented missing requirement |
| Rapidly switching or refreshing Easer details | PASS locally | Request generation, selected ID and container identity guards |
| Rendered layout at 1440 / 768 / 375 | WARNING | Browser state call timed out and reset its session; no visual verification claimed |
| Brand-color audit | WARNING, non-blocking | Launch audit reports 39 existing app-shell blue variants; this repair adds no brand palette change |
| Full launch / CI-only regression commands | PASS locally | `npm run test:launch`, SEO/sitemap, voice-call and Sora intake checks; changed-file syntax, lint and whitespace checks |
| Production application rollout | BLOCKED / not deployed | Protected main requires Constitution guards; GitHub billing lock still blocks open repairs #226/#227 |

## Issues and business impact

- **P1: offline labeled as incomplete setup.** `/api/assembler/list` and `/api/owner/easer-readiness` use availability-required readiness, while Live Ops and Market Demand separate availability. The roster's generic action label and locally duplicated checklist implied a setup defect. This wastes owner time and can prompt unnecessary Easer follow-up. There is no evidence that this display defect changed charges, payouts, or legal obligations.
- **P1: tax setup changed the detail's job verdict.** The endpoint appended tax items to `missingItems/finalStatus` while retaining canonical `isReady`. The resulting contradiction could discourage valid staffing. Tax and payout concerns remain visible in their own section, with the existing release gates untouched.
- **P1: late response could describe the wrong Easer.** Detail requests had no selected-ID/request/container guard. This can mislead owner intervention; the repair only accepts the current request's response.
- **P1: tier normalization could imply approval.** The roster evaluated readiness after inferring active status from tier, unlike dispatch's raw evidence. No live active mismatch was found, but the roster now checks stored evidence consistently with dispatch. Display normalization and approval-action rules remain unchanged.
- **P2: duplicate requirements created clutter and stale contradictions.** The cached operational checklist is removed. Work activity remains; authoritative requirements and availability have one detail section. Payout/tax details have a separate disclosure.

No new P0 money/security defect was found in this narrow repair. This is not the requested whole-platform crawl, accessibility audit, or launch certification.

## Before → after

| Before | After |
|---|---|
| Active + “Readiness action needed” for an offline Easer | Active + “Offline” |
| Red “MISSING Available right now” | “Job requirements: Complete”; offers paused while offline |
| Payout/tax item makes job status “Ineligible” | Job offer verdict stays canonical; payout/tax action shown separately |
| Missing response becomes a guessed failure | “Unverified” with Retry readiness check |
| A's delayed result can replace B's panel | Only the current Easer and current request may update the panel |

## Files / APIs and source of truth

- `api/_easer-readiness.js`: additive requirements evidence, requirement list and offer presentation state from the same canonical gates. Existing `isReady`, `finalStatus`, missing-item order and availability option behavior are preserved.
- `api/assembler/list.js`: raw stored profile evidence for readiness, normalized profile for existing display and approval behavior.
- `api/owner/easer-readiness.js`: keep job verdict canonical, tax status separate. Existing Connect verification/cache synchronization behavior remains; this GET was not used for the live read-only audit.
- `owner/index.html`: shared label mapping, separated requirement/availability/payout presentation, removed duplicate cached checklist, stale-response guards and retry.
- `scripts/test-easer-readiness-presentation.mjs`: canonical and actual-handler behavior including omitted proof, raw status, payout-only warnings, auth and read failures.
- `scripts/test-owner-readiness-display.mjs`: actual production renderer/loader behavior, escaping, retry and response races.
- `scripts/audit-source-of-truth.mjs`: scope requirement visibility inspection to the actual renderer after splitting payout rows from job rows.
- `scripts/test-easer-security-checkpoint.mjs` and `scripts/launch-regression.mjs`: update existing source-wiring assertions for the new server-owned label; the new behavioral suites verify its actual meaning.
- `package.json`: include the new backend and UI checks in `test:launch`.
- This report and `business-artifacts/backlog.md`: audit and release tracking.

No schema migration, stored availability change, account approval, job assignment, charge, payout, notification or live mutation is part of this repair. The existing distinction between job readiness and payout setup is preserved; changing Connect eligibility policy would require a separate business decision and audit.

## Test plan and release recommendation

Exercise complete online/offline profiles, genuine missing requirements, suspended/closed accounts, missing and inherited fields, raw-status disagreement, manual/Connect modes, tax-only and unverified payout states, roster/detail handlers, API failures and rapid A→B / same-Easer refresh races. Run the full launch suite and additional CI commands. Verify the rendered owner interface when browser access recovers.

Push only the scoped files to a review branch. Merge/deploy only through protected main after required checks succeed. Keep this work marked in progress until production is deployed and validated. No full-platform completion or production-ready claim follows from this focused repair.

Full launch validation completed with exit code 0 after updating three older source assertions that pinned the replaced binary label and duplicate phone checklist. Those invariants are now backed by the actual presentation/loader tests. An independent reviewer compared 794 baseline/current canonical cases: job eligibility, missing-item order and payout setup verdicts were unchanged. Exact local log: `C:/Users/tgbiz/aae-readiness-qa-20260928/launch-validation.log`. Rendered layout remains unverified; this is ready for code review, not a claim that all release gates are complete.
