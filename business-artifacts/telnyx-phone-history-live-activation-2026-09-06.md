# Phone Calls live activation record

User approved pushing, deploying, configuring and verifying call capture while preserving forwarding and Sora's voice.

## Scope and source

- Implementation PR 141 merged as `18c991ed0ca8740a6d70cee7b71fc691b9353d0a`.
- Initial deployment with capture disabled: `dpl_41gKPyyZoSUU8s2MwBCo9fT9eFgb`, READY on both production domains.
- Capture-enabled redeployment: `dpl_8DAEWxN8aMjZ8FNGzHVsBfRtNVpg`, READY.
- Live timestamp compatibility fix: PR 144 merged as `5e8a7bbedc9c4375507d3bcc91ab39eba7f48d89` after the updated branch's full CI and preview deployment passed. Production deployment `dpl_EbBmQ3FvrszcD5AmjgahfcrL6gzE` is READY with both production domains assigned.
- Work was isolated from the original dirty worktree. Existing main-branch changes were preserved; the concurrent PR 143 hours-copy change was not authored as part of this task.

## Saved production configuration

- `TELNYX_VOICE_HISTORY_ENABLED=true` (production only).
- `TELNYX_VOICE_CONNECTION_IDS=3043075771762476974,3040104147199198769` (production only).
- `TELNYX_VOICE_BUSINESS_NUMBERS=+19792325139` (production only).
- Existing `TELNYX_PUBLIC_KEY` reused, not replaced. Checked as a valid 32-byte public verification key. No private key or credential was printed or saved in this report.
- Sora TeXML app `3043075771762476974`: status callback set to `https://www.assembleatease.com/api/webhooks/telnyx-voice`, method POST. Readback changed only `status_callback`.
- Web Dialer connection `3040104147199198769`: event URL set to the same receiver, existing API v2 format retained. Readback changed only `webhook_event_url`.

The public number 979-232-5139 remains assigned to Web Dialer with Always Forward to 737-290-6129. No call parking, routing, voice instruction URL, fallback URL, SIP credentials, outbound limit, recording, payment, payout or booking settings were changed.

Sora owner-test version remains `20260906T153456589927`; main version was `20260906T200024569168`. Voice settings and instructions were compared before/after and were unchanged.

## Proven before live test

- Required production database columns exist for call events, Case linking and email-delivery state. No migration or deletion was performed.
- Production owner inbox API: HTTP 200 with existing owner authentication.
- Unauthenticated inbox request: HTTP 401.
- Disabled receiver: HTTP 503 with explicit disabled response.
- Enabled receiver with unsigned payload: HTTP 401, signature rejected.
- Production HTML contains the new Phone Calls view. The owner signed in, and the live view was refreshed and visually verified in Edge after the final test.

## First real call: important failure and correction

At 2026-09-07 00:39:48 UTC, one approved test was placed from the business number to the owner forwarding number, using the owner-test Sora version, no recording, a 20-second ringing timeout and a 60-second connected-call limit. This was not a customer booking.

Telnyx generated initiated, ringing, answered (`in-progress`) and terminal (`failed`) callbacks. The terminal failure followed the imposed connected-call time limit; it is not evidence of a caller saying "never mind" or of human versus voicemail answer. No confirmed support Case was created.

All four initial deliveries reached the live receiver but returned HTTP 400 because Telnyx used space-separated UTC timestamps with microseconds, while the parser required `T`. Signature verification had passed. These events were not durably saved in the inbox at that stage and must not be represented as successful capture.

PR 144 accepts the observed timestamp format while still requiring an explicit timezone, signature, allowed connection and valid call context. It also acknowledges validated post-analysis callbacks without storing insights. The actual provider payloads passed the patched parser. Offline regression results: 178 phone-history checks and 479 Sora intake checks PASS. Both suites were added to the required CI workflow.

## Final live result

