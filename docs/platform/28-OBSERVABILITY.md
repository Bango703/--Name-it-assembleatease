# Observability

Status: target contract mapped to current logs and dashboards
As of: 2026-09-24

## Service Metrics

- API latency p50/p95/p99
- API error rate by route and status
- queue depth and oldest queued job
- worker throughput and failure rate
- webhook failures and signature failures
- provider latency and timeout rate
- database connections, lock time, slow queries, and rollbacks
- storage upload and signed URL errors

## Business Alerts

- payment double-processing risk
- reconciliation mismatch
- authorization expiry risk
- capture failure
- payout failure
- unassigned job
- Easer late/no-show
- evidence upload failure
- SMS/email delivery failure
- worker failure and dead letter

Every alert should identify affected resource, severity, owner action, created time, acknowledgement, resolution, and correlation/request ID.
