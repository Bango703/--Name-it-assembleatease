# Notification timing and operational delivery QA — September 23, 2026

Implementation and offline verification in the isolated `aae-notification-fixes-20260923` worktree. No outbound message, production data change, migration application, commit, push, or deployment was performed by this work.

## Timing matrix

| Cron / purpose | Timing and channel | Duplicate / stop rule |
|---|---|---|
| `reminders`: prior-day appointment | One email for each customer and accepted Easer, on the prior calendar day at or after 9 AM and before 8 PM in the job's timezone. Hourly scan. | Durable recipient + appointment-version key. Legacy successful email and SMS records are recognized separately. Email expires at 8 PM that same local day, so a delayed message cannot say “tomorrow” on the appointment day. |
| `reminders`: day-of appointment | At most one SMS per consenting customer/Easer, approximately two hours before arrival; the hourly scan may catch it less than an hour after that target. | Both target and actual send must be within 8 AM–8 PM. An early target is skipped, not shifted into the arrival window. Expires one hour before the appointment. No simultaneous email from this cron. |
| Routine sender coordination | Shared sender enforces the recipient's spacing and daily allowance across channels. The cron also avoids reminders within four hours of booking creation/rescheduling, and of acceptance for the Easer. | A deferred result is not a successful send. Delivery keys distinguish reschedules, return appointments and new Easer acceptances. The display-only `reminder_sent` flag cannot suppress another recipient/channel/version. |
| `reminders`: owner authorization-age review | At most one successful owner digest per Central calendar day for confirmed bookings whose authorization record is at least five days old. | Actual capture deadlines must be checked in Stripe. Copy does not assert every hold lasts seven days or instruct premature completion/cancellation. Failed sends do not increment the warned count. |
| `easer-arrival-nudge` | Every 15-minute scan; first at/after arrival-window start; second at least 30 minutes after the first actual successful send. Prefer push, with consented SMS fallback. | Maximum two successful nudges. Stop on arrival, cancellation, reassignment, stale appointment after six hours or separate return visit. SMS also expires at the six-hour cutoff. Pending/uncertain SMS cannot trigger an alternate duplicate push. |
| `unassigned-escalation`: sourcing | Owner alert when an unaccepted confirmed booking is six hours or less away. | Successful delivery record and durable appointment key; unsuccessful alerts remain actionable. Not an automatic cancellation. |
| `unassigned-escalation`: customer cutoff | Customer staffing notice at two hours or less, then a truthful owner outcome notice. | Customer sent timestamp is written only after provider acceptance or a proven prior success. Owner failure retries do not resend the customer notice. Missing/failed delivery is not reported as “customer notified.” |
| `no-show-check` | Every 30-minute scan; owner-only alert after 60 minutes past the start of an accepted but unarrived booking. | Successful owner-notification proof, not an unverified legacy activity event, stops repeat sends. Recheck appointment, assignment and current state before sending. No automatic redispatch. |

Staffing escalation retains its existing 12-hour lookback; no-show review retains its existing three-day lookback. These are urgent operational alerts and are not routine appointment marketing. The normal arrival/staffing/no-show scans skip separate return-visit records rather than interpret their original appointment as a current no-show. The reminder cron uses the actual return date, window and recorded remaining scope.

## Eligibility and truthful outcomes

- Routine appointment reminders exclude test bookings, cancelled/completed bookings, missing/invalid appointment times, stale appointments, and payment-blocked records. They reuse the dispatch payment eligibility helper and the existing narrow owner-manual/owner-Easer exception; no payment calculation is duplicated.
- Customer email failure does not prevent an independently eligible Easer reminder. Unaccepted Easers receive no accepted-job reminder. SMS checks consent and opt-out before sending, and the shared sender rechecks at delivery.
- Reschedule resets the old reminder/escalation projections; new assignment and dispatch rounds reset the old Easer's arrival-nudge budget inside their existing compare-and-set mutations. A losing state transition cannot reset the winner's markers.
- Arrival counters advance only after accepted push/SMS delivery. Successful logged push or SMS is recovered after a lost counter write, without a second delivery. Overlapping scans are serialized using a notification workflow lease.
- Failed and unverified outcomes appear in activity/cron results. “Provider accepted” is not represented as “recipient read.” An uncertain SMS requires provider review and is not described as retry-safe.
- The actual reminder email builder uses the shared branded shell, readable date, “Arrival window,” Central/Mountain timezone, and a working customer-booking or Easer-job CTA. Instructions distinguish On My Way from Arrived. Return reminders show the recorded remaining scope.

