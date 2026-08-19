# AssembleAtEase Email, Easer Platform, and Owner Operations Audit

**Audit date:** August 18, 2026

**Audience:** Founder, engineering, operations, customer success, finance, risk, and QA

**Decision horizon:** First 25 real jobs

**Repository:** `Handyman-marketplace` on `main` at rebooking commit `09342c63`

## Audit Scope and Evidence

This audit covers:

- Every repository file that sends customer, Easer, or owner email through `sendEmail()`
- All authenticated Easer pages and their primary and exception workflows
- All owner navigation areas, booking actions, case handling, finance presentation, and notification visibility
- Authentication, role ownership, payment-state, payout-state, and audit-log boundaries touched by those workflows
- Responsive behavior across the project's eight-width visual matrix

Evidence used:

- 148 email send call sites across 72 API files
- 431 owner/Easer interaction hooks inventoried
- `npm run test:launch`: PASS
- Mobile visual audit: 50 routes at 8 widths, 400 page-width checks
- Static endpoint/auth review and existing focused workflow tests
- Read-only DNS authentication checks for AssembleAtEase mail

Important limitation: no signed-in browser session was available to this audit run. The click audit therefore uses source inspection, the project's mocked browser harness, and regression tests. It does **not** claim a live production, real-account click-through. That live proof remains a release gate.

---

## 1. Executive Summary

### Is the platform launch-ready?

**Conditionally ready for one closely supervised real booking; not ready for unattended volume.** The core booking, Stripe, Easer state, cancellation, refund, completion, and payout regression suite passes. No new payment-mutation or payout-mutation failure was found in this audit.

### Biggest risk

The biggest risk is notification truth. The platform records an email as `sent` and exposes fields named `notificationDelivered` or `emailDelivered` as soon as Resend accepts the API request. There is no webhook handling for final `delivered`, `bounced`, or `complained` events. The owner can therefore believe a critical customer or Easer email reached an inbox when it did not.

### What must be fixed before relying on the platform at volume?

1. Add verified Resend delivery webhooks and show true delivery status to the owner.
2. Turn owner Cases into a complete contact-and-resolution workflow; “Wait for Customer” must actually send or require a message.
3. Replace the Easer's static notification bell with a real notification inbox or remove the bell until one exists.
4. Perform one signed-in production smoke test for each customer, Easer, and owner critical path.

### What can wait?

Brand-blue cleanup, minor touch-target adjustments, address capitalization, and deeper component refactoring can wait until the critical operational truth is fixed.

---

## 2. PASS / WARNING / FAIL Matrix

| Category | Status | Evidence and decision |
|---|---|---|
| Customer flow | WARNING | Booking and rebooking regression tests pass, including secure payment-method collection. Final inbox delivery is not known. |
| Customer emails | FAIL | Critical templates exist, but provider acceptance is presented as delivery and bounce/complaint events are not ingested. |
| Easer onboarding | WARNING | Readiness, agreement, identity, owner approval, and manual-payout gates pass. Account-closure lifecycle emails to the Easer are incomplete. |
| Easer platform | WARNING | Core job state machine passes. Notification bell is static, and critical mutations are duplicated across Home and Jobs. |
| Owner dashboard | FAIL | Underlying operations work, but Cases cannot contact the party they claim to be waiting for, email delivery truth is absent, and the booking/finance interface is excessively dense. |
| Payments | PASS | Server-side Stripe truth, authorization, capture, rebooking, refund, and manual-payment regression tests pass. |
| Payouts | PASS | Payment collection and Easer payout remain separate; payout ledger and closure guards pass. |
| Cancellations | PASS | Customer/Easer/owner role checks and server-calculated cancellation behavior pass regression coverage. |
| Refunds | PASS | Stripe truth and guarded owner refund flows pass focused tests. |
| Pricing | WARNING | Server authority is preserved, but this audit did not repeat a service-by-service margin review. |
| Finance tracking | WARNING | Canonical finance API tests pass. Owner-entered CAC and overhead assumptions live only in browser storage, and the page is too dense for fast decisions. |
| Legal documents | WARNING | Existing launch tests pass; legal text was not substantively re-audited in this email/Easer/owner scope. |
| SEO | WARNING | Not substantively re-audited in this scope. Existing statewide email-copy tests pass. |
| Security | WARNING | Critical owner/Easer mutation endpoints inspected use owner verification or authenticated user ownership. A live authorization/IDOR test was not possible without a signed-in session. |
| Operations | FAIL | Case contact loop, notification truth, and owner action hierarchy are incomplete. |
| Notifications | FAIL | Static Easer inbox plus no final email-delivery events. Push subscription exists, but the bell is not a durable inbox. |
| Database / data quality | WARNING | Booking and ledger guards pass. Notification status vocabulary is insufficient for provider lifecycle truth, and several email logs lack full recipient/booking metadata. |

