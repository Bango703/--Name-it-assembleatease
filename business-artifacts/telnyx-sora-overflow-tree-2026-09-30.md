# Sora High-Volume and No-Answer Overflow

Status: LOCAL RUNTIME IMPLEMENTATION + 45 OFFLINE ASSERTIONS PASS. NOT DEPLOYED, CONNECTED, OR ENABLED. No live number, assistant, version, recording, or routing settings were changed.

## Current Live Findings

Read-only inspection of the Telnyx portal on 2026-09-30 found:

- Public number `+1-979-232-5139` is active and associated with `AssembleAtEase | Sora Receptionist` (`assistant-3e75ad89-92e9-447d-b42d-f84a33ac0d84`).
- Number-level call forwarding is enabled as **Always** to `+1-737-290-6129`. Telnyx documents that Always bypasses the assigned SIP connection/application and immediately forwards every inbound call.
- Number-level inbound recording is unchecked. This alone does not establish that assistant-level recording or transcripts are disabled. A prior September 6 call used the wrong assistant version and produced a recording despite the draft's recording-off setting; do not claim calls are unrecorded until that mismatch is resolved and retested.
- The Sora **Main** version is named `Live - Confirmed intake save guard`. Traffic Distribution showed no target rules and a default to Main. The assistant workflow reported 3 nodes and 4 edges: role triage, customer intake, and service-pro intake, with role-switch edges. There is no separate overflow node in the visible graph.
- The My Numbers list displayed a stale/conflicting `Call Forwarding disabled` badge while the detailed Voice settings showed forwarding enabled. Treat the detailed setting as current until Telnyx support resolves the list discrepancy.
- The workflow editor subsequently failed to render its canvas and its Add Node control would not stabilize. Telnyx API requests for assistant canary-deploy metadata intermittently returned 404/500. No changes were saved.

## Proposed Call Tree

```text
Inbound call to +1-979-232-5139
  -> Dedicated Call Control entry answers/retains the caller leg
  -> Attempt one transfer to the fixed human destination
       -> Human answers: bridge the call; do not start Sora
       -> Busy, rejected, or bounded no-answer timeout:
            keep the original caller leg active
            start the configured Sora assistant on that leg
            inject overflow_route=true
            play the one-call overflow greeting
            continue through the existing Sora role/intake workflow
                 -> Customer request intake
                 -> Service Pro support intake
                 -> Explicit readback + callback consent before save
       -> Transfer/API failure that cannot be recovered:
            play a truthful contact-page fallback, then end the call
```

The call-control application must preserve the caller leg when the transfer leg fails. It must handle Telnyx's transfer-leg webhooks idempotently; a timeout or hangup from the human leg must not end the original caller leg before Sora starts. Do not use number-level **On-failure** as a substitute for this flow: Telnyx says On-failure handles unreachable/rejected endpoints, not a call that successfully rings without answer.

## Overflow Prompt Copy

The code sends this as the Sora greeting only on the failed-transfer path:

> "Sorry, we can't connect you with a team member right now. I'm Sora, AssembleAtEase's virtual assistant. I can help take the details of your request."

Use this only on the `overflow_route=true` path. Do not say call volume is unusually high unless the system actually measures that condition. The existing Sora workflow then handles customer/Easer triage. It must still obtain explicit readback confirmation and callback consent before saving; a Case is a request, not a booking or promised callback time.

## Implementation Shape

The current number-level forwarding control cannot provide a human-first ring timeout into Sora. The local runtime path is implemented in `api/_telnyx-overflow.js` and `api/webhooks/telnyx-overflow.js`; the focused test is `scripts/test-telnyx-overflow.mjs` and the command is `npm run test:telnyx-overflow`. All 45 mocked assertions pass. The route is default-off. Implement/configure a dedicated Call Control voice application as the number's primary route only after the release and activation gates below. The handler:

1. Answer the original caller leg and place one bounded transfer attempt to the fixed human destination.
2. On human answer, bridge and stop the overflow branch.
3. On a confirmed unanswered failure (`timeout`, `user_busy`, or `user_rejected` with no answer timestamp), preserve the original caller leg and start the configured Sora assistant with `overflow_route=true` in its dynamic variables.
4. Starts the assistant without recording options. The feature gate also requires both `TELNYX_OVERFLOW_ASSISTANT_VERSION_CONFIRMED=true` and `TELNYX_OVERFLOW_RECORDING_OFF_CONFIRMED=true`; these are activation attestations, not technical overrides. Verify the selected assistant/Main version and actual recording events on bounded calls. Do not treat the number-level recording toggle as proof that assistant recording is off.
5. Runs Telnyx AMD on the human transfer. A confirmed `result=machine` hangs up only the destination leg with `park_after_unbridge=self`; the resulting signed event starts Sora on the parked caller leg. `human` and `not_sure` results do not start Sora.
6. Uses stable Telnyx command IDs for retries. Signed transfer-leg state ties a failed human leg to the original caller leg; unknown causes fail closed.
7. If Sora start is definitively rejected, plays a short contact-page fallback and hangs up after playback. Ambiguous/network failures return a retryable error with the same command ID.
8. Keeps public routing unchanged until the candidate path passes the acceptance tests below and the owner explicitly approves activation.

This implementation does not modify or save a new Telnyx assistant workflow version. The existing three-node/four-edge Sora workflow remains authoritative for role triage and consent-gated customer/Easer intake. `overflow_route` is injected for observability/context; the per-call greeting is the deterministic overflow announcement. The API key, number route, Call Control Application, assistant recording behavior, and live version are not configured by this code.

## Required Acceptance Tests Before Activation

- Normal inbound path does not speak the overflow apology.
- Human answer bridges correctly and starts no Sora conversation.
- Human busy, explicit reject, and no-answer timeout each keep the caller connected and start the intended assistant/version once.
- Verify live AMD ordering, actual machine/human/not-sure results, parked caller-leg behavior, and iOS call-screening behavior. Offline tests cover confirmed `machine`; AMD false classifications and `not_sure` deliberately do not trigger Sora.
- A confirmed voicemail pickup is detected, only the transfer leg is ended, and Sora starts on the parked caller leg. Test AMD ordering and iOS screening; a `not_sure` result intentionally leaves the call with the human destination.
- Sora's overflow greeting is spoken once, then the existing customer/Easer intake continues. Its existing readback and explicit callback-consent requirements remain mandatory; no Case is created without them.
- Tool timeout, rejected request, rate limit, Telnyx webhook/API failure, and caller hangup never produce a false "request saved" confirmation or a duplicate Case.
- Verify actual `assistant_version_id`, recording state/events, tool calls, Case persistence, owner email provider delivery, and call cost on bounded test calls.
- Keep full booking, payment collection, dispatch, cancellation, refund, and payout actions unavailable to Sora.
- Confirm rollback restores the prior working number route and Always-forward state exactly, without deleting call history.

## Verified Telnyx References

- [Call Forwarding](https://support.telnyx.com/en/articles/1130657-call-forwarding): Always bypasses the primary SIP connection; On-failure does not fire for a call that merely rings without answer.
- [My Numbers Page](https://support.telnyx.com/en/articles/4349113-my-numbers-page): number-level forwarding modes and inbound recording settings.
- [Start AI Assistant](https://developers.telnyx.com/api-reference/call-commands/start-ai-assistant): starts an assistant on an active Call Control leg and accepts dynamic variables.
- [Transfer Call](https://developers.telnyx.com/api-reference/call-commands/transfer-call): failed transfer webhooks leave the original call active for another command.
- [Answering Machine Detection](https://developers.telnyx.com/docs/voice/programmable-voice/answering-machine-detection): transfer-leg human/machine result webhooks and supported AMD modes.
- [Conversation Workflows](https://developers.telnyx.com/docs/inference/ai-assistants/workflows): deterministic speak nodes, workflow branches, and dynamic-variable comparisons.
- [Dynamic Variables](https://developers.telnyx.com/docs/inference/ai-assistants/dynamic-variables): runtime injection and variable behavior.
