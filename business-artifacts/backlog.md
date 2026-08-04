# AssembleAtEase — Single Prioritized Backlog

The one source of truth for tracked work. Owned by the Product Manager seat (see CLAUDE.md → Backlog Discipline). Priority-ordered. Nothing is left as "maybe later" — every deferral lives here. Capturing an item does **not** mean building it now; the "first 25 jobs" stage gate and the Executive Board decide sequence. Distribution and completion outrank expansion.

**Legend:** `[ ]` open · `[~]` in progress · `[x]` verified complete (shipped + validated). P0 = launch/money/security · P1 = trust/conversion/ops · P2 = polish.

_Last reconciled: 2026-08-02_

---

## Now (top of stack)

- [~] **P1 · Distribution — work the move-in / referral channel for 30 days** _(CEO, VP Marketing)_
  Demand is the real bottleneck, not code. Kit is built (see Done). **Owner action:** approach top-2 partners (apartment/property managers, realtors), leave 5–10 QR counter-cards each, and track completed bookings with `utm_source=partner`. Double down on whichever partner drives the first jobs. This is where the first 25 jobs come from.

## Mobile (P1 — 90% of traffic)

- [ ] **P1 · Homepage "double-talk": value props repeated 4–7× ** _(UX, Growth, CPO)_ — "Upfront pricing", "reviewed local pros", and "pay after completion" each recur across the hero, the "Why choose" band, trust items, every service card, how-it-works, and FAQ (grep-confirmed on `index.html`). On mobile you scroll the same three promises repeatedly across 9+ sections → the "double-talk / gotta-scroll / not friendly" the owner reported. Violates the existing no-repeated-value-props rule. Fix = **subtraction**: each benefit once; shorten the mobile homepage so the service tiles / book CTA arrive sooner. Highest-traffic page — plan the cut carefully, don't blind-edit.
- [ ] **P2 · Homepage load-in animation timing** _(UX)_ — service cards use staggered `mCardIn` fade (`animation:...both`); on slow phones content can read as "not there yet" briefly. Verify on a real mid-tier device; consider trimming stagger.
- [ ] **P1 · Horizontal-swipe carousels hide content on mobile** _(UX, Growth)_ — confirmed on real 390px renders: the **pricing "service menu"** (6 service categories) and the **homepage reviews strip** are sideways-swipe carousels. Users routinely don't discover off-screen cards → this is the owner's "can't see certain things, gotta scroll." Dots + a peeking next-card help but many still miss it. Fix: on mobile prefer stacked/vertical or make the swipe affordance unmistakable.
- [ ] **P2 · Cookie banner covers bottom CTAs on first visit** _(UX)_ — `cookie-banner` is `position:fixed;bottom:0;z-index:9999`; on pages where a primary CTA sits at the bottom (e.g., pricing "Book Furniture →") it's obscured until dismissed. Dismissable/standard, but consider lifting page bottom-padding while the banner is shown.
- [ ] **P1 · Booking CTA is not sticky → recurring empty void every step** _(UX, CPO, Growth)_ — device-tested the FULL customer flow at 390px (service → item/bundle picker → When&where → Your info → Payment). Every step leaves a large empty void (~600–1000px) below a mid-page primary button; the "Continue/Complete Booking" CTA floats with dead space beneath. Pro fix: make the step CTA a **sticky bottom bar** (thumb-reachable, eliminates the void) — must sit above the fixed cookie banner (z-index 9999). Biggest booking-mobile improvement; the flow content itself is clean.
- [ ] **P2 · Verify booking validation-error timing** _(QA, UX)_ — on the "Your info" step, Required/email/phone errors appeared on arrival in test (likely a seed artifact). Confirm on a real device that field errors only show after interaction/submit, never on first view.
- [ ] **P2 · Section-picker dual action ambiguity** _(UX)_ — the item-section screen offers both per-card "Open" and a global "Continue to items →"; mild "which do I tap" ambiguity.
- [ ] **P2 · Booking step-numbering is fragile** _(Eng hygiene)_ — internal steps 1/3/4/5 map to "Step 1–4 of 4" with a dead step-2; works but easy to break in maintenance (matches the earlier step-cruft note).
- [ ] **P2 · Service-page hero over-uses the city** _(UX/SEO)_ — e.g. furniture page hero shows "Austin" 3×: photo badge "Completed Austin project" + eyebrow + H1. Trim to keep it within the city-neutral rule (eyebrow/service-area/FAQ).
- [ ] **P2 · Pricing copy brushes the tools-only rule** _(Legal/Trust)_ — "Parts, mounts, and hardware are separate unless listed" implies listed hardware add-ons exist; reconcile with the tools-only positioning / open hardware-add-on decision.
- [ ] **P1 · Authed Easer + Owner mobile UNTESTED** _(QA, Ops)_ — both are auth-gated so headless renders came back blank; the two field-critical mobile surfaces have NOT been visually verified. Test on a real logged-in phone (owner dashboard tables + Easer my-assignments, per Rule #5).
- [ ] **P2 · Verify Easer login + my-assignments responsiveness** _(UX)_ — `assembler/index.html` (login) has 0 media queries; `my-assignments.html` has 1. Spot-check on a real phone.
- _Verified NOT broken (device-tested at true 390px via Edge iframe): no horizontal overflow / clipping on home, booking, or track; booking step-1 tiles + prices render clean. Earlier "severe overflow" alarm was a headless tooling artifact (Edge floored `--window-size=390` at 492px), now corrected._

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
