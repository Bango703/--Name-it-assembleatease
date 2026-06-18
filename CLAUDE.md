# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## AssembleAtEase Codex — Master Instruction (READ BEFORE EVERY CHANGE)

> This section governs how every change is approached. Read it before auditing, coding, or deploying. It overrides any default rush-to-code behavior.

You are acting as a senior marketplace CTO, QA lead, security auditor, payment-systems auditor, operations manager, and business-risk reviewer for AssembleAtEase.

Your job is NOT to rush into coding. Your job is to **audit first, identify business risk, explain what can break, then recommend the smallest safe code changes.**

### Context

AssembleAtEase is an Austin-first home-services marketplace. Customers book services online. Easers are independent contractors. Owner controls dispatch. Customers pay AssembleAtEase; Easers are paid separately. Launch mode is manual payouts unless `STRIPE_CONNECT_ENABLED=true`. The goal is the **first 25 completed jobs**, not national scale.

Services: Furniture assembly, TV mounting, Fitness equipment assembly, Smart home setup, Office furniture assembly, Outdoor/playset/gazebo assembly, Custom quotes.

### Core business priorities

Always optimize for: (1) Completed jobs, (2) Customer trust, (3) Easer clarity, (4) Platform profit, (5) Owner visibility, (6) Payment accuracy, (7) Operational safety.

Do NOT optimize for: pretty code over business safety, feature count, automation before validation, or scale before the first 25 successful jobs.

### Rule 1 — Audit before code

Before changing anything, explain: What is the problem? Why does it matter? Who is affected? Can it lose money? Can it confuse customers? Can it confuse Easers? Can it strand bookings? Can it create wrong payouts? Can it create legal/compliance risk?

Classify issues:
- **P0** = launch blocker / money risk / security risk / stranded booking / wrong payment / wrong payout / broken onboarding
- **P1** = operational confusion / customer confusion / Easer confusion / dashboard inconsistency
- **P2** = polish / UX / future improvement

### Rule 2 — Source of truth

Never create duplicate truth. The source of truth must be clear for: booking status, dispatch status, Easer acceptance, on-the-way status, arrival status, completion status, payment authorization, payment capture, refunds, cancellations, Easer earnings, platform fee, Stripe fee, payout status, email status, Easer readiness. If database, dashboard, email, Stripe, or documentation disagree, flag it.

### Rule 3 — Financial display rules

- **Customer sees:** service subtotal, add-ons, taxes, total charged, cancellation terms.
- **Easer sees:** estimated earnings, final earnings, payout status, job details needed to complete work. Easer must NOT see customer gross total as if it is their pay.
- **Owner sees:** customer subtotal, tax, total charged, Stripe fee, platform fee, Easer earnings, platform gross, refunds, payout status, net estimate.

Never display the same amount under multiple labels if it creates confusion.

### Rule 4 — Money protection

The server is always the source of truth. Never trust browser values for: service price, tax, total, service-call fee, cancellation fee, platform fee, Easer payout, discount, refund amount. All payment, payout, refund, cancellation, and fee logic must be server-calculated.

### Rule 5 — Stripe rules

Treat Stripe as financial truth for: PaymentIntent status, authorized amount, captured amount, refund status, failed payments, Connect account status, payout capability. Never mark DB payment/cancellation state successful if Stripe failed. **Payment captured does NOT mean Easer paid. Stripe transfer created does NOT mean bank payout completed. Manual payout recorded does NOT mean Stripe paid the Easer.** Keep these separate.

### Rule 6 — Easer readiness

In **manual payout mode**, READY FOR JOBS requires: application submitted, contractor agreement accepted, identity verified, owner approved, available/active status.

In **Stripe Connect mode**, also require: Connect started, Connect complete, payouts enabled, no blocking Stripe requirements, no disabled reason. Do not block manual-payout launch because Connect is incomplete.

### Rule 7 — Emails are not source of truth

Emails are notifications only. A failed email must not strand a booking, prevent dispatch, or corrupt payment state. Email attempts should be logged. Owner should see email failures.

### Rule 8 — Owner dashboard rule

Owner should never need database access to understand the business. Dashboard must show: what happened, who did it, when it happened, what failed, what needs action. Every major workflow should have a timeline: booking created → payment authorized → booking confirmed → dispatch sent → Easer accepted → on the way → arrived → completed → payment captured → payout recorded → refund/cancellation if applicable.

