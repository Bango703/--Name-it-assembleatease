# AssembleAtEase: notification timing and dashboard audit

Date: September 23, 2026. Requested after screenshots of repeated reminders, email wording, market coverage, Easer tiers, and an incorrect AI answer.

## 1. Executive summary

The repeated Easer reminder is a confirmed production defect, not an intentional reminder schedule. For booking `AAE-DVSNHXE4OO`, the delivery log records an Easer email at 7:00:51 AM Central, an SMS at 7:00:53 AM, and another identical email at 8:00:50 AM on September 23. All three have delivered status. The actual duplicate emails are one hour apart; relative inbox labels in the screenshot are not exact timestamps.

The hourly reminder query reads only one prior notification across email and SMS. In the real database, that query returns the SMS row. The code therefore believes no email was sent and sends again; its email call explicitly disables the shared duplicate check. It can repeat on subsequent hourly runs while the job remains eligible.

Two other screenshot defects are confirmed. The market-demand endpoint omits SMS-consent fields needed by the readiness calculation, incorrectly reporting zero ready Easers in San Antonio. The owner AI receives today's jobs and aggregate totals but no upcoming-job records or per-job financial breakdown. Its statement that there is no job on September 24 is unsupported: the booking exists, is confirmed and accepted, and is not flagged as a test.

This was an investigation, including bounded production database reads and offline tests. No email/SMS was sent, no live record or setting was changed, and no application fix was made or deployed. New work is tracked in the existing backlog, not in a second task list.

## 2. PASS / WARNING / FAIL matrix

| Workflow | Result | Evidence and practical limit |
|---|---|---|
| Easer day-before reminder | FAIL | Two delivered identical emails; exact production duplicate-check query returns only the SMS. |
| Customer day-before reminder | WARNING | One delivered email for this booking; same-day wording, reschedule keys, concurrent sends and quiet hours remain unsafe. |
| Coordination between email and SMS | FAIL | Easer reminder sends both immediately; SMS helper has no shared duplicate/cadence guard. |
| Assignment notifications | WARNING | Email now has a 60-minute duplicate window; SMS and push do not share that rule. Historical repeat assignments were real separate actions, not all cron defects. |
| Urgent staffing notification | FAIL | Customer-notified state is claimed before sending; a returned email failure is not used to correct that state or schedule retry. |
| Arrival reminders | WARNING | Maximum two; second threshold is measured from appointment time, not from the first actual send. |
| SMS consent and delivery evidence | PASS, bounded | Helper checks recorded consent/opt-out; today's reminder SMS is provider-confirmed delivered. Five earlier assignment SMS attempts in the sampled week failed. Do not extrapolate one success to all SMS. |
| Review / rebooking cadence | WARNING | Review requests have spacing and stop rules; rebooking follow-up has separate limits and no recipient-wide spacing policy. |
| Required-action reminders | WARNING | Configured spacing exists; channel success/counters can advance despite a returned send failure. |
| Market readiness | FAIL | Both active San Antonio Easers pass with complete profiles and fail when SMS-consent fields are omitted. |
| Easer tiers / roster | WARNING | Display matches stored tiers, but account status, job readiness, tier, and payout capability need distinct explanations. |
| AI upcoming-job answer | FAIL | Future booking and individual-job finances are omitted from the supplied data. |
| Existing focused regression checks | PASS with coverage gap | Five checks pass despite the reproduced bugs. Passing them is not acceptance of this release. |

## 3. P0 issues

### N01: failed operational notices can still be recorded as successful

In `api/cron/unassigned-escalation.js`, the system writes `unassigned_customer_notified_at` and `customer_notified` before attempting the customer email. `sendEmail` commonly returns `{ ok: false }` rather than throwing. The result is not checked, and the owner can still receive a message saying `CUSTOMER NOTIFIED`. Later runs see the timestamp and skip the customer notification.

Related paths also overstate success: no-show checking writes an activity saying the owner was alerted without checking the send result; arrival nudges consume a count before channel delivery is established. A claim is necessary for concurrency protection, but a claim must not be represented as successful notification.

