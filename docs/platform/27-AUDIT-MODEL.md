# Audit Model

Status: target contract
As of: 2026-09-24

Audit event fields:

```text
actor
role
action
resource
resource_id
before
after
reason
timestamp
ip
request_id
result
failure_code
booking_id
customer_id
easer_id
financial_impact
provider_event_id
idempotency_key
```

Rules:

- Actor and role are server-derived.
- Before/after values are server snapshots.
- Sensitive tokens, secrets, payment credentials, and unnecessary PII are redacted.
- Rejected high-risk actions are audited too.
- Human audit, domain events, provider events, and owner timeline events remain distinct.
- Financial corrections are append-only and link the correction to the original.
