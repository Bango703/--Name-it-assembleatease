# Phone Calls inbox: implementation and activation gate

## 1. What changed

A separate owner-only Phone Calls inbox records signed provider lifecycle events independently of Sora's confirmed support intake. Immediate hangups, initiated-only calls, answered calls, terminal events, and separate transfer legs can be visible without creating a support Case. Events do not reveal why a caller ended a conversation. The system does not guess that a caller said "never mind."

The receiver handles the two different Telnyx contracts: raw signed TeXML form callbacks and raw signed Voice API v2 JSON events. It rejects invalid/stale signatures, unknown connections, malformed recognized events and oversize bodies. Durable, deterministic event IDs deduplicate simultaneous provider retries. Failed writes return 503, not a false success.

The owner view shows numbers, direction when known, first/latest observed event, provider duration when supplied, timeline, confirmed Cases, owner-email delivery state, and a manual reviewed indicator. Reviewing sends nothing and does not change a Case. A later event makes the call unreviewed again. The sidebar checks for activity every minute while an authenticated dashboard is visible; the inbox has an explicit Refresh control. This is not a background SMS/email alert for every call.

## 2. Why it changed

- P0: A caller could end before the intake endpoint and remain invisible to the website owner.
- P0: The earlier unshipped draft created a Case for every call, conflating call presence with a confirmed request and callback permission.
- P1: False empty states, duplicate events, late events, cramped details, and email "sent" versus "delivered" ambiguity undermine owner decisions.

The new implementation protects Customer and Easer intent, preserves existing Case truth, and provides an owner review signal. It neither books a service nor creates payment/payout state. Unverified caller ID is never proof of identity or permission to disclose a booking.

## 3. Exact files

- `api/_voice-call-history.js`: configuration, signature verification, allowlisted projections, event identity, monotonic call projection.
- `api/webhooks/telnyx-voice.js`: default-off signed receiver, no Case or email creation.
- `api/owner/voice-calls.js`: existing owner-session authorization; paginated history, details, exact Case linkage, notification truth and review markers.
- `owner/assets/voice-calls.js`: inbox rendering, selection, review, refresh, Case navigation, escaped output.
- `owner/assets/voice-calls.css`: spaced desktop/mobile list and detail layout.
- `owner/index.html`: navigation, view mount, stylesheet/script, badge and refresh wiring.
- `owner/assets/cases.js`: open a specific linked Case even outside active filters; guard stale detail responses and queued selection.
- `.env.example`: disabled configuration template with no credentials.
- `scripts/test-owner-voice-calls.mjs`: offline security, lifecycle, pagination, consent boundaries, database errors and browser-module checks.
- `scripts/preview-owner-voice-calls.mjs`: localhost-only fictional visual fixture; no credentials or provider access.
- This report.

Implementation is isolated in branch `fix/owner-phone-call-history-20260906`, clean worktree `C:\Users\tgbiz\AppData\Local\Temp\aae-owner-call-history-20260906`, based on production/main `0ab7f1595c5afc9a7efc0291e8feb8423ede74e6`. The original worktree's unrelated edits were preserved and not copied into this build.

## 4. What was not changed

Sora voice/model/transcription and prompt; Telnyx routing or provider settings; public forwarding to 737-290-6129; booking, dispatch, prices, tax, Stripe, capture, refunds, payouts; existing support confirmation/consent rules; SMS, AI Missions, subscriptions, budgets; live records or database schema. No records were deleted. No push, deployment, real call, or provider activation was performed for this change.

Data uses existing `activity_logs` with event type `telnyx_voice_event`, booking_id null. Only receipt time, safe lifecycle fields, normalized E.164 numbers, configured connection IDs and hashed call/relationship references are persisted. Raw payloads, transcripts, recordings, SIP URIs, DTMF, API credentials and model/client_state are not stored by this receiver. This does not change Telnyx's own transcript retention or privacy settings. Review markers use `telnyx_voice_review`; the immutable lifecycle rows remain unchanged.

No automatic deletion/retention job was added. The inbox is a 30-day receipt-time view; older retained calls remain accessible by an exact call reference. Its counts describe the displayed page, not all historical calls. Older-page controls are explicit; event limits produce an incomplete state instead of false certainty. This is a first-25-jobs scope, not an all-time analytics/search product.

## 5. Validation

Run from the isolated worktree:

```text
node scripts/test-owner-voice-calls.mjs
node scripts/test-sora-support-intake.mjs
node scripts/test-operations-cases.mjs
node scripts/ci-check-inline-scripts.mjs
node scripts/audit-source-of-truth.mjs
npm run lint
git diff --check
```

