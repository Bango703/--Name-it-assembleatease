# AssembleAtEase — Single Prioritized Backlog

The one source of truth for tracked work. Owned by the Product Manager seat (see CLAUDE.md → Backlog Discipline). Priority-ordered. Nothing is left as "maybe later" — every deferral lives here. Capturing an item does **not** mean building it now; the "first 25 jobs" stage gate and the Executive Board decide sequence. Distribution and completion outrank expansion.

**Legend:** `[ ]` open · `[~]` in progress · `[x]` verified complete (shipped + validated). P0 = launch/money/security · P1 = trust/conversion/ops · P2 = polish.

_Last reconciled: 2026-08-04_

---

## Now (top of stack)

- [~] **P0 · Easer session identity is not bound to rendered private state** _(Security, Easer, Engineering)_
  Implemented locally: shared user-ID binding, immediate private-DOM/cache scrubbing, allowlisted profile bootstrap, and abortable private reads across all four pages. Focused security, full launch, and authenticated mobile checks pass; approved push and Production verification remain.
- [~] **P0 · Authenticated assignments response is publicly cacheable** _(Security, Customer, Easer)_
  Implemented locally: the API sets `private, no-store` before authentication and every Home/Jobs assignments read uses `cache: 'no-store'`. Regression coverage passes; approved push and Production header verification remain.
- [~] **P1 · Easer Home paints stale actionable job snapshots and has a serial load waterfall** _(Easer, Ops, UX, Engineering)_
  Implemented locally: full assignment snapshots were removed and erased from existing sessions, readiness is no longer duplicated, and independent earnings load in parallel. Authenticated 390px verification settled at about 1.6s versus 3.4-4.6s before; approved push and Production timing verification remain.
- [~] **P1 · Easer Jobs duplicates resume refreshes and serializes earnings after assignments** _(Easer, Ops, Engineering)_
  Implemented locally: one identity-bound refresh path now handles initial load, resume, reconnect, polling, and offer deep links; assignments and earnings run concurrently. One resume produced exactly one request per source; approved push and Production verification remain.
- [~] **P1 · Easer Earnings flashes the legacy manual payout method before Connect truth** _(Easer, Finance, UX)_
  Implemented locally: one neutral payout loading state gates both modes, routine status reads avoid Stripe reconciliation, and Manage payout uses mobile-safe same-tab navigation. Authenticated mobile and simulated login-link checks pass; approved push and Production verification remain.
- [~] **P1 · Easer Profile flashes false zero/completion data and does not revalidate on wake** _(Easer, UX, Engineering)_
  Implemented locally: neutral placeholders replace false zeroes, independent reads run concurrently, membership status is a GET, derived data refreshes on wake, and review/closure copy is Easer-facing. Authenticated mobile verification passes; approved push and Production verification remain.
- [~] **P1 · Easer Profile save exposes the complete internal profile row** _(Security, Easer, Engineering)_
  Implemented locally: migration 059 adds an eight-field response projection and all browser writes use it; migration 060 revokes browser access to the legacy full-row function after frontend rollout. Migration 059 is applied and catalog-verified; deployment, migration 060, and final Production verification remain.
- [~] **P1 · Easer Profile password recovery redirects to the login page** _(Easer, Security, Support)_
  Implemented locally: Profile now targets the canonical `/auth/set-password` recovery flow. Authenticated mobile interception and launch regression pass; deployment and Production verification remain.
- [~] **P1 · Easer Profile identity and completion states can misdirect Easers** _(Easer, Ops, UX)_
  Implemented locally: `Contact profile` is explicitly separate from job readiness, not-started identity shows the secure verification action, and in-progress identity states whether action is required. Mobile and launch regression pass; deployment and Production verification remain.
- [~] **P1 · Easer Profile can display an unsaved photo as complete** _(Easer, UX, Reliability)_
  Implemented locally: avatars are reduced to 384px with a strict encoded-size cap, confirmed save truth rerenders the page, and failed saves restore the persisted avatar and completion state. Simulated mobile failure rollback passes; deployment and Production verification remain.
- [~] **P2 · Easer Profile form and closure sheet need accessible interaction states** _(Easer, Accessibility, UX)_
  Implemented locally: semantic alerts and field errors, visible keyboard focus, verified-user edit focus, and closure-dialog semantics, Escape, containment, and focus return. Authenticated 390px interaction checks pass; deployment and Production verification remain.
- [~] **P1 · Easer pages hide the whole body during auth instead of presenting a stable shell** _(Easer, UX, Reliability)_
  Implemented locally: all four routes use a shared non-private loading shell and the Easer critical-asset version was advanced. Mobile verification and full launch regression pass; approved push and Production verification remain.
- [~] **P2 · Easer service-worker shell/cache list is stale** _(Easer, PWA, Engineering)_
  Implemented locally: cache v7 uses current Easer assets, network-first versioned scripts/styles, and a dedicated non-private offline screen. Service-worker and launch regressions pass; approved push and Production verification remain.
- [~] **P1 · Distribution — work the move-in / referral channel for 30 days** _(CEO, VP Marketing)_
  Demand is the real bottleneck, not code. Kit is built (see Done). **Owner action:** approach top-2 partners (apartment/property managers, realtors), leave 5–10 QR counter-cards each, and track completed bookings with `utm_source=partner`. Double down on whichever partner drives the first jobs. This is where the first 25 jobs come from.

## Mobile (P1 — 90% of traffic)

