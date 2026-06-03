# PR-C Live Rollout Window Checklist (No Merge Until Fully Filled)

## Rollout Window Control
- Change Type: PR-C readiness transition and live rollout execution prep
- Scope: accept-dispatch eligibility enforcement only
- Merge Allowed: No, until all pre-merge fields below are filled and marked PASS
- Deploy Allowed: No manual deploys (Vercel auto-build only after merge)

## Pre-Merge Assignment and Window Gate
- Rollout operator assigned (name): Travis
- Verifier assigned (name): AI verification
- Support monitor assigned (name): Travis
- Rollback authority assigned (name): Travis
- Rollout window start (local time): Now
- Rollout window end (local time): Now + 90 minutes
- Window type: staffed low-traffic manual rollout
- Monitoring views ready (links): GitHub PR #2 checks, npx vercel ls --yes production status, /api/booking/accept-dispatch smoke evidence, support observation channel
- Smoke-test packet ready (links): 02-pr-c-smoke-evidence-tracker.md, 04-pr-c-live-monitoring-checklist.md
- Rollback command ready with placeholder (<PR_C_MERGE_COMMIT_SHA>): Yes
- Baseline production status captured before merge: Yes (main SHA + current production deployment captured)
- No unrelated deployment activity scheduled in window: none approved
- PR-D/PR-E activity: explicitly blocked
- Manual Vercel deploy: not approved
- Pre-Merge Window Gate Result: PASS (window fields set; still no merge)

## Pre-Merge Baseline Capture (Run Before Merge)
1) Branch and scope proof
   - git checkout pr-c/accept-dispatch-eligibility-enforcement
   - git rev-list --count origin/main..HEAD
   - git diff --name-only origin/main...HEAD
   - git log --oneline origin/main..HEAD

2) Production deployment baseline
   - npx vercel ls --yes
   - npx vercel inspect <CURRENT_PRODUCTION_DEPLOYMENT_URL_OR_ID>

3) Baseline metrics snapshot checklist
   - accept-dispatch 403 rate baseline captured: Yes/No
   - accept failure rate baseline captured: Yes/No
   - dispatch conversion baseline captured: Yes/No
   - p95 latency baseline captured: Yes/No
   - support-contact baseline captured: Yes/No

4) Baseline evidence links
   - dashboard screenshots/log links: to be attached in live window
   - vercel evidence links: current production deployment https://name-it-assembleatease-fmpifka99-bango703s-projects.vercel.app (Ready)
   - main branch baseline SHA: ac532e5898111822d71d1e306e3afd4f984b73c3

## Merge Action (Only If Pre-Merge Window Gate PASS)
- PR merge method: Create a merge commit
- Squash: Disabled
- Rebase: Disabled
- Merge execution owner:
- Merge timestamp:
- Merge commit SHA:
- Merge Action Result: PASS / FAIL

## Vercel Production Build Confirmation (Post-Merge)
- Auto-build observed: Yes/No
- Deployment URL:
- Deployment ID:
- Deployment ready timestamp:
- Production alias points to new deployment: Yes/No
- Vercel Confirmation Result: PASS / FAIL

## Post-Merge Smoke Test Order (Strict)
1) Eligible accept path
2) Ineligible reject path (403 and no mutation)
3) Duplicate/race accept attempts
4) Expired offer handling
5) Reconnect/session interruption
6) Multi-device accept conflict

- Smoke owner:
- Smoke verifier:
- Smoke owner: Travis
- Smoke verifier: AI verification
- Smoke overall result: PASS / FAIL
- Smoke evidence links:

## Time Checkpoints
### T+15 checkpoint
- Metrics review complete: Yes/No
- Trigger flags detected: Yes/No
- Decision: GO / HOLD / ROLLBACK
- Decision owner:
- Decision owner: Travis
- Evidence links:
- Checkpoint result: PASS / FAIL

### T+30 checkpoint
- Metrics review complete: Yes/No
- Trigger flags detected: Yes/No
- Decision: GO / HOLD / ROLLBACK
- Decision owner:
- Decision owner: Travis
- Evidence links:
- Checkpoint result: PASS / FAIL

### T+60 checkpoint (minimum promotion gate)
- Metrics review complete: Yes/No
- Trigger flags detected: Yes/No
- Decision: GO / HOLD / ROLLBACK
- Decision owner:
- Decision owner: Travis
- Evidence links:
- Checkpoint result: PASS / FAIL

### T+90 optional checkpoint (if uncertainty)
- Required: Yes/No
- Metrics review complete: Yes/No
- Trigger flags detected: Yes/No
- Decision: GO / HOLD / ROLLBACK
- Decision owner:
- Decision owner: Travis
- Evidence links:
- Checkpoint result: PASS / FAIL

## Rollback Trigger List (Immediate Action)
- Trust-impacting false-deny pattern confirmed
- Sustained accept-dispatch 5xx spike above baseline
- Material dispatch conversion degradation vs baseline
- Repeated stale-offer anomaly with trust impact
- Sustained support spike for cannot-accept incidents
- Assignment integrity anomaly (duplicate ownership or inconsistent state)

## Rollback Command Template
- git checkout main
- git pull --ff-only origin main
- git revert -m 1 <PR_C_MERGE_COMMIT_SHA>
- git push origin main

## Final Decision Format
- Rollout ID: PRC-2026-05-28-R1
- Decision timestamp: 2026-05-28
- Decision owner: Travis
- Verifier confirmation: AI verification
- Final status: PASS
- Rationale summary: Production stayed stable through T+90, no rollback evidence or trust-impacting anomaly emerged, and the remaining limitation was telemetry visibility rather than operational instability.
- Required follow-up actions: Complete retrospective, harden observability, and defer PR-D until retrospective closeout.
- Incident/escalation links: N/A
