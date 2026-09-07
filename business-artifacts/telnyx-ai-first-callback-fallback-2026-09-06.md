# Sora AI-first callback fallback: preparation and verification

Date: September 6, 2026. Status: optional-field fix deployed; retest ended before saving. Short, caller-led conversation rules saved in the owner-test version. Independent owner call history is still missing. Public inbound routing remains unchanged. See the latest addenda before any launch decision.

## 1. What changed

- Updated Sora version `20260906T153456589927` on assistant `assistant-3e75ad89-92e9-447d-b42d-f84a33ac0d84`. Its label is now `Owner test - AI-first callback fallback`.
- Added explicit busy, unanswered, rejected, failed and voicemail-transfer fallback instructions to the global prompt and all three role-workflow nodes.
- Created isolated transfer tool `tool-cb956bef-f017-4f72-8ad2-167b464c95f2`, keeping the sole destination `+17372906129`, caller number `+19792325139`, and existing warm-transfer acceptance enabled. Premium voicemail detection now uses `stop_transfer` to return the caller to the assistant.
- Replaced the old transfer tool association only in the owner-test version and its nodes. The old shared tool was not edited or deleted.
- Changed Sora's shared TeXML application's outbound profile from unlimited `Default` to the existing protected `AssembleAtEase Outbound` profile (`3036113158570771947`). The profile itself was not changed: $10 daily outbound ceiling, 2 concurrent calls, $0.10 maximum destination rate, US/Canada destinations. This is a ceiling, not a daily fee, and is not a total AI/account spending cap.

### Intended caller language

If a transfer returns without a human connection:

> I'm sorry, I can't connect you with our team right now. I can take your details and request a callback. Would you like me to do that?

Only after the request-save tool reports success:

> Your callback request is saved. Our team will follow up using the number you confirmed.

If the request was already saved, acknowledge the existing request rather than creating another Case. If saving fails, clearly say saving could not be confirmed and offer the contact page or support email. Do not invent a busy queue, queue position, staffing status, callback deadline or automatically scheduled callback.

After hours, state that phone support is closed only when the current hours tool explicitly reports closed. Offer confirmed intake rather than a transfer. A failed hours lookup is not proof that the team is closed.

## 2. Why it changed

P0 for AI-first launch: unconditional forwarding bypasses Sora, and voicemail/failed transfers can strand callers if the fallback is not proven. P1: inaccurate busy/queue claims and duplicate requests create customer confusion and owner work. This preparation is presentation/telephony behavior only; it grants no booking or financial authority.

## 3. Files and provider resources changed

- `business-artifacts/telnyx-sora-intake-only-prompt-2026-09-06.txt`: only HUMAN HELP AND AFTER HOURS section changed.
- This handoff report.
- Owner-test assistant version, its three workflow nodes, and the new isolated transfer tool.
- TeXML application `3043075771762476974`: only outbound profile reference changed. This application resource is shared across Sora versions.

No website runtime files were changed, committed, pushed or deployed during this routing-preparation pass. Existing unrelated root-worktree edits were preserved.

## 4. What was not changed

- Public number `979-232-5139` still Always Forwards to `737-290-6129`; it remains assigned to `AssembleAtEase Web Dialer` connection `3040104147199198769`.
- Sora main version remains `20260906T200024569168`. No version promotion, public-number assignment or traffic-distribution mutation was performed.
- Existing five-minute AI time limit, voice/model, recording-off and other assistant telephony settings remain unchanged.
- No new number, subscription, recurring test, outbound campaign or AI Mission was purchased/enabled.
- During the initial preparation pass, no real call, SMS, booking, payment, refund, payout, dispatch or customer-data mutation was initiated. The later approved owner call is documented below. No record was deleted.

## 5. Validation performed

| Check | Result |
|---|---|
| Saved global prompt matches local approved changes | PASS |
| Prompt content outside the transfer/after-hours section preserved | PASS |
| Three nodes/four edges, role scope and resolved new transfer tool IDs | PASS |
| All three resolved transfer tools show premium detection/stop-transfer and acceptance enabled | PASS |
| Main version, public forwarding, voice and assistant duration/recording settings preserved | PASS |
| Protected outbound profile reference read back on the exact Sora app | PASS |
| TeXML inbound settings, primary URL and fallback URL preserved | PASS |
| Intake regression on isolated production-based copy | PASS: 373 checks, all 18 role/topic paths, consent, replay, privacy, outages and Central hours |
| Edge browser shows saved version label and updated workflow instructions | PASS |
| Real spoken intake, returned unanswered/voicemail transfer, owner delivery from an actual call | NOT VERIFIED |