- [ ] **P1 · Homepage "double-talk": value props repeated 4–7× ** _(UX, Growth, CPO)_ — "Upfront pricing", "reviewed local pros", and "pay after completion" each recur across the hero, the "Why choose" band, trust items, every service card, how-it-works, and FAQ (grep-confirmed on `index.html`). On mobile you scroll the same three promises repeatedly across 9+ sections → the "double-talk / gotta-scroll / not friendly" the owner reported. Violates the existing no-repeated-value-props rule. Fix = **subtraction**: each benefit once; shorten the mobile homepage so the service tiles / book CTA arrive sooner. Highest-traffic page — plan the cut carefully, don't blind-edit.
- [ ] **P2 · Homepage load-in animation timing** _(UX)_ — service cards use staggered `mCardIn` fade (`animation:...both`); on slow phones content can read as "not there yet" briefly. Verify on a real mid-tier device; consider trimming stagger.
- [ ] **P1 · Horizontal-swipe carousels hide content on mobile** _(UX, Growth)_ — confirmed on real 390px renders: the **pricing "service menu"** (6 service categories) and the **homepage reviews strip** are sideways-swipe carousels. Users routinely don't discover off-screen cards → this is the owner's "can't see certain things, gotta scroll." Dots + a peeking next-card help but many still miss it. Fix: on mobile prefer stacked/vertical or make the swipe affordance unmistakable.
- [ ] **P2 · Cookie banner covers bottom CTAs on first visit** _(UX)_ — `cookie-banner` is `position:fixed;bottom:0;z-index:9999`; on pages where a primary CTA sits at the bottom (e.g., pricing "Book Furniture →") it's obscured until dismissed. Dismissable/standard, but consider lifting page bottom-padding while the banner is shown.
- [ ] **P1 · Booking: mobile scroll-reduction + reachable CTA** _(UX, CPO, CX — owner-directed)_ — device-tested full flow at 390px. Two root causes found (sticky experiment built + reverted to keep checkout safe):
  1. **Empty void** below the CTA on every step = the booking wrapper's `min-height:100vh` ([book.html:45](../book.html#L45)) padding out short steps.
  2. **`position:sticky` for `.step-actions` is BROKEN** by an ancestor `overflow-x:hidden` (the horizontal-overflow guard makes an ancestor the sticky scroll-container). Confirmed: even a hardcoded sticky offset would not pin.
  **Correct fix:** use `position:fixed` bottom action bar (unaffected by the overflow ancestor) + per-panel bottom **clearance** (the `--mobile-actions-clearance` machinery already exists, currently only on item panes — extend to all `.step-panel`) + coordinate `bottom` with the fixed cookie banner (z-9999) via a CSS var. The item panes' existing clearance shows this bar was the original design intent.
  Owner also wants **minimal up/down scroll per step** — "everything in one, or slide to the next step after each input." Phase 2: tighten/collapse per-step content (e.g., collapse the optional AssembleCash block) and/or split long steps into auto-advancing micro-steps so each screen ≈ one viewport. Do carefully on the money path with 390px before/after renders.
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

- [x] **P0 · Stripe Connect inaccessible-account recovery fixed** — Stripe public support details and Express branding were completed; commit `a9d56984` recognizes revoked/inaccessible connected accounts as recoverable. Production self-healed the stale Easer state, created one correctly configured live Express account, and generated the branded onboarding link. The owner intentionally stopped before entering personal/bank details, so onboarding remains incomplete and no payout moved. Full launch regression and live status checks passed. _2026-08-04._
- [x] **P0 · Easer announcement tables locked down** — migration 058 enabled RLS, revoked `anon`/`authenticated`, preserved `service_role`, and recorded schema state 57–58. Production zero-row probes return HTTP 401 publicly and HTTP 200 through the server credential. _2026-08-04._
- [x] **P1 · Mobile — homepage pinch-zoom re-enabled** — removed `maximum-scale=1` from `index.html` viewport (was the only page of 339 blocking zoom; WCAG 1.4.4). _2026-08-02._
- [x] **P2 · Mobile — waitlist input iOS-zoom fixed** — added `.waitlist-input` to the mobile 16px guard ([marketing.css:224](marketing.css#L224)). _2026-08-02._
- [~] **Corrected (no change needed) · Easer field-input iOS zoom** — false alarm: `easer.css` already forces `input`/`select`/`textarea` to 16px under `@media (max-width:899px)` (lines 816–821), and all Easer pages load easer.css. No fix applied.
- [x] **P1 · Partner outreach kit + move-in QR counter-card built** — pitch, target list, and email/DM templates at [business-artifacts/partner-outreach-kit.md](partner-outreach-kit.md); print-ready 5×7 counter-card with a real scannable QR (segno v5) → `/book?bundle=move-in-ready&utm_source=partner`, published as a private artifact. Enables the distribution item above. _2026-08-02._
- [x] **P1 · Booking — card billing-address AVS false declines fixed** — removed the service `address` block from Stripe `billing_details` in both checkout paths ([book.html:7394](../book.html#L7394) quote/scheduled + immediate payment); billing_details now carries name/email/phone only. Service address still sent to the booking API. Stripe Radar + manual capture still protect. _Shipped 2026-08-02; surgical 2-block diff, smoke PASS, governance 371/371._
- [x] **P1 · Homepage re-assembly guarantee surfaced** — "Assembled right, or we come back free." added to desktop + mobile hero. _Shipped ff5d0e3f; governance 371/371, smoke PASS._
- [x] **P1 · Hero teal drift fixed** — mint-green `#5eead4` pulse dot → sky-blue `#8fe8ff`. _Shipped ff5d0e3f; verified 0 remaining `#5eead4`._
- [x] **P2 · LinkedIn in Organization JSON-LD `sameAs`** — added to homepage + About. _Shipped ff5d0e3f._
- [x] **P2 · Footer social logo icons (Facebook + LinkedIn)** — governed footer across 356 pages. _Shipped eb86f36b._