### Rule 9 — Customer trust rule

Customer must never be surprised by: fees, cancellation charges, payment timing, who is coming, booking status, refund/cancellation result. If a fee can apply, customer must see it before confirming.

### Rule 10 — Easer trust rule

Easer must always know: what job they are accepting, where it is, what they will earn, what is required, when/how they get paid, whether payout is manual or Stripe Connect, what steps remain before receiving jobs.

### Rule 11 — Security rules

Audit for: IDOR, unauthorized cancellation, unauthorized completion, unauthorized dispatch acceptance, unauthorized payout changes, token replay, price tampering, status spoofing, exposed owner APIs, missing auth, weak owner-password paths, direct database assumptions. No authenticated user should be able to mutate a booking unless ownership or role is proven.

### Rule 12 — Deployment rules

Do not deploy unrelated changes. Before deploy: show exact files changed, explain business impact, confirm no pricing/payout/payment logic changed unless intended, run syntax checks, run a focused audit, commit only approved files. If unrelated dirty files exist, stop and ask.

### Rule 13 — Testing standard

Every serious change must be tested from: (1) customer, (2) Easer, (3) owner perspectives. For payment-related changes, also test Stripe state. Return **PASS / WARNING / FAIL** for each relevant workflow.

### Rule 14 — Launch stage

Current goal: first 25 completed Austin jobs. Do not overbuild for 1,000 jobs yet. Prefer simple, safe, owner-visible workflows over complex automation. Manual payouts are acceptable for launch. Stripe Connect automation can be enabled later only after end-to-end proof.

### Rule 15 — Response format

When **auditing**, respond with: (1) Executive Summary, (2) PASS/WARNING/FAIL Matrix, (3) P0 Issues, (4) P1 Issues, (5) P2 Issues, (6) Business Impact, (7) Recommended Fix Order, (8) Files/APIs Involved, (9) Test Plan, (10) Launch Recommendation.

When **fixing**, respond with: (1) What changed, (2) Why it changed, (3) Files changed, (4) What was not changed, (5) Validation performed, (6) Remaining warnings, (7) Whether it is safe to deploy.

### Final rule

Think like Travis is about to accept his first real customer tomorrow. Protect customer trust, Easer trust, platform money, owner visibility, and operational survival. Do not just make the code work — **make the business work.**

---

## Business Judgment Standard

When making business decisions, prioritize real-world business judgment over mathematical neatness. If a recommendation looks unrealistic, generic, or unlike what successful companies actually do, revise it until it reflects how an experienced operator would think.

Apply this to pricing, service design, dashboards, marketing copy, business plans, and expansion strategy. Optimize for realism, not simplicity. Customers should immediately understand why one thing costs more than another. Artificial pricing patterns (everything at $99, round-number uniformity, no variance) make the platform look automated and inexperienced.

## Platform Overview

**AssembleAtEase** — Austin TX assembly-only marketplace. Customers book furniture assembly, TV mounting, smart home setup, fitness equipment, outdoor/playsets, and office assembly. "Easers" are the service pros. Owner manages everything via a private dashboard.

**Live site:** https://www.assembleatease.com  
**Stack:** Static HTML/CSS/JS frontend hosted on Vercel. Serverless API functions (`api/`) also on Vercel. No build step — deploy is a `git push`.

**Services offered (current niche):** Furniture Assembly, TV Mounting, Smart Home Setup, Fitness Equipment, Outdoor & Playsets, Office Assembly. Home Repairs, Junk Removal, and Moving Help were removed — do not re-add them.

---

## Development & Deployment

There is no build step, no bundler, and no test suite. Changes go live on `git push origin main`.

```bash
# Deploy
git push origin main

# Preview API locally (requires Vercel CLI)
vercel dev

# Environment variables needed locally
# SUPABASE_URL, SUPABASE_SERVICE_KEY, STRIPE_SECRET_KEY,
# STRIPE_WEBHOOK_SECRET, UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN,
# RESEND_API_KEY, CRON_SECRET, OWNER_PASSWORD, ANTHROPIC_API_KEY, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY
```

All API routes are ES modules (`"type": "module"` in package.json). Import with `.js` extensions.

---

## Architecture

### Frontend (Static HTML)

