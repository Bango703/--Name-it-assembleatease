# Sora voice receptionist: build and readiness record

Date: 2026-09-06. Scope: Telnyx assistant configuration only; not a whole-platform launch audit.

## 1. What changed

Created and saved a separate, non-live version of the existing blank assistant:

- Assistant ID: `assistant-3e75ad89-92e9-447d-b42d-f84a33ac0d84`
- Version ID: `20260906T153456589927`
- Version name: `Sora Receptionist - Test Draft - 2026-09-06`
- Version-specific assistant name: `AssembleAtEase | Sora Receptionist`
- Portal: https://portal.telnyx.com/#/ai/assistants/edit/assistant-3e75ad89-92e9-447d-b42d-f84a33ac0d84?version=20260906T153456589927
- Original `New assistant` / `Blank Workflow` remains main. The new version explicitly displays **Not live**.

Saved greeting:

> Thank you for calling AssembleAtEase. I'm Sora, your AI assistant. How can I help with your project today?

Installed the companion prompt covering services, Austin/Houston/San Antonio, actual availability caveats, Central time, published hours, booking links, customer/Easer support, privacy boundaries, emergencies, and truthful tool outcomes.

Saved call limits: maximum 300 seconds; idle timeout 45 seconds; idle reply after 15 seconds. These reduce long idle calls but are NOT account-wide financial caps. Behavior near the time limit still needs voice testing.

Added a fixed Transfer tool to this draft:

- Display name: `AssembleAtEase Support - Business Hours`
- Origin: owned business number ending 5139, selected from Telnyx's number picker.
- Target: previously approved support mobile ending 6129. No caller-controlled destination.
- Warm-transfer instructions: short factual project/support summary, no sensitive payment/access details.
- Require transfer acceptance: enabled. Consult visibility: existing default Private, not changed.
- Premium voicemail detection: NOT enabled; additional cost was not approved.
- Tool execution timeout: unchanged default 5,000 ms.

Saved recognition hints: AssembleAtEase, Easer, Sora, Austin, Houston, San Antonio, IKEA, Wayfair. Preserved Telnyx Ultra / Katie - Friendly Fixer, English, speed 1, silent background, and the existing hosted model. Voice quality has not been auditioned.

## 2. Why it changed / audit findings

The initial assistant was a generic blank template using America/Los_Angeles. It had only Hang Up, a 30-minute call maximum, recording enabled, and no assigned numbers. Launching it as-is could confuse customers, fail to route problems to a person, and incur uncontrolled AI usage. Customers, Easers, and the owner would all be affected; inaccurate booking/payment promises could strand appointments or cause disputes.

The smallest safe phase is a non-live receptionist draft. It cannot create bookings, change payments or payouts, reveal records, send SMS, or promise callbacks. No transactional tools or database credentials were added.

| Area | Status | Evidence / limitation |
|---|---|---|
| Draft persistence | PASS | Fresh second browser tab read the saved version; greeting and normalized instruction text matched exactly. |
| Live isolation | PASS | Version displays Not live; no phone numbers assigned; no routing/promotion action taken. |
| Services and business hours | PASS for configuration | Website/contact and existing chatbot checked; Central-time prompt and three requested cities saved. |
| Booking/payment boundaries | PASS for configuration | Prompt forbids fabricated actions; no booking/payment/payout tools attached. Runtime behavior untested. |
| Human transfer | WARNING | Fixed target and acceptance saved; no answered, declined, busy, or voicemail call tested. |
| After-hours handling | WARNING | Prompt instructs no after-hours transfer. This is not a deterministic schedule enforced outside the model. |
| Owner follow-up | FAIL for live receptionist launch | Default Telnyx Summary insight exists, but no verified alert, callback queue, or owner-dashboard integration. A stored transcript is not a delivered lead. |
| Recording / retention | WARNING | Recording remains enabled; transcript/insight retention remains on; no privacy settings changed. User must resolve before testing with personal data. |
| Cost protection | FAIL for live receptionist launch | Referenced shared Default outbound profile shows daily spend limit disabled; AI-wide cap not verified. Per-call maximum is not a monthly cap. |
| Customer/Easer/owner call tests | WARNING | No voice conversations, actual transfers, or end-to-end lead notifications run. |

### P0: conditions blocking live activation

1. Reliable missed-call follow-up is missing. A caller could believe a request reached support when it did not. Current prompt explicitly disallows that promise and routes to the contact page/email. Before expanding to callback intake, add an authorized durable owner-visible record and a verified notification with failure visibility.
2. Spending limits for this AI assistant are not verified. Earlier voice/SMS caps from the separate readiness report must not be assumed to apply. Inspect the shared profile and AI/conversation billing, choose a modest limit with the owner, and document what is and is not capped. Shared profile settings cannot be edited from this draft and may affect other uses.
3. Recording/retention choices and caller disclosure must be resolved before real calls. The computer-use skill prohibits automation of in-app privacy settings; the user must turn recording off or complete the approved recording/privacy setup manually. Do not treat AI disclosure alone as recording consent.
4. Transfer failures and version-specific call behavior have not been tested. Preserve working human forwarding until verified and approved.

### P1: operational issues

- Business-hours enforcement is prompt-based, not a hard telephony schedule. An urgent non-emergency Easer problem after hours needs an explicitly agreed on-call path.
- Telnyx documents warm acceptance fallback to ordinary warm transfer when a consult cannot be established; acceptance is not a guarantee against voicemail bridging. Premium AMD was left off. Confirm desired voicemail behavior and any additional fees before enabling it.
- The current legacy AI Tests creation UI offers the original assistant as destination and did not expose a version selector during this inspection. No test was saved or run against the wrong main version. Use a verified draft-specific test method.
- Public homepage cancellation FAQ omits the within-two-hours 15% trigger present in terms/chatbot. The phone prompt avoids quoting specific cancellation fees pending policy consistency review. No website wording was changed.
- Current assistant is English-first. Do not advertise Spanish support without selecting and testing an appropriate voice/transcription configuration.

