# Easer Foundation Stabilization Audit

Date: 2026-05-27
Mode: Read-only architecture and code-path audit (no DB writes, no deployments, no feature expansion)
Scope: Easer operational reliability, mobile safety, session/auth hardening, dispatch consistency, notification reliability

## Executive Result

Stabilization baseline status: Partially ready.

What is strong today:
1. Dispatch acceptance races are guarded with atomic compare-and-set updates.
2. Lifecycle mutation endpoints enforce assigned-Easer ownership checks.
3. Core mobile shell includes safe-area tokens, fixed nav, and mobile-first tap target sizing.
4. Stripe capture flows are idempotent in completion paths.

What blocks declaring the Easer foundation fully stabilized:
1. Notification panel offset uses hardcoded `top:56px` on all Easer pages instead of safe-area-aware offset.
2. Scroll lock for modal uses `body:has(...)`, which has compatibility risk on older mobile Safari.
3. Real-time lifecycle robustness under weak/reconnect/session-expiry scenarios is partially handled, but not uniformly verified through executable mobile simulations.
4. Push registration flow uses a captured access token without explicit token-refresh retry in subscribe path.

## 1) Mobile UX Stability Audit

### Strengths
1. Mobile viewport and safe-area meta are present on primary Easer pages.
   - `viewport-fit=cover` present on home/jobs/earnings/profile pages.
2. Shared shell is safe-area aware.
   - Header/nav spacing uses `env(safe-area-inset-top/bottom)` and reserved body padding.
3. Bottom nav uses large touch targets.
   - `min-width:44px` and `min-height:var(--e-nav-h)` in nav items.
4. Bottom-sheet close state is hardened.
   - Local page styles force `display:none` on closed sheet overlays.

### Findings
1. High: Notification panel/backdrop use fixed `top:56px` instead of safe-area-aware top value.
   - Risk: overlap under iPhone notch/dynamic island; tap region inconsistency.
2. Medium: Modal scroll lock depends on `body:has(.modal-overlay.open)`.
   - Risk: lock failure on less compatible Safari versions causes background scroll bleed.
3. Medium: Loading and disabled states are present for key actions, but inconsistent text and persistence across pages can cause ambiguity under flaky network.
4. Medium: Keyboard overlap risk remains in support-message composer inside bottom sheet/modal due lack of keyboard-aware insets and focused-element auto-scroll guarantees.

## 2) Easer Lifecycle Reliability Verification

### Strengths
1. Offer receive/queue model is explicit (`_is_pending_offer`) and hides customer PII until acceptance.
2. Accept/decline routes require JWT and offer ownership (`easer_id`) checks.
3. Expired offer handling returns explicit `410` path.
4. Status progression (`en_route`, `arrived`, `in_progress`) is transition-guarded with workflow engine checks.
5. Completion endpoint verifies assigned Easer, active status, and transition legality.
6. Home and jobs pages both support accept/decline and stage updates using Bearer-auth API calls.

### Findings
1. Medium: Completion proof upload is not present in lifecycle flow.
   - Operationally relevant for disputes and interrupted completion scenarios.
2. Medium: Job history consistency relies on repeated fetch/reload strategies and realtime refreshes; there is no explicit versioning or optimistic conflict model in UI state.
3. Low: Review linkage is indirect (profile review section), not clearly integrated as a post-completion operational step in Easer job flow.

## 3) Session + Auth Hardening Audit

### Strengths
1. Client auth is persisted and auto-refreshed (`persistSession`, `autoRefreshToken`, `detectSessionInUrl`).
2. Easer pages call `APP.requireAuth(['assembler'])` and retry on 401 with refresh in jobs/earnings fetch flows.
3. Multiple pages include explicit token refresh helper logic before protected API calls.
4. Stripe Identity return handling exists in apply flow (`?verification=complete`).

### Findings
1. Medium: Protected-route enforcement is role-based and authentication-based, but verified/suspended gating is not uniformly centralized at route level across all Easer pages.
2. Medium: Home push-subscribe registration path sends subscription with cached `_swToken` and no explicit refresh-and-retry if token expired at subscribe call time.
3. Low: Mixed login route usage patterns (`/auth/login` and `/auth/login.html`) can increase redirect complexity and edge-case inconsistencies.

## 4) Dispatch Consistency Verification

