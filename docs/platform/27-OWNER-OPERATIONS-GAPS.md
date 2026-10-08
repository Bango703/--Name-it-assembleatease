# Owner Operations Gaps

Status: Phase 9 review, no runtime changes
As of: 2026-09-24

## Confirmed Controls

- Owner endpoints require `verifyOwner`.
- Financial actions use financial-operation locks and expected-state CAS guards.
- Case transitions use expected-status checks and database transition RPCs.
- Successful operations write activity, case-event, or financial-audit records.
- Evidence sharing demotes sibling evidence before promotion.

## Critical Gaps

### Rejected high-risk actions are not consistently audited

Rejected case actions, payout-review actions, and related 400/409/403 paths often return without an audit/activity record. This conflicts with the audit model rule that rejected high-risk attempts are auditable.

Required future audit fields include actor, role, action, resource, resource ID, reason, result, failure code, request ID, and financial impact where applicable.

### Owner permissions remain flat

The target permission matrix defines `owner_finance`, `owner_dispatch`, `owner_support`, and `owner_admin`, but current owner authorization is primarily a single `verifyOwner` gate. Do not grant role-specific permissions until a migration and permission test exist.

### Support SLA is documented but not implemented

Operations cases have severity and state, but no verified due-by/SLA/escalation timer contract exists.

### Recommended action is not first-class

Case APIs expose valid action menus, but do not identify one recommended next action. Owner UI cleanup should add a policy-derived recommendation rather than guessing in the frontend.

## Safest Next Contract Test

Exercise rejected high-risk owner actions with stale state, missing acknowledgement, dispute hold, or permission denial and assert:

- no unauthorized financial mutation;
- rejection reason is explicit;
- audit/event record is attempted with result `rejected`;
- request correlation is preserved;
- owner UI receives one actionable explanation.
