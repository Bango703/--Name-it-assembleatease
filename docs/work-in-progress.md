# Work in progress

Last verified: 2026-11-13. Active work only; the full prioritized backlog is `business-artifacts/backlog.md`. Check each item against the code before resuming: this record is not proof that anything was implemented.

## 1. Dispatch contract, Phase 1: one coverage service
- Objective: make geography and eligibility one service, per `docs/business-rules/dispatch-contract-v1.md`.
- Approved scope: audit done (`docs/decisions/2026-11-13-dispatch-contract-audit.md`). Owner asked for it to be fully built and retested until green. Policy changes (strict coverage, opening Houston and DFW, removing Laredo) await explicit owner approval (contract 11.4) and ship behind switches.
- State: not started in code.
- Next action: build `api/_coverage.js` with the existing exports as wrappers (no behaviour change), move every caller, add reason codes, then the browser reads the market list from the server.

## 2. PR #453: a quote scope change invalidates old prices and links
- State: CI green, mergeable, awaiting the owner's "merge 453".

## 3. Live end-to-end test of the hybrid marketplace
- Booking AAE-DMA4UGNPV2 (owner's test inbox, marked as a test). It found the five defects in `docs/incidents/2026-11-13-live-e2e-dispatch-and-quote-defects.md`.
- State: paused after #452 so the booking can be moved to an Austin address (now possible) and priced by the owner's own Easer account.
- Next action: move the address in the dashboard, confirm `service_zip` changes, ask only the owner's Easer account, owner prices on the phone, send the quote, owner approves with a card, verify the hold and records, owner cancels.

## 4. Waiting on the owner
- Policy decisions 1 to 4 in the audit record.
- Checkr account, package choice, API key and webhook secret, before the background-check integration is built.

## Planned next
- Automatic asking of Easers on new custom quotes, behind a switch (owner pricing stays manual).
