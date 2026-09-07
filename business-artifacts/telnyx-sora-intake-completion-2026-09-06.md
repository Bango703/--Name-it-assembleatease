# Sora intake-only release: completed implementation summary

Verified September 6, 2026, approximately 4:54 PM America/Chicago.

**Result: deployed, saved in Telnyx's owner-test version, and verified through live tool -> Case -> owner-email integration. Not yet approved for public AI phone routing.**

This completion record supersedes the deployment/attachment status in the earlier same-day intake draft and capabilities audit. Their unresolved real-call and operational warnings still apply. This is an engineering/operations review, not an external board certification.

## 1. What changed

- Published the isolated intake-only release through [PR #138](https://github.com/Bango703/--Name-it-assembleatease/pull/138).
- Source commit: `39b264fb01547adeb0a25538d878e3a499e867ab`; merged production commit: `911dfb6cb610c5df802a0093dcf7042bfa0c6a1d`.
- Initially deployed with `TELNYX_AI_SUPPORT_ENABLED=false`; proved the deployed disabled gate before enabling it.
- Saved `TELNYX_AI_SUPPORT_ENABLED=true` for Production and redeployed the same source commit. [Final production deployment](https://vercel.com/bango703s-projects/name-it-assembleatease/FzY8FjMFPg4nD5wE7oJXGMCmsh3f) reached Ready at 4:50:54 PM CDT.
- Created two secret-backed shared Telnyx webhook tools using the existing protected Authorization integration. No secret was exposed or rotated.
- Replaced the owner-test global instructions and all three node instructions/tool scopes. Kept four role-routing edges. Removed legacy callback/booking tools from this version only; did not delete shared tools.
- Verified the updated workflow in the Telnyx browser UI using the computer-use skill.

### Saved Telnyx configuration

| Item | Saved value |
|---|---|
| Sora assistant | `assistant-3e75ad89-92e9-447d-b42d-f84a33ac0d84` |
| Updated owner-test version | `20260906T153456589927` |
| Version label | Owner test - Customer and Easer intake |
| Options tool | `tool-c8abaa7b-2988-4084-9c25-29130f795458` |
| Request-save tool | `tool-e312fe1b-80b6-4063-b791-6da646f1e28c` |
| Endpoint | `POST https://www.assembleatease.com/api/ai/support` |
| Entry node | Identify customer/pro; options/catalog/items/transfer/hangup; cannot save |
| Customer node | Options/catalog/items/save/transfer/hangup |
| Easer node | Options/save/transfer/hangup; no customer booking interview |

Telnyx rejected boolean `enum: [true]` fields in its tool schema. The saved provider schema uses boolean types and explicit consent descriptions without those two enums. The deployed server still independently requires `detailsConfirmed === true` and `callbackConsent === true`. A live false-consent test returned 400. This is a provider-schema compatibility adaptation, not weaker server validation.

The provider's Test Assistant Tool endpoint did not find tools attached only to a non-main version. An isolated QA assistant was therefore used to exercise the exact same shared tools without promoting Sora. QA fixture `assistant-1b37b7f1-ebb4-4aae-9c6a-b0fedbf963c6` had no phone number assigned and no real conversations started. After verification, its tools were detached. It remains as a clearly named, unrouted record with no default telephony application and unauthenticated web calling disabled; nothing was deleted.

## 2. Why it changed / how it works

The assistant needed to collect useful requests for the platform, not merely give guidance or direct every caller back to the website.

**Customer:** identify service/request -> collect contact and relevant job details -> read back and obtain callback permission -> save one Case -> alert owner -> state that the request is received, not a confirmed appointment.

For new service/custom quotes, supported details include multiple services, item descriptions and quantities, city, optional address/ZIP, preferred dates/windows, product readiness and relevant site notes. Unknown optional facts stay visibly missing rather than being invented. Furniture and fitness equipment remain separate service categories.

**Easer:** identify application/account/job/access/scope/availability/customer/safety/earnings issue -> collect relevant contact, optional job reference, current-job condition and desired help -> confirm -> save one appropriately prioritized Case -> alert owner. No account lookup, assignment verification, earnings disclosure or payout change occurs.

The seven catalog categories and nine topics for each role were returned by the live options tool. Current-job reports can raise priority. Immediate emergencies are directed to emergency services by the instructions; a Case/email is not emergency dispatch.

**Owner:** Cases is the durable work record. Read the request, verify identity/assignment when relevant, follow up, document the outcome and close the Case. Email is an alert, not booking or payment truth. A failed email does not erase a saved request.

## 3. Exact release files

Only these eight files were committed and deployed from the clean production-based worktree:

1. `api/ai/support.js` — gated request intake and options endpoint.
2. `api/_ai-intake-validation.js` — shared contact/call-reference validation.
3. `scripts/test-sora-support-intake.mjs` — 373 focused checks.
4. `scripts/sora-offline-test-preload.mjs` — network isolation for offline regression.
5. `business-artifacts/telnyx-sora-intake-only-prompt-2026-09-06.txt`.
6. `business-artifacts/telnyx-sora-intake-tool-contract-2026-09-06.json` — logical contract; see provider schema adaptation above.
7. `business-artifacts/telnyx-sora-intake-capabilities-2026-09-06.md` — earlier audit/capability inventory.
8. `business-artifacts/telnyx-sora-intake-release-2026-09-06.md` — isolated release checklist.

This completion document is a local handoff artifact created after deployment, not an additional runtime release. Existing unrelated root-worktree edits were preserved and excluded. No database migration was deployed.

## 4. What was not changed

- Public number `(979) 232-5139` still Always Forwards to `(737) 290-6129`, connection `3040104147199198769`.
- Sora's main version remains `20260906T200024569168`. No promotion or public traffic-distribution change was made.
- Existing owner-target canary rule remains limited to `telnyx_end_user_target = +17372906129` and the owner-test version. Telnyx's LIVE badge on that version reflects this existing rule; it does not mean the public number now answers with the new AI flow.
- Fixed transfer target/acceptance settings, owner-test five-minute duration, voice/model and recording-off setting were preserved.
- Existing owner-test privacy settings remain `data_retention=true`, `pii_redaction=disabled`. Recording off does not mean that all transcripts/history are absent.
- No pricing, tax, fee, payment, refund, payout, booking-status, dispatch or Easer-readiness logic was changed by this release. No payment, payout or dispatch API was invoked by these checks.
- No real customer/Easer was called or texted; no real booking was created. No new phone numbers, paid subscriptions, AI Missions, outbound campaigns or scheduled automations were enabled.
- No existing database records were deleted. The only new business records were two labeled synthetic Cases, their audit/notification records and associated test rate-limit activity. Only those two newly created Cases were closed after verification; previous Cases were untouched.

## 5. Validation performed

| Workflow/check | Result | Evidence |
|---|---|---|
| Focused offline validation | PASS | 373 checks: all 18 role/topic paths, seven categories, auth, privacy, consent, replay, limits, outages and Chicago hours/DST |
| Full clean-worktree regression | PASS | `npm run test:launch`; 776 inline blocks across 427 pages parsed |
| GitHub required checks | PASS | Constitution guards and Vercel completed successfully before merge |
| Production deployment | PASS | Ready, exact merged commit; final same-source redeploy applies enabled flag |
| Unauthenticated intake | PASS | POST 401; GET 405; `Cache-Control: no-store` |
| Disabled live gate | PASS | Options reported false; save returned 503; exact synthetic source references had zero Cases |
| Enabled live gate | PASS | Options reported true after redeployment |
| No callback consent | PASS | Live tool request returned 400; no Case created |
| Full mixed-service customer intake | PASS | One Case with bed + treadmill, separate categories, quantities, address, ZIP, preferred date/window, readiness and site/product notes |
| Exact retry | PASS | Same customer reference; one Case and one owner notification |
| Changed same-call retry | PASS | 409; saved request not overwritten |
| Easer earnings + active-job issue | PASS | One Service Pro Case, high priority, factual paused-work notes, unverified reference, no customer/account/booking linkage |
| Owner notification delivery | PASS | Exactly one log per synthetic Case; both final statuses `delivered` |
| Owner browser display | PASS with presentation warning below | Full descriptions, priority, delivery status and timeline visible; closed test records retained |
| Booking-page smoke check | PASS | `/book` returned 200; no checkout/payment action performed |
| Owner endpoint unauthenticated check | PASS | `/api/owner/cases` returned 401 |
| Sora configuration readback | PASS | Exact prompt match, three nodes/four edges, correct scoped tools; main/canary/telephony/privacy preserved |
| Real phone conversation / speech quality | NOT VERIFIED | No real call placed in this release |
| After-hours / voicemail / failed-transfer voice behavior | NOT VERIFIED | Function/prompt checks do not prove telephony behavior |

### Retained synthetic evidence

| Role | Case reference | Final Case state | Owner email |
|---|---|---|---|
| Customer | `AAE-AI-MTQCJ73Q-AA354439` | Closed — test completed, record retained | Delivered; log `8811743e-5eaa-4997-9e84-9e6f9bfda1f4` |
| Easer | `AAE-AI-MTQCJEVT-4AD6C742` | Closed — test completed, record retained | Delivered; log `8cf4b4a7-b898-495d-b81d-2612dd3eade2` |

Find these under Owner Dashboard -> Cases -> Status: Closed. Each has created, notification-attempted and test-closure events. The timeline's original “delivery not yet confirmed” note is historical; the notification summary/log subsequently shows Delivered. No closure email was sent. Test names, address and 512-555-0100 phone are fictional; do not contact or dispatch.

These are real webhook/database/email integration tests with synthetic input. They are not evidence that the assistant heard, routed, confirmed or saved a real spoken call correctly. Provider call-context interpolation was exercised using a synthetic test dynamic variable, not a real call-control event.

## 6. Remaining warnings / launch gates

### P0 before public AI rollout

1. **Real voice acceptance tests:** exercise customer mixed-service intake, Easer active-job/earnings support, interrupted/declined consent, a correction and emergency handling. Verify spoken readback against the exact resulting Case and delivered owner alert. Use an explicitly bounded paid-call test allowance; none was spent/initiated here.
2. **No false completion claims:** saving a request is not booking, cancellation, refund, dispatch, approval or payout. Server flags and prompt enforce this distinction; still test actual model behavior by phone.
3. **Human escalation proof:** test open/closed hours, busy/no-answer, rejection and voicemail before advertising reliable human handoff. Immediate danger must not be routed into a lengthy intake checklist.

### P1 operational limits

- Hours are currently a server-provided fact used by the prompt, not a hard enforcement gate on the separate transfer tool. Do not promise after-hours transfers are technically impossible.
- Owner does not yet receive a complete platform timeline of every abandoned, missed or failed call. An unfinished/unconfirmed intake is not automatically a Case.
- No automatic outbox recovery is implemented for a crash between Case creation and notification attempt. Check Cases even when no email arrives.
- Five minutes may be tight for a large project; test pacing and essential-first collection before changing duration/spending.
- Easer name/callback are present in the request text. Generic customer/phone fields intentionally remain blank, and the Case says “No customer linked.” A dedicated caller-contact presentation would reduce owner confusion; the unrelated, locally modified owner UI was not included in this release.
- One confirmed request is allowed per call. Post-save corrections need follow-up; they are not silently amended or duplicated.
- Review transcript retention/redaction and an owner monitoring schedule before exposing this flow broadly. This release is not a privacy/compliance certification.
- Existing non-blocking lint/brand-color notices remain. Vercel also reported an existing ESLint deprecation warning; no dependency upgrade was mixed into this release.

### Deferred deliberately

AI Missions; autonomous full bookings; card collection; payments/refunds/payouts; automatic dispatch; account lookup/verification; customer SMS/email confirmation links; multilingual promises and new CRM systems. These are not prerequisites for an owner-managed request-intake pilot.

## 7. Deployment and launch recommendation

**The approved controlled intake implementation is complete and deployed. Keep public forwarding unchanged for now.**

The next approval is a bounded real-call acceptance test, not broader automation. After voice and escalation tests pass, make a separate public-routing decision. Until then, customers calling the public business number still reach the existing forwarding flow, not this new AI version.

For the first 25 jobs, the owner should review Cases at the start/end of each support day, prioritize active-job issues, check failed notifications, verify scope/identity before account actions, and reconcile each service request with its eventual secure booking or documented outcome. No customer response-time guarantee was added.

### Provider references used

- [Update a specific Telnyx assistant version](https://developers.telnyx.com/api-reference/assistants/update-a-specific-assistant-version) — used to keep the main assistant unchanged.
- [Test Assistant Tool](https://developers.telnyx.com/api-reference/assistants/test-assistant-tool) — synthetic webhook checks, not real phone-call validation.
- [Official Telnyx shared-tools SDK](https://github.com/team-telnyx/telnyx-node/blob/master/src/resources/ai/tools.ts) — shared tool creation and attachment configuration.
