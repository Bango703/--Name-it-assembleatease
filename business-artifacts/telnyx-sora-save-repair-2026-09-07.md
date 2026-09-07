# Sora confirmed-request save repair — September 7, 2026

## 1. What changed

The owner explicitly requested FIX IT after a real test call collected and confirmed service details but created no Case.

- Live Sora version is now `20260907T194813414905`, labeled **Live - Confirmed intake save guard**.
- The existing authenticated `save_support_request` tool is available in all three prompt nodes. Confirmed intake no longer depends on a successful role-node transition.
- The existing customer/Easer interviews, role-specific restrictions and four routing edges remain. The receptionist can complete the correct role's intake if the node does not change.
- The prompt explicitly requires a real tool call, `success=true` plus a nonempty returned reference, and a separate caller response after readback. It prohibits inventing the caller's reply or announcing a save without a receipt.
- The prompt specifies top-level city placement and a bounded correction of schema-placement errors without changing confirmed facts.
- Recovered the failed owner test call as **AAE-AI-MTRNEXKW-341D5848**, linked to its original call reference and clearly labeled RECOVERED OWNER TEST CALL. The preserved transcript contains the actual readback and separate caller confirmation. This was an operator recovery, not proof that Sora originally saved it.
- Prepared a server-side provider-conversation confirmation validator. It is committed locally but **not pushed/deployed**, pending the separately requested push/deploy approval.

## 2. Why it changed

### P0 — confirmed request lost with false success

The actual September 7 call began at 19:19:22 UTC and its completed callback reported 207 seconds. All 20 assistant turns remained in `sora_receptionist`, which lacked the save tool. The caller confirmed at 19:22:40 UTC. Sora claimed the request was saved at 19:22:41 UTC, but the provider transcript recorded zero tool calls and the platform contained no Case.

This can lose customer leads, leave Easer support unanswered, hide work from the owner and damage trust. It did not charge a customer, create a confirmed booking or change a payout.

### P0 — model-generated confirmation flags were not independent evidence

A labeled runtime test revealed that the assistant could generate its own purported caller confirmation and submit before a separate user reply. That test created **AAE-AI-MTRNDL7E-B5804A69**. It is TEST ONLY, not a real customer request. This was a failed safety test, not a pass. The stronger live prompt subsequently waited correctly in both role tests; the prepared server guard is still needed to reject manufactured confirmation independently of prompt adherence.

### P1 — unhelpful schema rejection

A customer test placed city inside `bookingDetails`. The server correctly rejected it, but the error was generic. The local endpoint change names the placement issue without dropping caller information. The live prompt was clarified. A subsequent customer runtime test saved correctly.

## 3. Files changed

Isolated branch: `fix/sora-confirmed-request-save-20260907`.

Local commit: `c99303d152554c35db655607382f7fdebf9ec304`.

Worktree: `C:/Users/tgbiz/AppData/Local/Temp/aae-owner-call-history-20260906`.

- `api/_sora-confirmation.js` — bounded authenticated provider reads; verify exact call/assistant binding, separate caller reply after the latest readback, matching callback number and recent confirmation; store timestamps/hash rather than the raw transcript.
- `api/ai/support.js` — require provider confirmation before Case/email writes; preserve evidence; actionable schema-placement rejection.
- `scripts/lib/sora-save-guard.mjs` — pure, fail-closed configuration transform; no network or secrets.
- `scripts/test-sora-confirmation.mjs` — provider evidence, fabrication, mismatch, ambiguity and outage checks.
- `scripts/test-sora-save-guard.mjs` — tool accessibility, unchanged boundaries and draft safety checks.
- `scripts/test-sora-support-intake.mjs` — integration checks and both new suites attached to the existing required CI test entry point.
- `business-artifacts/telnyx-sora-intake-tool-contract-2026-09-06.json` — remove the obsolete entry-node save prohibition.

This report is local only. No original dirty workspace files were staged or overwritten.

## 4. What was not changed