PASS: A second, final approved test call was placed at 2026-09-07 00:51:09 UTC (September 6, 7:51 PM Central), using the same owner-test Sora version, recording disabled, a 15-second ringing timeout and 30-second maximum connected duration. No per-call callback URL or callback-event override was supplied: this verified inheritance of the saved TeXML application callback.

Telnyx reported `no-answer` at 00:51:26 UTC. One terminal event was durably stored in `activity_logs`, and the owner-authenticated detail API returned HTTP 200 with status `no-answer`, one event and review state `unreviewed`. No `operations_cases` row exists for this exact test call reference.

The actual production dashboard in Edge visibly shows Phone Calls with badge **1**, the test phone numbers, **Not answered**, the outbound direction, timestamp, 0-second provider-reported duration, one timeline event and no confirmed request. The view was also visually inspected for spacing/readability. The test call remains unreviewed so the owner can inspect it; no records were removed.

The saved application callback produced the terminal event for this test, not an initiated/ringing event stream. This proves call visibility after the call ends without submitting a request; it does not prove a live ringing indicator or the caller's reason for ending the call. An actual answered "never mind" conversation was not tested successfully in this turn.

Final configuration readback still differs from the original only in the two intended event URLs. The public number's voice/forwarding configuration is unchanged. Sora voice settings and instructions are unchanged. The enabled receiver still rejects unsigned requests with HTTP 401.

Telnyx's webhook-delivery listing had not returned this successful test's delivery entry at the final check (00:53 UTC). Therefore a provider-side HTTP acknowledgment and a live signed duplicate replay are not claimed. Durable storage plus the authenticated owner API and the visible dashboard prove ingestion. Duplicate/replay protection was verified in the 178-check regression suite, not by a second live delivery. The original four rejected test callbacks were not backfilled.

## Validation matrix

| Workflow | Result | Evidence / limit |
| --- | --- | --- |
| Owner call visibility | PASS | Real no-answer test persisted, API 200, visible dashboard badge and details, no Case created. |
| Customer intake regression | PASS / WARNING | Automated intake checks pass; no complete live customer conversation was performed here. |
| Easer intake regression | PASS / WARNING | Automated role/topic checks pass; no real Easer was contacted. |
| Authentication and event validation | PASS | Unauthorized owner API and unsigned event POST return 401; live signed event was stored. |
| Duplicate, replay, privacy and outage regressions | PASS | 178 phone-history checks and 479 Sora intake checks rerun successfully after deployment. |
| Production build and CI | PASS | PRs 141 and 144 merged with checks; final production deployment READY. |
| Public inbound forwarding coverage | WARNING | Route preserved, callback configured, external incoming test still required. |
| Full assistant launch readiness | WARNING | Customer/Easer intake, transfer, voicemail and answered abandonment scenarios still require live proof. |

## Exact files in the scoped PRs

- `.env.example`
- `api/_voice-call-history.js`
- `api/webhooks/telnyx-voice.js`
- `api/owner/voice-calls.js`
- `owner/assets/voice-calls.js`
- `owner/assets/voice-calls.css`
- `owner/index.html`
- `owner/assets/cases.js`
- `scripts/test-owner-voice-calls.mjs`
- `scripts/preview-owner-voice-calls.mjs`
- `business-artifacts/owner-phone-call-history-implementation-2026-09-06.md`
- `.github/workflows/guards.yml`

This activation report is a separate local handoff file, not an additional production code change. No pricing, payment, payout or booking logic changed. No database rows were deleted and no schema migration was applied.

