# Contract Test Backlog

Status: Phase 4/5 planning
As of: 2026-09-24

These tests must be added before consolidating duplicate paths or changing owner operations.

## Financial

- Same-day fee split parity between owner and Easer completion.
- Tax excluded from Easer payout basis.
- AssembleCash redemption does not reduce Easer payout basis.
- Assignment fee snapshot remains stable through completion.
- Capture requires valid `requires_capture` provider truth.
- Capture timeout creates reconciliation, not duplicate capture.
- Repeated completion returns the original trusted result.
- Payout is blocked by dispute, damage, evidence, reconciliation, or Connect readiness.
- Payout transfer is idempotent and distinguishes transfer from bank payout.
- Refund amount never exceeds remaining refundable amount.
- Refund unknown outcome is reconciled before retry.

## Lifecycle

- Booking state reachability matches the workflow graph.
- Decline is terminal and documented.
- Refund payment state does not silently become booking status.
- Owner completion override accepts supplied-on-behalf evidence only with owner permission and audit.
- Easer completion requires assignment-scoped evidence.
- Dispatch and execution state axes do not regress each other.
- Reassignment preserves prior assignment history.
- Offer acceptance race yields exactly one winner.

## Security and Operations

- Rejected high-risk owner action is audited.
- Customer ownership check rejects another customer's booking.
- Easer assignment check rejects unrelated job access.
- Owner finance action requires finance permission once role permissions exist.
- Webhook duplicate is acknowledged without repeating mutation.
- Webhook out-of-order event cannot regress state.
- Notification type taxonomy stays in parity across callers, JS policy, SQL, and registry.

## Release Rule

A runtime consolidation is not ready until the affected contract tests pass and a production rollback point exists.
