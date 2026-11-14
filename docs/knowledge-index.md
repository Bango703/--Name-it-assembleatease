# Knowledge index

Start every task here (`docs/process/deep-execution-protocol.md`, section 4). Read only what the task touches; inspect code when a document may be stale.

## Instructions
- `CLAUDE.md`: the constitution. Board, panel, 17 Articles, critical modules, enforcement. Governs.
- `AGENTS.md`: external-copy boundary, working rules, auditor brief.
- `docs/process/deep-execution-protocol.md`: how every change is executed, verified and recorded.

## State of the system
- `docs/current-state.md`: verified recent capabilities and limitations.
- `docs/work-in-progress.md`: active work, blockers, next action.
- `business-artifacts/backlog.md`: the single prioritized backlog.

## Business rules
- `docs/business-rules/dispatch-contract-v1.md`: geography, eligibility and dispatch target contract (proposed, owner, 2026-11-13).
- `docs/platform/00-PLATFORM-CONSTITUTION.md`, `docs/platform/10-SOURCE-OF-TRUTH.md`: who owns each fact.

## Decisions
- `docs/decisions/2026-11-13-dispatch-contract-audit.md`: current system measured against the dispatch contract; Phase 1 to 3 plan; open owner decisions.

## Incidents
- `docs/incidents/2026-11-13-live-e2e-dispatch-and-quote-defects.md`: five defects found by the live hybrid test (#449 to #453), causes and prevention.
- `docs/incidents/2026-11-13-easer-price-request-page.md`: the Easer price-request page did not say where a request stood; server stages and the rebuilt page.

## Architecture (docs/platform)
By area. Each file states its own "As of" date; check code when it is old.
- Domain and data: `01-SYSTEM-CONTEXT.md`, `04-DOMAIN-MAP.md`, `05-DATA-MODEL.md`, `06-STATE-MACHINES.yaml`, `20-BOOKING-LIFECYCLE.md`.
- Dispatch: `19-DISPATCH-ARCHITECTURE.md`, `19-DISPATCH-REVIEW.md`, `14-DUPLICATE-PATH-REGISTER.md`.
- Money: `16-PAYMENT-ARCHITECTURE.md`, `17-FINANCIAL-LEDGER.md`, `18-EASER-PAYOUTS.md`, `05-FINANCIAL-CONTRACT-STATUS.md`.
- Events and notifications: `06-EVENT-OUTBOX-BOUNDARY.md`, `07-EVENT-CATALOG.yaml`, `12-NOTIFICATION-MATRIX.yaml`, `25-NOTIFICATION-POLICY.md`.
- Security and audit: `11-PERMISSION-MATRIX.yaml`, `26-SECURITY-MODEL.md`, `27-AUDIT-MODEL.md`.
- Operations: `14-FAILURE-MATRIX.md`, `23-WORKER-CATALOG.yaml`, `24-SCHEDULER-CATALOG.yaml`, `28-OBSERVABILITY.md`, `29-DISASTER-RECOVERY.md`.
- Testing and release: `34-TEST-STRATEGY.md`, `35-E2E-SCENARIO-CATALOG.md`, `36-RELEASE-CHECKLIST.md`.
- Product surfaces: `30-OWNER-IA.md`, `31-CUSTOMER-IA.md`, `32-EASER-IA.md`, `33-DESIGN-SYSTEM.md`.

## Code anchors (verify before relying on them)
- Geography today: `api/_source-of-truth.js` (`isTexasZip`, `AUTOMATIC_DISPATCH_*`, `SERVICE_MARKETS`), `api/_booking-location.js`, `api/_easer-coverage.js`, `api/booking/_dispatch-internal.js` (`bookingLocation`, `findEligibleEasers`).
- Custom quotes and Easer prices: `api/booking/_quote-state.js`, `api/booking/_quote-offers.js`, `api/booking/_quote-offer-invites.js`, `api/owner/quote-approve.js`.
- Partner accounts: `api/_partners.js`, `api/owner/partners.js`, `api/_promotions.js`.