- Sora voice, model, transcription, interruption, recording/privacy settings and post-conversation settings.
- Public number routing, forwarding flag, fixed human destination, transfer acceptance and voicemail detection.
- Tool credentials, authentication, spending settings and messaging settings.
- Pricing, taxes, payments, payouts, refunds, booking/dispatch/account state or database schema.
- No existing Cases, calls, conversations or versions were deleted. No real phone calls or customer SMS were placed by the repair tests.

## 5. Validation

| Workflow/check | Result |
| --- | --- |
| Local phone history | PASS — 184 checks |
| Local Sora intake | PASS — 485 checks |
| Provider confirmation validator | PASS — 42 checks |
| Save-guard configuration | PASS — 40 checks |
| Focused lint, syntax and diff checks | PASS |
| Source-of-truth audit and status drift | PASS |
| Failed real call replay at the original save moment | PASS — preserved separate caller yes is accepted by the new validator |
| Premature runtime save replay | PASS — new validator rejects an assistant-written confirmation |
| Final customer runtime before yes | PASS — no save tool and no Case before separate reply |
| Final customer runtime after yes | PASS — real tool execution and one Case, AAE-AI-MTRNLDYX-DBE8B0A8 |
| Final Easer runtime before yes | PASS — no Case; validator rejects absent confirmation |
| Final Easer runtime after yes | PASS — real tool execution and one Case, AAE-AI-MTRNM127-903A3ED9; no booking/Easer record link |
| Final customer owner email | PASS — delivered 19:48:35.446 UTC |
| Final Easer owner email | PASS — delivered 19:49:05.689 UTC |
| Recovered original call | PASS — exactly one Case linked to original call; no booking created |
| Recovered request owner email | PASS — delivered 19:43:34.607 UTC |
| New server confirmation guard live | PENDING PUSH/DEPLOY APPROVAL |
| New spoken phone call on repaired version | NOT YET VERIFIED |

The conversation tests used the actual Telnyx assistant chat runtime and authenticated production save tool, with clearly labeled synthetic input and the owner's callback number. They are stronger than manual tool-only tests but are not phone-audio/TeXML workflow proof. The new server validator was exercised against the corresponding live provider conversations as read-only checks; production does not yet enforce it.

Other repair test Case: **AAE-AI-MTRND0S2-8ABF8B80**, a model-generated payload executed through the provider tool test. All repair test Cases are internal TEST ONLY and must not be dispatched or charged. The prematurely submitted test Case remains preserved as failure evidence.

## 6. Remaining warnings

- Push/deploy approval was requested for the seven-file server safeguard. No push occurred during this repair. The live prompt correction is active, but model-supplied consent flags are still the production server behavior until this commit is deployed.
- The provider-backed guard fails closed on provider outages, missing evidence, uncertain replies, stale confirmation, callback mismatch or ambiguous conversation matching. It may require a fresh readback/yes; it must never substitute missing evidence with assumed consent.
- It verifies a separate confirmation and callback readback, not legal identity, account ownership, perfect transcription or semantic correctness of every service detail.
- Full spoken customer/Easer tests, unanswered-transfer return and independent provider-outage fallback remain open. Do not call the entire phone system fully certified.

## 7. Deployment recommendation

Ready for scoped PR/CI and production validation after explicit push/deploy approval. Deploy only the isolated seven-file commit, never the original dirty workspace. After deployment, prove premature saves are rejected by the actual production endpoint, then confirm a separate yes creates one durable Case and one owner notification. Verify a spoken phone call as the final acceptance step.

Primary references: [Telnyx conversation messages](https://developers.telnyx.com/api-reference/conversations/get-conversation-messages), [assistant/node tool scope](https://raw.githubusercontent.com/team-telnyx/telnyx-node/master/src/resources/ai/assistants/assistants.ts), [version promotion API](https://raw.githubusercontent.com/team-telnyx/telnyx-node/master/src/resources/ai/assistants/versions.ts).