### Strengths
1. Duplicate assignment race is blocked by CAS guard (`.is('assembler_id', null)`) in accept path.
2. Offer ownership and status checks enforce correct accept scope.
3. Expired/accepted/superseded statuses are explicitly represented and handled.
4. Dispatch engine deduplicates active sent offers before new dispatch round.
5. Eligibility enforces active status, identity verification, and availability.
6. Membership/tier logic is explicitly included in dispatch scoring.
7. Daily cap and decline-penalty logic exist.

### Findings
1. Low: Schema guarantees `UNIQUE(token)` but not unique active-offer-per-(booking_id,easer_id). Current code prevents duplicates logically, but DB-level invariant could be stronger.
2. Low: Legacy token path remains for backward compatibility and increases branching surface.

## 5) Notification Reliability Audit

### Strengths
1. Offer dispatch uses push plus email path, giving fallback beyond push.
2. Push attempts are logged to `notification_log` with status.
3. Dead subscriptions are cleaned when 404/410 occurs.
4. Service worker click handler deep-links into Easer pages.

### Findings
1. Medium: Push registration is initiated from home page only; users who never open home may remain unsubscribed.
2. Medium: No explicit dedupe key for push payloads per booking/event in service worker layer; multiple subscriptions per user can surface perceived duplicates.
3. Medium: Notification UI panel is currently static placeholder, not backed by operational notification feed, reducing in-app recovery when push is delayed.
4. Low: Background behavior depends on browser push support; no in-app polling fallback is defined for missed push while app stays backgrounded long periods.

## 6) Mobile Operational Testing Matrix

Result classification:
- `Code-verified`: behavior is clearly enforced by current code paths.
- `Partially verified`: behavior has partial safeguards but no full end-to-end simulation evidence in this audit run.
- `Not fully verified`: requires controlled runtime simulation/device testing.

1. Weak connection
- Status: Partially verified
- Basis: offline banners, retry/load patterns, reconnect fetch paths.
2. App refresh mid-job
- Status: Code-verified
- Basis: state reload from `/api/booking/my-assignments` and stage rendering from backend truth.
3. Reconnect during active booking
- Status: Partially verified
- Basis: visibility/online refresh hooks exist.
4. Expired session during status update
- Status: Partially verified
- Basis: token refresh helpers exist, but not uniformly wrapped around every operational action with deterministic retry policy.
5. Double-tap actions
- Status: Code-verified for key CTAs
- Basis: immediate disable/loading state on accept/decline/complete buttons.
6. Slow uploads
- Status: Not fully verified
- Basis: no completion-proof upload pipeline in current lifecycle flow.
7. Failed uploads
- Status: Not fully verified
- Basis: no upload pipeline in current lifecycle flow.
8. Interrupted completion flow
- Status: Partially verified
- Basis: idempotent server completion/capture guards exist; UI recovery is refresh-driven.

## 7) UI/UX Cleanup Audit (Operational Minimalism)

### Good direction already present
1. Easer pages are task-oriented and mobile-first.
2. Bottom nav and active-job-first layout are aligned to operational usage.
3. Offer/action controls are direct and concise.

### Cleanup opportunities before expansion
1. Reduce static/placeholder notification panel content and align wording to operational actions.
2. Unify loading/disabled copy across actions (accepting, declining, processing, retry).
3. Remove residual desktop-like density in some modal/detail sections on jobs page.
4. Improve concise empty/error messaging for low-connectivity contexts.

## 8) Scope Control Check

No expansion recommendations in this report include:
1. Marketplace intelligence additions.
2. New automation systems.
3. Customer-flow redesign.
4. Scaling architecture redesign.

## Required Pre-Expansion Stabilization Gates

These are the minimum gates to declare the Easer foundation fully stabilized:

1. Mobile safe-area correctness gate
- Replace hardcoded notification panel/backdrop top offsets with safe-area-aware offsets across Easer pages.

2. Modal/scroll reliability gate
- Remove dependency on `body:has(...)` for scroll lock and use compatibility-safe lock pattern.

3. Session-resilient action gate
- Standardize token refresh + one-retry wrapper for all lifecycle mutations (accept/decline/stage/complete/push-subscribe).

4. Notification reliability gate
- Add deterministic dedupe key handling for in-app notification presentation and ensure non-home page path can still complete push subscription flow.

5. Operational simulation gate
- Execute controlled mobile test runbook for weak network, reconnect, session expiry, double-tap, interrupted completion, and delayed notification scenarios.

## Final Gate Decision

Current objective status:
- Operational mobile Easer foundation is substantially hardened but not yet fully stabilized for pre-expansion sign-off.

Decision:
- Proceed with Easer Foundation Stabilization remediation only.
- Do not add new Easer functionality until the required pre-expansion stabilization gates above are closed.
