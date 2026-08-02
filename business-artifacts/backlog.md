# AssembleAtEase — Single Prioritized Backlog

The one source of truth for tracked work. Owned by the Product Manager seat (see CLAUDE.md → Backlog Discipline). Priority-ordered. Nothing is left as "maybe later" — every deferral lives here. Capturing an item does **not** mean building it now; the "first 25 jobs" stage gate and the Executive Board decide sequence. Distribution and completion outrank expansion.

**Legend:** `[ ]` open · `[~]` in progress · `[x]` verified complete (shipped + validated). P0 = launch/money/security · P1 = trust/conversion/ops · P2 = polish.

_Last reconciled: 2026-08-02_

---

## Now (top of stack)

- [~] **P1 · Distribution — work the move-in / referral channel for 30 days** _(CEO, VP Marketing)_
  Demand is the real bottleneck, not code. Kit is built (see Done). **Owner action:** approach top-2 partners (apartment/property managers, realtors), leave 5–10 QR counter-cards each, and track completed bookings with `utm_source=partner`. Double down on whichever partner drives the first jobs. This is where the first 25 jobs come from.

## Mobile (P1 — 90% of traffic)

- [ ] **P2 · Verify Easer login + my-assignments responsiveness** _(UX)_ — `assembler/index.html` (login) has 0 media queries; `my-assignments.html` has 1. Likely fluid/mobile-first but spot-check on a real phone for overflow/hierarchy.
- _(New deep-audit findings appended below as they are confirmed — whole-site mobile pass, booking-first.)_

## Trust & communication (P1)

- [ ] **P1 · SMS notifications + consent** _(CX, Ops, Security)_
  Zero SMS in 200 routes; home-services customers live in texts ("your pro is on the way"). Stage-appropriate: add an SMS-consent checkbox on booking **now** (so no re-consent later); owner texts manually at "en route" for the first jobs; wire a provider post-validation.
- [ ] **P1 · Customer-facing "en route" status on /track** _(CX)_
  `/track` is manual-refresh, no ETA. Owner/Easer-driven status the customer can see + the SMS above closes most of the anxiety gap without realtime infra.
- [ ] **P1 · Step-level booking funnel analytics** _(Data, PM)_
  Can't currently prove where people drop across the 4 booking steps. Add GA4 step events **before** touching the flow. Optimize with data, not vibes.

## Polish & positioning (P2)

- [ ] **P2 · Hero trust trio** _(Growth)_ — "Upfront price · Pay after completion · Vetted local pro" as a 3-item row; that trio is the wedge vs Thumbtack/Angi.
- [ ] **P2 · Completion after-photos in the customer email** _(CX)_ — evidence exists (`_completion-evidence.js`); send it to the customer as a referral trigger.
- [ ] **P2 · Reviews → meta title + `aggregateRating` JSON-LD** _(Growth)_ — real reviews exist; surface the star count for SEO/CTR.
- [ ] **P2 · Booking step-numbering cruft cleanup** _(VP Engineering)_ — dead comments ("Step 2 removed", "Step 5 rendered") vs live "of 4"; hygiene, not customer-facing.

## Done (verified)

- [x] **P1 · Mobile — homepage pinch-zoom re-enabled** — removed `maximum-scale=1` from `index.html` viewport (was the only page of 339 blocking zoom; WCAG 1.4.4). _2026-08-02._
- [x] **P2 · Mobile — waitlist input iOS-zoom fixed** — added `.waitlist-input` to the mobile 16px guard ([marketing.css:224](marketing.css#L224)). _2026-08-02._
- [~] **Corrected (no change needed) · Easer field-input iOS zoom** — false alarm: `easer.css` already forces `input`/`select`/`textarea` to 16px under `@media (max-width:899px)` (lines 816–821), and all Easer pages load easer.css. No fix applied.
- [x] **P1 · Partner outreach kit + move-in QR counter-card built** — pitch, target list, and email/DM templates at [business-artifacts/partner-outreach-kit.md](partner-outreach-kit.md); print-ready 5×7 counter-card with a real scannable QR (segno v5) → `/book?bundle=move-in-ready&utm_source=partner`, published as a private artifact. Enables the distribution item above. _2026-08-02._
- [x] **P1 · Booking — card billing-address AVS false declines fixed** — removed the service `address` block from Stripe `billing_details` in both checkout paths ([book.html:7394](../book.html#L7394) quote/scheduled + immediate payment); billing_details now carries name/email/phone only. Service address still sent to the booking API. Stripe Radar + manual capture still protect. _Shipped 2026-08-02; surgical 2-block diff, smoke PASS, governance 371/371._
- [x] **P1 · Homepage re-assembly guarantee surfaced** — "Assembled right, or we come back free." added to desktop + mobile hero. _Shipped ff5d0e3f; governance 371/371, smoke PASS._
- [x] **P1 · Hero teal drift fixed** — mint-green `#5eead4` pulse dot → sky-blue `#8fe8ff`. _Shipped ff5d0e3f; verified 0 remaining `#5eead4`._
- [x] **P2 · LinkedIn in Organization JSON-LD `sameAs`** — added to homepage + About. _Shipped ff5d0e3f._
- [x] **P2 · Footer social logo icons (Facebook + LinkedIn)** — governed footer across 356 pages. _Shipped eb86f36b._