The initial full-object workflow comparison differed because Telnyx resolves shared tools in its response. Explicit assertions on node configuration/edges and inspection of every resolved tool confirmed the intended IDs and protection settings. No mismatch was ignored.

## 6. Remaining warnings / test gates

1. The owner subsequently approved and answered one bounded real call. It exposed an intake validation failure; see the addendum. Human transfer acceptance/rejection still needs a separate test.
2. Verify customer mixed-service intake and Easer active-job support through real speech, then match the readback to one resulting Case and a delivered owner notification.
3. Verify refusal of callback consent creates no confirmed request; verify an existing saved request is not duplicated after failed transfer.
4. Verify no-answer, voicemail, decline and accepted-human transfers. Provider configuration/readback is not proof of actual call behavior. A second caller endpoint is needed to test transfer to the owner's phone without transferring that same phone to itself.
5. Verify after-hours behavior without pretending Sunday is open or changing the real support schedule. A controlled test-only harness or an in-hours test is needed for the open-hours branch.
6. Prove initial AI/telephony failure recovery separately before claiming outage failover. The current app's primary and fallback URLs both point to the same Telnyx assistant endpoint; this pass did not create an independent outage fallback.
7. The outbound profile ceiling is shared with existing calling and does not prove a cap on inbound/LLM/voice-AI charges. Monitor actual usage during the controlled pilot.
8. Provider warm acceptance can fall back to a normal warm transfer if the consult cannot initialize. Do not promise universal fail-closed acceptance; validate the actual path.

## 7. Safe-to-launch decision and rollback

Prepared for controlled testing, NOT yet ready to switch public traffic. The user approved AI-first routing only after tests pass. Keep public forwarding intact until the gates above have evidence. No claim is made that callers currently hear this new wording.

Rollback of preparation, if needed: restore the prior prompt/three node instructions and transfer associations to `tool-a193faea-60da-436d-ad92-6c866c19b9f7` on the owner-test version. The original prompt is retained in the preceding production release. The prior shared-app outbound profile was `3043075499417929620` (unlimited Default); restoring it would remove cost protection and should not be done casually. Do not delete Cases, old tools or versions as rollback.

