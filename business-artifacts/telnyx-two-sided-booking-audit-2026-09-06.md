# Sora: Customer and Service Pro voice workflows

Date: 2026-09-06. Scope: two-sided phone assistant, all service selection, quote intake, secure booking/payment, and owner visibility through job completion. This is an implementation/acceptance document, not a booking database or financial ledger.

Update after "FIX ALL PLEASE": [Fixing-pass status and exact release scope](telnyx-sora-fix-pass-2026-09-06.md). P0-5 and P0-6 now have tested local safeguards; catalog-only handoff and signed call-event intake have local implementations. They are NOT deployed/activated. The findings below are the original audit baseline, not a claim that those local fixes are already live. Full booking/payment/authentication acceptance remains open.

## 1. Executive summary

The two-path conversational foundation is saved in the Telnyx TEST draft. Full transactional phone booking and authenticated Service Pro operations are NOT implemented or launch-approved.

The desired experience is feasible as a staged integration: the caller explains the job, Sora prepares the correct service selection, a trusted server produces the actual quote and booking state, the customer authorizes securely, and Sora reports the verified outcome. A longer prompt cannot supply missing authentication, staffing, payment, or reconciliation mechanisms.

For the first release, recommend voice-assisted intake with a prefilled, secure continuation of the existing Stripe booking flow while the caller stays on the phone. This continuation itself still needs implementation. Keep a fully telephone-based keypad-payment option behind a separate acceptance gate until a compatible processor connection is verified. Do not change processors or buy a subscription without approval.

"Board review" here means my review from CTO, payments, security, QA and operations perspectives and the owner's implementation board. No independent human board or external PCI assessor has approved this system.

### What changed during this review

- Saved a new greeting asking Customer or Service Pro in draft `20260906T153456589927`.
- Replaced the single workflow node with three named nodes and four edges: role selection, Customer, Service Pro, and explicit switches between the two purposes.
- Preserved global safety instructions on every node. Entry has read-only catalog plus the existing fixed transfer/hangup. Customer inherits the existing customer tools. Pro has only the existing transfer/hangup, not customer callback intake.
- Added separate new-applicant, in-progress application, assigned-job, safety and earnings guidance. No claim that an application, Pro case, booking or payment is saved without a corresponding enabled tool.
- Corrected Sora's support-hours/appointment-hours confusion and reinforced multi-service selection and quote-only boundaries.
- Production website APIs, customer/Easer records, prices, taxes, payment timing, payouts, public forwarding, main assistant and recording settings were not changed. No new phone calls or financial transactions were made.
- After the owner said CONTINUE, built and tested proper Pro-support options/intake locally behind an additional default-off flag. It creates an unverified Pro case, not a customer lead or account update. This backend has NOT been deployed, enabled or attached to the provider. [Scoped connection/release checklist](telnyx-pro-support-connection-2026-09-06.md).

## 2. PASS / WARNING / FAIL matrix

PASS means only the specific evidence stated, not universal readiness. FAIL means the requested capability is absent or unsafe to launch, not that the existing website necessarily fails.

| Area | Result | Evidence / gap |
|---|---|---|
| Two conversational paths | PASS configuration; WARNING full voice runtime | Saved/read back 3 nodes, 4 edges and greeting; visible in Edge Workflow tab. Full multi-turn voice route and role-switch tests remain. |
| Canonical services | PASS catalog/runtime | 7 categories, 201 items, 6 quote-only entries. Retest actually invoked catalog and both relevant item tools. |
| Pro application conversation | PASS limited text test | Stayed in applicant context; refused to approve an unsubmitted applicant. No account mutation. |
| Customer callback | PASS prior integration evidence | Previous synthetic Telnyx tool-to-case-to-delivered-alert test. Must recheck complete voice callback after this graph change. |
| Voice booking creation | FAIL / not implemented | Receptionist handler supports only catalog and callback, returns `bookingCreated=false`. |
| Secure card collection during call | FAIL / not configured | Live read-only `GET /v2/pay_connectors` returned HTTP 200 and an empty connector list. No Pay tool attached. |
| Customer and Pro authentication | FAIL / not connected to voice | Website has existing auth/ownership guards; Sora has no verified per-caller account session. |
| Quote application | WARNING | Website requires successful card setup before formal quote submission, and later customer approval. Callback is only an enquiry. |
| Appointment/staffing promise | WARNING | Server permits daily 8 AM-8 PM time windows; no Sora capacity tool. Houston/San Antonio require owner assignment. |
| Owner call lifecycle | FAIL / incomplete | Confirmed callback cases are logged; no verified all-call/abandoned-call ingestion and reconciliation. |
| Customer/Easer/owner job lifecycle | WARNING | Existing APIs and regressions, not a full voice-originated completed-job test. |
| Payment/payout protection | PASS unchanged scope; WARNING policy conflict | No financial change here. Connect readiness differs from supplied master policy; see P0-5. |
| Test isolation | FAIL for financial testing | Local Stripe key is live; dedicated test-key/database variables absent. Earlier board inspection also found preview using production services. |
| After-hours, failover, cost controls | FAIL for public AI launch | Deterministic transfer schedule, on-call fallback and AI-specific spending cap remain unverified. |

