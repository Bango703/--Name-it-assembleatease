# Sora call visibility: independent AI board review

Date: September 6, 2026.

Scope: Sora call handling, owner visibility, abandoned calls and deployment readiness. This is a three-perspective AI review, not a human board or legal certification. Engineering/QA, Telnyx integration architecture, and customer/Easer/owner/privacy operations were reviewed independently, then reconciled against the actual test evidence and provider configuration.

## 1. Executive Summary

**Do not replace public forwarding with Sora yet.** The user correctly identified a missing business workflow: the owner must be able to see that someone called even if the caller never saves a request. A prompt or confirmed-intake endpoint cannot guarantee this.

Telnyx retained both test calls; they were not erased. The gap is between provider call records and the website's owner dashboard. The deployed website creates a Case only for confirmed, callback-consented intake. No request means no Case or owner alert from that endpoint.

Keep Sora's existing voice. The long catalog recital was a conversation-design problem. Short-question/wait rules and stop-intent handling have now been saved to the tested assistant version; voice, tools, safety/consent boundaries and public routing were preserved. No new voice, AI Mission, recording or automated callback is required.

The optional-field compatibility fix is deployed through PR 140, production merge `0ab7f1595c5afc9a7efc0291e8feb8423ede74e6`. Offline verification passes; its actual save path still needs a completed real call after deployment.

## 2. PASS / WARNING / FAIL Matrix

| Area | Result | Evidence / boundary |
|---|---|---|
| Existing Sora voice retained | PASS | Full voice configuration equality checked after changes |
| Short-turn/no-catalog instructions | PASS configuration / WARNING behavior | Global plus all three nodes saved; no post-change spoken test yet |
| Optional-field fix deployed | PASS deployment / WARNING live save | Exactly two approved files, guards/preview/production ready, 479 offline checks |
| Owner test call connects | PASS | Provider records for both authorized calls |
| Successful real confirmed intake after fix | WARNING | Second caller ended before confirmation/save |
| Every call visible on owner website | FAIL | No deployed lifecycle history endpoint/view; no TeXML status callback |
| Caller ends without consenting | PASS no fabricated request / FAIL visibility | Abandoned retest had zero Cases, but no owner call entry |
| Customer/Easer Cases as request truth | PASS design | Existing confirmed intake remains separate from booking/payment truth |
| Owner delivery for actual successful voice request | WARNING | No completed post-fix live save/delivery proof |
| Transfer/no-answer/voicemail recovery | WARNING, launch gate | Configuration is not end-to-end proof |
| Independent AI-outage fallback | FAIL readiness | Primary and fallback point to same assistant dependency |
| Payment/payout boundaries | PASS scope preservation | No booking, payment, refund, dispatch or payout authority added |
| Privacy / minimal call history | WARNING | Metadata-only owner access/retention must be specified; no recording is not no transcript |

## 3. P0 Issues

### P0-A: Owner call visibility depends on successful intake

Problem: immediate hangup, silence, "never mind," failed save or disconnect can leave no entry in the owner's website. This can hide customer leads and Easer support needs. The correct fix is independent provider-event logging, not forcing callers to finish intake or creating a request after they decline.

Production evidence at merge `0ab7f159`:

- `api/ai/support.js:85`: confirmation/consent gate; `:228-238`: durable request Case creation; `:245-259`: owner email only after Case save.
- `api/webhooks/telnyx.js:76-78`: existing handler ignores non-SMS events.
- `api/owner/cases.js:51-55`: owner list loads Cases rather than provider calls.
- Live Sora TeXML app `3043075771762476974`: status callback absent. Post-conversation processing is disabled and must not be used as a substitute for guaranteed lifecycle logging.

Fix: verify provider lifecycle events and store minimal durable call activity independently from Cases. Expose a separate owner Phone Calls view, with links to real saved requests and explicit unavailable states when lookup fails.

