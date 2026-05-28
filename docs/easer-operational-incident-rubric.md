# Easer Operational Incident Rubric and Promotion Criteria

Date: 2026-05-28
Scope: Operations and documentation baseline only
Mode: No feature expansion, no architecture changes, no DB writes, no deployments

## 1) Incident Severity Table

| Severity | Example Easer incidents | Operational impact | Customer impact | Required response urgency | Escalation path | Pause live observation immediately |
|---|---|---|---|---|---|---|
| Severity 1 (Critical) | Lifecycle corruption (wrong assembler marked complete), repeated unauthorized lifecycle mutation success, widespread active-job state loss, push/deep-link failures with active jobs stranded | Core booking lifecycle integrity compromised | High likelihood of missed jobs, wrong status, payment/payout disputes | Immediate, acknowledge within 15 minutes, active triage until contained | Owner on-call -> Engineering lead -> Product/Operations lead -> Incident bridge | Yes |
| Severity 2 (High) | Frequent status mutation failures during active jobs, dispatch accept races above normal conflict baseline, reconnect/session failures blocking active jobs, repeated stale assignment drift | Core flows degrade but some jobs still recoverable | Delays, confusion, missed updates, manual intervention needed | Acknowledge within 30 minutes, mitigation started within 60 minutes | Owner on-call -> Engineering lead -> Operations lead | Yes if sustained for 30+ minutes or affecting multiple active jobs |
| Severity 3 (Medium) | Intermittent push registration failures, delayed dispatch sync, non-blocking payout visibility lag, occasional duplicate user actions rejected cleanly | Partial degradation with workarounds | Noticeable friction but jobs usually complete | Acknowledge within 4 hours, fix or mitigation by next business day | Owner on-call -> Engineering queue -> Operations review | No, unless trend crosses stop thresholds |
| Severity 4 (Low) | Cosmetic mobile quirks, isolated non-reproducible UI lag, transient notifications delay without lifecycle impact | Minimal operational risk | Minor inconvenience | Triage in routine backlog window | Engineering backlog owner | No |

## 2) Easer Live Observation Watchlist

Track these metrics continuously during limited live observation.

| Metric | Definition | Primary source | Alert threshold |
|---|---|---|---|
| Failed lifecycle mutations | Count of failed lifecycle calls: accept, decline, easer-status, assembler-complete (4xx/5xx excluding expected auth tests) | API responses, activity logs, incident notes | Severity 2 if 3+ failures in 30 minutes on active jobs; Severity 1 if corruption pattern appears |
| Duplicate accept/completion attempts | Multiple accept or complete attempts for same booking within short interval | dispatch_offers, bookings timestamps, activity_logs | Severity 3 at 3+ duplicate attempts per 20 jobs; Severity 2 if duplicate attempts succeed incorrectly |
| Push registration failures | Failed push subscribe saves or repeated inability to register subscription | notification_log, push_subscriptions, client error traces | Severity 3 at 5%+ of active Easers in window; Severity 2 at 15%+ |
| Session expiration during active jobs | Active jobs where lifecycle action fails due to token expiration and does not recover on retry | API error bodies, client logs, activity timeline gaps | Severity 2 if 2+ blocked active jobs in 60 minutes |
| Stale assignment drift | Mismatch between UI-shown assignment/status and bookings or dispatch_offers truth older than threshold | bookings, dispatch_offers, support incidents | Severity 2 if 3+ mismatches > 5 minutes in 60 minutes |
| Reconnect failures | App reconnect does not recover current job state after network return | support reports, activity timeline, client traces | Severity 2 if affecting 2+ active jobs in 60 minutes |
| Payout visibility mismatches | Completed booking payout fields/owner payout view inconsistent with expected state | bookings, payout_ledger, owner payouts view | Severity 3 if transient and recovers < 24h; Severity 2 if persistent or wrong values |
| Delayed dispatch sync | Offer accepted but assignment/status not reflected in expected time window | dispatch_offers, bookings, activity_logs | Severity 3 at > 90 seconds median lag; Severity 2 at > 3 minutes sustained |

## 3) Stop Conditions

### Pause live observation

Pause immediately when any of the following occurs:

1. Any Severity 1 incident.
2. Two Severity 2 incidents within a rolling 6-hour window.
3. Lifecycle corruption evidence: incorrect terminal state or wrong actor ownership persisted.
4. Active-job mutation failure rate exceeds 10% over the last 25 lifecycle actions.
5. Reconnect/session failures block 3 or more active jobs in a 60-minute window.

### Rollback consideration

Initiate rollback assessment when:

1. A newly introduced behavior is strongly correlated with Severity 1 or sustained Severity 2 incidents.
2. Incident impact continues beyond 60 minutes despite mitigation.
3. Data integrity risk is unresolved for active lifecycle transitions.

### Emergency investigation

Trigger immediate incident investigation when:

1. Token/auth anomalies allow unauthorized lifecycle mutation success.
2. Booking state transitions violate expected pipeline ordering.
3. Dispatch assignments show race outcomes inconsistent with guard logic.
4. Push pipeline shows broad failure pattern (delivery or registration) across active devices.

### Immediate hotfix priority

Assign immediate hotfix priority when:

1. Active-job completion is blocked for multiple Easers.
2. Accept or complete actions can produce incorrect persisted state.
3. Session/reconnect path prevents recovery of active assignments.

## 4) Promotion Criteria

Promotion target: move from Limited Live Observation to Operationally Production-Safe.

All criteria below must pass.

1. True-device lifecycle runs completed successfully:
1. iPhone Safari: dispatch offer -> accept -> on-my-way -> arrived -> in-progress -> complete -> payout visibility -> review linkage.
2. Android Chrome: same full lifecycle.

