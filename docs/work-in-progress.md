# Work in progress

Last verified: 2026-11-13. Active work only; the full prioritized backlog is `business-artifacts/backlog.md`. Check each item against the code before resuming: this record is not proof that anything was implemented.

## 1. Dispatch contract, Phase 1: one coverage service
- Objective: make geography and eligibility one service, per `docs/business-rules/dispatch-contract-v1.md`.
- Approved scope: audit done (`docs/decisions/2026-11-13-dispatch-contract-audit.md`). Owner asked for it to be fully built and retested until green. Policy changes (strict coverage, opening Houston and DFW, removing Laredo) await explicit owner approval (contract 11.4) and ship behind switches.
- State: not started in code.
- Next action: build `api/_coverage.js` with the existing exports as wrappers (no behaviour change), move every caller, add reason codes, then the browser reads the market list from the server.

## 2. Easer price-request page rebuild
- Objective: the owner, as an Easer, found the page basic and unclear, and a sent price stayed on screen as a form (`docs/incidents/2026-11-13-easer-price-request-page.md`).
- State: built on branch `feat/easer-price-request-experience`; `test-hybrid-offers` and the phone Playwright spec pass locally.
- Next action: owner approval to push and merge, then check the page live with the owner's Easer account on AAE-DMA4UGNPV2.

## 3. Live end-to-end test of the hybrid marketplace
- Booking AAE-DMA4UGNPV2 (owner's test inbox, marked as a test). It found the five defects in `docs/incidents/2026-11-13-live-e2e-dispatch-and-quote-defects.md`.
- State: address moved to 78701 (`service_zip`, `service_city` updated, verified); only the owner's Easer account was asked; it priced $1,500 earnings, 7 hours, crew of 1; the server priced the quote at $2,142.86 + $176.79 tax = $2,319.65 (verified). Quote not sent yet.
- Found on the way, not fixed yet: Live Ops "Bookings needing action" labels the unpriced quote "Unknown Payment State" (another reader of the `not_required` quote state); the owner's ask list shows the Easer city in capitals (`askableEaserView`).
- Next action: send the quote from the Easer's price, owner approves with a card, verify the hold and records and that the job is offered to that Easer first, owner cancels.

## 4. Waiting on the owner
- Policy decisions 1 to 4 in the audit record.
- Checkr account, package choice, API key and webhook secret, before the background-check integration is built.

## Planned next
- Automatic asking of Easers on new custom quotes, behind a switch (owner pricing stays manual).
