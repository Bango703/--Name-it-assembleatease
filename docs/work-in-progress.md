# Work in progress

Last verified: 2026-11-13. Active work only; the full prioritized backlog is `business-artifacts/backlog.md`. Check each item against the code before resuming: this record is not proof that anything was implemented.

## 0. Review request email (owner, 2026-11-17)
- Objective: the owner found the review email bare and unlike the rest; research how real review requests look and rebuild it (`docs/incidents/2026-11-17-review-email-look.md`).
- State: #461 merged and live 2026-11-17. The owner's first check was refused (test bookings get no review mail; the dashboard hid the reason). Fix built on `fix/review-request-reasons` in worktree `aae-review-reasons`.
- Next action: owner's word to push and merge, then Request Review on AAE-GX0XLYQM or AAE-4NSSNOA (both send to an @assembleatease.com inbox) and a star tapped through to /review.

## 1. Dispatch contract, Phase 1: one coverage service
- Objective: make geography and eligibility one service, per `docs/business-rules/dispatch-contract-v1.md`.
- Approved scope: audit done (`docs/decisions/2026-11-13-dispatch-contract-audit.md`). Owner asked for it to be fully built and retested until green. Policy changes (strict coverage, opening Houston and DFW, removing Laredo) await explicit owner approval (contract 11.4) and ship behind switches.
- State: not started in code.
- Next action: build `api/_coverage.js` with the existing exports as wrappers (no behaviour change), move every caller, add reason codes, then the browser reads the market list from the server.

## 2. Easer price-request page rebuild
- Objective: the owner, as an Easer, found the page basic and unclear, and a sent price stayed on screen as a form (`docs/incidents/2026-11-13-easer-price-request-page.md`).
- State: built on branch `feat/easer-price-request-experience`; `test-hybrid-offers` and the phone Playwright spec pass locally. Owner then asked (2026-11-13) for a text when an Easer's price is approved: built on the same branch (text, push, email once per offer; the owner's toast reports whether the Easer was reached).
- Next action: owner approval to push and merge, then check the page live with the owner's Easer account on AAE-DMA4UGNPV2.

## 3. Live end-to-end test of the hybrid marketplace
- Booking AAE-DMA4UGNPV2 (owner's test inbox, marked as a test). It found the five defects in `docs/incidents/2026-11-13-live-e2e-dispatch-and-quote-defects.md`.
- State: address moved to 78701 (`service_zip`, `service_city` updated, verified); only the owner's Easer account was asked; it priced $1,500 earnings, 7 hours, crew of 1; the server priced the quote at $2,142.86 + $176.79 tax = $2,319.65 (verified). Quote not sent yet.
- Found on the way, not fixed yet: Live Ops "Bookings needing action" labels the unpriced quote "Unknown Payment State" (another reader of the `not_required` quote state); the owner's ask list shows the Easer city in capitals (`askableEaserView`).
- Next action: send the quote from the Easer's price, owner approves with a card, verify the hold and records and that the job is offered to that Easer first, owner cancels.

## 3a. Pricing model v1
- Objective: owner, 2026-11-13: high demand, affordable, out-do every competitor. Foundation in `docs/business-rules/pricing-model-v1.md`, evidence in `docs/decisions/2026-11-13-custom-quote-take-rate-research.md`.
- State: owner approved section 4 on 2026-11-13. Stepped fee, card processing in the price, owner fee control, profit floor and quote record built on branch `docs/pricing-model` behind `QUOTE_FEE_SCHEDULE=stepped`; migration 131 written and tested locally, not applied.
- Next action: owner approves running migration 131 (after comparing the two functions with the production definitions), merge, set `QUOTE_FEE_SCHEDULE=stepped` in Vercel, send one real quote. Then the price-per-person-hour flag, the "Price is too high" re-quote and the AI quote advisor.

## 3b. Owner console revamp
- Objective: owner, 2026-11-13: the owner dashboard like the four reference images, fully working, nothing broken.
- State: Phase 1 (frame and Bookings) built on branch `feat/owner-dashboard-revamp`, stacked on `docs/pricing-model`; launch suite, 26 browser tests and governance:truth pass locally.
- Phase 2 (Financials) built: Overview from server figures (`monthly`, `breakdown`, `easerEarnings`); launch suite, 28 browser tests and governance:truth pass locally.
- Phase 3 (Cases) built; launch suite, 30 browser tests and governance:truth pass locally.
- Phase 4 (Market Demand) built; launch suite, 31 browser tests and governance:truth pass locally.
- Live since #456; the five fixes from the owner's live review shipped in #457 (2026-11-15).
- Phase 5 (every remaining screen, owner 2026-11-16) built on branch `feat/owner-console-all-screens` in worktree `aae-console-all`: Live Ops, Today, Messages, Phone Calls, Easers, Easer Waitlist, Customers, Partners, Gift Cards, Thumbtack, Reviews, Website Photos, Marketing, AI Intelligence on the frame through `owner/assets/console-frame.js`; Today schedule order fixed on the server and the screen. Launch suite, 46 browser tests and governance:truth pass locally.
- Thumbtack retired (owner, 2026-11-16) on branch `chore/remove-thumbtack`, stacked on the console branch: tools removed, the past Thumbtack job kept; see backlog THUMBTACK-RETIRED.
- Merged: #459 and #460 (2026-11-17).
- Next action: check every screen with the owner's real data once signed in. Owner: switch off the Thumbtack webhook and delete `THUMBTACK_WEBHOOK_USERNAME` and `THUMBTACK_WEBHOOK_PASSWORD` in Vercel.

## 4. Waiting on the owner
- Policy decisions 1 to 4 in the audit record.
- Checkr account, package choice, API key and webhook secret, before the background-check integration is built.

## Planned next
- Automatic asking of Easers on new custom quotes, behind a switch (owner pricing stays manual).
