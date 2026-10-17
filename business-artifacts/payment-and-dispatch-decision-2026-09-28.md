# Payment, confirmation and dispatch: decision audit

Date: 2026-09-28. Source reviewed: `deb3e7fe`, including the pending PR 226 fixes. PR 226 is not yet merged or deployed; GitHub's billing lock blocked its required check. This document recommends a workflow; it does not change application behavior or existing customer payment timing.

## 1. Executive summary

**Recommendation: reserve the appointment and begin staffing immediately after successful payment-method setup; require a verified, sufficient payment hold before travel; collect the agreed payment after completion.**

For appointments close enough for a normal hold to cover the work, place that hold during checkout, before confirming success. For appointments farther ahead, save and verify the card with customer consent, start staffing, and place the hold nearer service. Use a target of 72 hours before the appointment for the revised advance-booking design, with the actual Stripe deadline controlling readiness. This target is an operational recommendation, not a guarantee of any issuer's authorization window.

Do not make automatic staffing wait simply because a future payment hold is intentionally scheduled. Do not call a saved card funds held. Do not send an Easer to work without current payment protection. A failed or unreadable payment check must be visible early enough to resolve before travel.

Product/Marketplace Operations: reserve contractor capacity promptly. Finance/Payments: protect the service with a real hold and preserve idempotent capture. Customer Experience/Content Design: disclose a temporary hold before it affects available funds, and ask for action only when the customer can resolve the problem. Owner's Office: the owner should see one next action, not infer readiness from conflicting badges.

The existing system already allows the owner to assign an Easer to a verified saved-card booking and that Easer to accept. It is automatic offers, not all staffing, that currently wait for the hold.

## 2. PASS / WARNING / FAIL matrix

These are source-review and isolated-helper findings, not a live end-to-end certification.

| Area | Result | Evidence |
| --- | --- | --- |
| Near-term checkout | PASS | Manual-capture payment is authorized before successful confirmation; source verifies matching Stripe payment. |
| Advance reservation | PASS | Successful SetupIntent saves the card and creates a reserved appointment; it does not claim funds have been collected. |
| Early owner staffing | PASS | Owner assignment and assigned-Easer acceptance allow saved-card bookings; travel remains separately gated. |
| Automatic staffing | WARNING | Offers wait for authorization even when a verified saved card and future appointment are present. This is a deliberate current policy, not proof of a broken bank payment. |
| Actual hold duration | WARNING | Six-day immediate/five-day scheduled rules can require renewal. Stripe's real deadline, not either constant, determines coverage. |
| Easer action consistency | FAIL | Button availability considers appointment time alone; the action endpoint can then reject payment readiness. |
| Unknown hold deadline | FAIL | Travel deliberately allows an unknown deadline; it has not established that the hold covers completion. |
| Failure wording | FAIL | Known expiry can be described as requiring a new customer card even when the existing saved card may be reusable. |
| Staffing status presentation | FAIL | Saved-card tracking returns the reservation status before an accepted Easer status, hiding that separate milestone. |
| Live policy change | NOT PERFORMED | No live charges, holds, cancellations, customer messages, dispatch offers or application edits in this audit. |

## 3. P0 issues: payment protection

### P0-PAY28-A: readiness must use verified current payment evidence

`api/_source-of-truth.js:146` allows authorized bookings with a linked PaymentIntent through its dispatch predicate without evaluating the hold deadline. `api/booking/easer-status.js:120` blocks known expired/insufficient deadlines at the en-route transition, but intentionally allows unknown deadlines. A status label is not proof that money remains capturable.

Reproduction with isolated real helper functions: an authorized fixture whose hold ends before expected completion returns `isBookingPaymentReadyForDispatch=true`, while `evaluateAuthorizationWindow` returns `authorization_expires_before_completion`. A saved-card fixture returns false for automatic dispatch and true for the explicit owner-assignment option. No database or provider writes are involved.

For the recommended design, deliberately separate staffing eligibility from travel/work readiness. Use one server-derived result for every travel/work entry path and the Easer action availability. Unknown evidence should first trigger a safe provider read/recovery attempt; if it cannot be established, keep the job unavailable to start and create an owner-visible action. Do not blame the customer for an unavailable provider read or our own integration error.

### P0-PAY28-B: do not use a fixed seven-day assumption

The booking window is 30 days. Current immediate authorization lasts through six Chicago calendar days and scheduled authorization starts within five days. Stripe documents standard online card windows of seven days for many transactions and an exact Visa merchant-initiated window of four days and eighteen hours. The transaction's `capture_before` field determines its actual deadline.