---

## 3. P0 Issues

### P0-01 — Email provider acceptance is presented as inbox delivery

**Problem**

`api/_email.js` writes `status: 'sent'` after a successful Resend API response. Many APIs then return `notificationDelivered` or `emailDelivered` based on that result. No code handles Resend delivery events such as delivered, bounced, or complained.

**Why it matters**

A booking remains safe because email failure does not mutate financial truth, but a customer can miss a booking confirmation, payment action, cancellation, refund, or return-visit notice. An Easer can miss an offer, schedule change, evidence request, or payout notice. The owner currently has no authoritative way to distinguish “accepted by provider” from “delivered to mailbox.”

**Who is affected**

Customers, Easers, owner operations, and support.

**Can it lose money or strand work?**

Yes. Missed payment-action and assignment messages can strand a booking; missed cancellation or schedule-change messages can create a trip, refund, or complaint.

**Files / APIs involved**

- `api/_email.js`
- `api/migrations/004_observability.sql`
- `api/migrations/053_operations_cases.sql`
- Every endpoint returning `notificationDelivered` or `emailDelivered`
- `api/owner/live-ops.js`
- `api/owner/email-usage-report.js`
- `owner/index.html`

**Smallest safe fix**

1. Rename immediate truth to `providerAccepted` in new responses and owner copy.
2. Add a signature-verified Resend webhook endpoint.
3. Store provider lifecycle states: `queued`, `sent`, `delivered`, `delivery_delayed`, `bounced`, `complained`, `failed`, and `suppressed`.
4. Update by immutable `provider_id`, with idempotency for repeated webhook events.
5. Surface critical undelivered/bounced notifications in Live Ops and the linked booking timeline.
6. Add a customer/Easer fallback action: Call, Text, or Resend.

**Required tests**

- Valid and invalid webhook signature
- Duplicate webhook event replay
- Out-of-order delivered/bounced events
- Critical bounce creates one owner action item
- Email failure never rolls back or changes booking/payment truth
- Owner UI never labels provider acceptance as delivery

---

## 4. P1 Issues

### P1-01 — Owner Cases changes status without completing the communication loop

The Cases UI offers `Wait for Customer` and `Wait for Easer`, but `api/owner/case-action.js` only changes internal status and records an internal note. It does not send a message. The operations-case layer supports `public_message`, but the owner form never collects or submits it.

**Business impact:** the owner thinks the case is waiting on someone who was never contacted. Cases then feel empty and remain open without a clear next step.

**Recommended change:** when choosing a waiting status, require a recipient-facing message, show the exact destination, send through the normal notification service, log the attempt to the case and booking, and leave the case in an explicit “Contact failed” owner-action state if provider acceptance fails. Resolving or closing must remain separate from refunds, booking status, or payout release.

### P1-02 — Easer notification bells are not real notification inboxes

`assembler/index.html`, `assembler/payouts.html`, and `assembler/profile.html` hard-code “No new notifications.” `assembler/my-assignments.html` has a `notif-list` element, but no code populates it. Clicking the bell only opens a static panel.

**Business impact:** the bell creates false confidence and can hide schedule changes, required evidence, payout changes, or support updates.

**Recommended change:** either build one authenticated Easer notification API backed by durable events and shared across all four pages, or remove the bell everywhere until that inbox exists. Do not maintain four separate notification implementations.

### P1-03 — Critical Easer job mutations are duplicated across Home and Jobs

Home and Jobs separately implement offer acceptance/decline, status updates, evidence upload, and completion behavior.

**Business impact:** server guards protect state today, but duplicated clients increase drift, QA burden, and inconsistent copy. A future change can work on one page and fail on the other.

