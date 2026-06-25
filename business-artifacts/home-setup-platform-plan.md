# AssembleAtEase → Home Setup Platform — Implementation Plan

**Status:** PLAN ONLY. No code written yet. Review before any PR begins.
**Date:** 2026-06-25
**Decisions locked with Travis:**
- Deliver the written plan first (this document).
- **Omit AssembleCash & Setup Club from the homepage until their backends are real** (honesty rule —
  no advertised benefit without working logic).
- **No customer login. Identity = normalized email** (Option A). System recognizes returning customers by
  email across multiple bookings (server-side lookup, same pattern the promo engine already uses).
- **AssembleCash balance is viewed on `track.html`**, but **only after passwordless email verification**
  (one-time code emailed to the address) — never by merely typing an email. Same gate protects redemption.
- **Numbers confirmed:** 5% AssembleCash; **$20** max redemption/booking; **180-day** expiry (recommended
  over 90 — home-setup repurchase cycle is long, 90 would often expire before the next need); Move-In Pass
  **$49**; Setup Club **$9.99/mo**, **$79/yr**.
- **Financial-backend start trigger:** build PR 3 (AssembleCash) once there are **~10 completed + captured
  bookings AND at least one repeat customer** (proof the loop is worth incentivizing). PR 4 (Setup Club)
  after AssembleCash is live and ~25 completed jobs.
- **Setup Club benefits honorable at launch:** manual booking priority, 5% AssembleCash, extended
  workmanship-support window, reduced reschedule fee, faster support response. **Deferred:** *automated*
  priority dispatch (needs member-priority scoring in the dispatch engine — added later).

---

## 0. Strategic reconciliation (why the order below is NOT the spec's order)

The spec is sound, but the business is **pre-revenue (zero bookings)**. That reorders priorities:

- **Flat pricing + outcome positioning + bundles** improve *conversion* and *average order value*. These are
  worth building now and are cheap/safe because the catalog + pricing engine already exist.
- **AssembleCash** drives *repeat* bookings — but there are no first bookings yet.
- **Setup Club** creates *recurring revenue* — but there are no customers to subscribe yet.
- Building a rewards ledger + subscription billing + a pass system for zero customers is the
  "automate before validation / build for 1,000 before proving 25" trap the operating rules warn against.

**Therefore:** ship positioning + functional bundles first; gate the financial backend behind real booking
traction and one architecture decision (customer identity). Positioning improves the funnel but does **not**
create demand — run it alongside the demand playbook (`business-artifacts/first-bookings-playbook.md`).

---

## 1. Audit — what already exists (REUSE, do not rebuild)

| Capability | Where it lives | Notes |
|---|---|---|
| Service catalog source of truth | `assets/js/booking-source-of-truth.js` (`window.AAE_BOOKING_SOURCE`) + server mirror `api/_source-of-truth.js` | Structured items, prices, `popular`, `addon`, reco tags. Missing: bundle catalog, SEO metadata fields. |
| Canonical money split | `computeBookingSplit()` in `api/_source-of-truth.js` | THE pay split. tax = pass-through; base = total−tax; fee = base×pct; payout = base−fee. Never bypass. |
| Pricing layer w/ bundle field | `api/_pricing.js` (carries `discountedItemSubtotalCents`, `bundleDiscountCents`) | A bundle-discount concept already flows through pricing + promo preview. |
| Margin floor guardrail | `MIN_PRETAX_BOOKING_BY_ZONE`, `getMinimumPretaxBookingCents()` | Exactly the floor AssembleCash redemption must respect. |
| Promotions / credits engine | `api/_promotions.js`, `api/promo.js`, `api/booking/promo-preview.js`, `api/owner/promo.js`, `assets/js/site-promo.js` | Owner-configurable, $ or %, **first-booking gating via email lookup**, server-validated, recomputes tax/total. Email-keyed eligibility already works. |
| Membership w/ recurring billing | `api/assembler/membership.js` + `api/assembler/stripe-webhook.js` | **Easer-side** subscription. A working template for Setup Club — but a SEPARATE concept (see risks). |
| Stripe fee / cancel / reschedule | `estimateStripeFeeCents()`, `computeCancellationFee()`, `CANCELLATION_POLICY` | Done. |
| New-customer offer primitive | `NEW_CUSTOMER_OFFER` (WELCOME25, $25 off first) | Proves the discount path end-to-end. |

## 1b. Audit — what is MISSING (BUILD)