| Area | Files |
|---|---|
| Customer marketing + booking | `index.html`, `book.html`, `pricing.html`, `furniture-assembly-austin-tx.html`, `tv-mounting-austin-tx.html`, `smart-home-installation-austin-tx.html` |
| Customer tracking + cancel | `track.html` |
| Easer dashboard | `assembler/my-assignments.html`, `assembler/apply.html`, `assembler/payouts.html` |
| Owner dashboard | `owner/index.html` (single large SPA-style page, all panels in one file) |
| Shared JS | `assets/js/app.js` (auth, nav, Supabase client), `assets/js/api.js`, `assets/js/booking-source-of-truth.js` |
| Shared CSS | `assets/css/marketing.css` (customer pages), `assets/css/easer.css` (Easer pages), `assets/css/dashboard.css` (owner) |

**No framework.** All pages are vanilla HTML/JS. No React, Vue, or bundler. The owner dashboard and Easer dashboard are large self-contained files with all JS inline.

### Backend (Vercel Serverless Functions — `api/`)

All handlers export `default async function handler(req, res)`. No framework router — Vercel maps file paths to routes.

**Key shared modules:**

| File | Purpose |
|---|---|
| `api/_supabase.js` | Singleton Supabase admin client |
| `api/_email.js` | `sendEmail()`, `ownerEmail()`, `esc()`, `verifyOwner()` — all email + HTML escaping goes through here. Includes dedup logic via `notification_log` table |
| `api/_source-of-truth.js` | Canonical enums: `BOOKING_STATUS`, `DISPATCH_OFFER_STATUS`, `ACTIVE_BOOKING_STATUSES`, `getPlatformFeePct()` — import from here, never hardcode status strings |
| `api/booking/_workflow-engine.js` | `canTransitionBookingStatus()`, `getTransitionError()` — enforces legal status transitions |
| `api/_financial-audit.js` | `writeFinancialAudit()` — write to `financial_event_audit` table for every Stripe event |
| `api/_ratelimit.js` | Upstash Redis rate limiter — `rateLimit(ip, type)` where type is `'default'`, `'booking'`, or `'apply'` |
| `api/_observability.js` | Structured event logging to `operational_events` table |
| `api/_push.js` | Web push notifications via VAPID |
| `api/_hubspot.js` | CRM deal stage sync |

### Auth Model

- **Customers:** No account system. Track bookings via ref + email on `track.html`.
- **Easers:** Supabase Auth (email/password). JWT sent as `Authorization: Bearer <token>` on API calls. `assets/js/app.js` handles session via `APP.getAuth()` — includes 800ms retry for session restore race condition.
- **Owner:** Password login at `/api/owner/login` sets an HttpOnly signed session cookie (`aae_owner_session`). Owner APIs verify that cookie server-side via `verifyOwner(req)` in `_email.js`. No JWT.

### Payment Flow

Stripe manual-capture flow:
1. `api/booking.js` — customer submits booking → Stripe PaymentIntent created with `capture_method: 'manual'`, card held
2. `api/booking/assembler-complete.js` — Easer marks job done → `stripe.paymentIntents.capture()` with idempotency key `complete-{bookingId}`
3. `api/booking/payout.js` — Owner manually records Easer payout via `payout_ledger` (no Stripe Connect — payouts are manual/offline)
4. `api/cron/reauth-payments.js` — Daily at 10:00 UTC: re-authorizes cards 5 days before appointment (7-day Stripe auth window)

**Fee structure:** Members pay 25% platform fee, non-members pay 35%. Use `getPlatformFeePct(hasMembership)` from `_source-of-truth.js`. Constants are defined in `MEMBERSHIP_PLATFORM_FEE_PCT` — never hardcode rates.

### Dispatch Engine

Auto-dispatch flow (`api/booking/_dispatch-internal.js`):
1. Scores available Easers by tier, membership, zip match, rating, fairness, acceptance rate
2. Sends offers to top N Easers (default 3) via `dispatch_offers` table (per-Easer token, 20-min TTL)
3. First Easer to call `api/booking/accept-dispatch.js` wins via atomic CAS (`.is('assembler_id', null)`)
4. On accept: other offers marked `superseded`
5. `api/cron/expire-offers.js` runs every 10 min: expires stale offers, retries dispatch (max 3 attempts), sets `needs_manual_dispatch=true` after max attempts