**Recommended change:** Home should summarize the next job and deep-link into Jobs. Jobs should own the full mutation flow, or both pages should call one shared client module with one state renderer.

### P1-04 — Important emails do not consistently log recipient and booking context

Examples include portions of completion, legacy confirm/decline, application fee, owner-added Easer, stale reassignment, and AssembleCash email paths. Some call `sendEmail()` without `recipientType`, `recipientUserId`, or `bookingId`.

**Business impact:** owner search, case linkage, failure reporting, and delivery analytics cannot reliably answer who should have received what for which booking.

**Recommended change:** make structured email metadata required at the helper boundary. Reject or loudly log missing metadata in test/development; enforce enumerated notification and recipient types.

### P1-05 — Email templates and terminology are fragmented

Only 26 uses of the shared `buildStatusEmail()` were found among 148 email send sites. Most messages are bespoke inline HTML. Easer-facing examples still use internal language such as “Application Review Pending,” “Application Fee Review,” and “Reliability review.” Other templates alternate among Easer, assembler, pro, and professional.

**Business impact:** inconsistent tone, accessibility, footer behavior, and status language; internal workflow leaks to external users.

**Recommended change:** create a versioned email-template registry with shared layout, user-facing vocabulary, required CTA rules, and snapshot tests. Preserve internal detail only in owner emails.

### P1-06 — Account-closure lifecycle is not confirmed to the Easer by email

Request and cancellation endpoints notify the owner only. Final owner archive/revoke logic also returns API state without sending a final closure confirmation to the Easer.

**Business impact:** the person closing the account has no durable external receipt of request, cancellation, completion, access revocation, or retained financial/tax records.

**Recommended change:** send concise Easer receipts for requested, cancelled, and completed states. Do not expose internal reviewer names or queues.

### P1-07 — The owner Financials screen mixes accounting truth and planning assumptions

The canonical API passes, but CAC and other operating expense inputs are stored in `localStorage`. They vary by browser/device, have no saved-by or timestamp trail, and can make the same period report disagree between sessions. The screen also presents more than twenty KPI cards plus obligations, formulas, tax, 1099, service profitability, expansion, and ledger sections at once.

**Business impact:** the owner cannot quickly answer cash retained, obligations, gross profit, and actual net estimate. Planning inputs can look like authoritative company records.

**Recommended change:** use three layers:

1. **Cash truth:** customer cash retained, refunds, sales tax, unpaid Easer earnings, Stripe fees.
2. **Job economics:** gross platform contribution and service profitability.
3. **Planning assumptions:** reserve, CAC, and operating overhead, visibly labeled and durably saved with an audit timestamp.

### P1-08 — Owner dashboard has grown into a single high-risk monolith

`owner/index.html` is approximately 596 KB and 8,751 lines. Authentication, routing, booking detail, payments, messages, finance, Market Demand, content, Easer management, and modal behavior are coupled. Login also starts broad booking/payout loading and background polling before the owner selects a workflow.

**Business impact:** a small edit can regress unrelated owner operations; slow or failed secondary APIs can make the whole dashboard feel unstable or messy.

**Recommended change:** keep the current visual shell, but split by owner domain into tested modules: bookings, money, communication, cases, Easers, demand, and reporting. Lazy-load view-specific data. Do not redesign everything at once.

### P1-09 — Owner booking detail needs a next-action hierarchy

Many safe actions exist, but conditional notices and buttons accumulate in one long surface. Internal reconciliation, customer communication, money, assignment, evidence, and exceptions compete for attention.

**Business impact:** the owner can miss the one action that actually unblocks a job or payment.

**Recommended change:** render one **Next required action** first, then group the rest under Communication, Money, Assignment, Evidence, and Administrative actions. Destructive or overriding actions keep confirmation dialogs and server guards.

### P1-10 — The current visual audit can mask owner defects

The browser harness contains an undefined `url` reference in the Cases route and has no mock for `/api/owner/announcement-adoption`. After temporarily correcting the local harness to complete the audit, all 96 owner mock runs were flagged by that missing route, even though there were no navigation, overflow, fixed-clipping, page-error, or failed-request defects elsewhere.

**Business impact:** a green or red visual report can be misleading. Current owner changes are not receiving trustworthy full-page automated coverage.

