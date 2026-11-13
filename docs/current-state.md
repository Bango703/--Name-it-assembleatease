# Current state

Last verified: 2026-11-13. Each line was checked in code, CI, the live site or production data (read-only) on that date. Detailed architecture is in `docs/platform/`; this file records recent, verified capabilities and limitations only. Correct it when they change.

## Live and verified
- **Hybrid marketplace, Easer price offers on custom quotes** (#445, #448, #453 pending): the owner asks the eligible Easers they tick; Easers answer privately (earnings, hours, crew); the owner sends one server-priced quote (`prepare_hybrid_quote`, fee on top). Switch `PRIVATE_EASER_OFFERS_ENABLED=true` in Vercel Production. Migration 129 applied and verified in production.
- **Partner accounts** (#445, #448, #449): account code and link with 0-20% off the catalog through the normal checkout, preferred Easers (local first, no demo accounts), card per job, account report. Switch `COMMERCIAL_ACCOUNTS_ENABLED=true` in Vercel Production.
- **Dispatch places a job by its stored ZIP** (#450). Edited addresses update the stored ZIP, city and state and must include a ZIP (#451).
- **Unpriced custom quotes** can be edited before pricing and cannot be confirmed without a price (#452).
- **Customer receipt**: one black-and-white receipt for both completion paths (`api/booking/_receipt.js`, #447).
- **Easer application fee**: non-refundable for new payments, consent version `...-2026-11-12-nonrefundable-v2`; legacy-terms payments are still refunded on rejection (#447). Migration 130 applied and verified. The fee is $0 in every hub until it has six active Easers (`applicationFeeDecision`; `/api/assembler/application-fee-status` returned a waiver for 78701 on 2026-11-13).
- **Browser tests** run on every PR: 21 Playwright tests including the owner hybrid flow and the Easer price page on a phone viewport.
- **Easer iPhone app**: build #35 uploaded to TestFlight on 2026-11-13 (not submitted for review).

## Known limitations (verified)
- Four different "same area" rules: automatic-dispatch ZIPs, service markets, `isTexasZip` (defined twice) and `_easer-coverage.js`; browser copies in `booking-source-of-truth.js`, `book.html` and `aae-location.js` (Austin only). Details: `docs/decisions/2026-11-13-dispatch-contract-audit.md`.
- Houston and Dallas-Fort Worth bookings wait for manual assignment although those markets have active Easers.
- `isSameServiceMarket` fails open when either ZIP maps to no market.
- Custom-quote price requests are owner-triggered; no automatic asking.
- No time-overlap check between jobs (daily cap only); no Easer travel radius or opt-in zones; no address validation or geocoding.
- Not built: net-30 partner invoicing, per-item partner price sheets, native Easer price-request screen, Checkr background checks.