## 3. P0 issues

### P0-1: Payment collection is not a plug-in checkbox

Telnyx documents a Pay flow with keypad collection, automatic isolation from assistant audio/recording/DTMF events, and masked result callbacks. Its generic connector posts raw card data to the configured payment-processor endpoint. Your account currently has no connector. An ordinary AssembleAtEase webhook must not be that processor endpoint. The documented charge mode captures immediately, which conflicts with this marketplace's usual authorization-before-service/capture-after-completion model. [Telnyx Pay over Voice](https://developers.telnyx.com/docs/voice/programmable-voice/pay)

Risk: card-data exposure, wrong payment timing, duplicate charges, compliance burden; affects customer, owner and business finances. A tokenization success is not an authorized PaymentIntent or a confirmed booking.

Required fix: verified PCI processor/adapter returning a Stripe-compatible token/payment method; server retrieves and binds it to the correct customer, booking, currency, total, mode and terms. No arbitrary amount, destination or token supplied by the model. Preserve existing capture and future-authorization rules. Never build a raw-PAN forwarding endpoint on Vercel to make the generic contracts fit.

Stripe requires PCI verification before enabling its MOTO feature, and an issuer may still require website completion. MOTO is not blanket permission to collect card numbers in AI transcripts. [Stripe MOTO](https://docs.stripe.com/payments/payment-intents/moto)

Tests: processor/Stripe compatibility, test-card intersection, interrupted entry, card decline, issuer challenge, duplicate callback, stale quote, amount mismatch, token reuse, recording/transcript/log inspection with test values only, return-to-Sora, and provider outage. Do not enable live mode first.

### P0-2: Role selection and caller ID are not authentication

`api/ai/receptionist.js` authenticates the integration, not the person speaking. Customer ownership and Easer role/assignment are enforced elsewhere. Giving Sora broad owner APIs or trusting an LLM-produced `verified=true` would bypass those protections.

Risk: disclosure of another customer's address/job, unauthorized cancellation, forged completion, wrong earnings or payout changes. Applies to both lanes.

Required fix: caller-bound, short-lived, least-privilege session established through the existing secure account/guest flow. Keep passwords, login codes and authentication tokens out of spoken dialogue and transcripts. Server derives identity and permitted booking IDs; never trust IDs alone. Do not pass a reusable owner credential to the assistant. High-risk changes still require step-up confirmation and existing server guards.

Tests: wrong caller, unverified email, stolen booking reference, expired/replayed link, wrong Easer, helper versus lead, role switching without privilege escalation, and changed assignment during a call.

### P0-3: Interrupted calls and interrupted financial actions need durable recovery

The earlier real call ended before callback consent; no case was created. That was correct consent behavior, but the owner lacks a complete automatic call ledger. The current case/email path also has a crash window between durable case creation and notification attempt.

Risk: lost leads, unresolved safety/access problems, a payment authorized with no visible confirmation, owner assuming silence means success.

Required fix: signed provider lifecycle events, event-ID uniqueness, server-side call/session correlation, bounded/redacted payloads, durable processing and reconciliation. Use existing Cases for actionable follow-up, activity logs for business events, and notification_log for delivery. Store incomplete/consent-not-obtained distinctly; do not manufacture callback consent. A failed email must not undo a booking or payment. Avoid a separate competing booking-status table.

Tests: hangup at every step, webhook out of order/retry, replay, wrong signature, provider timeout after successful operation, notification failure, process crash and reconciliation recovery.

### P0-4: A genuinely isolated financial environment is missing

Local read-only configuration inspection found a live Stripe secret and no dedicated test Stripe/database variables. The earlier board records production Supabase/live Stripe in preview. Never insert test bookings, use test card data against live mode, or complete/pay real jobs to simulate success.

Required fix: isolated database fixtures, Stripe sandbox/test keys and webhooks, non-customer notification destinations, and verified environment/credential-mode guards. No new keys or projects were created in this turn.

### P0-5: Easer readiness policy conflict in Connect mode

The supplied master instruction says Connect-mode job readiness also requires Connect completion/payout capability. `api/_easer-readiness.js` instead treats incomplete Connect as a payout-setup reminder, not a job-readiness blocker. An offline fictional fixture returned `isReady=true` with `connectRequired=true`, no Stripe account and `payoutSetupComplete=false`.

This does not show a wrong payout occurred, and manual-mode readiness remained valid in the same fixture. It does show two competing definitions. Do not have Sora announce readiness from its own checklist or enable Connect to finish the phone project. Reconcile the intended rule before adding Pro readiness/actions; preserve manual payouts meanwhile.

### P0-6: Mixed priced and quote-only carts need server review before voice booking

`api/_pricing.js` returns `hasCustomQuote` and gives quote-only lines zero price. `api/booking.js` derives `quoteRequested` from the request flag and computes `pricedBooking` from amount and that flag; no `hasCustomQuote` guard appears in that handler. This is a code-level potential underpricing/scope risk, not a reproduced live charge. A new voice adapter must never assume a positive total prices every included item.

Required fix: a focused server-side contract/negative test and an explicit policy for mixed carts (quote the whole request or separate agreed scopes). Reuse that rule in browser and voice. Do not silently set every job to quote or discard items.

## 4. P1 issues

- Support hours versus appointment hours: contact page lists Mon-Fri 7 AM-5 PM / Sat 7 AM-1 PM; `api/booking.js` accepts daily 8 AM-8 PM windows. Sora no longer says Sunday appointments are closed. `api/chat.js` still contains the old Sunday-closed statement and needs a separate scoped correction. Do not broaden human-transfer hours to appointment hours.
- Coverage versus staffing: example ZIPs 78701, 77002 and 78205 all permit online booking, but only the Austin example permits automatic dispatch. Do not promise an available Easer merely because a Texas ZIP/time validates. Owner assignment visibility is mandatory for Houston/San Antonio.
- Quote friction: formal quote submission currently requires secure card setup. Keep early questions/enquiries possible without falsely claiming a quote application was filed. Do not remove existing card/approval requirements without an explicit product decision.
- Pro-specific support persistence is absent in production. The customer callback schema requires a customer service category; using `Other` to disguise a Pro problem would contaminate the owner's queue. A proper Pro-specific case action is now implemented/tested locally, but still requires scoped deployment, separate feature activation, tool attachment and runtime/delivery proof before Sora can claim a Pro request is saved.
- Customer catalog and Pro skills labels differ (`Mounting & Hanging` versus `TV & Display Mounting`, `Smart Home` versus `Smart Home Installation`). Reuse each canonical schema; add explicit tested mapping at the boundary, not silent renaming of records.
- No verified voice delivery of booking/payment links. SMS permission is separate from callback and marketing permission; respect opt-outs. Confirm the email/phone destination and record provider outcome, with a non-SMS fallback.
- Longer sessions need resume support and bounded time. Do not simply increase the 300-second draft limit indefinitely; waiting through payment problems can waste money and strand callers at cutoff.

## 5. P2 items

Multilingual support, automated upsells, additional local numbers and voice-only rewards redemption can wait. Avoid selling unavailable memberships or repeating the entire catalog. Natural concise phrasing matters, but cannot substitute for transaction proof.

## 6. Business impact and two complete target journeys

These are the required target journeys, NOT a claim that the tools already exist.

### Customer: new booking, all services and custom quotes

1. Recognize Customer versus Pro, respecting callers who already state their purpose; urgent safety overrides sales.
2. Determine new service, quote, existing booking or other support. Existing records require verified access before disclosure.
3. Select exact catalog items and quantities, including multiple services, add-ons, bundles and quote-only work. Confirm model/size, condition, supplied hardware and scope; use secure upload for photos. Never request access codes.
4. Collect only necessary contact and service location. Confirm spelling/address, ZIP and requested Central-time window. Server checks region, date, lead time and service rules; staffing is a separate verified fact.
5. Create a resumable server-owned draft linked to the call, not an order copied into the prompt. It must have one eventual booking/application reference, idempotent submission and an expiry policy. Revalidate prices and terms after edits or expiry.
6. Read the server-approved itemized subtotal, add-ons, service-call/same-day fees when applicable, discounts, tax and total. Present payment timing and cancellation terms before consent. No LLM arithmetic or unapproved discount.
7. For standard work, send a single-use prefilled secure booking continuation with explicit channel permission. Do not send the customer back to an empty form. Caller reviews details/terms and authorizes with Stripe while Sora remains available. Server confirms the provider state; Sora does not trust "I paid."
8. For quote-only work, save an accurate enquiry, obtain required secure card setup for the current formal quote flow, route scope for pricing, send the exact approved quote, and obtain customer approval before scheduling/authorization. Quote changes invalidate stale approvals. A call can complete quote submission without promising an instant final quote.
9. Payment path distinguishes immediate card authorization from future card setup and later scheduled authorization. The current booking window is 30 days; server logic, not prompt constants, determines which path applies.
10. Return the actual booking/quote reference, status and next action. If authorization succeeded but persistence failed, display a recoverable state and reconcile the same intent; never create a second payment blindly.
11. Continue using the same booking through owner assignment, Easer acceptance, on-the-way, arrival, completion evidence, capture, receipt and any refund/cancellation. No call-ending event may complete a job.

### Service Pro: application through job and payout support

1. Recognize new applicant, application continuation or existing Easer; allow an Easer to switch to hiring a service without leaking privileges.
2. New applicant: collect relevant city/skills/tools/transport/experience through a resumable intake only when persistence exists. Provide secure account, current fee disclosure, agreement/code acceptance and identity-verification steps. Never accept SSN, ID images, bank credentials or spoken card data in Sora.
3. Application continuation: verify identity first, fetch the actual missing steps and provide the exact secure continuation. Do not create another applicant record, re-charge an application fee or mark the agreement signed from a casual yes.
4. Readiness: return the authoritative allowed state and required action. Respect owner approval, current agreements, identity, availability and manual/Connect policy. A pending applicant cannot access jobs.
5. Existing job support: authenticate the Easer, prove assignment/lead role, then show only their permitted job information and estimated/final earnings, never the customer gross total as their pay.
6. Accept/decline and status updates must use existing offer expiry, payment-readiness, assignment and transition guards. If a spoken action is implemented, read back the job and action and require clear confirmation; repeat requests must be idempotent.
7. Safety/access/missing-parts problems create the appropriate linked case and escalation. No instruction to enter without permission or continue unsafe work. Human support availability/failure must be explicit.
8. Completion still requires the existing evidence process. Provide secure photo upload, validate requirements server-side, then use existing authorized completion. Voice "done" alone is not sufficient. A helper cannot impersonate the lead.
9. Earnings support reports estimated earnings, final earnings, payout status and next action. Completed, payment captured, manual payout recorded, Stripe transfer and bank payout remain separate facts. No AI payout release, bank change, fee waiver or approval privilege.
10. Close with the real result/reference and next step; unresolved cases remain visible to the owner, not merely in a transcript.

### Owner visibility required across both sides

One call/session correlation should link to the existing case, booking and/or verified profile without duplicating their truth. Owner must see caller purpose, identity-verification state, collected/confirmed scope, consent state, current workflow step, unfinished actions, exception reason, assigned follow-up and acknowledgement. Payment references remain server-side; never put card data or access tokens in summaries.

Notify/queue the owner for new confirmed requests, incomplete booking after permission, urgent job issues, quote approval needed, assignment needed, failed payment/webhook/notification, cancellation/refund exceptions, completion and payout follow-up. Show accepted/sent/delivered/failed separately. A periodic reconciliation check must surface lost events. Acknowledgement and backup/on-call coverage are operational decisions, not an AI promise.

## 7. Recommended fix order / review decision

1. DONE for test configuration: distinct role greeting/branches, tool scoping, hours correction and bounded text checks.
2. Build isolated test infrastructure and a dedicated AI spend/duration policy. Keep existing forwarding working.
3. Connect every-call event ingestion and durable owner failure/retry visibility; add accurate Customer/Pro case types.
4. Build verified, limited caller sessions and prefilled resume links using existing account/guest permissions.
5. Extract/reuse booking validation and canonical pricing/quote classification; test multi-service and mixed quotes before exposing a prepare-booking tool. Do not call owner/manual-booking APIs with AI-supplied prices.
6. Complete voice-assisted secure web authorization and prove all three perspectives through completion/capture/manual payout in sandbox.
7. Complete verified Pro application/support/actions with required evidence and least privilege; resolve Connect policy conflict without changing manual launch mode.
8. Separately validate telephone-only Pay processor compatibility and PCI responsibilities. Prototype tokenize-only in isolated test mode; no direct charge shortcut. If the integration requires a new paid provider, obtain exact pricing/contract approval.
9. Run bounded real phone tests, then obtain the exact public routing decision and release only approved files/configuration.

CTO/security/payments/operations review decision: proceed with staged development; do not approve full public transactional launch yet. No unsupported feature should appear as enabled merely because it is described in a workflow node.

## 8. Files and APIs

Changed locally in this turn:

- `api/_ai-intake-validation.js`
- `api/ai/_pro-support-intake.js`
- `api/ai/receptionist.js`
- `business-artifacts/telnyx-sora-receptionist-prompt-2026-09-06.txt`
- `business-artifacts/telnyx-sora-two-path-workflow-2026-09-06.json`
- `scripts/test-ai-receptionist.mjs`
- `business-artifacts/telnyx-ai-implementation-board-2026-09-06.md`
- `business-artifacts/telnyx-pro-support-connection-2026-09-06.md`
- This audit.

Provider change: only the existing test version's greeting, instructions and conversation_flow. Existing five global tools, secrets, voice/telephony settings, main version, canary rule and public forwarding preserved.

Reuse during implementation: `api/ai/receptionist.js`, `api/booking.js`, `api/_pricing.js`, `assets/js/booking-source-of-truth.js`, `api/_legal-consent.js`, `api/booking/setup-intent.js`, `api/booking-confirmed.js`, `api/booking/payment-recovery.js`, `api/owner/quote-approve.js`, `api/_easer-access.js`, `api/_easer-readiness.js`, `api/assembler/apply.js`, `api/booking/accept-dispatch.js`, `api/booking/easer-status.js`, `api/booking/assembler-complete.js`, existing Cases/activity/notification APIs.

Do not edit/deploy the unrelated dirty SMS webhook, .env.example, vercel.json, Ads/SEO or booking-mock files as part of this release. No website deployment or push was performed.

## 9. Validation and remaining acceptance tests

Performed:

- Official Telnyx Pay/TeXML/workflow and Stripe/PCI documentation reviewed; account connector inventory read without printing credentials.
- Provider GET verified saved greeting, local prompt equality, all three node tool scopes, four edges, unchanged global tools and recording disabled.
- Edge refreshed and visibly displayed the saved three-node/four-edge graph with Save disabled. The LIVE badge is still the previously approved owner-number-only canary, not public routing.
- Pro text fixture `faea7920-fddf-4c12-aad9-78365b564335`: applicant context, no fake approval or writes.
- First customer text fixture `8adf9365-f1ef-43d5-a489-7ca5c5a8a727` exposed unavailable-catalog-at-entry tool markup and an overstated staffing claim. NOT a pass. Corrected entry catalog access and availability wording.
- Customer retest `81604180-81dc-4f05-97d1-0f3060a2bf35`: actual tool messages for get_service_catalog and two get_service_items calls; correct Furniture Assembly/Fitness Equipment separation. No callback, booking, message, transfer or payment action.
- Five focused local suites passed: receptionist, Operations Cases, growth booking window/scheduled authorization, pending-payment recovery and Easer security checkpoint. The receptionist suite forbids networking; the last three were also run with global fetch disabled and their existing fixtures. These are mocked/static regressions, not live financial tests. Fictional readiness/market fixtures demonstrated the documented gaps without reading customer records. Text fixtures do not prove telephone latency, full route switching, payment, consent completion or real job completion.
- Pro-intake continuation tests additionally passed for default-off/preview refusal, parent authentication, strict fields, sensitive-digit rejection, independent catalog outage, all six topics, correct unverified case identity, shared fail-closed limiter, duplicate/concurrent requests, changed retry, failed notification/timeline and HTML escaping. No live case/email was created by these tests.
- No additional telephone call. Observed balance remained $27.61 during the initial two text tests; final provider billing is authoritative.

Required before full completion:

| Test group | Required proof |
|---|---|
| Role routing | Customer, new Pro, existing Pro, ambiguous caller, both roles, explicit switches, urgent interruption; verify actual node context/tool availability. |
| All services | Every category, quantities/add-ons, TV versus furniture, treadmill versus furniture, commercial/bundle and mixed quote-only items. |
| Booking | Address correction, outside area, all three cities, no staffing, expired window, same-day lead time, future booking and duplicate submit. |
| Quotes | No-card enquiry versus formal quote, photo upload, changed quote, explicit approval, expired approval and no premature booking/charge. |
| Payment | Success, decline, 3DS, timeout after success, mismatch, duplicate/out-of-order event, expired hold and cancelled-during-authorization. |
| Card isolation | Only approved test values; no PAN/CVV in AI audio, text, analytics, recordings, application logs or owner dashboard. Do not rely on redaction after exposure. |
| Pro | Apply/resume, fee already paid/waived, identity pending, inactive/suspended/wrong account, lead/helper, duplicate acceptance, readiness and agreement changes. |
| Job/payout | Customer/Easer/owner agree at every milestone; failed capture not paid; completion evidence; manual payout separate from capture/Connect. |
| Operations | Silence, hangup, transfer busy/voicemail/declined, after-hours, call cutoff, provider outage, alert failure, missing event, reconciliation and backup ownership. |
| Security | Prompt injection, arbitrary URL/amount/recipient, role spoofing, IDOR, link replay, shared phone, consent withdrawal and rate/spend limits. |

## 10. Launch recommendation and external dependencies

Safe to inspect/test this non-public conversational draft. NOT safe to promote it as a full booking/payment/Pro-management assistant. Keep manual payouts and current public forwarding. The root worktree remains dirty with unrelated changes; a website release needs a clean, scoped worktree and approval.

To finish telephone-only card entry, obtain Telnyx/processor confirmation of a Stripe-compatible connector, token format and customer binding, manual authorization/future SetupIntent support, MOTO eligibility, PCI responsibility/AOC boundaries, test-mode card support, signed callbacks and fees. No support ticket was sent or service purchased here.

The lower-risk first release is the existing Stripe-hosted fields with a prefilled continuation while the caller remains on the call. Stripe documents direct-to-Stripe collection as reducing the application's card-data exposure; merchant PCI responsibilities still apply. [Stripe integration security](https://docs.stripe.com/security/guide)

Do not ask a caller to read a card/CVV into Sora. PCI SSC prohibits retaining card verification values after authorization even in encrypted audio recordings. [PCI SSC audio-recording FAQ](https://www.pcisecuritystandards.org/faqs/1210/)

Decisions the owner still needs before public rollout: exact routing (all/missed/after-hours calls), backup for urgent Pro issues, maximum unresolved-request age, realistic staffing confirmation in each city, dedicated cost limit, and approval of any paid PCI connector. A completed call is not necessarily a completed booking; a completed booking is not a paid Easer.