**Risk:** a customer waits for an unstaffed booking, the owner believes the customer knows, and automated recovery stops. This is a code-confirmed failure path, not a claim that this specific customer's staffing notice failed.

**Smallest safe correction:** distinguish claimed/pending, provider accepted, delivered and failed; check each channel outcome; retain safe concurrency claims; retry failed notices with bounded backoff; show the owner precisely what failed. Do not change booking, cancellation, payment, or payout outcomes merely because a notification failed.

## 4. P1 issues

### N02: Easer reminder sends repeatedly

`api/cron/reminders.js` queries `notification_log` for the booking/Easer/type, selects `id, channel`, and applies `.limit(1)` without a channel filter or deterministic ordering. It then tries to determine two channel states from that single row. For this booking the row is the delivered SMS, so `emailAlreadySent` is false. The email call uses `disableDedupe: true`.

There is also no atomic claim before either send. Concurrent runs can both see no prior notification. The guard is keyed to a booking and Easer, not the appointment version, so an old reminder can suppress a necessary reminder after rescheduling. Removing `.limit(1)` alone would not resolve these other edges.

**Smallest safe correction:** one durable send identity per booking, appointment version, recipient, purpose and channel; atomic claims; preserve a successful channel when retrying a failed one; safe handling for uncertain provider outcomes. Reuse the notification ledger rather than creating an independent reminder truth.

### N03: no shared recipient timing policy

`api/_email.js` has separate 2-minute, 30-minute and 24-hour duplicate windows. Its default bulk cap is per notification type, not a total email/SMS allowance for a person. `disableDedupe` bypasses that check entirely. `api/_sms.js` checks consent but provides no shared timing, duplicate protection, or quiet-hour gate. `_send-governor.js` governs selected bulk callers; it is not a universal recipient communication policy.

An appointment reminder can follow a confirmation or manual detail resend closely; assignment email suppression does not suppress the corresponding SMS. The owner resend action itself disables duplicate checking. Genuine changes must still get through, so a blanket daily message limit would be unsafe.

**Correction:** classify messages by purpose, coordinate routine messages across channels, use the same event identity for repeated attempts, and exempt genuine urgent changes from routine limits. Manual resend should display the last delivery and record an intentional resend reason without inventing a customer request.

### N04: appointment timing and wording do not agree

The reminder window is any future appointment within 25 hours, yet both email templates always say `tomorrow`. A same-day booking can receive that wording. The customer query selects `reminder_sent = false`, excluding null values despite its comment saying null/missing is included. Rescheduling resets that flag but the email's subject-based duplicate key and Easer lifetime booking guard do not reliably distinguish the new appointment.

The customer reminder asks for at least 24 hours' rescheduling notice although it may arrive with less time remaining. The Easer reminder gives no clickable dashboard button, displays a broad service category, and says `at 8 AM-10 AM` without clearly naming the arrival window or timezone. It tells the Easer to open a dashboard without making that action easy.

**Suggested copy:** `Your upcoming job` with `Thursday, September 24, 2026` and `Arrival window: 8:00-10:00 AM Central`, plus `View job details`. Use `On My Way` before travel and `Arrived` only once on site. Render precise item/scope details only from the booking's source of truth.

Current appointment helpers use `America/Chicago`. A statewide policy must explicitly handle the job's timezone rather than infer it from the server clock. Scheduled UTC jobs also shift their local send hour seasonally.

### N05: incorrect coverage counts and ambiguous demand labels

`EASER_SUPPLY_SELECT` in `api/owner/market-demand.js` omits `sms_consent_at` and `sms_opted_out_at`. Readiness consequently adds `Job texts enabled` to every active profile's missing items. In the bounded live check, all five active profiles pass the full non-availability readiness calculation; both San Antonio profiles are available and have consent. The current market projection reports them unready. Cached payout capability is not the cause of this zero count.