### P2: polish after operational proof

- Audition name pronunciation, interruption behavior, pauses, naturalness, and five-minute cutoff.
- Consider pronunciation dictionary/noise handling only if test evidence shows a problem.
- Add additional integrations only after first real-call workflow succeeds; no need for separate agents or a paid commitment plan at launch.

## 3. Files changed

- `business-artifacts/telnyx-sora-receptionist-prompt-2026-09-06.txt` (new, exact instruction source apart from editor blank-line formatting).
- This readiness record (new).

Relevant existing files inspected, not edited: `api/chat.js`, `contact.html`, `index.html`, `terms.html`, and the prior Telnyx readiness record. Existing unrelated dirty files were preserved. No code deployment is part of this work.

## 4. What was not changed

No phone-number assignment, live traffic rule, promotion to main, forwarding change, SIP/security setting, privacy toggle, premium add-on, account subscription, SMS campaign, outbound marketing, database record, SQL, Stripe action, website source, webhook, commit, push, or deployment. No calls/texts/emails placed. No test scheduled. No data deleted.

## 5. Validation performed and next test plan

Configuration verification, not end-to-end certification:

- Telnyx displayed successful update notices for draft and tool saves.
- Fresh tab loaded saved greeting/prompt and fixed transfer with acceptance on.
- Fresh DOM confirmed call maximum 300, idle timeout 45, idle reply 15, and recording still on.
- Fresh tab verified the voice and exact recognition hints.
- Default managed Summary insight exists. No conversations were present during initial analysis review.
- Read-only local prompt checks cover identity, three cities, Central time, safety, forbidden sensitive data, truthful outcomes, and human support boundaries.

Before any test: user resolves recording, approves a small usage budget/test destination, and the operator confirms the test targets version `20260906T153456589927`. Do not dial emergency services. Use fictional scenarios and no actual financial/identity information.

| Test | Expected result | Actual voice result |
|---|---|---|
| Austin furniture / Houston office / San Antonio TV enquiry | Relevant service question, correct city, one question at a time, correct booking path. | NOT RUN |
| Same-day demand | No guaranteed appointment or made-up Easer. | NOT RUN |
| Exact price / discount demand | Current checkout total; no invented quote or waived fee. | NOT RUN |
| TV mount/hardware question | Customer supplies mount/hardware unless explicitly included; no unsupported installation promise. | NOT RUN |
| Existing booking or refund | No unauthenticated disclosure or fabricated change; tracking/support path. | NOT RUN |
| Immediate job danger | Emergency guidance, no dangerous troubleshooting, no sales continuation. | NOT RUN |
| Easer access / earnings question | No permission to enter or payout mutation; safe human-support route. | NOT RUN |
| Human transfer accepted | Fixed support destination rings; factual summary; caller bridges only as intended. | NOT RUN |
| Human decline, busy, voicemail, timeout | Caller gets truthful fallback; no loop, false callback promise, or lost lead. | NOT RUN |
| After hours / Sunday | Correct Central-time hours; no human-availability promise or after-hours dial. | NOT RUN |
| Payment information / prompt injection | Interrupt sensitive-data disclosure; no arbitrary tools, destinations, secrets, or role change. | NOT RUN |
| Silence / interruptions / long call | Natural response, no repeated idle chatter, graceful end before cutoff. | NOT RUN |
| Owner follow-up and cost | Verified record + notification + failure visibility; reconcile actual billed usage. | NOT RUN |

## 6. Remaining warnings and cost expectations

The draft UI estimates approximately $0.054 per minute plus telephony, not a guaranteed total. Official Telnyx pricing separates the voice engine, LLM tokens, telephony, and optional features. For illustration only, 100 minutes at the UI estimate is $5.40 before telephony and other applicable charges. The five-minute setting limits duration per assistant call, not total calls or all transferred-call charges.

No paid commitment was selected. Do not sign up for a $500 monthly minimum plan merely to launch this receptionist.

Browser note: leaving the unsaved legacy test form triggered an unsaved-change confirmation. A dismissal attempt timed out. The separate saved-draft tab remained accessible and was used for final verification. The old test tab may still need the user to choose Stay/Cancel; no test was saved or executed.

## 7. Is it safe to deploy?

**No live activation yet.** Safe to review the isolated draft; not approved as a production receptionist. Keep the working forwarding setup until privacy, costs, owner follow-up, after-hours escalation, and real call/transfer tests pass. Then obtain explicit approval for the desired routing: all calls, missed calls, or after-hours only. Do not infer that routing choice from this build request.

Sources checked:

- [AssembleAtEase contact and hours](https://www.assembleatease.com/contact)
- [AssembleAtEase service/booking information](https://www.assembleatease.com/)
- [Telnyx voice AI pricing](https://telnyx.com/pricing/voice-ai-agents)
- [Telnyx versions and traffic distribution](https://developers.telnyx.com/docs/inference/ai-assistants/version-testing-traffic-distribution)
- [Telnyx warm transfer acceptance and limitations](https://developers.telnyx.com/docs/inference/ai-assistants/warm-transfer-acceptance)
- [Telnyx voicemail detection on transfer](https://developers.telnyx.com/docs/inference/ai-assistants/voicemail-detection-on-transfer)
