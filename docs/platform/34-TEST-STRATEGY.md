# Test Strategy

Status: target contract

Validation ladder:

```text
unit -> domain -> database -> integration -> contract -> security -> failure injection -> E2E -> visual -> live synthetic
```

Financial, permission, webhook, payout, and completion changes require domain, database, integration, contract, security, failure, and E2E proof before release.

Current repository has extensive script-based regression tests but lacks a complete three-role E2E environment. That gap is tracked, not hidden.
