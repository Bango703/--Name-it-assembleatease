# PR-C Rollback Decision Matrix

## Immediate Rollback Rule
Rollback first when trust or operational continuity is threatened. Investigation follows stabilization.

## Ownership
- Rollout operator:
- Verifier:
- Decision owner:
- Rollback authority:
- Support escalation owner:
- Deployment verifier:

## Trigger Matrix
| Trigger | Threshold | Severity | Rollback Required (Y/N) | Evidence Required |
|---|---|---|---|---|
| False-deny on eligible Easers | Confirmed pattern, not one-off | Critical | Y | Logs + account examples + timestamps |
| Accept-dispatch 5xx spike | Sustained above baseline | High | Y | Error rate graph + logs |
| Dispatch conversion degradation | Material drop vs baseline | High | Y | Conversion dashboard snapshots |
| Stale offer acceptance anomalies | Repeated and trust-impacting | High | Y | Offer traces + support tickets |
| Support spike: "cannot accept" | Sustained abnormal volume | High | Y | Ticket counts + examples |
| Single isolated anomaly | One-off, non-repeating | Low | N | Incident note + monitor plan |

## Rollback Command (Prepared)
```bash
git checkout main
git pull --ff-only origin main
git revert -m 1 <PR-C merge_commit_sha>
git push origin main
```

## Rollback Execution Record
- Trigger met:
- Trigger timestamp:
- Decision owner:
- Rollback authority:
- Rollback command run timestamp:
- Revert commit SHA:
- Push completion timestamp:

## Post-Rollback Verification
- Vercel auto-build observed: Yes/No
- Deployment ready timestamp:
- Production alias verified: Yes/No
- Quick checks:
  - Eligible accept baseline restored: PASS/FAIL
  - Ineligible reject baseline behavior: PASS/FAIL
  - 5xx normalized: PASS/FAIL
  - Support spike stabilizing: PASS/FAIL
- Evidence links:

## Stabilization Confirmation
- Stabilization decision: Confirmed / Not confirmed
- Decision owner:
- Timestamp:
- Next action:

## Incident Logging Requirements
- Incident ID:
- Impact summary:
- Root-cause status: Unknown / Investigating / Identified
- Timeline log link:
- Follow-up owner:
- Retrospective due date:
