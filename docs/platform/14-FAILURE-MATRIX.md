# Failure Matrix

Status: target contract
As of: 2026-09-24

| Failure | Retry | State action | Owner action |
|---|---|---|---|
| Network timeout | Yes, bounded | Keep pending/unknown | Reconcile after retry exhaustion |
| Provider 5xx | Yes, idempotent | Keep prior state | Alert after threshold |
| Card declined | No blind retry | Payment action required | Send customer recovery |
| Authorization expired | Reauthorize safely | Hold completion/payout | Send recovery link and alert |
| Capture unknown | No duplicate capture | Reconcile provider truth | Review payment state |
| Refund unknown | No duplicate refund | Refund pending | Reconcile provider truth |
| Payout failure | Retry if safe | Payout failed/on hold | Owner alert and Easer action if needed |
| Invalid permission | No retry loop | Reject and audit | Review configuration |
| Invalid webhook | Dead-letter | No state mutation | Owner/system alert |
| Duplicate event | Acknowledge | No duplicate side effect | Log dedupe |
| Database unavailable | Retry bounded | No false success | System alert |
| Worker crash | Resume from lease/outbox | Preserve pending work | System alert after threshold |
| Evidence upload failure | Retry/replacement | Preserve completion path | Support fallback and owner alert |