PRs: [141](https://github.com/Bango703/--Name-it-assembleatease/pull/141), [144](https://github.com/Bango703/--Name-it-assembleatease/pull/144). Provider diagnostic reference: [Telnyx webhook delivery API](https://developers.telnyx.com/api-reference/webhooks/list-webhook-deliveries).

## Boundaries that still require proof

- A configured Web Dialer event URL does not prove forwarded public-call coverage. An external call to 979-232-5139, including forwarding, must be reconciled against provider events and the inbox.
- No independent outage monitor or automatic historical backfill was added.
- A call row does not prove caller identity, callback consent, a booking, payment, or why a call ended.
- Call-only activity uses the owner inbox's unreviewed indicator; it does not send a new email or SMS for every call. Confirmed intake retains its existing Case notification flow.
- A full confirmed customer request, Easer request, owner transfer and missed/voicemail flow still need scenario-specific live checks before claiming the entire assistant workflow is launch-ready.

## Rollback

Restore Sora app status_callback to null and Web Dialer webhook_event_url to null, preserving every other setting. Both had no event destination before this change; status callback method was already POST and Web Dialer webhook API was already v2. Then disable the production capture flag and redeploy if needed. Do not delete saved call records. Disabling ingestion alone returns 503 and may provoke provider retries.

## September 7 follow-up: real public calls captured, answering workflow still blocked

The owner reported calling from another number and hearing that the party was unavailable. Read-only investigation at approximately 12:02-12:10 PM Central found:

- **PASS: Public call capture is now proven for the observed forwarded route.** Five public incoming calls appear in Telnyx SIP records and as five distinct call references with 15 persisted start/answer/end events. The provider reports all 15 callbacks delivered with HTTP 200. Latest calls were at 8:18:51 and 8:19:11 AM Central; earlier calls were at 12:48:19, 12:50:53 and 4:04:34 AM. The initial two-hour lookup found nothing because these calls were older than that window; the full-day reconciliation found them.
- **PASS: Owner visibility.** The actual Edge dashboard shows these five calls plus the prior outbound test, with badge 6, timestamps and three-event timelines. Calls were left unreviewed. No records were deleted or contact initiated.
- **P0: Assistant bypass.** The business number remains assigned to Web Dialer with Always Forward enabled to 737-290-6129, exactly as preserved in the prior approval. Telnyx documents that Always Forward bypasses the primary SIP connection. The intended Sora customer/Easer reception flow does not run on this path.
- **Observed carrier result, not an audio diagnosis:** The five public calls have answered timestamps, normal clearing and no SIP invite failure in their CDRs. This proves the forwarded destination connected; it does not distinguish a person from voicemail or an unavailable-party announcement. No recording was reviewed. The exact announcement source is not proven.
- **P0: Wrong default assistant configuration.** A fresh GET of assistant `assistant-3e75ad89-92e9-447d-b42d-f84a33ac0d84` returns name `Blank Workflow`, a generic 371-character instruction, greeting `Hi, how can I help you today?`, and only a hangup tool. The separately saved owner-test version `20260906T153456589927` still contains `AssembleAtEase | Sora Receptionist`, the customer/service-pro greeting and webhook/transfer tools. The TeXML voice URL is the unversioned assistant endpoint. Do not switch the public number to this endpoint before verifying and activating the intended business version. This investigation does not establish who or what changed the default assistant.
- **P1: Direction display.** The initiated event correctly stores `inbound`; later provider callbacks omit direction and store `unknown`. The projection currently chooses the latest non-null direction, allowing `unknown` to overwrite the earlier known direction. Consequently the dashboard labels these calls `unknown`. Proposed scoped correction: preserve the last known inbound/outbound value across events, add a regression for omitted direction on answered/hangup events. No production code change was made in this diagnostic follow-up.

Recommended next approval: verify and activate the prepared Sora receptionist version, replace blanket Always Forward with Sora-first reception, retain 737-290-6129 as the human handoff destination, verify a truthful no-answer callback path, and correct the direction projection. Test incoming customer and Easer paths, human handoff, no answer, and caller abandonment before declaring the answering service ready. This expands beyond the previous explicit approval to preserve forwarding, so no routing or assistant configuration was changed during this follow-up.

Source for forwarding behavior: [Telnyx Call Forwarding](https://support.telnyx.com/en/articles/1130657-call-forwarding). The historical warnings above describe the earlier activation checkpoint; the observed public-route call-capture warning is superseded by this follow-up evidence, but the full assistant workflow remains unverified.
