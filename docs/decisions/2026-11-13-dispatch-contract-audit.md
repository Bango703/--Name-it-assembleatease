# Dispatch contract audit: current system vs. the Marketplace Geography, Eligibility & Dispatch Contract v1.0

Date: 2026-11-13. Status: audit complete; Phase 0 shipped; Phase 1 build next; four policy decisions open for the owner.

The contract (owner, 2026-11-13) is the target. This record measures the live code against it. Every finding below was checked in the repository or in production data (read-only), not inferred.

## Phase 0: defects found by the live end-to-end test (shipped)

| PR | Defect | Contract |
|---|---|---|
| #449 | Partner preferred-Easer list offered the App Review demo account and every Easer in Texas | Inv. 4 |
| #450 | Dispatch read the ZIP only from the address text. Customer-app bookings store it separately, so the market gate failed open: a San Antonio job could be offered statewide. 2 real bookings affected (AAE-URFQXEHY6M, AAE-QSLOVSUAQS) | Inv. 3, 4 |
| #451 | Edit Request changed the address but not the stored ZIP and city, so dispatch kept the old area | Inv. 3 |
| #452 | Unpriced custom quotes were locked against edits as if paid, and the confirm endpoint could confirm one into a job with no price | Inv. 8, 10 |
| #453 | A scope change left Easer prices for the old scope open and a sent quote link valid | Inv. 6, 8 |

## Invariant matrix

| # | Invariant | Status | Evidence |
|---|---|---|---|
| 1 | One canonical booking record and lifecycle | Met | `bookings` row; transitions guarded by `_workflow-engine.js`; dashboards read server lists (`test-live-ops-active-jobs`) |
| 2 | At most one active assignment (crews modelled separately) | Met | `assembler_id` single column, set by compare-and-set (`accept-dispatch.js` `.is('assembler_id', null)`); crews in `_crew.js` |
| 3 | ZIP is a postal attribute, not proof of coverage | Partial | Booking is open to any Texas ZIP and coverage is not promised, but two geography models disagree (below) and the market gate fails open on unknown ZIPs |
| 4 | No invitation without skills, coverage, eligibility, capacity | Partial | Readiness, market and daily cap enforced (`findEligibleEasers`); skills are optional work preferences that fail open; no travel radius or opt-in zones; no time-overlap check (daily cap only); unknown ZIP fails open |
| 5 | Invitation is not assignment; read is not acceptance | Met | Notifications open the offer only; acceptance is an explicit server call |
| 6 | Offers tied to a scope revision | Partial | Quote prices close on scope change (#453); job offers have no scope revision id |
| 7 | Payout, fees, tax, promos separate | Met | `computeBookingSplit`, tax pass-through, credits as payments, `financial_event_audit` |
| 8 | Customer price changes need agreement | Met | Quote approval flow; change orders; #453 |
| 9 | Transactional outbox, idempotent delivery | Partial | `notification_log` with keys, `notification-retries` cron, send governor; not a transactional outbox (sent after commit, recorded per attempt) |
| 10 | Server authorizes every transition | Met | Owner, Easer and customer endpoints verify; prices and splits server-side |
| 11 | Timeouts, retries, exception states, operations fallback | Partial | Offer TTL and retries, `needs_manual_dispatch`, unassigned escalation (3h, 6h, 2h); no reason codes separating out-of-area, no supply and offers exhausted |
| 12 | No silent coverage, status or pricing changes | Met | Owner actions are logged; flags gate new behaviour |

## Geography: what exists today (counted)

Server, `api/_source-of-truth.js`, three models:
1. `isTexasZip`: who may book (statewide). Defined twice (also `api/_booking-location.js`).
2. `AUTOMATIC_DISPATCH_ZIP_PREFIXES` (782, 787) plus 27 listed suburb ZIPs: which bookings auto-dispatch; everything else is `needs_manual_dispatch`.
3. `SERVICE_MARKETS` (central_texas 786/787, san_antonio 780/781/782, houston, dallas_fort_worth, lubbock, permian_basin): which Easers may get a job; `isSameServiceMarket` fails open when either ZIP is unknown.

Plus `_easer-coverage.js` `sameCoverageArea` (market, or 3-digit prefix when unknown): a fourth "same area" rule used for the customer coverage message.

Browser: `assets/js/booking-source-of-truth.js` mirrors model 2 (parity-tested); `book.html` re-implements `isAutomaticDispatchZip` from it; `assets/js/aae-location.js` keeps its own Austin-only served-ZIP list (San Antonio missing since 2026-09-23).

Consequences:
- Houston and Dallas-Fort Worth have active Easers but every booking there waits for manual assignment.
- Laredo (78040-78046) is outside auto-dispatch but inside the san_antonio market, so it would match San Antonio Easers if it were opened.
- An unknown ZIP on either side makes every Easer eligible.
- The coverage message and dispatch can disagree.

## Plan

Phase 1, coverage and eligibility as one service (build next, behaviour-preserving by default, flag-gated where policy changes):
1. `api/_coverage.js` (CoverageService): one market table with status (planned, limited, active, paused), prefixes, explicit ZIPs, excluded ZIPs, and auto-dispatch per market. `resolveServiceLocation(booking)` returns zip, city, market and a reason: `ADDRESS_REVIEW` (no usable ZIP), `OUTSIDE_SERVICE_AREA` (no market), `IN_MARKET`. The existing exports become thin wrappers so no caller changes behaviour.
2. One "same area" rule for dispatch, quote prices, partner accounts and the coverage message.
3. The browser reads the market table from the server (`/api/booking-config`); the hard-coded lists in `booking-source-of-truth.js`, `book.html` and `aae-location.js` become fallbacks covered by a parity test.
4. Dispatch reason codes recorded on the booking and shown in Live Ops: `ADDRESS_REVIEW`, `OUTSIDE_SERVICE_AREA`, `NO_ELIGIBLE_EASERS`, `OFFERS_EXHAUSTED`.
5. Strict eligibility (flag `DISPATCH_STRICT_COVERAGE`): unknown job ZIP or unknown Easer ZIP means no automatic offers; the booking goes to `ADDRESS_REVIEW` and the owner is alerted.

Phase 2: scope revisions on job offers (inv. 6); time-overlap check against confirmed jobs (inv. 4); acceptance re-checks market and work preferences.

Phase 3: address validation and geocoding with stored accuracy (contract section 2); Easer opt-in zones and travel limits; transactional outbox for essential notifications (inv. 9); versioned dispatch policy records.

## Decisions the owner must make (contract section 11.4)

1. Strict coverage: should an unknown ZIP stop automatic offers and go to address review? Recommended yes.
2. Open automatic dispatch in Houston and Dallas-Fort Worth, where Easers are active? Recommended yes, per market, after Phase 1 reason codes ship.
3. Remove Laredo (780xx) from the San Antonio market. Recommended yes.
4. Address validation provider (Google Address Validation has a per-request cost). Recommended for Phase 3, decided on cost.