- Persistent customer identity / account (today: ref + email only).
- Bundle catalog as first-class data (slug, included items, SEO meta) + bundle pages.
- AssembleCash ledger (earn / pending / available / redeemed / expired / reversed) + expiry cron + reverse-on-refund.
- Customer-facing Setup Club subscription (distinct from Easer membership).
- Move-In Pass (one-time pass + 30-day window + seeded credit).
- Outcome-first homepage IA/copy; `/services`, `/bundles`, `/setup-club`, `/assemblecash` URL structure.
- Owner analytics for AOV, bundle attach rate, rewards liability, membership.

---

## 2. Architecture gates & decisions (resolve before the PR they gate)

1. **Customer identity — RESOLVED: Option A, email-keyed, no login.** Everything keyed to normalized
   lowercase email. Returning customers recognized server-side by email (reuse the promo engine's existing
   `customer_email` lookup). No passwords, no Supabase Auth for customers.
   **Security design (mandatory — prevents balance leak / credit theft):**
   - **Viewing balance on `track.html`:** customer enters email → server emails a **6-digit one-time code**
     (short TTL, rate-limited via `_ratelimit.js`) → entering it unlocks balance for that session. Never
     reveal a balance from an email alone (IDOR/enumeration). Existing ref+email booking lookup is unchanged.
   - **Redeeming at checkout:** applying AssembleCash requires the same one-time email-code verification
     before the discount is honored, so no one can spend another person's credit. Server always recalculates
     the credit, caps it ($20), enforces `getMinimumPretaxBookingCents()`, and never trusts a client value.
   - **Earning:** keyed to the booking's `customer_email`; accrues only after completed + payment captured.
2. **Honesty / omit (LOCKED):** no AssembleCash/Setup Club CTAs on the homepage until backend exists.
3. **Two "memberships" must stay separate in code & money:** existing `isMember` (25%/30%) is the **Easer
   platform-fee tier** and affects payouts. **Setup Club** is a **customer** subscription and must never feed
   `getPlatformFeePct()` or the Easer split.
4. **Margin floor is mandatory on every credit:** AssembleCash + promo + membership benefit, combined, may
   never push a booking below `getMinimumPretaxBookingCents(zone)` after Stripe fee + Easer payout.
5. **Booking pricing snapshot is immutable:** store the full priced breakdown + a `pricing_version` on the
   booking at creation. Never recompute historical bookings when catalog prices change.

---

## 3. Source-of-truth schemas (to add)

**Catalog item additions** (in `booking-source-of-truth.js` + server mirror): `service_id`, `slug`,
`category`, `minimum_price`, `complexity` level, `active`, `display_order`, `seo_title`, `seo_description`.

**Bundle catalog** (new section in the catalog SoT): `bundle_id`, `bundle_name`, `slug`, `included[]`
(catalog item names — priced by the existing engine), `optional_addons[]`, `eligibility`, `seo_title`,
`seo_description`, `active`, `display_order`. Starting price = sum of included item prices (optional small
incentive only if margin floor allows).

**Membership plans** (new table, customer-side): `plan_id`, `plan_name`, `price_cents`, `interval`
(month/year/one_time), `benefits[]`, `credit_cents`, `priority_level`, `support_window_days`, `active`.

**AssembleCash ledger** (new table): `ledger_id`, `customer_key` (email or customer_id), `booking_id`,
`amount_earned_cents`, `amount_redeemed_cents`, `expiration_date`, `status`
(pending|available|redeemed|expired|reversed), `reason`, `created_at`.

**Promotion/credit rules** (extend existing promo settings or new table): `eligibility`, `stackable`,
`max_redemption_cents`, `min_booking_cents`, `expiration`, `margin_floor`, `active`.

**Booking pricing snapshot** (columns on `bookings`, mostly present — fill gaps): selected service, bundle
(if any), add-ons, base price, complexity price, discounts, AssembleCash applied, membership benefit applied,
final customer price, expected Stripe fee, expected Easer payout, expected platform margin, custom-price flag,
`pricing_version`.

---

## 4. PR-by-PR plan

### PR 1 — Positioning + IA + functional Room-Ready bundles  *(DO NOW)*
- **Goal:** Make the homepage communicate "flat-price home setup, handled start to finish" in <10s; ship
  bundles that actually work and raise AOV.
- **Scope:** Homepage hero/subhead/trust-strip/5-step "how it works"/who-it's-for; reframe service cards as
  outcomes; broaden brand copy beyond Austin (keep city only in title/meta/JSON-LD/service-area/FAQ per the
  city-neutral rule). **Bundles = curated pre-filled `/book` selections** (deep-link with items pre-added),
  priced by the existing engine. No new pricing backend.
- **Reuse:** existing catalog + pricing engine + `/book` flow.
- **Do NOT:** add AssembleCash/Setup Club CTAs (omit per decision); add fake stats/testimonials/guarantees;
  break the booking flow; create thin duplicate pages.
