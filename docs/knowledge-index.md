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
- `docs/business-rules/pricing-model-v1.md`: pricing foundation: lowest final price among trusted options, catalog rules, stepped fee on custom quotes, how Easers price, what agents may adjust (proposed, 2026-11-13; numbers await owner approval).
- `docs/platform/00-PLATFORM-CONSTITUTION.md`, `docs/platform/10-SOURCE-OF-TRUTH.md`: who owns each fact.

## Decisions
- `docs/decisions/2026-11-13-dispatch-contract-audit.md`: current system measured against the dispatch contract; Phase 1 to 3 plan; open owner decisions.
- `docs/decisions/2026-11-13-custom-quote-take-rate-research.md`: competitor fees, take rates, cost per job, price sensitivity, Austin prices; evidence for the pricing model.

## Incidents
- `docs/incidents/2026-11-13-live-e2e-dispatch-and-quote-defects.md`: five defects found by the live hybrid test (#449 to #453), causes and prevention.
- `docs/incidents/2026-11-15-owner-console-live-review.md`: five problems the owner found in the live console (Messages off-screen, waitlisted onboarding refused, .webp on Google, squeezed items, cramped Market Demand).
- `docs/incidents/2026-11-16-today-schedule-order.md`: Today and the Live Ops Today panel listed 11:00 AM above 8:00 AM; clock order on the server and the screen.
- `docs/incidents/2026-11-17-review-email-look.md`: the review request was a bare page outside the shared email frame with the ask buried; research on how review requests look; stars that open /review with the rating chosen.
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
- Owner console frame: `owner/assets/console-frame.js` (number cards, tabs with counts; every screen builds them here), styles in `owner/assets/console.css` ("every screen"); each card is the length of the list it opens (`tests/e2e/owner-console-screens.spec.mjs`).