## Offline evidence

| Perspective / workflow | Result | Evidence |
|---|---|---|
| Customer reminders | PASS | Prior local calendar day, 9 AM/8 PM boundaries, UTC rollover, Central/El Paso timing, DST, failure/deferred handling, stale flags, cancellation during scan, current booking terms and CTA. |
| Easer reminders | PASS | Accepted-recipient gating, independent delivery, only-email/only-SMS/both historical records, repeated/overlapping scans, short-hour `8 AM-10 AM` format, reassignment/appointment versions, no consent/opt-out. |
| Easer arrival | PASS | Delayed first run followed by +15-minute scan sends nothing; +30-minute scan can send second; third is blocked. Success plus counter-write failure recovers without another push/SMS. Completed/cancelled/arrived/stale/unaccepted/return visits are stopped. |
| Owner staffing/no-show | PASS | Provider rejection leaves no success marker; retry can succeed; owner retry does not repeat customer delivery; failed no-show alert does not create successful activity; current cancellation wins. |
| Owner authorization warning | PASS | Failure reports zero warned; one successful daily digest; repetition is suppressed; no fabricated Stripe expiry or completion instruction. |
| Message length / cost | PASS | Actual production arrival/day-of SMS builders are measured, including opt-out: arrival 152, Easer day-of 129, customer day-of 110 GSM characters at tested longest published slot/reference. All nine SMS templates pass the shared length guard. |
| Booking and payment safety | PASS | Notification handlers mutate only notification projections; existing dispatch and mutation guards pass. No pricing, taxes, capture, refund, payout amounts, splits or financial execution schedules changed. No Stripe call was made. |
| Production delivery / deployment | WARNING | Requires migration 096 and approved rollout, followed by provider/log verification. Offline stubs do not prove the production schema, hosting cron clock or provider credentials. |

Executed successfully:

- `node scripts/test-reminder-cadence.mjs`
- `node scripts/test-operational-notification-truth.mjs`
- `node scripts/test-arrival-verification.mjs`
- `node scripts/test-unassigned-escalation.mjs`
- `node scripts/test-sms-message-length.mjs`
- `node scripts/test-final-mutation-safety.mjs`
- `node scripts/test-dispatch-safety.mjs`
- `node scripts/test-assignment-email-accuracy.mjs`
- `node scripts/test-review-and-statewide-email-consistency.mjs`
- ESLint on all owned cron, reset and test changes; syntax checks; `git diff --check`.

The new behavioral tests run the real handler bodies with an in-memory database/provider boundary. Expected injected errors (invalid time and simulated counter-write failure) appear in test output and are asserted recovery cases. Shared sender/SQL tests are owned by the parent change and must also pass before deployment.

## Remaining live checks

1. Apply and verify the reviewed notification-policy migration before publishing code that depends on its event keys and leases.
2. Confirm the next day-before and day-of events against production provider acceptance/delivery logs, without sending an extra manual test to real customers or Easers.
3. Inspect historical staffing success stamps against provider records if their notification logs are missing. The old pre-send claim design cannot prove whether an unlogged message was delivered; historical delivery must not be guessed. Current legacy recovery can produce a one-time repeat if a successful old delivery had no log. Reconcile any such records before rollout.
4. A push provider has no application-level idempotency key. Normal overlaps and recorded-success retries are covered; a process loss after push acceptance and before both logging and counter persistence remains intrinsically unprovable. Review provider/operational evidence for such an incident rather than infer delivery.
5. Run the complete release gate and perform browser checks of the real exported email builders and the owner views with the parent change. No live launch readiness claim is made by these offline checks.