- **Risks:** copy drifting into unverifiable claims; bundle deep-links must resolve to correct catalog items.
- **Acceptance:** homepage explains the model fast; every bundle CTA lands in `/book` with the right items
  pre-selected and a correct live total; no fake claims; booking flow unchanged; mobile clean.

### PR 2 — Bundle catalog as data source of truth
- **Goal:** Stop hardcoding bundle contents in the homepage; one bundle SoT the homepage + future pages read.
- **Scope:** Add bundle section + SEO metadata to the catalog file (+ server mirror for validation).
- **Do NOT:** introduce a separate bundle pricing path that diverges from item pricing.
- **Acceptance:** homepage bundles render from the SoT; server can validate a bundle booking by item names.

### — GATE: choose customer identity model (Section 2.1) before anything below —

### PR 3 — AssembleCash ledger
- **Goal:** Real future-booking credit that cannot harm margin.
- **Scope:** ledger table; earn (5% default) **only after completed + payment captured**; statuses incl.
  reverse-on-refund; expiry cron (90/180d); redemption as a credit source inside the existing promo/credit
  pipeline with max cap ($15–20), min-booking, no-stack, and **margin-floor enforcement**; customer-visible
  balance (via the chosen identity model).
- **Reuse:** `_promotions.js` apply pipeline; `getMinimumPretaxBookingCents`; `computeBookingSplit`.
- **Do NOT:** mutate `computeBookingSplit`; let credit breach margin floor; pay cash; allow withdrawal.
- **Acceptance:** earns only post-capture; reverses on refund; never breaches floor; copy says "earned $X
  toward your next setup," never "cashback."

### PR 4 — Setup Club (customer subscription)
- **Goal:** Recurring membership: priority, 5% AssembleCash, member bundle pricing where margin allows,
  reduced reschedule fee, faster support. **No unlimited labor.**
- **Scope:** customer membership plans table; Stripe **customer** subscription (reuse Easer pattern as a
  template, NOT the same records); member-status tracking; benefits gated by real logic only.
- **Do NOT:** wire Setup Club into `getPlatformFeePct()` / Easer split; promise priority unless dispatch
  supports it; show benefits that don't function.
- **Acceptance:** membership state tracked server-side; each advertised benefit maps to working logic;
  margin floor still holds for member pricing.

### PR 5 — Move-In Pass
- **Goal:** One-time $49 pass: 30-day priority window + $25 seeded credit + member bundle access.
- **Depends on:** PR 3 (credit) + PR 4 (benefit plumbing).
- **Acceptance:** pass purchase activates a 30-day window; seeded credit obeys ledger rules; expires cleanly.

### PR 6 — SEO page restructure
- **Goal:** `/services/*`, `/bundles/*`, `/setup-club`, `/assemblecash` with unique, useful content.
- **Scope:** new canonical pages; **301 redirects** from existing flat pages to preserve SEO; internal links;
  FAQ; structured data only where accurate.
- **Do NOT:** create thin/duplicate pages; ship pages for features that aren't live yet.
- **Acceptance:** no duplicate-intent pages; old URLs 301 to new; metadata unique; claims accurate.

### PR 7 — Owner analytics
- **Goal:** Owner sees AOV, bundle attach rate, AssembleCash earned/redeemed (liability), membership signups,
  repeat-booking rate, margin after rewards, conversion by service/bundle. Mark estimated vs actual.

---

## 5. SEO / URL migration
- Keep existing local SEO pages working; **301** any path that moves.
- City stays only in title/meta/JSON-LD/service-area/FAQ/nearby-links; value copy stays location-neutral.
- One purpose per page; no city-swapped or thin duplicates.

## 6. Demand tie-back (do not forget)
PR 1 lifts conversion; it does not create traffic. Your first booking still comes from the demand playbook
(Google Search/LSA, Google Business Profile, apartment outreach, Nextdoor/FB). Run PR 1 *with* it, not instead.

## 7. Decisions — RESOLVED (2026-06-25)
1. Customer identity: **email-keyed, no login (A).** Returning customers recognized by email. Balance view +
   redemption gated by one-time email code (see 2.1).
2. **5% AssembleCash, $20 cap, 180-day expiry, $49 / $9.99 / $79.**
3. Setup Club at launch: manual priority, 5% AssembleCash, extended support window, reduced reschedule fee,
   faster support. Automated dispatch priority deferred.
4. Financial backend starts at **~10 completed+captured bookings + ≥1 repeat customer** (PR 3); Setup Club at
   ~25 completed jobs (PR 4).

All gates resolved → PR 1 and PR 2 can proceed on approval; PR 3+ unlock at the booking trigger above.