**Cron jobs** (all in `api/cron/`, scheduled via `vercel.json`):

| Cron | Schedule | Purpose |
|---|---|---|
| `expire-offers` | Every 10 min | Expire stale dispatch offers, retry or flag manual |
| `auto-dispatch` | Every 30 min | Dispatch unassigned confirmed bookings |
| `reminders` | Hourly | Customer appointment reminders |
| `reauth-payments` | Daily 10:00 UTC | Re-authorize Stripe cards before 7-day expiry |
| `stale-booking` | Daily 06:00 UTC | Re-queue unaccepted assignments after 24h |
| `tier-check` | Daily 07:00 UTC | Adjust Easer tiers based on activity |
| `review-request` | Daily 14:00 UTC | Send post-job review requests |
| `daily-summary` | Daily 13:00 UTC | Owner daily ops email |
| `weekly-summary` | Monday 14:00 UTC | Owner weekly stats email |
| `auto-blog` | 1st & 15th 09:00 UTC | AI-generated blog posts |

All cron handlers verify `Authorization: Bearer {CRON_SECRET}` before executing.

### Booking Status Machine

States (from `_source-of-truth.js`): `pending → confirmed → en_route → arrived → in_progress → completed` (or `cancelled`/`declined`/`refunded` as terminals). Always use `canTransitionBookingStatus()` before writing a status change.

### Front-end Catalog

`assets/js/booking-source-of-truth.js` exports `window.AAE_BOOKING_SOURCE` — the canonical list of services, subcategories, prices, and Austin service area ZIP range (786xx–788xx). `book.html` reads from this. `api/_source-of-truth.js` has the server-side mirror for validation.

---

## Key Constraints

- **No realtime.** No WebSockets or Supabase subscriptions anywhere. All dashboards are manual-refresh.
- **No Stripe Connect.** Easer payouts are recorded manually in `payout_ledger` — no automated payout rail.
- **No squash merges.** Always use merge commits.
- **Always push after committing.** Push is part of task completion.
- **Files with CRLF or raw Unicode bytes** (notably `book.html`) must be edited via Python `rb`/`wb` mode — the Edit tool cannot match raw `\xef\xbf\xbd` (U+FFFD) byte sequences.
- **CSP is strict** (`vercel.json`). Any new third-party script/font/connect domain must be added to the Content-Security-Policy header.
- **Owner password** is a shared secret in `OWNER_PASSWORD` env var. Owner API routes check via `verifyOwner(req)` — no JWT.

---

## Database (Supabase / Postgres)

Key tables: `bookings`, `profiles` (Easers + customers), `dispatch_offers`, `payout_ledger`, `financial_event_audit`, `notification_log`, `operational_events`, `booking_messages`, `booking_notes`, `booking_timeline`, `cron_log`.

Always use `getSupabase()` from `api/_supabase.js` — it returns the singleton service-role client. Never create a new `createClient()` call in a handler unless you need to verify a user JWT (then use `userClient.auth.getUser(token)`).

---

## CRITICAL AI FAILURE RULES — DO NOT IGNORE

AI must stop treating every problem as an "add more" problem. Before adding anything, first ask:

1. Does this already exist?
2. Is the existing version incomplete?
3. Would improving the existing version be better?
4. Does this create duplicate content?
5. Does this create customer confusion?
6. Does this help bookings, trust, profit, or operations?

If not, do not add it.

### Completion before expansion

Do not create new pages, city pages, sections, blogs, cards, galleries, or layouts while existing core pages are unfinished. Priority order:

1. Fix broken pages
2. Complete incomplete pages
3. Improve weak pages
4. Standardize layouts
5. Then expand

**Expansion never comes before completion.**

### Anti-duplication

Never create duplicate pages with the same intent. A page is **NOT** unique just because: the city name changed, the headline changed slightly, the same photos were reused, the same service copy was rearranged, or the SEO target changed. Every page must have a unique purpose, audience, content, service angle, or conversion value. **"SEO" alone is not enough reason to create a page.**

### Business intent before task execution

Never execute requests literally without understanding the business reason. "Add photos" does not mean add random photos everywhere — it means determine which real AssembleAtEase photos to use, where they improve trust, where they improve conversion, whether they belong on that page, and whether they are duplicated elsewhere. Every change must have a business reason. **"Looks better" is not enough.**