**Recommended change:** repair the harness, add the missing owner mock, and fail separately for product errors versus missing test fixtures.

### P1-11 — Generic one-click unsubscribe headers are not aligned with the target URL

All emails receive `List-Unsubscribe-Post: List-Unsubscribe=One-Click`. Broadcast emails have a tokenized unsubscribe URL, but generic transactional mail falls back to a contact/preferences page that is not an email-specific one-click POST endpoint.

**Business impact:** inconsistent mailbox-provider behavior and misleading unsubscribe semantics.

**Recommended change:** use one-click POST only for tokenized marketing/broadcast unsubscribe endpoints. Keep transactional preference handling distinct and do not allow opting out of legally or operationally essential booking notices.

---

## 5. P2 Issues

1. `formatAddress()` uppercases the entire address in shared emails. Use title/canonical casing for reading while preserving the original stored value.
2. The Easer Profile “Close account” button is approximately 34 px high on mobile; increase interactive targets to at least 44 px.
3. Owner Cases filters are approximately 38 px high and the action select approximately 42 px at mobile widths.
4. Owner Cases renders raw stored phone formatting. Normalize for display while preserving a dialable `tel:` value.
5. Financial subtraction cards can show `-$0.00`. Normalize zero before applying a minus sign.
6. The privacy-page “Cookie choices” inline control is approximately 28 px high on mobile.
7. The owner/Easer shell uses 36 noncanonical blue color variants. Consolidate only during component extraction; this is not a launch blocker.
8. Standardize external role language on “Easer” with one short explanation of “independent professional” where needed.

---

## 6. Email Lifecycle Audit

| Lifecycle | Existing coverage | Status | Required correction |
|---|---|---|---|
| Booking request / quote request | Customer receipt and owner alert exist | WARNING | Add true delivery state and enforce booking/recipient metadata |
| Booking confirmed | Customer confirmation and track/manage CTA exist | WARNING | Distinguish provider accepted from delivered |
| Rebooking | Customer receives appointment details and secure payment-method link; success email confirms saved method/authorization | PASS | Complete one live Stripe test and add delivery webhooks |
| Assignment / offer | Easer offer and customer assignment acceptance messages exist | WARNING | Real Easer inbox needed; standardize terminology |
| On My Way / Arrived / Started | Customer status emails exist through booking status flows | WARNING | Verify final delivery and avoid duplicate sends across client entry points |
| Completion / receipt / review | Customer completion and receipt exist; review CTA routes through AssembleAtEase first | PASS | Consolidate duplicate completion templates and metadata |
| Cancellation / refund | Customer and Easer messages exist; customer refund timing is stated | PASS | Final delivery and bounce follow-up still required |
| Return visit / partial work | Schedule and resolution emails exist | PASS | Verify production rendering and delivery |
| Payment failure / reauthorization | Customer action and owner alerts exist | WARNING | Bounce on an action-required email must become an owner P0 action |
| Support/contact | Customer receipt and owner case alert exist | WARNING | Cases must be able to send and log the next external update |
| Damage / safety case | Owner receives and can investigate internal evidence | WARNING | Correctly keep raw allegations internal; add an explicit owner-controlled customer/Easer update when contact is required |
| Review follow-up | Multi-step review requests exist and point to platform review flow | PASS | Delivery tracking and suppression visibility required |
| Easer application / readiness | Application, verification, approval, rejection, evidence, and suspension messages exist | WARNING | Remove internal “review” language and centralize templates |
| Easer payout | Payout-recorded email exists and payment/payout truth is separate | PASS | Delivery status must be accurate |
| Easer account closure | Owner alerts exist | FAIL | Send requested, cancelled, and completed receipts to the Easer |
| Marketing/broadcast | Address and tokenized unsubscribe support exist | PASS | Keep separate from essential transactional preferences |

### Email authentication posture

- MX is configured through IONOS.
- The sending subdomain has Amazon SES/Resend-related MX and SPF records.
- DKIM record is present.
- DMARC is present with `p=none` and aggregate reporting to `service@assembleatease.com`.

**Assessment:** authentication is present, but DMARC is monitoring-only. After confirming legitimate sender alignment and monitoring reports, move deliberately toward quarantine/reject. Do not change DMARC blindly.

---

## 7. Easer Platform — Click-by-Click Audit

