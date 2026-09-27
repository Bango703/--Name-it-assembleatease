# Owner Rejection Audit Plan

Status: deferred implementation plan
As of: 2026-09-24

## Why This Is Deferred

Current owner handlers use a flat owner authorization gate and do not share a request-context/audit-rejection helper. Adding isolated audit calls to individual handlers would create another logging variation and risk false completeness.

## Required First Boundary

Create one server-side helper with:

```text
actor
role
action
resource
resource_id
result: rejected | failed
failure_code
reason
request_id
financial_impact
```

The helper must be non-fatal to the original rejection, redact sensitive values, and write to the appropriate durable audit channel.

## Initial Scope

Start with high-risk finance actions:

- manual refund
- payout review
- manual payment record
- price/financial adjustments

Then extend to:

- case transitions
- reassignment
- suspension
- permission changes
- evidence review

## Proof Required

- Rejected action creates exactly one audit record.
- Successful action does not create a duplicate rejection record.
- Audit write failure is visible but does not turn a correct rejection into success.
- Actor, role, request ID, reason, and resource scope are server-derived.