Provider references: [Voicemail detection on transfer](https://developers.telnyx.com/docs/inference/ai-assistants/voicemail-detection-on-transfer), [warm-transfer acceptance and limitations](https://developers.telnyx.com/docs/inference/ai-assistants/warm-transfer-acceptance), [Voice API pricing](https://telnyx.com/pricing/voice-api), [version routing/testing](https://developers.telnyx.com/docs/inference/ai-assistants/version-testing-traffic-distribution). Current listed premium AMD charge is $0.0065 per use, in addition to applicable call/AI charges.

## 8. Approved real-call test and isolated fix preparation

### 1. What changed

One owner-approved outbound call was initiated at 2026-09-06 23:19:46 UTC (6:19:46 PM Central) from the public business number to the approved owner endpoint. The API explicitly selected owner-test version `20260906T153456589927`, with a 300-second maximum, 30-second answer timeout, and recording disabled. Telnyx reported a final duration of 196 seconds and `is_alive=false`.

Conversation evidence: `4d90ee95-9b53-4391-adee-1ed63d6f0213`. The caller chose Service Pro and tested an earnings question, rather than the suggested customer furniture scenario. The transcript contains 37 messages, one support-options invocation, and two identical save attempts.

Prepared, but did NOT deploy, an optional-field compatibility fix in an isolated production-based worktree. No additional outbound call was made. No post-call request was silently created or replayed.

### 2. Why it changed: audit finding

**P0 for AI-first launch:** both real save attempts returned HTTP 400, `Email must be plain text, no more than 254 characters.` The model's captured arguments omitted email and other optional fields. The validator accepts an omitted email but rejects null. This points to a webhook optional-field serialization mismatch; the raw rendered request body was not available from the conversation log, so the exact transport value remains unverified. An offline null-filled equivalent reproduces the rejection. Do not describe the null hypothesis or proposed fix as proven live yet.

The failure can strand customer leads and Easer support requests and prevent owner notification. It does not authorize or change bookings, Stripe, refunds, dispatch, or payouts. No new legal or financial authority is granted by the proposed compatibility change.

**P1 observations:** the assistant retained the spoken city in the summary but omitted the structured city field; it retried an identical request after a validation error. These should be rechecked in the next spoken test. Avoid implying a payout can be released by this intake assistant.

### 3. Files changed

Local branch: `fix/sora-optional-intake-20260906`.

Worktree: `C:/Users/tgbiz/AppData/Local/Temp/aae-sora-optional-intake-20260906`.

Base: production merge `1d886a5d10c68ea9e7c7b4e16e80e09bc3f05bb9`.

- `api/ai/support.js`: treat null as missing only for optional text, optional active-job flag, optional non-service booking details, and optional item lists. Required strings, role/topic, callback phone, explicit confirmation and consent, new-service categories, item quantities, extra-field rejection and sensitive-input checks remain enforced.
- `scripts/test-sora-support-intake.mjs`: add null/omitted equivalence, retry/idempotency, owner visibility, required-null rejection and invalid-type/security regression coverage. The regression first failed before the validator change, then passed afterward.
- This handoff report was updated in the original workspace. It is not a website runtime change.

### 4. What was not changed

Public number `979-232-5139` remains on Web Dialer connection `3040104147199198769`, with Always Forward enabled to `737-290-6129`; read back after the test. Main assistant version remains `20260906T200024569168`. No assistant configuration, tool schema, secret, public routing, payment, payout, pricing, booking, or dispatch setting was modified during this test/fix pass. No existing record was changed or deleted. No code was committed, pushed or deployed.

### 5. Validation performed

| Workflow/check | Result |
|---|---|
| Approved owner phone connects to explicit test version | PASS |
| Customer/Service Pro role question and Service Pro path | PASS |
| Server-derived Sunday closed-hours handling | PASS |
| Spoken callback readback, details confirmation and callback consent | PASS |
| Real request save | FAIL: both attempts HTTP 400 |
| Durable Case for actual provider call reference | FAIL: zero matching Cases, verified read-only |
| Owner notification from this request | NOT CREATED: validation failed before Case/email workflow |
| Honest failure response and contact/email fallback | PASS; no false saved-request claim |
| Human transfer, voicemail return, customer mixed-service path | NOT EXERCISED |
| Proposed fix: intake regression | PASS: 479 offline checks, including all 18 role/topic paths |
| Proposed fix: owner Case durability/security regression | PASS |
| Proposed fix: existing receptionist regression | PASS |
| Proposed fix: Case detail layout regression | PASS |
| Syntax, focused lint, diff whitespace checks | PASS |
| Proposed fix deployed/retested live | NOT DONE |

Tests used the network-blocking preload and injected fake data/services; no real test requests or emails were generated by the regression suite. The printed notification-timeline warnings came from intentional failure fixtures, not production. The isolated worktree reuses installed dependencies through a `node_modules` junction without changing dependencies or the lockfile.

### 6. Remaining warnings

The exact provider-rendered invalid email value still needs live confirmation. A no-write tool diagnostic (explicit false consent/confirmation) was rejected by Telnyx with 404 because the tool is not attached to the main version; it did not reach the website or create data. Do not attach it to main solely to bypass that diagnostic limitation.

The proposed compatibility patch needs deployment approval and a new, bounded live test before claiming the failure fixed. Do not fabricate a saved request from the failed call. The failed call's user-provided callback number was read back and confirmed; it is not the same as the test destination, and must not be silently replaced with caller ID. A future test should explicitly use the owner's intended callback number.

Customer spoken intake, human transfer acceptance/decline/no-answer/voicemail recovery, initial AI outage failover, and owner delivery remain launch gates. The 300-second ceiling also needs validation against a longer mixed-service conversation; this call ended below the ceiling.

### 7. Safe-to-deploy / launch decision

The isolated validator change is ready for a scoped, approved deployment, followed by real-call verification. It does not require a schema migration. Do not deploy the dirty original workspace. Do not claim all calling is ready, promote the test version, or disable Always Forward until the failed intake is resolved and the remaining routing gates pass.

Outbound call schema was checked against the [official Telnyx SDK](https://github.com/team-telnyx/telnyx-node/blob/master/src/resources/texml/texml.ts); verification used the [official conversation endpoints](https://github.com/team-telnyx/telnyx-node/blob/master/src/resources/ai/conversations/conversations.ts). No recording was retrieved or created by this test.

## 9. Approved compatibility deployment and retest

The user explicitly approved pushing/deploying the two-file fix and one additional phone test. The user then explicitly instructed: leave Sora's voice unchanged. No voice or assistant configuration was changed during this release.

### Deployment evidence

- Release commit: `e0b2c0802a7ebdc62baf2490f5e59ef2aa56e5dc`.
- [PR 140](https://github.com/Bango703/--Name-it-assembleatease/pull/140) merged at 2026-09-06 23:32:12 UTC after platform guards and the preview build passed.
- Production merge: `0ab7f1595c5afc9a7efc0291e8feb8423ede74e6`.
- Diff from the preceding production merge contains exactly `api/ai/support.js` and `scripts/test-sora-support-intake.mjs`.
- [Production deployment](https://vercel.com/bango703s-projects/name-it-assembleatease/DMZvH6pfzyCGi4u2syCcUfPtdyCp): `dpl_DMZvH6pfzyCGi4u2syCcUfPtdyCp`, READY. The `www.assembleatease.com` and `assembleatease.com` aliases were verified on this exact deployment before retesting. The merge commit's production status and post-merge platform guards passed.
- Production endpoint checks: GET returns 405; unauthenticated POST returns 401. Neither writes intake data.
- No migration, environment/secret update, payment/payout/pricing/booking/dispatch change, or public-routing change was included.
- Repeated offline intake regression: 479 checks PASS; focused lint, syntax and whitespace checks PASS. The separate Cases/receptionist/layout regressions had also passed before approval.

### Retest started

One approved call was initiated at 2026-09-06 23:34:30 UTC (6:34:30 PM Central), to the approved owner endpoint, using explicit owner-test version `20260906T153456589927`, recording disabled, 30-second answer timeout, and 300-second call ceiling. Conversation: `7a6d1555-d1cd-4adb-99ee-f3bdd229bbff`. The caller was asked to repeat the Service Pro/no-email scenario with clearly labeled test details. This entry does not itself establish successful intake; final results follow after verification.

### Retest outcome

The caller chose a customer outdoor-assembly enquiry. Sora fetched the outdoor item catalog and recited many services. The caller then said "Never mind" and ended the conversation. Provider final duration was 109 seconds, `is_alive=false`; 15 messages contained `get_service_items` and `hangup`, but no support-save invocation. Read-only lookup by this exact provider call reference found zero Cases, as expected without confirmation/consent. No background request was created. This proves a connected customer call and respected abandonment, NOT a successful save after the compatibility fix. No further call was initiated.

Public Always Forward to `737-290-6129` was read back enabled. Sora's voice remained identical to the pre-release snapshot.

## 10. Caller-led conversation correction and AI board review

The user explicitly requested no service recitation and time for the customer to speak. Saved a focused instruction change to owner-test version `20260906T153456589927`:

- Ordinary turn: one brief acknowledgment and one short question, normally under 30 words, then end the turn and wait.
- Broad category does not request a list. "Outdoor assembly" gets "What outdoor item would you like assembled?" with no catalog recital.
- Tool catalogs are for silent reference; only requested items are discussed. At most two relevant examples when the caller explicitly asks for examples.
- All three workflow nodes reinforce short turns and no unsolicited lists.
- Explicit stop intent ends intake with one polite goodbye and Hang Up, without a new callback offer, request save or implied consent. Withdrawing one item is distinguished from ending the call.
- Required safety guidance, complete factual readback and explicit callback consent are preserved.

The global prompt outside the style/ending edits, all tools/tool scopes, routing edges, voice settings, transcription, interruption settings, telephony, privacy, and main version were preserved and checked by API readback/assertions. No public promotion occurred. The active transcription model is Deepgram Flux; its turn-taking controls differ from legacy pause settings, so no untested timing/model change was made. Actual spoken compliance still needs a future approved test.

Changed local artifact: `business-artifacts/telnyx-sora-intake-only-prompt-2026-09-06.txt`. It matches the saved test-version instructions. No additional website runtime code or deployment was included in this conversation adjustment.

The user then requested independent AI board review. Three read-only reviewers covered engineering/QA, official Telnyx integration behavior, and caller/owner/privacy operations. This is not an external human board certification. Findings are recorded in `business-artifacts/telnyx-call-visibility-board-review-2026-09-06.md`.

Live configuration confirms Sora's TeXML application has no status callback configured, post-conversation processing is disabled, and primary/fallback URLs point to the same assistant endpoint. Telnyx does retain both test conversations, but the website has no independent owner-visible every-call history. The board rejected shipping the old local one-Case-per-call draft unchanged; it would clutter and duplicate support work. New call-history implementation/activation was not performed during the review.