| Screen / action | Status | Audit result |
|---|---|---|
| Sign in and role gate | PASS | Authenticated Easer ownership is required by sensitive APIs. |
| Home summary | WARNING | Useful summary, but it duplicates full job mutations and has a static bell. |
| Online / Offline toggle | PASS | Readiness and agreement gates are enforced server-side; manual payout mode is not blocked by incomplete Connect. |
| Offers list and details | PASS | Easer can inspect job, earnings, timing, and location before accepting. |
| Accept offer | PASS | Auth and atomic assignment/concurrency tests pass. |
| Decline offer | PASS | Authenticated Easer ownership and dispatch state are checked. |
| Scheduled jobs list | PASS | Friendly service labels, absolute dates, payout, and job details are covered by regression tests. |
| Call / Text / Directions | PASS | Actions are available in job detail without cluttering the list. |
| On My Way | PASS | Two-hour availability window is enforced in UI and server tests. |
| Arrived / Start Job | PASS | State ordering and authenticated assignment ownership are enforced. |
| Evidence upload | PASS | Booking ownership and evidence flow tests pass. |
| Complete job | PASS | Server checks completion state, payment/payout separation, and evidence paths. |
| Need help / cannot make job | PASS | Structured reasons and safe self-drop/support routing exist. |
| Safety concern | PASS | Routed as a special exception path rather than a normal drop. |
| Earnings | PASS | Canonical earnings API and payout-status separation pass. |
| Payout preference | PASS | Saves preference only and does not collect bank credentials. |
| Profile and readiness | PASS | Profile source-of-truth and required action gates pass. |
| Notifications bell | FAIL | Static “No new notifications”; not a durable inbox. |
| Close account | WARNING | Financial and active-job guards are strong; Easer email receipts are incomplete and the mobile button is too small. |
| Mobile layout | WARNING | No document overflow or fixed clipping; one Easer touch-target issue remains. |

### Easer state machine confirmed

`Offer -> Accepted -> Scheduled -> On My Way -> Arrived -> In Progress -> Complete -> Payout Pending/On Hold -> Paid`

Internal reasons remain on the owner side; the Easer-facing labels use concise outcome states. This boundary should be preserved.

---

## 8. Owner Dashboard Audit

| Owner area | Status | Audit result |
|---|---|---|
| Login / owner verification | PASS | Owner endpoints inspected require owner verification; client session is intentionally memory-only. |
| Live Operations | WARNING | Useful action feed, but email failures show only initial send failure, not bounce/delivery truth. |
| Today | PASS | Date-scoped view and timezone tests pass. |
| Bookings | WARNING | Comprehensive, but action density makes the next required step hard to find. |
| Rebook cancelled job | PASS | Secure customer payment-method email and server-authoritative amount flow are implemented and pushed. |
| Dispatch | PASS | Preview, confirmation, eligibility, assignment, and payment safeguards pass. |
| Customer / Easer messages | PASS | Explicit recipient selection and server-side role checks exist. |
| Evidence | PASS | Owner can review/add historical evidence; damage acknowledgment and hold semantics are tested. |
| Cases | FAIL | Case state management exists, but waiting actions do not contact the customer/Easer and public updates are not exposed. |
| Customers | PASS | Booking/customer history view exists. |
| Market Demand | PASS | Real booking demand and submitted demand are combined by the audited API/tests. |
| Reviews | PASS | Owner can resend eligible review requests; links route through platform review. |
| Financials | WARNING | Canonical math passes; presentation mixes truth and assumptions and is too dense. |
| Easer approvals/readiness | PASS | Owner approval remains available while current agreement acceptance gates online readiness. |
| Easer payouts | PASS | Separate audited payout ledger and guards exist. |
| Easer waitlist | PASS | Owner review actions and messages exist. |
| Email operations | FAIL | An unused summary API exists, but no complete delivery/bounce center is surfaced. |
| Marketing / Content / AI | WARNING | Present, but not live-click verified in this session and secondary to first-25-job operations. |
| Mobile owner layout | WARNING | No broad overflow found; Cases touch targets and monolithic loading remain. |

### Owner information architecture target

The smallest safe cleanup is not a new giant control center. Use this order:

1. **Now:** Live jobs, late jobs, unassigned jobs, customer/Easer contact failures
2. **Money:** authorization/capture, refund, customer balance, Easer payout
3. **Cases:** new, waiting, action failed, resolved
4. **People:** customers, Easers, applications, waitlist
5. **Growth:** Market Demand, reviews, marketing, content
6. **Reporting:** finance, analytics, AI recommendations

Each booking should show one primary next action and disclose secondary/internal actions progressively.

---

## 9. Business Impact

- **Customer trust:** strong booking/payment copy can still fail if the inbox never receives it and owner believes it did.
- **Easer trust:** status and payout truth are strong, but a fake notification center undermines confidence.
- **Platform money:** core server-side financial safeguards pass; notification and case gaps can create avoidable refunds, missed jobs, and support cost.
- **Owner time:** the owner must scan too many cards and notices to find one next action, which will break before 25 simultaneous workflows.
- **Legal/compliance:** transaction and payout separation is good. Unsubscribe semantics and account-closure receipts need correction. Raw case allegations should remain internal unless the owner deliberately sends an external update.
- **Operational survival:** one supervised job is manageable; unattended scheduling, cases, or payment actions are not yet safe to trust solely from the dashboard.

---

## 10. Recommended Fix Order / Board Lanes

### Lane A — Before unattended bookings

- [ ] **P0:** Add verified Resend webhook and provider lifecycle states
- [ ] Rename provider acceptance versus inbox delivery throughout owner APIs/UI
- [ ] Add critical bounce/complaint owner action cards and fallback contact actions
- [ ] Run signed-in customer/Easer/owner production smoke test

### Lane B — Before scaling through the first 25 jobs

- [ ] Make Cases waiting actions send and log an external message
- [ ] Add a real shared Easer notification inbox or remove all bells
- [ ] Require complete metadata on every `sendEmail()` call
- [ ] Centralize customer/Easer templates and external vocabulary
- [ ] Add Easer account-closure lifecycle receipts
- [ ] Reorganize booking detail around one next required action
- [ ] Separate financial truth from durable planning assumptions
- [ ] Repair the visual audit Cases route and announcement-adoption mock

### Lane C — Controlled cleanup

- [ ] Move duplicate Easer job mutations into a shared module / Jobs-owned flow
- [ ] Extract owner domains from the monolithic HTML file
- [ ] Normalize address and phone display
- [ ] Remove negative-zero currency
- [ ] Raise remaining mobile touch targets to 44 px
- [ ] Consolidate noncanonical brand-blue variants during component work

---

## 11. Files and APIs Involved

### Email and observability

- `api/_email.js`
- `api/migrations/004_observability.sql`
- `api/migrations/053_operations_cases.sql`
- `api/owner/email-usage-report.js`
- `api/owner/live-ops.js`
- 72 email-sending API files listed by the audit inventory

### Easer

- `assembler/index.html`
- `assembler/my-assignments.html`
- `assembler/payouts.html`
- `assembler/profile.html`
- `api/assembler/*`
- `api/booking/accept-dispatch.js`
- `api/booking/decline-dispatch.js`
- `api/booking/easer-status.js`
- `api/booking/assembler-complete.js`
- `api/booking/drop-job.js`

### Owner

- `owner/index.html`
- `owner/assets/cases.js`
- `api/owner/cases.js`
- `api/owner/case-action.js`
- `api/_operation-cases.js`
- `api/owner/financial-dashboard.js` and `api/owner/_finance-ledger.js`
- `scripts/mobile-visual-audit.mjs`

---

## 12. Test Plan

### Customer perspective

1. Book now, scheduled authorization, custom quote, and rebooking.
2. Verify exact totals and that no email or browser value can change price.
3. Open every email CTA on desktop and mobile.
4. Trigger delivered, bounced, complained, delayed, and failed events.
5. Confirm track, payment, cancellation, refund, completion, and review pages match database/Stripe truth.

### Easer perspective

1. Apply, accept agreement, verify identity, receive owner approval, and go Online.
2. Offer -> accept -> On My Way gate -> arrive -> start -> evidence -> complete.
3. Exercise cannot-make-it, customer-unavailable, safety, and support paths.
4. Confirm every notification appears in one real inbox and deep-links to the correct job.
5. Verify payout pending/on hold/paid labels and account-closure receipts.

### Owner perspective

