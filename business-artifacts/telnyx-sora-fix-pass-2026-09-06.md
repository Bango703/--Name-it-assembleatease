# Sora fixing pass: protected booking, Pro readiness and owner visibility

Status: LOCAL CHANGES. NOT PUSHED, DEPLOYED OR ENABLED. Public transactional assistant is NOT launch-approved.

## 1. What changed

- The booking server rejects any instant-price request containing catalog-defined quote-only work with `CUSTOM_QUOTE_REQUIRED`, before database access, promotions, rewards or Stripe calls. Customer-selected prices/flags cannot turn a quote item into free work. The existing website already selects quote mode for these carts; an explicit full quote request remains supported.
- Connect-mode job readiness now requires verified complete Connect/payout readiness, no blocking requirements and no disabled reason. Manual-payout readiness remains independent of Connect. This changes eligibility only when Connect is enabled; it never changes historical payouts, earnings, approval records or the live feature flag.
- Website chat distinguishes Mon-Fri 7-5 / Sat 7-1 Central human support from daily 8-8 appointment options. No guaranteed staffing based on a selected slot.
- A default-off read-only `prepare_booking` action accepts confirmed canonical items/quantities and prepares a selection link for the existing booking page. It preserves separate service categories and forces quote mode for custom items. The browser derives current prices/flags from its catalog; final server pricing remains authoritative. Existing carts and payment-return URLs are not overwritten.
- The selection fragment contains no name, phone, address, email, card, login token or booking reference. It is not an authentication credential or price guarantee. The link is not automatically sent; consented delivery and caller-session continuity are still unimplemented. Customer contact details, schedule, terms and payment must still be completed in the existing website flow.
- A default-off voice webhook validates Ed25519 signatures against the exact raw request, bounds size/timestamp, and restricts events to one configured connection. Minimal initiated/answered/hangup/conversation-ended events become owner Cases timeline entries. Cases are keyed by the same call hash used for intake; event IDs are deterministic for retries. Failed persistence returns 503 instead of acknowledging a lost event. No transcripts, recordings, DTMF, raw client_state, payment data or arbitrary payload fields are stored.
- Owner Cases explicitly warns when a Sora request has no logged notification, failed/delayed delivery, unconfirmed delivery, or unavailable notification history. Detail view links the corresponding call log and confirmed Customer/Pro cases, without inventing a customer identity or another booking-status source.
- Added a network-denying regression preload and a local UI-only preview. The preview binds only to 127.0.0.1, serves an allowlist of public static assets, and blocks API/Stripe connections, payment frames and form submissions. This is NOT a financial sandbox.

## 2. Why it changed / risk

| Issue | Priority | Customer / Easer / owner impact |
|---|---|---|
| Quote-only line accompanying priced work | P0 | Potential underpriced scope and confusing charge; server must reject instant-price mode for the full selection. |
| Connect readiness policy conflict | P0 in Connect mode | New jobs could be accepted before payout prerequisites; manual launch must stay unaffected. |
| Lost or interrupted calls | P0 for public AI launch | Owner can miss a lead or problem; store events without fabricating consent or booking completion. |
| Saved case with absent/failed email | P1 / potentially P0 operationally | A successful save must not be hidden by a failed notification. Owner needs an actionable warning. |
| Re-entering or misclassifying service selections | P1 | Customers can abandon booking or select the wrong service; preserve catalog choices for review. |
| Incorrect Sunday/support hours | P1 | Lost booking opportunities and inaccurate availability claims. |

Financial prices, taxes, fee percentages, capture timing, cancellation rules, refunds and payout calculations were not changed. The quote-mode enforcement and Connect eligibility correction are intentional business safeguards, not incidental refactoring.

## 3. Exact runtime release files

This includes the previously prepared Pro-intake dependencies. Deploying the receptionist alone will omit required imports.

1. `api/_ai-intake-validation.js`
2. `api/ai/_pro-support-intake.js`
3. `api/ai/_booking-continuation.js`
4. `api/ai/receptionist.js`
5. `api/_easer-readiness.js`
6. `api/booking.js`
7. `api/chat.js`
8. `api/webhooks/telnyx-voice.js`
9. `api/owner/cases.js`
10. `assets/js/voice-booking-selection.js`
11. `owner/assets/cases.js`
12. `book.html`

Related tooling / tests:

- `eslint.config.js`: classify the one shared browser/server validator as an ES module; no rule disabled.
- `package.json`: add `npm run test:sora` with network-blocking preload.
- `scripts/test-ai-receptionist.mjs`: previous customer/Pro regression coverage.
- `scripts/test-operations-truth.mjs` and `scripts/launch-regression.mjs`: update the prior conflicting Connect expectation to the supplied master policy.
- `scripts/test-sora-launch-guards.mjs`: all-item handoff, tampering, quote guard, readiness, caller boundaries, webhook signature/retry/outage and owner-warning tests.
- `scripts/sora-offline-test-preload.mjs`: block real fetch, WebSocket and Node HTTP/TCP/TLS transports for local regressions.
- `scripts/serve-sora-ui-check.mjs`: opt-in local static UI preview; never a production server or payment sandbox.

Retain the prior prompt/graph artifacts as test evidence:

- `business-artifacts/telnyx-sora-receptionist-prompt-2026-09-06.txt`
- `business-artifacts/telnyx-sora-two-path-workflow-2026-09-06.json`

Updated acceptance documentation: this report, the implementation board, the two-sided audit and the Pro connection checklist.

## 4. What was not changed