The projection also omits refund/decision fields read by readiness. Fix the full required field set, not only the two fields exposed by today's example. The readiness test only recognizes literal SELECT strings and misses `.select(EASER_SUPPLY_SELECT)`, explaining its false green result.

`Applications: 2` counts all Easer profiles in the market, including approved ones. `Top services: No services yet` describes absence of recorded demand, not absence of offered services. `ZIPs` comes from request demand, not Easer coverage. A profile's home city alone also does not prove its entire service territory.

**Smallest safe correction:** use the canonical readiness projection; distinguish approved profiles, eligible Easers, online Easers and pending applications; label the demand-derived fields `Most requested services`, `No requests recorded yet`, and `Requested ZIPs`. Link counts to the exact people/requests counted. Do not block other Texas areas or loosen actual dispatch requirements to make a card look healthy.

### N06: owner AI cannot see the future job or its economics

`api/owner/monitor.js` loads bookings, but the AI payload contains only `todaySchedule` and aggregate counts/financials. It supplies no dated upcoming jobs, booking reference list, or per-job expected earnings. The prompt nonetheless says it has full access to real-time platform data. Chat requests also lack the explicit `Today is ...` sentence used for generated briefings.

**Smallest safe correction:** include a bounded upcoming-job list with booking reference, local date/window, service, status and assignment. Supply server-calculated per-job financial estimates and actuals with clear provenance; unknown processing costs stay unknown or explicitly estimated. State the snapshot time and timezone. The model must say information is unavailable when it is missing, not conclude the job does not exist. Preserve the owner's chosen Haiku 4.5 / 600-token configuration and existing chat-memory fixes; changing the model will not repair missing input data.

### N07: false resend wording and inconsistent roster labels

`api/owner/resend-booking-details.js` always says `You asked for these again`, although this is an owner action and a customer request is not recorded. The screenshot's resend was delivered at 8:25 AM Central, after the 7:00 AM customer reminder. That is a separate manually initiated email, not the repeated Easer reminder.

**Replace with:** `Here are the latest details for your booking. Use the link below to view updates or contact us.`

`TRUE/FALSE` for payout capability is a raw Boolean; use `Enabled/Not enabled` or an accurate action state. Capability is not a completed payout. `Active` means an approved account, not automatically ready for a particular job. `Starter`, `Professional`, and `Elite` are platform tiers, not identity verification or payment status.

The screenshot tiers match saved values. Four active Easers are Starter; Travis is Professional. His profile has three completed jobs, no qualifying rating/acceptance baseline, and a tier grace period starting September 14. The tier engine has a 30-day grace rule, so the badge alone is not proof of a bug. Explain its basis/grace period; do not silently rewrite it. Prior owner statements identify historic test work that is not consistently flagged, so unflagged completed rows must not automatically be presented as proven real demand or verified tier achievements.

### N08: other notification paths can bypass delivery truth and coordination