1. Run every sidebar destination at desktop, tablet, and phone widths.
2. Complete booking, rebooking, manual-payment, refund, payout, evidence, return visit, damage, and review-request actions.
3. Put a case into each state and prove that waiting actions contact the intended person.
4. Confirm every critical failed or bounced email becomes an owner action.
5. Reopen the finance page on another browser and confirm assumptions/report output remain consistent.

### Stripe and source-of-truth perspective

1. Test authorization, capture, cancellation, refund, partial refund, duplicate webhook, dispute, and failed payment.
2. Prove no email result changes a Stripe, booking, refund, or payout state.
3. Prove customer payment captured, Stripe transfer, manual payout record, and bank payout stay distinct.

### Required result format

Each scenario must be recorded as `PASS`, `WARNING`, or `FAIL`, with booking reference, actor, database state, Stripe state where applicable, notification provider state, timestamp, and screenshot/log evidence.

---

## 13. Launch Recommendation

- **Would I launch tomorrow?** Only for one personally supervised booking with phone/text fallback and manual owner checks.
- **Would I accept one real customer?** Yes, if the owner verifies the confirmation, assignment, payment, and completion communications manually.
- **Would I onboard real Easers?** Yes, in a small controlled group; tell them not to rely on the in-app bell yet.
- **Would I turn on Stripe Connect?** No. Keep manual payouts until a full end-to-end Connect payout and failure-recovery test passes.
- **Would I keep manual payouts?** Yes. The current ledger separation and safeguards are appropriate for the first 25 jobs.
- **Exact launch condition:** no booking proceeds unless the owner can see authoritative payment state, assignment acceptance, customer/Easer contact confirmation, completion evidence, and payout state in the dashboard.

---

## 14. First 25 Jobs Survival Plan

### Before each job

- Confirm customer phone and email
- Confirm payment authorization or recorded owner-manual funds
- Confirm Easer assignment and acceptance in the database/dashboard
- Confirm both parties received schedule details; use phone/text until delivery webhooks exist
- Confirm required agreement/readiness and job-specific equipment/vehicle needs

### Day of job

- Watch Today and Live Ops for On My Way, Arrived, late, or unassigned state
- Call/text if a critical status email is not independently confirmed
- Keep case allegations internal until an owner-approved external message is ready
- Record any exception in the booking timeline and linked case

### After each job

- Verify completion evidence
- Verify Stripe capture or owner-manual payment truth
- Verify refund/discount state if applicable
- Verify Easer earnings and separate payout status
- Send/verify customer receipt and review request
- Reconcile sales tax, Stripe fee, Easer earnings, and platform gross

### Daily owner closeout

- Unassigned/late jobs
- Failed or bounced critical communications
- Open cases and who is actually waiting on whom
- Payment authorizations/captures needing action
- Unpaid Easer earnings
- Refunds/disputes
- Tomorrow's readiness and assignment coverage

---

## 15. Missing Business Systems

1. Provider-truth email delivery center with bounce/complaint handling
2. Real Easer notification inbox with read/unread state and deep links
3. Case communication composer and response history
4. Durable owner planning assumptions with edited-by/edited-at audit
5. Shared, versioned email template registry and rendering snapshots
6. Release smoke-test checklist with named evidence for customer/Easer/owner/Stripe
7. Escalation SLA timers for new, high-priority, and waiting cases

---

## 16. What the User Forgot to Ask

- Who owns each critical notification failure, and within how many minutes must they act?
- What is the fallback when the customer never opens the secure payment or rebooking link?
- How will support prove which exact email version and CTA a person received?
- When may a closed damage/safety case be reopened, and who can see the allegation?
- How long are evidence, case notes, notification logs, and account-closure records retained?
- What happens if Resend, Supabase, Stripe, or the owner dashboard is unavailable on job day?
- Which four owner numbers must be checked every morning: tomorrow's assigned jobs, payment actions, open priority cases, and unpaid Easer earnings?
- What is the rollback plan if a new owner UI release passes unit tests but fails the signed-in smoke test?

---

## Final Board Decision

**Core money safety:** PASS

**Customer/Easer communication truth:** FAIL

**Easer operational workflow:** WARNING

**Owner usability and case workflow:** FAIL

**Recommended release posture:** supervised first booking only; fix delivery truth and case communication before unattended growth.
