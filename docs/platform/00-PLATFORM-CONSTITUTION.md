# AssembleAtEase Platform Constitution

Status: governing architecture contract
As of: 2026-09-24

## Principles

1. Money, identity, permissions, and state transitions are treated as correctness boundaries.
2. Every external input is untrusted.
3. Every financial mutation is idempotent, audited, and reconciled.
4. Every resource read or write is ownership- or assignment-checked.
5. Customer-facing language is plain and does not expose internal mechanics.
6. Provider truth, platform state, ledger state, earning state, and payout state remain distinct.
7. Existing behavior is preserved until replacement behavior has equivalent tests.
8. Documentation registries describe reality and label target work explicitly.
9. No destructive migration, route removal, or provider change happens without review and rollback.
10. A feature is incomplete until its failure, retry, notification, audit, and test behavior are defined.

## Change Safety

- Inventory first.
- Make the smallest reversible change.
- Run focused validation immediately after edits.
- Keep unrelated working-tree changes untouched.
- Never claim production success without fresh verification.
