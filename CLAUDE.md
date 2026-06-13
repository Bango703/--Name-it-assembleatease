# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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
- **Owner:** Simple password auth via `x-owner-password` header, verified server-side by `verifyOwner(req)` in `_email.js` against `OWNER_PASSWORD` env var. No JWT.

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