The 21-day follow-up logs `followup_sent` without checking `sendEmail().ok`, and is not in the bulk notification-type set. It lacks the review sequence's open-case/return-visit stop checks. Its copy promises `we'll make it right` without expressing the actual resolution policy.

Required-action campaigns can add email to `channels_sent` and advance reminder counters even when the sender returns failure. Business-inquiry emails call Resend directly instead of the shared logged sender. These paths need inclusion in any statement that timing and delivery visibility are fixed for all email.

The arrival nudge's second threshold is 30 minutes after appointment start, not 30 minutes after the first send. If a delayed run sends the first nudge 35 minutes late, the next 15-minute cron can send the second only 10 minutes later. Keep its maximum of two, but measure minimum spacing from the actual first send.

## 5. P2 issues

Make the accepted-job reminder use the same branded email frame, clear call to action and date/window format as other transactional emails. Add concise tier explanations and remove duplicate capability labels. These presentation changes must follow the data corrections; changing badges alone would conceal the problem.

## 6. Business impact

- Customer: repeated or inaccurate messages reduce confidence, can contradict the actual appointment, and can make a manual resend sound like a conversation that never happened.
- Easer: duplicated channels and early routine reminders encourage muting/opt-out; unclear actions can cause missed check-ins.
- Owner: false zero coverage and missing AI job data encourage wrong staffing/growth decisions; falsely successful notifications hide work needing recovery.
- Money: unnecessary SMS costs and unreliable staffing information create avoidable operating expense; this audit does not establish a wrong charge or payout for the shown job.
- Operational/legal review: retain consent and opt-out enforcement and truthful notification state. Quiet hours below are proposed product policy, not a representation of a legal deadline or compliance certification.

## 7. Recommended fix order and timing policy

First stop the duplicate-reminder defect and repair false notification-success states. Next repair readiness projections and AI input data, then the screenshot wording. Implement the common timing policy across every notification entry point and prove the failure cases before publication.

### Current cadence inventory

| Purpose | Current timing / channels | Issue or existing safeguard |
|---|---|---|
| Appointment reminder | Hourly scan, appointment within 25 hours; customer email, Easer email and SMS together | Easer repeats; no quiet hours or shared channel spacing. |
| Assignment / dispatch offer / crew added | On action; email, SMS, push depending on path | Assignment email has 60-minute suppression; repeated SMS is not governed by the same rule. Offers are time-sensitive. |
| Booking confirmation / Easer accepted | On transition; confirmation can include SMS | Must identify changes/replacements accurately; distinguish event retry from new event. |
| On the way / arrived | On Easer action; customer email and SMS | Immediate status is useful; no fabricated ETA; avoid replaying identical state events. |
| Arrival check-in nudge | Every 15-minute scan; first at start, next after start+30 minutes; push with SMS fallback; maximum two | Delayed first run can compress spacing. Stop after arrival/change of assignment. |
| Unassigned booking | Every 15-minute scan; owner escalation at 6 hours out; customer and owner at 2 hours out | Critical notice must be retriable and truthfully logged. |
| No-show warning | Every 30 minutes; owner alert after start+60 minutes | No customer barrage intended; owner alert success is not checked before one-time activity marker. |
| Scheduled card authorization / reauthorization | Daily 10:15 / 10:00 UTC; emails on meaningful outcome | Early local sends possible. Payment action/hold-release updates must not be hidden by routine caps. Do not change financial execution timing as a messaging fix. |
| Card-expiry owner warning | In hourly reminder cron | Explicitly bypasses duplicate check and can repeat hourly for the same batch. Deduplicate/digest unless risk changes. |
| Review request | Daily 14:00 UTC; days approximately 2, 5, 9; at most three | Stops after a review/open case/required return visit; no shared routine recipient budget. |
| Rebooking/referral follow-up | Daily 15:00 UTC; completed jobs aged 21-35 days | One activity marker per booking; outcome/eligibility defects above. |
| Payout setup required action | Daily 15:30 UTC; configured days 0, 2, 5; email/in-app/push | Live configuration read; rechecks payout source before sending. |
| SMS opt-in required action | Same daily scan; configured days 0, 5; email/in-app/push | Live configuration read; do not text without consent or nag opted-out users. |
| Tier/coaching | Daily 07:00 UTC; on transition; 30-day grace/coaching spacing, 14-day owner re-alert rule | Routine email can leave overnight; expose why a tier changed. |
| Owner daily / weekly summaries | 13:00 UTC daily / 14:00 UTC Monday | Can overlap urgent alerts; summaries should consolidate routine owner information. |
| Manual resends, support replies, broadcasts | On owner/user action; bulk paths have separate pacing | Intentional repeat and accidental repeat need separate treatment; display last sent time. |
| Receipts, refunds, cancellations, payout updates | On financial/state event | Send promptly and exactly once per meaningful outcome; never delay or invent the underlying money state. |
| Business-inquiry acknowledgements | On submission, direct provider calls | Bypass common notification logging/dedupe. |

### Proposed customer/Easer policy (not activated)

| Message | Proposed behavior |
|---|---|
| Day-before appointment | One email on the prior calendar day, normally 9 AM in the job timezone. For late/same-day bookings, confirmation covers details; do not immediately add another routine reminder. |
| Day-of appointment | At most one concise SMS about two hours before the arrival window, only with consent and within 8 AM-8 PM local. Skip a pre-8 AM routine text for an early job; the day-before message carries the details. |
| Easer arrival | Prefer in-app/push at the window start; one follow-up at least 30 minutes after the first actual nudge if no arrival is recorded. SMS is fallback. |
| Routine communication spacing | At least four hours between routine outbound interruptions for the same person/booking, across email/SMS. Start with at most two routine interruptions per person/day; combine or defer lower-priority reminders. |
| Urgent/new state | New job offers requiring timely action, changed appointment/Easer, cancellation, payment action, receipts and actual payout updates are event-driven exceptions. Each still needs duplicate protection. |
| Reviews | One request around day 2 and one final follow-up around day 7; stop after review, dispute, unresolved return work or applicable preference. No SMS review campaign by default. |
| Rebooking/referral | At most one around day 21, with applicable marketing preferences and resolved-job checks; skip/defer if recent job communication makes it redundant. |
| Onboarding/payout tasks | Consolidate outstanding items, keep the in-app checklist current, and send only the configured spaced reminders while the action is actually incomplete. |
| Owner manual resend | Show last sent/delivered time and recent notices; one deliberate action sends one message, with neutral copy. |

These are product recommendations for review, not changes to cancellation terms, dispatch availability, financial timing, or live customer workflows. No pricing or payout split changes are needed.

## 8. Files / APIs involved

- `api/cron/reminders.js`, `api/_email.js`, `api/_sms.js`, `api/_send-governor.js`, `vercel.json`.
- `api/cron/easer-arrival-nudge.js`, `api/cron/unassigned-escalation.js`, `api/cron/no-show-check.js`.
- `api/cron/review-request.js`, `api/cron/followup.js`, `api/cron/easer-announcements.js`, `api/_announcements.js`, `api/cron/tier-check.js`.
- `api/booking/assign.js`, `api/booking/_dispatch-internal.js`, `api/owner/crew.js`, `api/booking-confirmed.js`, `api/booking/easer-status.js`, `api/booking/reschedule.js`.
- `api/owner/resend-booking-details.js`, `api/business-inquiry.js`.
- `api/owner/market-demand.js`, `api/_easer-readiness.js`, `owner/index.html`.
- `api/owner/monitor.js` and the existing server finance source used to provide per-booking figures.
- Existing notification, readiness, AI and SMS tests listed below; add behavioral coverage rather than relying only on source-pattern assertions.

## 9. Validation performed and acceptance test plan

### Executed

1. Read-only production lookup proved the September 24 booking is confirmed, accepted, and not flagged as test; checked its notification records since September 20.
2. Read-only notification inventory since September 16 distinguished delivered emails, today's delivered reminder SMS, and five failed assignment SMS attempts. Older assignment/acceptance messages included real reassignment actions; do not label them all accidental duplicates. Multiple push rows can represent multiple devices and are not by themselves proof of repeated interruption on one device.
3. Executed the exact existing reminder prior-notification query: it returned only the delivered SMS.
4. Offline execution of the real `sendEaserReminder` helper with stub senders: two runs with that prior SMS produce two additional emails. **FAIL reproduced without sending anything.**
5. Compared all five active Easer profiles against the readiness helper using full fields versus omitted consent fields. Complete non-availability profiles pass; omitted consent produces `Job texts enabled` for all five. This test intentionally did not query Stripe and is not a new live payout-capability certification.
6. Read active announcement cadence and tier data. Tier profile counters match completed booking rows, but historical owner corrections mean those rows still need test-data reconciliation before treating them as real commercial outcomes.
7. Ran `test-notification-volume.mjs`, `test-readiness-select-parity.mjs`, `test-ai-intelligence-data.mjs`, `test-owner-ai-memory.mjs`, and `test-sms-message-length.mjs`: **all PASS**. Notification tests lack the cron scenario; readiness test skips constant-based selects; AI tests do not require future-job data; SMS length tests omit the reminder template.

### Required before declaring fixed

- Customer and Easer: repeated and overlapping cron runs; both channels previously delivered; only email delivered; only SMS delivered; provider rejection; timeout after provider acceptance; logging failure; no consent; opted out.
- Appointment versions: reschedule inside/outside 24 hours, reassignment, return visit, same-day booking, past/cancelled/completed job, pending payment action, null flags and ambiguous time format.
- Time: local quiet hours, daylight-saving boundary, UTC date rollover, early appointment and supported job timezones; no two routine nudges closer than policy permits.
- Owner: failed staffing notice remains actionable and is not shown as delivered; every count opens the exact matching rows; manual resends show last-send context.
- AI: upcoming September 24 fixture is found by date/reference; estimates and actuals have distinct labels; missing cost data is stated; no invented profitability; no model upgrade required.
- Tier: show stored tier and reason/grace without changing it; do not infer professional qualification from identity verification alone.
- Stripe: verify source states read by financial notices, test authorization/capture/refund/payout failure and recovery, and prove messaging changes do not mutate or relabel financial success.
- Browser: render actual email builders and owner dashboard at phone and desktop widths. Do not use the old hand-written preview script as proof of production wording.

## 10. Launch recommendation

Do not certify notifications or these dashboard views as corrected. Prioritize the live duplicate-reminder bug and false notification-success paths before the next operational cycle. Preserve urgent delivery paths, consent, booking state and financial logic during remediation.

The working tree already contains unrelated, unpushed fitness-gallery work across 54 city pages, its generator, sitemap and image assets. This audit changed documentation only. A future fix must isolate its approved files and must not accidentally publish that gallery work. No commit, push, deployment, production setting change, or outbound message was performed in this audit.

## Prior-chat context recovered for this work

Available local Codex and Claude history was reviewed, with relevant project notes. This is not a claim of access to every ChatGPT conversation in the account.

- Main AssembleAtEase project: `C:\Users\tgbiz\Handyman-marketplace`; initial workspace was the unrelated Divine_Designz project.
- Latest owner direction: all Texas areas remain open, prioritizing Austin, Dallas, Houston and San Antonio. Google Ads was canceled; focus is organic demand and actual completed jobs. Do not mistake recruitment, tests, declined cards or duplicate attempts for commercial traction.
- September 22 owner AI continuation retained Haiku 4.5 / 600 tokens at the owner's explicit direction; conversation memory/reset/error handling were reported deployed via PR #196. That work did not supply future-job records.
- September 22 SEO changes were reported deployed via PR #197. The recorded state was pending Google validation for 20 flagged public pages, including 15 service pages, with 11 individual indexing requests accepted before quota. Pending validation is not guaranteed indexing and was not rechecked today.
- Latest fitness work uses one angled real-job photo with requested retouching and distinct mobile/desktop layouts. It remained unpushed and is still present as local changes.
- The latest business discussion recommended easier private project inquiries using the existing Custom Quote flow, alongside flat rates; open bidding was discussed, not implemented. No proposed city introductory prices should be treated as approved live pricing.
- Historic manual-only payout notes are stale relative to later Connect work. Always inspect the applicable runtime flag and Stripe state; never treat a transfer as bank payout or a manual record as a Stripe payout.
- Earlier Google Analytics/Profile setup-failure conclusions were withdrawn after the owner showed the correct accounts. Preserve that correction rather than repeating the disproven claim.

Key local sources: `AGENTS.md`, `CLAUDE.md`, `business-artifacts/backlog.md`, the September 22 organic release/audit notes under `tmp`, Codex sessions beginning September 5 and September 22, and the Handyman-marketplace Claude session/memory directory. Historical completion statements remain dated claims unless separately verified in this audit.