2. Reconnect and session resilience validated on true devices:
1. Offline/reconnect during active assignment recovers correctly.
2. Background/foreground resume preserves or recovers active job state.
3. Session expiration during active job recovers via token refresh flow without lifecycle corruption.

3. Push reliability validated on true devices:
1. Subscription registration works reliably.
2. Push delivery and deep-link behavior verified on iOS and Android.
3. Duplicate push or duplicate action outcomes remain controlled.

4. Stable dispatch progression:
1. Accept/decline and assignment sync remain consistent.
2. No sustained stale assignment drift.

5. No severe lifecycle corruption:
1. Zero Severity 1 incidents during observation window.
2. No unresolved Severity 2 incidents at promotion decision time.

6. Incident thresholds acceptable:
1. Mutation failure, reconnect failure, and sync delay remain below thresholds in Section 5.

## 5) Observation Window Guidelines

Minimum baseline for promotion decision:

1. Minimum jobs observed: 40 completed lifecycle journeys across observed Easers.
2. Minimum duration: 7 consecutive calendar days.
3. Acceptable failure rates:
1. Active lifecycle mutation failures: under 2% overall and under 5% in any 24-hour period.
2. Reconnect recovery failures: under 3% of reconnect events.
3. Push registration failures: under 5% of attempted registrations.
4. Dispatch sync lag over 3 minutes: under 2% of accepted assignments.
4. Confidence thresholds:
1. Backend/API confidence: high with no unresolved Severity 1/2.
2. True-device confidence: high based on successful iPhone and Android runs.
3. Operational confidence: high when thresholds hold for full window.

If thresholds are not met, extend observation window and keep limited mode.

## 6) Response Runbook

### A) Failed lifecycle mutations

1. Owner first checks:
1. Which endpoint failed: accept-dispatch, decline-dispatch, easer-status, assembler-complete.
2. HTTP status and error body pattern.

2. Logs/tables to inspect:
1. activity_logs for event timeline.
2. bookings status and pipeline timestamps.
3. dispatch_offers state for offer lifecycle.

3. Backend vs frontend indicators:
1. Backend likely if API returns 5xx or invalid transition errors despite valid state.
2. Frontend/session likely if repeated 401/expired token and retry path fails to recover.

4. Temporary mitigation:
1. Owner-assisted manual verification of current booking state.
2. Pause further lifecycle actions for affected booking until state reconciled.

### B) Duplicate accept/completion attempts

1. Owner first checks:
1. Whether duplicate attempts were rejected cleanly.
2. Whether only one terminal state was persisted.

2. Logs/tables to inspect:
1. dispatch_offers for accepted or declined token outcomes.
2. bookings for assembler ownership and completion timestamps.
3. activity_logs for repeated action patterns.

3. Backend vs frontend indicators:
1. Backend issue if duplicate action succeeded in a conflicting way.
2. Frontend issue if user spam attempts occur but backend guards are correct.

4. Temporary mitigation:
1. Instruct operators to avoid repeated taps and confirm action response before retry.
2. Closely monitor same booking for follow-up inconsistencies.

### C) Push registration/delivery failures

1. Owner first checks:
1. Is failure at registration time or delivery time.
2. Is issue iOS-specific, Android-specific, or cross-platform.

2. Logs/tables to inspect:
1. notification_log rows with channel push and failed status.
2. push_subscriptions churn and dead endpoint cleanup patterns.

3. Backend vs frontend indicators:
1. Backend likely if push send attempts fail broadly across active subscriptions.
2. Frontend/device likely if subscriptions are missing or permission denied patterns dominate.

4. Temporary mitigation:
1. Use in-app polling/manual refresh instruction for active jobs.
2. Trigger manual communications for critical assignment events.

### D) Session expiration during active jobs

1. Owner first checks:
1. Error pattern includes invalid or expired token.
2. Whether one retry recovers action.

2. Logs/tables to inspect:
1. API response traces for 401 around lifecycle actions.
2. activity_logs to confirm whether action persisted despite client error.

3. Backend vs frontend indicators:
1. Frontend/session likely when refresh flow fails but backend is healthy.
2. Backend/auth likely when valid renewed token still fails unexpectedly.

4. Temporary mitigation:
1. Re-authenticate affected Easer and re-open active job view.
2. Avoid duplicate lifecycle actions until booking state is re-verified.

### E) Stale assignment drift and delayed dispatch sync

1. Owner first checks:
1. Compare UI state to bookings and dispatch_offers source of truth.
2. Measure lag duration from accepted_at to visible assignment state.

2. Logs/tables to inspect:
1. dispatch_offers sent/accepted/expired timeline.
2. bookings assignment and stage timestamps.
3. activity_logs for dispatch and assignment events.

3. Backend vs frontend indicators:
1. Backend issue if bookings and dispatch_offers are internally inconsistent.
2. Frontend/realtime issue if backend truth is correct but UI remains stale.

4. Temporary mitigation:
1. Force refresh and re-open assignment views.
2. Route critical job updates through manual owner confirmation until stable.

### F) Payout visibility mismatches

1. Owner first checks:
1. Booking completion state and payout_status.
2. Owner payouts view consistency with booking and ledger state.

2. Logs/tables to inspect:
1. bookings payout fields and completion timestamps.
2. payout_ledger rows for paid subset.

3. Backend vs frontend indicators:
1. Backend/data issue if values are inconsistent in source tables.
2. Frontend/view issue if source tables are correct but display is stale or mismatched.

4. Temporary mitigation:
1. Use ledger-first manual reconciliation for affected entries.
2. Hold promotion decision until mismatch class is resolved.

## 7) Decision Statement

Current operational posture:

1. Easer is approved for limited controlled live observation under this rubric.
2. Easer is not approved for unrestricted operational certification until promotion criteria are fully met.
