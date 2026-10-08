# Owner Rejection Audit Matrix

Status: Phase 9 contract review
As of: 2026-09-24

## Current Gap

High-risk owner operations generally audit successful mutations but many precondition rejections return without a queryable audit/activity/case event.

| Operation | Successful audit | Rejected-path audit |
|---|---|---|
| Case action | operations case events | incomplete |
| Payout review | activity/audit events | incomplete |
| Manual refund | financial audit processing/success | failure closure and guards incomplete |
| Manual payment record | activity on success and notification failure | financial guard rejection incomplete |
| Evidence supplied on behalf | activity and evidence record | upload/record failure is operationally logged but not unified |

## Required Rejection Event

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
created_at
```

## Priority

1. Close manual refund processing audit when Stripe throws.
2. Add rejection audit for high-risk finance actions.
3. Add rejection audit for payout review and damage-review gates.
4. Add role-aware permission audit after owner roles exist.

This is a target contract. No runtime behavior changes are authorized by this document alone.