Test: immediate hangup, never mind, declined callback, failed save and successful save must each leave one correct owner-visible call entry. Only the confirmed successful save creates a request Case.

### P0-B: Actual intake and routing failure paths remain unproved

The first 196-second Easer test returned HTTP 400 twice on email despite omitted model email arguments. The deployed null/missing compatibility fix passes 479 offline checks, but the second 109-second test ended before any save invocation. Do not convert an unexercised test into a pass.

Human transfer accepted/declined/no-answer/voicemail and independent initial/active AI-error fallback need actual proof before public AI-first routing. Primary/fallback pointing to the same assistant endpoint does not provide independent recovery.

### P0-C: Logging only the AI app does not cover current public forwarding

Public `979-232-5139` still Always Forwards through Web Dialer connection `3040104147199198769`; Sora tests use TeXML app `3043075771762476974`. Attaching a callback only to Sora does not establish visibility for the public forwarded route. Read-only inspection and a specifically approved forwarded-inbound test must prove event coverage. Do not change handling or enable parked calls just to obtain logs.

## 4. P1 Issues

- Catalog recital discouraged the caller. Fixed instructions now ask about the item and wait; behavioral proof remains pending.
- The unshipped local `api/webhooks/telnyx-voice.js` creates an open support Case per call leg. A confirmed request then creates another Case, cluttering the support queue. Do not ship that model unchanged.
- The draft has no independent owner alert, useful terminal/request-outcome projection, or proven provider payload compatibility.
- Generic lifecycle events cannot establish that a caller explicitly declined. Label only what is known.
- Structured city was omitted in the first test even though present in the summary. Verify complete structured data on the next confirmed test.
- Raw transcript retention/redaction, owner access, monitoring hours and retention duration need documented operational choices. Do not email full transcripts or copy sensitive volunteered content into call history.

## 5. P2 Issues / Can Wait

New voices, AI Missions, full phone payments/bookings, automatic callbacks, advanced analytics, extra CRM integrations and multilingual automation can wait. First validate a short conversation, durable request, every-call visibility and owner follow-through.

## 6. Business Impact and Source of Truth

| Fact | Source of truth | Must not imply |
|---|---|---|
| Call observed/answered/ended | Verified provider event | Human answered, booking completed or caller consented |
| Request received | Successful durable Case | Appointment confirmed or payment changed |
| Callback permitted | Explicit caller consent | Marketing/SMS consent or automatic callback schedule |
| Booking/payment/payout state | Existing verified platform/Stripe workflows | Any state change from call completion |
| Owner email delivered | Provider delivery event | That the owner read it or acted |

The owner should see time, direction, Caller ID (unverified/withheld), lifecycle status, duration when available, request status/reference and what needs attention. A safe default for an ended call without a Case is **Ended - no confirmed request saved**. Use **Outcome unknown** or **Unavailable** when evidence or lookup fails; do not show false zeroes.

Every call should be visible, but every call event should not send another email. Use one deduplicated end-of-call alert or unreviewed indicator, with prominent failed-save/active-job attention. No automatic customer call/text should follow a "never mind" result. Owner alerts are notifications; durable call history is the operational record.

## 7. Recommended Fix Order

1. Keep the existing voice and working public forwarding. Short-turn and respectful stop rules are saved on the owner-test version.
2. Build independent, signed call-event ingestion and a separate owner Phone Calls inbox. Link to confirmed intake by trusted call reference; never generate a consented Case from lifecycle events.
3. Use provider-specific payload handling: TeXML form callbacks and Call Control JSON events are different contracts. Verify raw signatures before parsing and reject invalid/foreign events.
4. Add durable deduplication, out-of-order-safe projection, pagination and explicit data-unavailable warnings. Do not acknowledge a failed persistence attempt as accepted.
5. Add owner attention/notification behavior without treating notification delivery as call truth or triggering unsolicited follow-up.
6. Prove both public-forwarded and AI-test event coverage. Complete customer and Easer live saves, linked Cases and owner delivery.
7. Test transfer and independent outage recovery. Only then reconsider public AI-first routing.