- No production deployment, git push/commit, Telnyx configuration change, new phone call, message, email, provider purchase or test financial transaction.
- No database schema change, customer/Easer/booking update or deletion.
- Public forwarding, owner-only test routing, five existing Telnyx tools, recording settings, main assistant, manual-payout mode and all existing credentials stay unchanged.
- No secret files copied into the clean test workspace.
- Unrelated root changes preserved: SMS/webhook edits, Ads/cookie consent, `.env.example`, `vercel.json`, SEO, mock pages, backlog and other user artifacts. In particular, `_mobileframe.html` was not removed or edited to make tests pass.

## 5. Validation

- `npm run test:sora`: PASS locally. Both suites explicitly block real network calls.
- Handoff: every one of the 201 catalog items round-trips through the actual shared validator and browser-state applicator. Multi-service and mixed-quote selection, duplicate/unknown items, invalid quantities, injected price/PII/credential fields, changed catalog price, existing-cart preservation and default-off/unauthorized requests tested.
- Booking guard: actual handler validation prefix executes against the real pricing function with no database or Stripe available. Mixed and quote-only requests reject false/missing/string quote flags; an explicit quote request proceeds past the guard. This is a bounded handler test, not a financial transaction.
- Easer: manual mode remains ready for a fully eligible fixture; Connect incomplete/unverified/disabled/requirements-due/provider-outage fixtures fail closed. Public readiness copy does not expose internal Stripe reasons. Complete Connect fixture remains eligible.
- Owner: durable case fixtures, signature and connection scope, stale timestamp, oversized body, bad JSON, missing fields, concurrent retries, out-of-order events and database failures tested. Missing/failed/unconfirmed/delivered notification presentation and exact same-call reference derivation tested.
- Edge: saved Telnyx three-node test graph inspected without modifications. Local booking UI visibly loads an accent chair under Furniture Assembly and treadmill under Fitness Equipment, one of each; switching to Fitness retains both category selections. The UI clearly states nothing is booked yet. No live checkout or consent form submitted.
- Root `npm run test:launch`: blocked by the unrelated `_mobileframe.html` draft missing metadata. This was not caused by the Sora fixes and was not hidden or deleted.
- Clean worktree: `C:/Users/tgbiz/AppData/Local/Temp/aae-sora-safe-check-8d50489c`, based on production commit `4c59619012196cca71cc18528f8420c75088faa8`, with only the exact Sora scope overlaid. First complete `npm run test:launch` passed with network-blocking preload; 777 inline script blocks across 427 pages parse. Existing non-blocking lint/color warnings remain.
- Final verification after same-call links: PASS. Clean-copy `npm run test:sora` and the full `npm run test:launch` both completed successfully with the network-blocking preload. Root `git diff --check` also passed. Two intentional failure-fixture warnings in the Sora tests are not live notification errors. Existing non-blocking lint/color warnings remain unchanged.

## 6. Remaining warnings and required acceptance

1. Direct voice booking/quote creation, identity-verified customer/Pro account operations, voice-originated completed job and financial end-to-end proof remain incomplete. Role choice/caller ID is not authentication; no such privileged tools were exposed.
2. No approved Telnyx payment processor connector is configured. Telephone-only card entry cannot be enabled safely without confirmed processor compatibility, required compliance scope and isolated testing. No raw-card proxy or payment shortcut was built.
3. A real Stripe test environment plus isolated database and non-customer notification destinations is still required. The network-blocked UI/regressions do not provide that integration environment.
4. `prepare_booking` is currently selection-only, not a resumable personal-data session or delivered payment link. Consent, opted-out numbers, delivery/retry failure, privacy and proper phone-to-web confirmation still need an implemented delivery/session adapter and acceptance tests.
5. Voice webhook is implemented but not connected or activated. It covers only events Telnyx delivers to the configured connection, not historical or missing-provider-event recovery. Provider API reconciliation, a durable notification outbox, automatic alert retry, after-hours/on-call handling and AI-specific spending controls remain open.
6. Call log Cases require owner review/closure. A signed answered/hangup event is not proof of successful booking, voicemail delivery, callback consent, or a human response. Keep urgent safety escalation separate from normal follow-up.
7. A clean scoped deployment needs explicit approval. Do not deploy the dirty root or automatically publish the test assistant. The earlier three-file Pro-only deployment checklist is superseded by the 12-runtime-file manifest above.

## 7. Release recommendation

Final verification is complete. This is a candidate for a scoped code-only release with all NEW integrations disabled, subject to explicit push/deploy approval. It is not approval to market or route public traffic to a fully transactional AI assistant.

Leave these new flags unset/false until each activation is approved and tested:

- `TELNYX_AI_PRO_SUPPORT_ENABLED`
- `TELNYX_AI_BOOKING_HANDOFF_ENABLED`
- `TELNYX_AI_VOICE_EVENTS_ENABLED`

Voice webhook activation additionally requires the verified `TELNYX_AI_VOICE_CONNECTION_ID` and existing `TELNYX_PUBLIC_KEY`. Configure only the correct assistant connection endpoint, not an unrelated SMS webhook. The new handler does not process SMS events.

No new tool should be attached to Telnyx before its deployed endpoint, authentication and feature gate are verified. Do not update the prompt to promise link delivery, account access, payments or saved bookings while those capabilities remain absent.

Provider event semantics used for the receiver: [Telnyx Voice API webhooks](https://developers.telnyx.com/docs/voice/programmable-voice/voice-api-webhooks), [call hangup](https://developers.telnyx.com/api-reference/callbacks/call-hangup). Provider documentation is not evidence that our live webhook is connected.