| Perspective | Offline result | Proof and remaining live proof |
| --- | --- | --- |
| Customer | PASS | Call exists without forced Case/contact; existing intake consent tests pass. Real post-deployment call pending. |
| Easer | PASS | Same exact-reference support linkage; existing role/topic rules unchanged. Real Easer request and notification pending. |
| Owner | PASS | Timeline, review, late-event re-review, exact Case link, private authorization, paging and truthful outages tested. Production rendering/feed still pending. |
| Security | PASS | Signed raw form/JSON, timestamp window, explicit connections, size limits, duplicate payload fields, untrusted content escaping and owner checks. Live provider signature contract pending. |
| Payment/payout | UNCHANGED | No financial dependency or state mutation added. No live financial test or transaction performed. |

The local visual preview uses fictional records and the actual new view fragment, CSS and browser module, not the production authentication backend. Desktop and phone-width inspection is not a substitute for full deployed owner-dashboard QA.

Recorded results: 159 new phone-history checks PASS; 479 existing Sora intake checks PASS; Operations Cases, owner-dashboard regression and external-facing copy tests PASS; 776 inline scripts parse; source-of-truth audit 12 PASS, zero warnings/failures. Full repository lint has zero errors and one pre-existing unused-disable warning in `scripts/apply-flagship-cities.mjs`. Changed browser modules additionally pass explicit browser-scope lint. Desktop and 390px mobile layout, selection, truthful missing-end state and fictional review action were visually checked using the computer-use skill. No full live end-to-end claim is made.

## 6. Remaining warnings and activation sequence

1. Obtain explicit approval to push these files and deploy. Keep the receiver disabled for the first deployment.
2. Inspect production schema read-only for `activity_logs` from migration 004; `operations_cases` source_ref and `notification_log.operation_case_id`; migration 068 delivery timestamps. Missing notification columns must show unavailable, never delivered/no-email. Inspect actual RLS policies and owner authorization. No new migration is required by this patch.
3. Obtain/verify the account Ed25519 public verification key, not the private API key. Configure production-only `TELNYX_PUBLIC_KEY`, `TELNYX_VOICE_CONNECTION_IDS` (only approved verified connection IDs), and `TELNYX_VOICE_BUSINESS_NUMBERS` (approved E.164 numbers). Enable `TELNYX_VOICE_HISTORY_ENABLED=true` only for the approved live test stage. Preview and custom non-production environments cannot ingest production events.
4. For the Sora owner-test TeXML app, configure its **status callback** to `https://www.assembleatease.com/api/webhooks/telnyx-voice`, POST, and explicitly request every supported lifecycle status needed by that app/call creation path. Do not replace the voice instructions URL or fallback URL with this JSON receiver. Per-call callback settings may override application callbacks: inspect and test both. This code does not configure Telnyx.
5. Verify the public number's actual Web Dialer/Always Forward route separately. A Sora TeXML callback does not automatically observe forwarded SIP calls. Do not switch public routing to fix monitoring. Inspect available signed event/CDR delivery on the existing connection and choose an approved, supported integration before claiming coverage. The JSON receiver only supports signed Voice API initiated/answered/hangup events; it is not a CDR ingestion endpoint.
6. Run approved real calls: immediate hangup; "never mind"; customer confirmed request; Easer support request; no answer; owner transfer accepted; owner transfer declined/voicemail; caller disconnect during transfer. Reconcile each provider leg/reference to the owner inbox and each confirmed intake to exactly one Case and its notification log. Verify caller-led short turns separately without changing Sora's voice. A completed call proves neither conversation intent nor human answer when voicemail may have answered.
7. Test database outage/retry in an isolated environment; do not deliberately break production. Verify no duplicate event/Case and no false review or email success. Observe late events and all relevant route configurations. There is no automatic historical backfill; previous calls will not appear just because this code is deployed.
8. Retain daily provider-to-inbox reconciliation until route coverage is proven. There is no independent provider outage monitor/failover in this patch. If all webhooks disappear, this inbox alone cannot detect unseen calls; do not claim otherwise.

Confirmed support Cases remain the only source for requested follow-up. No Case found means no confirmed request was found **at that check**, not proof that the caller declined, gave permission, or did not subsequently submit intake. Email failures must be handled from existing Cases/notification evidence. Call-only activity is an owner inbox indicator, not an automatic outbound campaign.

## 7. Deploy recommendation

Suitable for a scoped, approved deployment with capture disabled, followed by approved staging/live route verification. **Not approved to label all public calls captured or to promote Sora to the public route.** Public forwarding and Sora's voice must remain unchanged.

Rollback: restore the exact prior Telnyx callback settings first, then disable the ingestion flag/redeploy if necessary. Leave saved call history intact. Disabling ingestion alone returns 503 and can cause provider retries; it is not a clean provider-side rollback. Never delete history as rollback.

Provider contracts reviewed: [TeXML completed callback](https://developers.telnyx.com/api-reference/callbacks/texml-call-completed), [TeXML initiated callback](https://developers.telnyx.com/api-reference/callbacks/texml-call-initiated), [receiving webhooks](https://developers.telnyx.com/docs/development/api-fundamentals/webhooks/receiving-webhooks), [Voice API hangup callback](https://developers.telnyx.com/api-reference/callbacks/call-hangup).
