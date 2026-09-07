# Sora-first reception: approved live activation

## 1. What changed

The owner explicitly approved activating the prepared Sora receptionist, replacing Always Forward with Sora-first reception, keeping 737-290-6129 for human handoff, and fixing the call-direction display.

- Promoted assistant version `20260906T153456589927` to main for `assistant-3e75ad89-92e9-447d-b42d-f84a33ac0d84`. The previous default was `Blank Workflow`. The prepared three-node customer/Easer workflow is now the default, not just an owner-only canary. Promotion clears the old canary routing configuration; it does not delete conversations or customer records.
- Replaced the confusing old Owner Test release label with **Live - Customer and Easer Reception**, creating final main version **`20260907T171337630472`**. Compared all behavior fields before/after this label-only update: no differences in prompt, greeting, tools, workflow, voice, model, transcription, interruption, telephony, privacy or post-conversation settings. The original prepared version remains available.
- At **2026-09-07 17:08:47 UTC / 12:08:47 PM Central**, disabled Always Forward on business number **979-232-5139**, then assigned the number to TeXML application `3043075771762476974`.
- Readback confirms forwarding disabled and the Sora application assigned. The old forwarding destination remains stored but inactive. The warm-transfer destination remains **737-290-6129**.
- Prepared a two-file direction projection correction in an isolated clean worktree; local commit `4b3159b4`, branch `fix/sora-live-routing-direction-20260907`. The owner then explicitly authorized **PUSH DEPLOY**. [PR #145](https://github.com/Bango703/--Name-it-assembleatease/pull/145) passed required checks and preview deployment, and merged at **2026-09-07 19:21:50 UTC / 2:21:50 PM Central**, merge commit `313556ff818cb0ac9bb1068a4e594e6ab5d53a85`. Production verification follows below.
- Production deployment **`dpl_2qVmKBEyahvQ3fMTR8nZBo5GmPDi`** is **READY** for both `www.assembleatease.com` and `assembleatease.com`. At **19:24:53 UTC / 2:24:53 PM Central**, the production owner API confirmed all five previously unknown public calls now display as inbound. Their event revisions and terminal statuses were unchanged. The browser screen independently showed the corrected labels.

## 2. Why it changed / business risks

| Priority | Problem | Business impact | Smallest correction |
| --- | --- | --- | --- |
| P0 | Always Forward bypassed Sora. | Customers and Easers could hear an unavailable-party announcement instead of giving a request, losing leads or access to help. | Route the public number to the verified receptionist, retaining a fixed human handoff. |
| P0 | Default assistant was a generic Blank Workflow. | Simply switching the number could expose callers to an assistant without intake or transfer tools. | Audit and promote the existing prepared business version before switching the number. |
| P1 | Later callbacks omit direction and hide the earlier inbound value. | Owner sees `unknown` for proven incoming calls. | Preserve the latest known inbound/outbound direction in the projection; never rewrite historical events. |

No pricing, customer charges, Easer earnings, payouts, booking status or dispatch logic is changed. Intake remains unverified caller information, not identity verification or authority to change accounts. Payment/card collection and full phone booking remain paused. The assistant cannot dispatch emergency services. These limits avoid wrong payments/payouts, stranded confirmed bookings and misleading customer promises.

## 3. Active answering process

1. Sora greets the caller and asks customer or service pro. If the purpose is already clear, it should not repeat the menu.
2. The selected role gets its own workflow. Short questions, one at a time; no unsolicited service catalog recital.
3. Customer service/quote requests can include items, quantities, city, address if offered, requested time, product readiness and site notes. Easer requests capture the actual account/job/earnings issue without a customer booking interview.
4. Before saving, Sora reads back details and asks permission for a callback. A successful save creates one Case and attempts an owner email; no booking, payment or account action is completed.
5. Human transfer checks current Central support hours and caller permission. The fixed destination requires warm-transfer acceptance. Premium voicemail detection stops the transfer and returns to Sora when voicemail is detected.
6. If transfer is busy, unanswered, declined or fails and control returns to Sora, the configured prompt says it cannot connect the caller and offers to take a callback request. It does not invent a busy queue, wait time or guaranteed callback deadline. An already-saved request is not duplicated.
7. Outside human support hours, Sora offers intake instead of a transfer. Current human-support schedule is Monday-Friday 7 AM-5 PM, Saturday 7 AM-1 PM, Sunday closed. These are not appointment/service hours.
8. A clear "never mind" ends intake without a forced callback request. Independent call history remains separate from Cases.

## 4. Exact files and configuration

Local code changes only:

- `api/_voice-call-history.js`
- `scripts/test-owner-voice-calls.mjs`

Isolated worktree: `C:/Users/tgbiz/AppData/Local/Temp/aae-owner-call-history-20260906`.

This report is an additional local handoff artifact in the original workspace, not a production runtime file. The original workspace contains unrelated dirty files; none were staged, overwritten or deployed.

Live API changes:

- `POST /v2/ai/assistants/{assistant_id}/versions/{version_id}/promote`
- `POST /v2/ai/assistants/{assistant_id}`: only `version_name` plus explicit promotion, for the final live release label
- `PATCH /v2/phone_numbers/3036021714547901509/voice`: only `call_forwarding.call_forwarding_enabled=false`
- `PATCH /v2/phone_numbers/3036021714547901509`: only `connection_id=3043075771762476974`

Readback changed only the intended route/forwarding fields and their update timestamp. Existing voice-event receiver remains configured on the TeXML app.

## 5. What was not changed

- Sora's exact voice settings, model, transcription and interruption settings.
- The prepared prompt, workflow edges, node tool scopes and transfer configuration; promotion activated the audited saved configuration unchanged.
- Recording remains disabled. This is not a promise of no transcripts/log retention: provider data retention remains enabled and no new privacy setting was changed.
- The existing 300-second assistant limit, 45-second idle timeout and 15-second idle check-in remain in place.
- Phone number, messaging configuration, CNAM, SIP credentials, account spending settings, API keys, authentication and permission boundaries.
- Pricing, taxes, Stripe, payments, payouts, refunds, bookings, dispatch, customer/Easer account records or database schema.

No existing record was deleted. Two clearly labeled internal test Cases and their owner notifications were created for verification; they do not represent real customers or Easers.

## 6. Validation performed

| Check | Result |
| --- | --- |
| Main assistant name/version, full prompt, workflow and tools match audited saved Sora | PASS |
| Voice settings unchanged on promotion | PASS |
| TeXML telephone entry point returns valid assistant document | PASS |
| Provider tool authentication and `get_support_options` | PASS: HTTP 200, requests enabled, Central hours and role topics returned |
| Customer structured new-service tool test | PASS: HTTP 200, one durable Case, structured desk item preserved, null email accepted |
| Easer earnings tool test | PASS: HTTP 200, one durable Case, correct service-pro path, no job/account mutation |
| Owner customer email delivery | PASS: delivered at 17:07:41.819 UTC |
| Owner Easer email delivery | PASS: delivered at 17:07:43.457 UTC |
| Live identical-request retry | PASS: same Case reference, still two total test Cases and two owner notifications |
| Live missing-confirmation/consent rejection | PASS: HTTP 400; no success claim |
| Number assigned to Sora / Always Forward disabled | PASS by independent API readback |
| Direction regression | PASS: regression first failed against old code, then 184 checks passed with correction |
| Real historical event projection | PASS: all five observed public calls project as inbound using unchanged saved events; no database writes |
| Sora intake regression | PASS: 479 checks, including 18 role/topic workflows and privacy/security/outage cases |
| Syntax / whitespace / isolated scope | PASS |
| Actual owner dashboard Case layout | PASS: customer and Easer request details visibly grouped into readable sections; both show DELIVERED owner notification |
| Actual incoming greeting after routing switch | Pending user test |
| Real human-transfer answer, decline, timeout and voicemail return | Pending scenario tests; configuration alone is not proof |
| Direction correction deployed | PASS: PR #145 merged; Vercel production READY on both public domains |
| Live historical call correction | PASS: all five previously unknown calls are inbound; all six predeployment call revisions unchanged; five corrected calls retain their terminal status |
| Live Phone Calls screen | PASS: computer-use inspection showed corrected inbound list labels and detail, with the existing timeline preserved |
| Newly received inbound call visibility | PASS for the received TeXML completed callback: one additional inbound call, provider-reported duration 207 seconds; no linked confirmed request at inspection |
| Production public site health | PASS: both public domains resolve successfully with HTTP 200; apex redirects to www |
| Production authentication boundaries | PASS: unauthenticated owner call history and unsigned voice webhook both return HTTP 401 |
| Merged-commit Platform Guards | PASS: lint, API/dashboard syntax, source-of-truth audit, drift checks, phone/intake safety and regression suite |

Internal tool-test Cases:

- Customer: `AAE-AI-MTRHUH1U-1970E3CC`
- Easer: `AAE-AI-MTRHUIGW-8C40E437`

Both use synthetic, clearly labeled integration-test content and the owner's approved callback number. Tool-test confirmation flags are test inputs, not evidence of a spoken customer consent event. No SMS, external customer contact, booking, charge or payout was generated. Do not dispatch or contact anyone from these tests.

## 7. Remaining warnings / launch decision

Sora-first routing is saved live, and both roles' provider-to-platform intake/owner-email paths passed. This is not yet full spoken end-to-end certification. The owner was asked to call the public number from another phone, request a person and leave the destination unanswered to verify Sora's return and callback offer.

The assistant's initial TeXML primary and fallback URLs still point to the same provider assistant endpoint; there is no independent AI-platform outage fallback in this release. Human transfer hours are enforced by prompt/tool guidance, not a new deterministic telephony permission gate. No automatic historical backfill or independent outage monitor was added. Do not market guaranteed live answering or callback timing.

Deployment verification observed a new inbound TeXML completed callback at 19:22:51.209 UTC with a provider-reported 207-second duration. It had no linked confirmed Case at inspection. This proves the received callback reached owner call history, not what Sora said, whether transfer returned properly, or whether the caller gave confirmed booking details. It is not evidence that every call-start or transfer-leg event is captured. Spoken greeting, confirmed conversational intake and unanswered-transfer behavior still require a real end-to-end test.

The successful GitHub run emitted a nonblocking warning about `actions/checkout@v4` and `actions/setup-node@v4` being moved from the deprecated Node 20 action runtime to Node 24. CI modernization was not included in this two-file release.

## 8. Recovery

If the new inbound route fails, restore number connection `3040104147199198769`, then re-enable its saved Always Forward destination `+17372906129` as a temporary owner-line fallback. This fallback can still reach the owner's unavailable-party announcement, as previously observed; it is not equivalent to verified Sora service. Do not restore the generic blank assistant as the public receptionist, and do not delete call history or test Cases.

Sources checked: [official assistant version API](https://github.com/team-telnyx/telnyx-node/blob/master/src/resources/ai/assistants/versions.ts), [official webhook-tool test API](https://github.com/team-telnyx/telnyx-node/blob/master/src/resources/ai/assistants/tools.ts), [Telnyx transfer voicemail detection](https://developers.telnyx.com/docs/inference/ai-assistants/voicemail-detection-on-transfer), [number configuration API](https://github.com/team-telnyx/telnyx-node/blob/master/src/resources/phone-numbers/phone-numbers.ts).

## 9. Push/deploy receipt

- Approval: the owner's explicit **PUSH DEPLOY** request.
- Approved change commit: `4b3159b4ba98e6b1b2bf08788d33af9099956f18`.
- Merged production commit: `313556ff818cb0ac9bb1068a4e594e6ab5d53a85`.
- [Merged PR #145](https://github.com/Bango703/--Name-it-assembleatease/pull/145).
- [Production deployment](https://vercel.com/bango703s-projects/name-it-assembleatease/2qVmKBEyahvQ3fMTR8nZBo5GmPDi): READY, both public domains assigned; inspection of the www domain resolves to this deployment.
- [Merged-commit Platform Guards](https://github.com/Bango703/--Name-it-assembleatease/actions/runs/34155291857): success.
- Reran 184 phone-history checks and 479 Sora-intake checks before pushing; syntax and diff checks passed. The integration tests used fake data and made no live calls or requests.
- Production API at 19:24:53 UTC: HTTP 200, history enabled, seven call legs (six inbound, one outbound); all five prior unknown directions corrected. No event backfill or database mutation was needed.
- No Telnyx configuration, environment, pricing, payment, payout, booking or dispatch changes in this push. Read-only provider checks confirmed the Sora route, forwarding disabled and live version `20260907T171337630472` remain intact.
- Original dirty workspace preserved. Only the two approved files entered the PR. This report remains a local handoff artifact, not a deployed runtime file.
- Deployment recommendation: this narrowly scoped display correction is safely deployed and verified. Full voice-workflow certification remains pending the scenario tests above.
