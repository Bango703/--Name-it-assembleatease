# Sora customer and Easer intake: what exists, what was built, what remains

Updated 2026-09-06. Scope: useful phone intake and support, not transactional phone booking. This is a CTO/operations/security review, not an independent human board's approval.

## 1. Executive summary

The recommended purpose is a professional receptionist and support intake assistant: understand the caller, collect a clear request, confirm the facts and callback permission, save one durable Case, attempt the owner email, and explain the next step accurately. Keep the existing website and verified owner workflows responsible for actual bookings, changes and money.

The user explicitly paused full phone booking and card collection. Those are NOT prerequisites for launching this narrower intake assistant. No new CRM or plugin is required for the code designed here: it reuses existing Cases, email, catalog and Telnyx. Provider usage charges still apply; no new subscriptions, paid calls or spending-limit changes were made in this pass.

Built locally: a separate intake-only endpoint, a complete target conversation prompt, two tool contracts and role-routing instructions. All 18 customer/Easer topics and 373 offline checks pass. The isolated production-based release also passed the existing full launch regression. NOT pushed, deployed, attached to Telnyx or enabled. Existing forwarding/public routing was not changed.

Why this design: Telnyx supports webhook tools and conversation routing, which can connect a voice conversation to the existing platform. Keep the workflow simple and test its actual outcomes rather than relying on fluent conversation alone. [Telnyx conversation workflows](https://developers.telnyx.com/docs/inference/ai-assistants/workflows)

## 2. PASS / WARNING / FAIL matrix and complete practical capability inventory

Status meanings:

- **EXISTS**: previously inspected or tested in the current system; any limits are stated.
- **LOCAL PASS**: implemented and tested offline, not operating on the public line.
- **DRAFT**: conversation/tool configuration prepared; real model/voice behavior is unproven.
- **NEEDS WORK / TEST**: not established; do not promise it.
- **PAUSED**: intentionally outside this request, not a missing intake feature.

| Area | Verdict | Evidence / boundary |
|---|---|---|
| Existing short customer callback | PASS with limits | Prior actual synthetic Telnyx tool request reached a Case and delivered owner email. Full completed real voice intake remains unproven. |
| Full new-customer intake | LOCAL PASS | Multiple services/items, contact, address, preferences, scope, readiness and missing-detail list. |
| Existing-customer support | LOCAL PASS | Separate topics; no duplicate booking, account disclosure or false completed change. |
| Easer support | LOCAL PASS | Nine topics, active-job priority and no customer/profile mislabeling. |
| Owner Cases / email integration | LOCAL PASS; live test needed | Uses existing atomic Case creation, fixed owner destination and notification timeline. No automatic retry outbox. |
| Conversation quality | DRAFT | Target instructions and role scopes prepared; not a completed real-call test. |
| After-hours / human transfer | WARNING | Server time check built; transfer enforcement/acceptance/fallback not proven end to end. |
| Complete call visibility | WARNING | Confirmed requests only. Every missed, abandoned or failed call is not yet guaranteed visible in Cases. |
| Security / money boundaries | LOCAL PASS | Dedicated secret, default-off gate, durable limiter, no account or money actions; unknown optional data not invented. |
| Public intake-only rollout | NOT READY YET | Needs approved deployment, tool attachment, owner delivery proof and bounded live acceptance tests. |

### Customer capabilities

| # | Capability | Have now / new work / remaining need |
|---|---|---|
| 1 | Transparent AI greeting and Customer/Easer split | EXISTS in the owner-test version; updated intake wording is DRAFT. |
| 2 | Recognize caller purpose without repeating a menu | DRAFT; interruption and role-switch voice tests required. |
| 3 | Explain current service categories | EXISTS: seven canonical categories, 201 catalog items. No improvised catalog or guaranteed availability. |
| 4 | Accept Austin, Houston and San Antonio enquiries | EXISTS in prompt; each address/date/pro assignment still requires confirmation. |
| 5 | Full name and confirmed callback number | EXISTS in short callback; LOCAL PASS in new intake. Caller ID is not identity verification. |
| 6 | Optional email | LOCAL PASS; no customer email or marketing consent implied. |
| 7 | Service address, unit, city and ZIP | LOCAL PASS; optional omissions listed for follow-up. No gate/alarm/door codes. |
| 8 | Multiple services in one request | LOCAL PASS; exact current categories, no fitness equipment hidden in furniture. |
| 9 | Items, quantities, models and product condition | LOCAL PASS; up to 15 grouped item lines and bounded project notes. Unknown quantity stays in summary. |
| 10 | Service-specific clarification | DRAFT: furniture, office, mounting, fitness, smart home, outdoor and custom projects. No technical safety diagnosis. |
| 11 | Preferred service date/window and alternatives | LOCAL PASS as caller preferences; no slot reservation, calendar or staffing check. |
| 12 | Stairs, parking, surface and site-readiness notes | LOCAL PASS; only relevant non-secret details. |
| 13 | Custom projects, quotes and commercial enquiries | LOCAL PASS as enquiries; no approved quote, price or formal booking submission. |
| 14 | Save useful incomplete enquiries | LOCAL PASS; name/US callback/summary/confirmed consent required, optional gaps do not discard a lead. |
| 15 | Readback, corrections before save and callback permission | Backend flags LOCAL PASS; natural voice/readback behavior DRAFT. Silence or hangup is not consent. |
| 16 | Case reference and clear next step | LOCAL PASS; say saved only after successful persistence, never appointment confirmed. |
| 17 | Existing booking / arrival / scheduling help | LOCAL PASS for collecting the issue and requested outcome; no private lookup or change. |
| 18 | Cancellation requests | LOCAL PASS for intake only; clearly not cancellation. Secure tracking remains the available self-service route. |
| 19 | Charge, receipt and refund questions | LOCAL PASS for support intake; no card data, eligibility judgment, refund or fee calculation. |
| 20 | Workmanship, unfinished work and damage concerns | LOCAL PASS for categorized factual reports; no liability admission or compensation promise. |
| 21 | Photos / secure document or product-link collection | NEEDS WORK / TEST for an assisted upload/link workflow. Do not claim a voice call received attachments. |
| 22 | Send booking/contact links and written confirmations | NEEDS WORK / TEST: consent, supported delivery, delivery receipts and opt-out behavior. Not required to save a voice request. |
| 23 | Authenticated status lookup or changes | PAUSED / separate secure design. A phone number or reference does not grant account access. |
| 24 | Phone payment, exact quote, confirmed booking or automatic dispatch | PAUSED by the user. No payment connector is needed for this intake-only release. |

### Easer capabilities

| # | Capability | Have now / new work / remaining need |
|---|---|---|
| 25 | New application / onboarding questions | Existing secure application link; LOCAL PASS intake for the blocked step, not submission/approval. |
| 26 | Sign-in and dashboard problems | LOCAL PASS intake; never ask for passwords, OTPs or identity documents. |
| 27 | Assigned job, acceptance, arrival, completion/evidence issues | LOCAL PASS intake; secure Easer workflow remains authoritative. |
| 28 | Access, missing parts, unready site or unreachable customer | LOCAL PASS; factual summary, job reference if available, work-paused context and active-job priority. |
| 29 | Scope mismatch and additional work | LOCAL PASS intake; does not authorize extra work or alter agreed earnings. |
| 30 | Delay, scheduling conflict or availability concerns | LOCAL PASS intake; no job reassignment or automatic profile change. |
| 31 | Customer disagreement or dispute | LOCAL PASS factual support report; no blame assignment or promise of a remedy. |
| 32 | Earnings discrepancy, missing payout or payment question | LOCAL PASS; no bank details, invented pay date or disclosure of another account. |
| 33 | Safety concern | LOCAL PASS critical Case classification plus DRAFT immediate-emergency instructions. Not emergency dispatch. |
| 34 | Genuine identity/account/assignment verification | NEEDS separate secure workflow before any private lookup or mutation. Caller claims are explicitly unverified. |

### Owner, reliability and customer-trust capabilities

| # | Capability | Have now / new work / remaining need |
|---|---|---|
| 35 | Requests enter the existing Cases system | EXISTS infrastructure; LOCAL PASS for expanded intake. No separate booking-status database. |
| 36 | Full relevant intake reaches owner email | LOCAL PASS integration; provider-delivered status must be proven with the new live tool. Email is not the Case source of truth. |
| 37 | Clear role, topic, priority, requested outcome and missing facts | LOCAL PASS in Case description/creation event. Easer contact is not stored as customer identity. |
| 38 | Case/event and notification linkage | EXISTS infrastructure; LOCAL PASS consistent Case IDs and event metadata. |
| 39 | Duplicate/concurrent tool-call protection | LOCAL PASS: one Case and initial owner alert for exact retry. Changed payload/role on same call conflicts instead of overwriting. |
| 40 | Saved Case survives email or timeline failure | LOCAL PASS. The owner must still check open Cases; a saved request is not proof the email arrived. |
| 41 | Automatic repair of unsent owner alerts | NEEDS WORK: durable outbox/provider reconciliation. A process crash between Case save and email can leave an unalerted open Case. |
| 42 | Every inbound/missed/abandoned call visible | NEEDS CONNECTION / TEST. Earlier minimal signed voice-event receiver is local/off and not included in this intake-only release. No inferred consent from abandoned calls. |
| 43 | Live person, failed transfer and voicemail fallback | Existing fixed transfer configuration; NEEDS acceptance/voicemail/failure voice tests for the final version. |
| 44 | Correct after-hours behavior | LOCAL PASS America/Chicago time calculation including DST; DRAFT instructions. Not a hard block on the separate Telnyx transfer tool, not holiday staffing or on-call coverage. |
| 45 | Security, privacy and data minimization | LOCAL PASS request/auth/bounds/privacy guard tests. Instructions prohibit secrets; digit-pattern checks are not a comprehensive redactor or PCI solution. |
| 46 | Friendly repair of misunderstandings, silence or interruptions | DRAFT; real phone tests required. No assumption that script quality proves voice quality. |
| 47 | Prompt/tool/version QA and rollback | Existing versioned test setup; new release checklist prepared. New prompt and tool scopes must be read back after saving. |
| 48 | Owner response coverage and closure discipline | NEEDS an operating routine: acknowledge, contact, document outcome, resolve. No unapproved external response-time promise. |
| 49 | AI duration, spend and abuse controls | Existing five-minute test duration/idle settings from prior inspection; LOCAL PASS endpoint rate limits. Dedicated verified AI spend alerts/caps and duration suitability remain to test. No unlimited spending approval. |
| 50 | Call-quality metrics and optional structured insights | NEEDS WORK / optional after first controlled calls: completed intake, tool failures, missing facts, transfer outcome and unresolved requests. No automatic raw-transcript dump into Cases. |
| 51 | Accessibility / multilingual support | English-first professional pacing in DRAFT. Spanish or other language claims require explicit setup and representative call tests. |
| 52 | Post-save corrections, second issue/call and email-only follow-up | Limited: same-call changed payload is refused, not silently updated. Human/contact follow-up handles corrections. A structured append or email-only consent path is future work. |

Telnyx offers structured conversation insights and tools for assistant testing/version rollout. Their availability does not mean these are configured in this account. Test the task outcome, not only the words the model says. [Telnyx assistant insights](https://developers.telnyx.com/docs/inference/ai-assistants/no-code-voice-assistant), [Telnyx testing and traffic distribution](https://developers.telnyx.com/docs/inference/ai-assistants/version-testing-traffic-distribution)

## 3. P0 issues: conditions before advertising the expanded assistant as operational

1. **The new tool is not deployed/attached.** Current owner-test tools are `get_service_items`, `get_service_catalog`, `request_callback`, transfer and hangup. Rechecked by read-only API in this pass. A new prompt alone would promise unsupported functionality. Deploy the isolated endpoint, test its gates, attach both new tools and replace conflicting global/node instructions together. Do not delete shared tools used by older versions.
2. **No complete real customer/Easer call proof for the new flow.** Local code tests cannot prove speech recognition, correct role routing, actual tool calls, full detail retention and owner email delivery. Obtain bounded call-test approval; verify each outcome in Telnyx, Cases and email logs.
3. **Do not imply booked/cancelled/paid/approved from a saved Case.** Protected in local API and target prompt; exercise these misleading-success scenarios in actual assistant tests before public routing. Money, staffing and account truth remain unchanged.
4. **Urgent support is not emergency response.** The critical Case and email are only reports, not a monitored emergency line. Verify immediate-emergency behavior before opening this route; no intake checklist should delay contacting emergency services.

Affected people: customers, Easers and owner. Potential losses: missed leads, disputed expectations, delayed job help, unauthorized account disclosure or unsafe reliance on an unmonitored request. This release performs no pricing, payout or charge calculation and cannot directly issue those actions.

## 4. P1 issues: operational work still required

- An owner can miss an email. Open Cases and their timelines remain the recovery source; automatic outbox/reconciliation is not implemented.
- Call-start/end/missed/abandoned-call ingestion is not connected. Do not say the owner sees every call or every unfinished intake.
- Transfer destination is fixed, but the time check is advisory to the model, not a hard authorization layer on the Telnyx transfer tool. Test after-hours, voicemail, rejection, busy/no-answer and fallback. Add deterministic transfer gating before claiming that after-hours calls cannot reach the owner.
- Five minutes may be tight for complex multi-service intake. Test first; prioritize essentials and allow incomplete confirmed requests. Do not raise duration or spending without an explicit bounded decision.
- All contact, addresses, item details and job references are caller-provided. Owner must verify scope, address coverage, schedule and identity as needed before acting.
- Owner needs a repeatable follow-up procedure. Proposed internal checks for the first 25 jobs: open Cases at start/end of each support day, failed notifications, unresolved active-job issues and request-to-booking outcomes. This is an operating recommendation, not a promised customer response deadline.
- Same-call corrections after save require human follow-up. Never work around the dedupe guard with invented call IDs or separate legacy tools.

## 5. P2 improvements / deliberately deferred

Consented SMS/email confirmations, secure photo upload links, multilingual tests, structured QA insights, verified status lookup, and a secure post-save amendment workflow can follow after this intake is proven. Do not buy another CRM, add multiple agents, or turn on marketing automation for the first few phone requests.

Card collection, autonomous booking, payments, refunds, contractor payouts, dispatch and account approvals stay paused. Preserve earlier local work, but do not include it in this deployment by accident.

## 6. Business impact and privacy choices

- Customers can describe the entire job without navigating checkout during the call. Owner receives a useful service request rather than a vague "call me" message.
- Easers have an appropriate path for job and earnings help without being pushed into a customer interview.
- Cases hold durable request truth; email is a notification. Existing bookings, pricing, Stripe and payout records remain untouched.
- Missing optional facts remain visible; no fabricated appointment, quantity or account status fills the gap.
- Only necessary contact/location/request data is collected. Keep secrets out of the conversation as well as storage; do not promise that turning recordings off means no conversation data exists elsewhere.

FTC guidance supports collecting and retaining personal information only for a legitimate business need and protecting it appropriately. No deletion/retention change was made; the user has explicitly protected existing data. Review access and retention separately with the actual providers and business policy. [FTC: Protecting Personal Information](https://www.ftc.gov/business-guidance/resources/protecting-personal-information-guide-business)

## 7. Recommended fix / release order

1. Approve only the intake-only push/deployment in the release manifest; keep new capability disabled initially.
2. Verify unauthorized requests are denied and preview cannot save. Reuse existing protected secret, database, durable limiter and owner email configuration; no key exposure or rotation.
3. Enable the new intake flag only for the approved test-version connection. Create/attach the two shared tools with preset action and provider call ID; preserve existing public routing.
4. Replace global instructions and all three node policies, removing contradictory legacy restrictions and excluding old save/booking tools in this version.
5. Complete synthetic customer/Easer tool tests, exact retry checks, owner Case review and real delivery receipt checks.
6. With bounded call-test approval, prove full customer, Easer, after-hours and failed-transfer conversations. Log failures and repair before public rollout.
7. Obtain explicit public-routing approval only after those tests. Establish owner monitoring first. Expand optional conveniences later.

Preset action/call IDs should be supplied by Telnyx configuration, not chosen by the model. Telnyx documents preset fields as hidden from model-controlled parameters and applied to each call. [Telnyx preset webhook parameters](https://developers.telnyx.com/docs/inference/ai-assistants/preset-webhook-parameters)

## 8. Files / APIs involved

Runtime release is only `api/ai/support.js` and shared `api/_ai-intake-validation.js`. Existing dependencies: canonical `_pricing`, `_operation-cases`, `_email`, `_ratelimit`, `_supabase`. Endpoint: `POST /api/ai/support`, actions `support_options` and `submit_request`.

No schema migration or new table. Existing operations-case RPC atomically creates the Case and first event; existing email logger/provider webhook supplies delivery status. No booking, Stripe, Connect, dispatch, account or payout mutation API is called.

Exact test/config/documentation manifest and deployment gates: [Intake-only release checklist](telnyx-sora-intake-release-2026-09-06.md).

## 9. Test plan and evidence

Completed offline:

- **373 checks PASS** across all 18 role/topic workflows, all seven service categories, multi-service details, incomplete requests, proper customer/Easer labeling, urgent prioritization, actual Case-helper payload preservation and null account/booking links.
- Authentication, weak/missing secret, extra fields, invalid phone/email/ZIP/quantities, likely sensitive digits/access codes, oversized Case payload, disabled flags, preview/staging rejection and HTML escaping PASS.
- Exact and concurrent retry, changed-request/role conflicts, catalog outage with support still available, rate-limiter outage, database failure, email failure and timeline failure PASS. Test warning lines are intentional simulated failures, not live events.
- Chicago opening/closing boundaries, weekend rules and winter/summer offset checks PASS. These test the time function, not the independent transfer tool.
- Syntax and scoped ESLint PASS. Full `npm run test:launch` PASS in clean production-based worktree `aae-intake-only-check-e1d75fda`: 776 inline blocks across 427 pages parse. Existing non-blocking lint/brand-color warnings remain unrelated.
- Existing root `npm run test:sora` PASS; earlier local work preserved. No live mutation, customer email, SMS, call, payment, booking or data deletion was used for these tests.

Still required live (do not mark these PASS from the offline result):

| Scenario | Acceptance |
|---|---|
| Austin furniture + fitness, Houston office, San Antonio mounting/custom | Correct categories, all supplied details, one Case, accurate readback, no false appointment. |
| Caller declines address/email or has unknown quantity | Confirm useful essentials, mark gaps, no invented fields. |
| Existing customer cancellation/refund/scheduling | Request only; no changed booking/payment and no deadline/eligibility promise. |
| Easer payout issue and active-job access problem | Pro label, proper priority, reference unverified, no account disclosure/change. |
| Safety / active emergency | Immediate emergency guidance; no delayed intake, dangerous DIY or dispatch claim. |
| Noise, correction, interruption, silence and caller hangup | No invented facts, no consent from silence, no false saved claim. |
| Tool timeout/replay/changed request | Same reference for exact retry; no duplicate owner alert or silent overwrite. |
| Owner notification | Case exists, full description visible, log linked, delivery proven by provider receipt; failure remains discoverable. |
| Open/closed hours and transfer unavailable/voicemail | Correct spoken expectation; no loops or claim a human answered when they did not. |

## 10. Launch recommendation

Approve the **intake-only design** and isolated disabled-code deployment after user approval. Do not yet advertise that the expanded phone assistant is operational. The missing release permission, provider attachment and live acceptance evidence are specific remaining gates—not a reason to build phone payments first.

Keep owner dispatch, existing secure booking and current payout mode. Make the first successful outcome one complete customer request and one complete Easer support request, each verified in Cases and owner email, before opening public traffic to this version.