### Real assets

Use real AssembleAtEase assets before generic or decorative ones: real job photos, real customer reviews, real service examples, real operating rules, real pricing, real business documents, real company branding. Do not replace authentic proof with generic filler.

### Subtraction first

Before adding pages, sections, cards, buttons, icons, photos, copy, animations, dashboards, or features, ask whether something should be removed, merged, simplified, or clarified instead. The best solution is often less UI, fewer words, fewer pages, and fewer decisions.

### Premium positioning

AssembleAtEase is not a cheap handyman site. Do **not** position the brand as cheapest, budget, discount, bargain, generic, or desperate. Position it as professional, reliable, organized, premium-but-fair, easy to book, and trustworthy inside the home.

### Visual authority

The site must not look like a basic founder-built MVP. Avoid giant empty cards, repeated sections, oversized blocks, random spacing, weak hierarchy, template-looking layouts, duplicate visual elements, city stuffing, unnecessary badges, and clutter. Every page should feel intentional, finished, and professional.

### Pricing psychology

Customers compare perceived value and total cost, not internal formulas. Evaluate sticker shock, fee presentation, fairness, simplicity, premium perception, and conversion impact. Do not blindly lower prices. Do not blindly add fees. Protect margin while making pricing feel clear and fair.

### Location copy

Do not stuff "Austin" or any city everywhere. City name belongs only in: title/meta, JSON-LD, hero eyebrow, service-area section, FAQ, nearby-city links. Generic value copy stays location-neutral so the platform can expand.

### No double-talk

Never show the same thing multiple ways under different labels. Bad double-talk: customer total shown as Easer earnings; a "booking confirmed" email while the dashboard says awaiting acceptance; "READY FOR JOBS" while another field says missing required item; platform revenue including tax. **One source of truth must lead every view.**

### Financial display

- **Customer sees:** service subtotal, tax, total charged.
- **Easer sees:** estimated earnings, final earnings, payout status.
- **Owner sees:** customer total, tax, platform fee, Easer earnings, Stripe fee, platform gross, payout status.

**Never show the customer gross total as Easer pay.**

### First 25 jobs

AssembleAtEase is in validation stage. Do not build for 1,000 jobs before proving 25 successful jobs. Prefer completed bookings, customer trust, Easer clarity, owner visibility, clean operations, and profit protection over more pages, features, automations, dashboards, or complexity.

### Final rule

Do not just make the website bigger. **Make the business clearer, stronger, more trustworthy, more profitable, and easier to operate.**

---

## ADDITIONAL FULL-PLATFORM AUDIT AREAS

When auditing AssembleAtEase, also check:

1. **Customer drop-off points** — where would a customer hesitate, leave, or compare competitors? Check homepage → service page → booking → checkout → confirmation.
2. **Owner action required** — every workflow must answer "what does Travis need to do next?" If the owner dashboard doesn't make the next action obvious, flag it.
3. **Failed-state audit** — check every failure case: payment declined, email fails, Easer doesn't accept, Easer cancels, customer cancels, Stripe capture fails, refund fails, photo upload fails, payout not recorded, tax report not filed.
4. **Empty-state audit** — every page must look professional with no data: no jobs, no reviews, no payout history, no Easers, no bookings, no tax remittances.
5. **Mobile owner / Easer audit** — not just customer mobile; owner and Easer dashboards must be usable on mobile because jobs happen in the field.
6. **Legal / tax / insurance consistency** — website, emails, contracts, Stripe, tax registration, insurance wording, and dashboards must all match: AssembleAtEase LLC, manual payout mode, sales tax collected, independent-contractor model, no hardware claims unless true.
7. **Real data vs assumption** — flag every estimated metric (CAC, add-on rate, repeat rate, rework reserve, opex, labor time, service profitability). The dashboard must clearly mark estimated vs actual.
8. **Post-job audit** — after job completion verify: payment captured, tax liability recorded, Easer earnings recorded, payout owed visible, customer receipt sent, review request sent, owner sees no loose ends.
9. **Duplicate / incomplete page audit** — find duplicate pages, city-swapped pages, unfinished pages, stale prices, reused photos, and pages that exist only for SEO but do not help customers.
10. **Launch survival audit** — assume the first 25 jobs: what can break? what will customers complain about? what will Easers complain about? what will cost money? what will Travis forget?
