# PR-C Live Monitoring Checklist

## Monitoring Session Metadata
- Date:
- Timezone:
- Monitoring operator:
- Verifier:
- Support monitor:
- Decision owner:
- Support escalation owner:
- Deployment verifier:
- Deployment URL/ID:

## Vercel Deployment Verification
- Vercel auto-build observed: Yes/No
- Vercel deployment URL:
- Vercel deployment ID:
- Deployment ready timestamp:
- Production alias confirmed: Yes/No
- Verification result: PASS / FAIL
- Evidence screenshot/link:

## Dashboard Watchlist (Required)
- [ ] Accept-dispatch 403 rate dashboard open
- [ ] Accept failure rate dashboard open
- [ ] Dispatch conversion dashboard open
- [ ] Endpoint latency/error dashboard open
- [ ] Support contact dashboard open
- [ ] Stale offer anomaly view open
- [ ] Assignment integrity dashboard/query open

## Query Checklist
- [ ] Filter logs for /api/booking/accept-dispatch
- [ ] Segment by status code families (2xx/4xx/5xx)
- [ ] Group 4xx by error message pattern
- [ ] Track p95 latency and error bursts
- [ ] Correlate incidents to support contacts
- [ ] Verify assignment integrity invariants (single owner, no duplicate assignment)

## Rollback Reference
- Rollback decision matrix: 03-pr-c-rollback-decision-matrix.md
- Rollback command ready: Yes/No
- Rollback authority acknowledged: Yes/No

## Time-Based Monitoring Log
### T-15 (Pre-merge baseline)
- 403 baseline:
- Failure baseline:
- Conversion baseline:
- p95 latency baseline:
- Support baseline:
- Notes:

### T+0 (Post-ready)
- 403:
- Failure rate:
- Conversion:
- p95 latency:
- Support mentions:
- Stale offer anomalies:
- Notes:

### T+15
- 403:
- Failure rate:
- Conversion:
- p95 latency:
- Support mentions:
- Stale offer anomalies:
- Notes:

### T+30
- 403:
- Failure rate:
- Conversion:
- p95 latency:
- Support mentions:
- Stale offer anomalies:
- Notes:

### T+60
- 403:
- Failure rate:
- Conversion:
- p95 latency:
- Support mentions:
- Stale offer anomalies:
- Notes:

### T+90
- 403:
- Failure rate:
- Conversion:
- p95 latency:
- Support mentions:
- Stale offer anomalies:
- Notes:

## Trigger Flags
- [ ] False-deny suspicion detected
- [ ] Accept 5xx spike detected
- [ ] Conversion drop detected
- [ ] Support spike detected
- [ ] Stale offer anomalies detected
- [ ] Assignment integrity anomaly detected

## Escalation Block
- Escalation required: Yes/No
- Escalated to:
- Timestamp:
- Reason:
- Action taken:
- Evidence links:
- Monitoring checkpoint result: PASS / FAIL