## 8. Files / APIs Involved

Smallest proposed implementation, NOT built or deployed by this review:

- Adapt `api/webhooks/telnyx-voice.js` without importing unrelated local booking/payment work.
- New owner-authenticated `api/owner/voice-calls.js` and focused `owner/assets/voice-calls.js`.
- Minimal owner navigation/mount wiring in `owner/index.html`.
- Disabled-by-default environment documentation, focused webhook/history tests and activation runbook.

The existing `activity_logs` schema is a viable first-25-jobs event store: `api/migrations/004_observability.sql:9-18` has UUID primary keys, optional booking linkage, event types, metadata and timestamps, with service-role access at `:25-32`. Existing owner chat history provides a grouping precedent (`api/owner/site-chat.js:24-44`, `api/chat.js:197-211`). Use distinct voice event types, deterministic event IDs and the same hashed provider call reference used by intake. Confirm deployed schema/constraints before implementation. A dedicated call-reference index may eventually be useful; do not assume a new table/migration is required.

Telnyx supports an app status callback separate from its instruction URL. Never replace the TeXML voice URL with an event receiver. TeXML call status proves call existence even if no AI save tool runs. [Application configuration](https://developers.telnyx.com/api-reference/texml-applications/update-a-texml-application), [answered event](https://developers.telnyx.com/api-reference/callbacks/texml-call-answered), [completed event](https://developers.telnyx.com/api-reference/callbacks/texml-call-completed).

Verify Ed25519 signature/timestamp against exact raw bytes; TeXML form payloads must not be JSON-reserialized. Provider retries and event sequences require durable idempotency and out-of-order handling. [Webhook contract](https://developers.telnyx.com/docs/development/api-fundamentals/webhooks/receiving-webhooks).

Conversation-ended JSON events and AI Insights can enrich history, but must not be assumed to reach a TeXML form receiver or determine consent. [Conversation event](https://developers.telnyx.com/api-reference/callbacks/call-conversation-ended), [Insights](https://developers.telnyx.com/docs/inference/ai-insights/creating-insights).

TeXML Connect/AIAssistant action handling can distinguish AI errors from ordinary hangup/transfer, but any independent fallback requires separately tested routing. [Connect recovery](https://developers.telnyx.com/docs/voice/programmable-voice/texml-verbs/connect).

## 9. Test Plan

- Customer: immediate hangup, never mind, callback declined, outdoor enquiry without recital, mixed services, incomplete optional data, successful confirmation/save.
- Easer: abandoned start, no-email earnings question, active-job issue, safety interruption without payout/account changes.
- Owner: one call entry per logical caller session, no duplicate requests, correct Case link, unverified caller label, failed save/notification visible, no inferred consent.
- Security: invalid/stale/tampered signature, wrong connection/account, malformed/oversized input, unauthorized owner access, XSS, no secret/transcript retention.
- Reliability: concurrent duplicates, delayed answer after hangup, missing terminal event, persistence failure/retry, transfer child legs, paginated history, related lookup unavailable.
- Provider: real signed events for current forwarded inbound route and AI app; prompt rules, transfer and AI-outage behavior tested independently.
- Notification failure must not hide or undo the saved call/Case. No test may book, charge, refund, dispatch or pay an Easer.

## 10. Launch Recommendation

**No approval for public AI-first routing yet.** Keep current forwarding and do not represent the system as fully complete. The review is specific to phone-assistant readiness, not a fresh audit of the entire marketplace.

The next focused build should be Phone Calls visibility, not a new voice or more assistant features. Require every tested call to appear, a successful no-email Easer request and customer request to link to one Case each, correct owner notification evidence, and tested human/outage fallback. The new call-history code, provider activation and wider deployment scope require separate approval; none was performed during this board review.
