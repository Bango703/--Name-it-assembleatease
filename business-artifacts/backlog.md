# AssembleAtEase — Single Prioritized Backlog

The one source of truth for tracked work. Owned by the Product Manager seat (see CLAUDE.md → Backlog Discipline). Priority-ordered. Nothing is left as "maybe later" — every deferral lives here. Capturing an item does **not** mean building it now; the "first 25 jobs" stage gate and the Executive Board decide sequence. Distribution and completion outrank expansion.

**Legend:** `[ ]` open · `[~]` in progress · `[x]` verified complete (shipped + validated). P0 = launch/money/security · P1 = trust/conversion/ops · P2 = polish.

_Last reconciled: 2026-08-02_

---

## Now (top of stack)

- [ ] **P1 · Distribution — pick ONE channel and work it 30 days** _(CEO, VP Marketing)_
  Demand is the real bottleneck, not code. Start with move-in / realtor / apartment referrals (Bundles + Move-In Pass are built for it). Deliverable: one-page outreach pitch + QR counter-card → `/book`. This is where the first 25 jobs come from.

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

- [x] **P1 · Booking — card billing-address AVS false declines fixed** — removed the service `address` block from Stripe `billing_details` in both checkout paths ([book.html:7394](../book.html#L7394) quote/scheduled + immediate payment); billing_details now carries name/email/phone only. Service address still sent to the booking API. Stripe Radar + manual capture still protect. _Shipped 2026-08-02; surgical 2-block diff, smoke PASS, governance 371/371._
- [x] **P1 · Homepage re-assembly guarantee surfaced** — "Assembled right, or we come back free." added to desktop + mobile hero. _Shipped ff5d0e3f; governance 371/371, smoke PASS._
- [x] **P1 · Hero teal drift fixed** — mint-green `#5eead4` pulse dot → sky-blue `#8fe8ff`. _Shipped ff5d0e3f; verified 0 remaining `#5eead4`._
- [x] **P2 · LinkedIn in Organization JSON-LD `sameAs`** — added to homepage + About. _Shipped ff5d0e3f._
- [x] **P2 · Footer social logo icons (Facebook + LinkedIn)** — governed footer across 356 pages. _Shipped eb86f36b._
