# Release Checklist

Status: target contract

Before release:

- architecture impact identified
- source-of-truth impact identified
- permission impact reviewed
- migration reviewed and reversible
- provider calls and idempotency reviewed
- webhook compatibility reviewed
- customer copy reviewed for plain language
- focused tests pass
- failure tests pass
- E2E scenarios pass where applicable
- production safety baseline updated
- rollback commit identified
- deployment environment verified
- post-deploy health checked

Never release a financial or state-machine change based only on a happy-path test.
