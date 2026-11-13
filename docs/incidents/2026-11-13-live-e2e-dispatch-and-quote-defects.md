# 2026-11-13: defects found by the live end-to-end test of the hybrid marketplace

Trigger: the owner asked for a full live test of Easer price offers and partner accounts. The live run on test booking AAE-DMA4UGNPV2 (owner's test inbox, marked as a test) and the audit that followed found five defects in production. None were visible in the local demo, which used made-up data.

| PR | Defect | Root cause | Fix | Regression test |
|---|---|---|---|---|
| #449 | The partner preferred-Easer list offered the App Review demo account and every active Easer in Texas | The roster query took every active Easer; demo accounts and markets were not considered | Roster leaves out demo accounts (`loadDemoEaserIds`); Easers in the partner's market first, others folded under "Other areas" | `scripts/test-hybrid-offers.mjs`, `tests/e2e/hybrid-marketplace.spec.mjs` |
| #450 | A customer-app booking in San Antonio could be offered to any Easer in Texas | App bookings store the street address without city or ZIP and keep `service_zip` separately. Dispatch read the ZIP only from the address text, found none, and `isSameServiceMarket` fails open on an unknown ZIP. Two real bookings were affected (AAE-URFQXEHY6M, AAE-QSLOVSUAQS) | `bookingLocation()` in `_dispatch-internal.js` uses the shared `parseServiceLocation` (stored ZIP first) | `scripts/test-dispatch-market-gate.mjs` |
| #451 | Correcting an address left the old ZIP behind | `edit-booking.js` wrote `address` only; nothing kept `service_zip`, `service_city` and `service_state` in step | Edited addresses update all three and must carry a ZIP (`ADDRESS_ZIP_REQUIRED`) | `scripts/test-owner-edit-notification-preference.mjs` |
| #452 | An unpriced custom quote could not be edited, and the confirm endpoint could confirm one into a job with no price | On 2026-10-21 unpriced quotes moved to `payment_status 'not_required'` (card at approval). `edit-booking.js` (`hasBookingPaymentState`) and `confirm.js` were not updated | Both use the shared `isQuoteAwaitingPrice` | `scripts/test-owner-edit-notification-preference.mjs`, `scripts/test-quote-not-a-job.mjs` |
| #453 | Editing a quote's scope left Easer prices for the old scope open and a sent quote's approval link valid | The edit path had no notion of a scope revision; #452 opened the edit path without closing this | A change to service, address or job details closes open price requests, clears the description and any chosen price, and stops a sent quote's link | `scripts/test-owner-edit-notification-preference.mjs` |

## Pattern

Four of the five are the same failure: one fact read from two places, or a state change whose readers were not all updated. That is CLAUDE.md Articles 2 and 3 and the "find every reader" rule.
- #450 and #451: the job's location existed both as address text and as stored columns, and different code trusted different ones.
- #452: a payment-state value changed meaning and two readers kept the old meaning.
- #453: an edit path changed scope without reaching the records priced for that scope.

## Prevention
- Geography is the largest remaining instance: four "same area" rules (see `docs/decisions/2026-11-13-dispatch-contract-audit.md`). Phase 1 makes it one service.
- When a stored state changes meaning, grep every reader of that value before merging (`git grep "'value'"`), and add the new state to the shared predicate rather than to each reader.
- When a new edit path opens, list what was derived from the edited fields (prices, offers, links, snapshots) and decide for each one whether it closes, updates or blocks.