Holding every advance booking immediately can require repeated replacement holds before the appointment. Replacement holds can overlap at the customer's bank; successful card setup also does not guarantee a later hold will succeed. None of these mechanisms permits treating a 30-day appointment as funded through completion merely because a hold succeeded today.

Extended authorizations are available only with supported networks/categories and account access. They may reach 30 days, but are not a universal solution for all customers or this 30-day booking horizon plus work time. Do not make them the baseline policy without proving eligibility and costs for this account.

Sources: [Stripe hold validity and capture deadlines](https://docs.stripe.com/payments/place-a-hold-on-a-payment-method), [extended authorization eligibility](https://docs.stripe.com/payments/extended-authorization), [replacement-hold overlap](https://support.stripe.com/questions/does-stripe-support-holding-an-authorization-for-more-than-7-days-before-capture?locale=en-GB). The support article's older blanket statement about extended holds is superseded by the extended-authorization integration documentation; only its overlap warning is used here.

## 4. P1 issues: confusion and unnecessary waits

- **Staffing delay:** future bookings are written with `dispatch_paused=true`; the offer engine rejects saved-card state. Early owner assignment is already supported but the future-booking owner banner does not clearly explain it. Do not solve this by pretending saved-card means authorized.
- **Misleading next action:** Easer `_stage_availability` checks time only (`api/booking/my-assignments.js:403`), whereas `easer-status.js:83` also checks payment. One server-derived readiness result should drive the button and mutation, with a fresh recheck on mutation.
- **Incorrect blame:** `easer-status.js:136` says the customer needs to update their payment method on known expiry and says the office was notified. That branch records activity; it does not prove notification delivery. Try valid internal recovery first and show an owner action when that fails.
- **Hidden accepted Easer:** `api/booking/track.js:68` returns saved-card reservation text before checking `assembler_accepted_at` at line 74. Appointment, staffing and payment are distinct facts; staffing should remain visible while payment is scheduled.
- **Hold disclosure:** near-term checkout/confirmation emphasizes the saved card and no charge, while full temporary holds can reduce available funds. Explain the actual effect in plain language before confirmation. Future checkout expressly promises no temporary hold today; existing bookings must retain their agreed timing.
- **Confirmation race:** `api/assembler/stripe-webhook.js` and `api/booking-confirmed.js` can confirm from the same payment event. The latter's already-confirmed fast return precedes its owner-notification/SMS block. Trace both race orders and establish one durable notification intent per audience; do not add duplicate sends to compensate. Source finding; race integration proof remains to implement.
- **Wrong owner error:** `api/booking/confirm.js:36` groups every saved-card booking with custom quotes. A saved-card future reservation is not necessarily an unapproved quote.

## 5. P2 issues: presentation

Show four clear owner facts: appointment, assigned/accepted Easer, payment readiness, and next action. Customer and Easer views should show only their relevant status and action. Avoid exposing internal states, payment processor objects, renewal jobs or reconciliation details.

## 6. Business impact and recommended sequence

| Moment | Desired behavior | Customer experience |
| --- | --- | --- |
| Standard booking checkout | Server prices total and verifies payment method. If appointment is within the near-term policy, authorize the total now. | One checkout. Hold timing and total disclosed before submission. |
| Advance booking accepted | Save verified card and record consent; reserve appointment; immediately allow permitted matching/owner dispatch. | Appointment reserved; matching underway. No assertion that an Easer has accepted yet. |
| Easer accepts | Record one assignee atomically and show the actual accepted person. Retain the job if later payment needs recovery. | The Easer's name and arrival window become visible. |
| About 72 hours before service | For new-policy advance bookings, automatically place the hold. Verify amount, booking/customer identity, live mode and actual deadline. | No extra task when it succeeds. |
| Genuine payment problem | Use bounded/idempotent internal recovery when appropriate. If the bank requires customer action or a decline needs correction, send one actionable secure link and show owner follow-up. | Clear action only when needed; no repeated routine email/SMS about each internal attempt. |
| Before travel/work | Recheck shared readiness. A scheduled payment check in the future is not a reason to cancel the already-accepted assignment. Missing protection at service time prevents starting. | Any unresolved delay is explained without internal terminology. |
| Work complete | Validate evidence and authorized amount, collect payment once, and record completion/payment truth accurately. | Receipt for the actual charge. |
| Easer payout | Follow the existing payout policy, independently from customer collection. | Easer sees own earnings and payout status. |

Owner pauses, dispatch geography, Easer readiness, service suitability, offer budgets and atomic single-winner acceptance remain enforced. Enabling early offers must not unpause owner-stopped bookings or send one offer burst after another.

Why this recommendation: it provides early staffing without tying up customer funds for weeks or creating repeated holds just to satisfy a dispatch predicate. Charging the full job at booking would change the advertised pay-after-completion contract and refund obligations; that is not recommended as a shortcut. Extended holds can be evaluated later as an optional optimization, not assumed available.

## 7. Recommended fix order

1. **P0:** Unify verified travel/work readiness, projection and action checks. Resolve unknown deadlines before travel; preserve money locks, idempotency, cancellation races and provider-truth checks.
2. **P1:** Correct Easer action/copy and customer staffing projection so current supported early owner assignment is understandable.
3. **P1:** Introduce explicit eligibility for advance offers from verified saved-card bookings, with existing owner controls and single-assignee concurrency. Keep payment/start readiness separate. Release only after failed-payment and cancellation recovery are proven for accepted advance jobs.
4. **P1:** For new bookings, align near-term authorization and scheduled holds around a 72-hour target, actual deadline coverage, reliable due-time processing, and explicit checkout disclosure. Preserve existing booking promises or obtain a new explicit agreement on reschedule; never silently move a legacy hold earlier.
5. **P1:** Consolidate confirmation and action-needed notice intents so both webhook-first and browser-first outcomes notify correctly once, respect preferences, and retain owner-visible failures.
6. **P2:** Simplify owner milestone presentation using the same facts. Do not introduce parallel booking status truth.

## 8. Files/APIs involved

- Booking timing/creation: `api/booking/_booking-window.js`, `api/booking.js`, `api/booking/setup-intent.js`, `book.html`.
- Confirmation: `api/booking-confirmed.js`, `api/booking/confirm.js`, `api/assembler/stripe-webhook.js`.
- Staffing: `api/_source-of-truth.js`, `api/booking/_dispatch-internal.js`, `api/booking/assign.js`, `api/booking/accept-dispatch.js`, `api/cron/auto-dispatch.js`, applicable assignment/dispatch migrations.
- Payment protection: `api/booking/_authorization-window.js`, `api/cron/authorize-scheduled-payments.js`, `api/cron/reauth-payments.js`, `api/booking/easer-status.js`, `api/booking/assembler-complete.js`, `vercel.json`.
- Presentation/consent: `api/booking/my-assignments.js`, `assembler/my-assignments.html`, `api/booking/track.js`, `owner/index.html`, `terms.html`, current customer-language/email helpers and retry eligibility.
- Manual payout mode does not relax customer-payment protection. Owner-created offline bookings keep their narrow existing exception; it must not become a way to bypass ordinary customer payment rules.

## 9. Test plan

Use fake records and Stripe test mode for money behavior. No live customer is a test fixture.

- Customer: same-day/72-hour/boundary/30-day dates, DST and local time; SetupIntent success/failure; real hold disclosure; no false confirmed or accepted claim; actual bank-action recovery; reschedule and cancellation consent; no extra routine notices.
- Easer: accept advance offers without travelling; same readiness result in button and API; valid hold through completion; expired/unknown/declined/locked states; no loss of assignment on a recoverable internal error; stale/duplicate acceptance; evidence and completion.
- Owner: immediate staffing visibility; explicit owner pause preserved; exact next action and payment deadline; owner-assigned and automatically offered jobs; old customer promises retained; offline/manual payout distinctions.
- Stripe: payment/customer/amount/mode identity; insufficient capturable amount; actual expiration; authentication required versus integration failure; bounded retries and duplicate requests; atomic provider success/DB failure recovery; replacement cancellation ordering; no duplicate capture or payout.
- Notifications: webhook-first/browser-first confirmation; save failures; stale retries; customer opt-out; recipient/channel budgets; no duplicate assignment/customer alerts; internal failures never mislabeled as bank demands.
- Regression: cancellation, reschedule, deposits, partial/return visits, refunds, crew pay/access, customer/Easer ownership and current launch suite. Browser-test all affected screens at 1440/768/375; this remains distinct from a full accessibility audit.

## 10. Launch recommendation

Use the already-supported owner assignment path for advance staffing while the broader automatic workflow is being made consistent. Do not change the six-day constant to 30, capture early to bypass dispatch, or remove payment gates. The proposed advance-offer expansion requires the readiness/recovery work above before activation. No payment behavior was changed by this audit.
