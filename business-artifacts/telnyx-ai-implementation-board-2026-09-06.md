# Telnyx AI + booking + owner dashboard implementation board

Updated: 2026-09-06. This board covers Owner Dashboard integration and CTO/payments/security/operations acceptance review; it is not an independent human board's approval. Both call completion and job completion are explicitly covered below. This file is a work/acceptance checklist, not a second source of customer booking status.

## Current scope: intake and support only; full phone booking/payment PAUSED

The user narrowed the scope to full customer service-request details and Easer job/account/earnings support, saved into existing Cases and owner email. [Current 52-capability have/need review](telnyx-sora-intake-capabilities-2026-09-06.md) and [isolated two-runtime-file release checklist](telnyx-sora-intake-release-2026-09-06.md) supersede the larger release plan below for this task. The new endpoint/prompt/tool contracts are LOCAL, offline-tested and not deployed/attached. Existing transactional work is preserved, not activated. No paid call, live data change or public routing change occurred in this intake-only pass.

## Previous scope: Customer and Service Pro paths, full voice booking

### Latest fixing pass after "FIX ALL PLEASE" (local, not deployed)

This status overrides the older implementation gaps immediately below where noted. [Exact changes, test evidence, release scope and remaining blockers](telnyx-sora-fix-pass-2026-09-06.md).

- FIXED LOCALLY: server rejects priced/quote-only mixed carts unless the full request explicitly uses quote approval. It does not silently charge for only part of the work.
- FIXED LOCALLY: Connect-mode new-job readiness requires verified payout setup, while manual payout readiness is preserved. No Connect flag or payout rail was changed.
- FIXED LOCALLY: website chat now distinguishes human support hours from daily appointment windows, including Sunday; no staffing guarantee.
- BUILT / OFF: read-only `prepare_booking` handoff preserves exact catalog services/items/quantities, forces quote mode when required and opens the existing checkout for customer review. All 201 catalog items pass offline round-trip checks; furniture plus treadmill visibly verified in Edge. This does NOT send a link or create a booking, payment or authenticated caller session.
- BUILT / OFF: signed, connection-scoped voice lifecycle receiver persists minimal call events in existing owner Cases; duplicate and out-of-order fixtures pass, persistence failures request retry. No transcripts, recordings, card digits, client_state or inferred callback consent are stored. Provider webhook connection is not configured.
- FIXED LOCALLY: owner Cases flags missing/failed/unconfirmed notifications and failed notification lookups, and links call logs with confirmed Customer/Pro requests by the same provider-derived call hash. A call log and an intake case remain different facts; neither changes booking/payment status.
- VALIDATION: focused offline Sora tests and the full clean production-based launch regression PASS, including the final run after same-call owner links. Root-wide smoke failed on unrelated `_mobileframe.html`; that user draft remains untouched. No secret files were copied to the clean test worktree.
- STILL OPEN: authenticated voice account actions, full voice-originated booking/quote submission and completion proof, consented link delivery, isolated Stripe/database sandbox, telephone payment connector, durable notification outbox/provider reconciliation, deterministic after-hours fallback and dedicated AI spend controls.
- NO LIVE CHANGE in this pass: no push/deploy, no new calls/SMS/emails, no real record edits/deletions, no provider settings or public-routing change. New integrations stay default-off.

Full public transactional launch remains NOT approved. Local regression success is not provider/financial end-to-end certification.

### Prior two-path configuration pass (historical)

This section supersedes earlier descriptions of the draft as a single-node receptionist. Detailed findings, end-to-end target journeys, source files, test evidence and release gates: [Two-sided booking audit](telnyx-two-sided-booking-audit-2026-09-06.md).

- SAVED in existing TEST draft: Customer/Service Pro greeting, three named workflow nodes, four routing edges, separate Pro guidance and per-node tool scoping. Entry can read the catalog; only Customer inherits callback intake; Pro has only the existing fixed transfer and hangup. API read-back and Edge Workflow view verified. Full telephone route switching remains untested.
- CORRECTED in Sora: human-support hours no longer described as appointment hours; no Sunday-closed or real-time-professional-availability claim. The website chatbot still needs its own scoped hours correction.
- TESTED: limited Pro text response stayed in applicant context and refused unearned approval. Initial customer test exposed missing entry catalog access; fixed and retested with actual catalog/items tool invocation for couch plus treadmill. These are not booking/payment or complete voice tests.
- LOCAL IMPLEMENTATION TESTED after the owner's CONTINUE: proper unverified Service Pro support intake with separate default-off flag, six support topics, durable Cases record before owner email, shared rate limit, idempotent retries, and no customer/profile/booking mislabeling or financial mutation. Not deployed, enabled or attached to Telnyx. See [Pro-support connection checklist](telnyx-pro-support-connection-2026-09-06.md) for exact runtime files and acceptance steps.
- NOT IMPLEMENTED: voice booking/quote submission, prefilled secure payment continuation, authenticated Customer/Pro records and mutations, all-call/abandoned-call owner ingestion, and telephone payment connector. Pro support cannot be called live until the tested local backend is separately deployed and connected.
- P0 GATES: no Pay connector configured (live GET inventory empty); no proven isolated financial sandbox; no caller-bound account authorization; incomplete call/event reconciliation. Additional code findings: Connect-mode readiness contradicts master policy, and mixed priced/quote-only carts need server-side review before any voice booking adapter.
- PAYMENT DIRECTION: use the existing Stripe collection flow while on the call first; evaluate Telnyx Pay keypad/tokenization separately with a verified processor. Never send raw card data to an AssembleAtEase webhook, expose it to Sora, or use immediate charge as a substitute for the existing authorization/capture workflow.
- UNCHANGED: public +19792325139 still always forwards to +17372906129, owner-only test routing, main version, five global tools, recording off, website deployment, financial logic, records and manual payouts. No new phone calls or purchases.

Review decision: staged implementation may proceed; full public transactional launch is NOT approved. A node name is not proof that its backend action exists. Keep every required test open until there is specific evidence.

## Executive summary

Sora is enabled only for the approved owner test-number traffic, not public customer routing. The website already supports customer self-service booking. Sora can collect a confirmed project/callback request and guide customers to that same secure booking flow; it must not create a separate payment, availability, or completion system.

Implemented: a gated callback-request/catalog API and Easer-completion notification/timeline fixes. On 2026-09-06 the owner approved the scoped production integration, one labeled TEST callback/owner email, and one short call to the approved owner destination with a $1 testing limit and recording off. Public-number forwarding must stay unchanged. This does not approve promoting Sora to main or directing public calls to it. The implementation is not yet end-to-end certified.

## Current approved production integration (supersedes historical preview-only notes below)

### Follow-up repair approved by owner: 2026-09-06, after 20:00Z

- Owner replied "ARE WE GOOD? JUST FIX IT TO PROFESSIONALISM. I DONT CARE WHAT YOU DO. JUST FIX IT" to the specific request to disable recording on the old assistant, route only the approved test number to Sora, and make one additional short verification call within the original $1 total limit. This is not approval to delete data, change payments, or replace public forwarding.
- Disabled recording on main through the provider API, preserving its other telephony settings, prompt and tools. Telnyx created main version 20260906T200024569168. Both current main and Sora draft 20260906T153456589927 were verified recording=false. Historical versions and the unwanted first TEST recording were not deleted.
- Migrated the three existing draft webhook tools into the shared library through the portal, with clear names: AssembleAtEase - Service Catalog (tool-568f3d9b-9693-4103-83a4-60ad2f3c8f58), AssembleAtEase - Service Items (tool-41bb44a8-6d41-4008-8d1a-debc51f63298), AssembleAtEase - Confirmed Callback Intake (tool-8d955ef1-f44e-4e9b-addc-6bc55f55b09c). Saved the draft and verified all five tools, secret references, preset actions, and provider callControlId remained present. Prompt text is identical ignoring whitespace; the portal normalized formatting. The workflow editor is now accessible with one Sora receptionist node and append-mode inherited tools; no warning blocking editing remains.
- Saved exactly one canary rule: attribute telnyx_end_user_target, operator in, values [+17372906129], serve version 20260906T153456589927. No default override, weighted rollout, or public promotion. Provider GET verified the exact rule. Public +19792325139 remains Always Forward to +17372906129.
- The standalone catalog test endpoint still returns 404 for the draft tool; do not confuse this with runtime results. No callback or SMS tool test was submitted by the operator.
- Exactly one additional outbound TEST call submitted with Record=false, TimeLimit=120, Timeout=20 and idempotency key aae-sora-20260906-owner-approved-test-02. SID v3:fe1i5zatxZ9pSLLGJw3ngMptYGSzvkuIqdR4kdP0rMRD0GZ7o59JFg, leg 09b7501e-aa2e-11f1-98b7-3e4f21e0c25e, session 09b20096-aa2e-11f1-bf82-3e4f21e0c25e. Balance before this call: $27.73. The prior call cost was an observed $0.06.
- Correct runtime version VERIFIED for conversation abd18251-078e-429b-aaf0-f5a6cf9ffb88. Actual greeting identified Sora and AssembleAtEase. When the owner requested couch assembly, Sora offered service and asked city, item condition and brand; no DIY instructions in the dialogue. The call ran 20:03:47Z to 20:05:47Z and ended at the operator-set 120-second limit just before callback consent completed. The caller confirmed the read-back but had not answered the separate permission question. No callback case was created for this actual call, as verified by its exact hashed source reference. Do not treat the later synthetic test as this caller's consent or a successful full voice intake.
- Recording check PASS for this second call: 18 provider events included call_hangup (time_limit), session.stopped, conversation_ended and conversation_insights_generated, with zero recording events. The call is no longer alive. No third phone call was placed. Balance after the call and text tests was $27.61, an observed $0.18 change from the original $27.79; final provider billing remains financial truth.
- Professional-intake follow-up: Sora now must retrieve the live catalog first, offer to take project details instead of ending with only a website URL, avoid leading with "I can't book", reuse already-stated details, and combine the final read-back confirmation and callback permission in one clear question. It still never calls a request a booking or collects payment details. The start node also explicitly requires the catalog check. Provider GET verified exact prompt text, all five tools preserved and recording=false. This revised prompt was tested through Telnyx chat, not another voice call. Draft maximum remains 300 seconds; the 120-second cutoff was specific to this test call.
- Actual Telnyx catalog-tool test PASS in conversation 87877827-33be-4e43-aa63-03304b3fbe04, clearly named catalog-only/no phone/no booking. Provider tool messages show get_service_catalog and get_service_items for Furniture Assembly and Fitness Equipment returning the website's real catalog. Sora correctly separated couches, treadmills and TV mounting. No callback or other action was requested in this catalog-only test.
- Actual Telnyx callback-tool test PASS in separate synthetic conversation c97a67dd-04ee-4e4e-b850-758e931531ec, explicitly labeled not a real job or phone call. The synthetic provider-context reference was v3:aae_sora_synthetic_intake_20260906_02; it is NOT the real test call's ID. Sora checked the catalog, read back the TEST details, asked the combined confirmation/permission question, and only after the operator's synthetic-test confirmation invoked request_callback. The tool returned success=true, bookingCreated=false and reference AAE-AI-MTQ8W2UI-39E0BE2F.
- Exactly one synthetic TEST case was verified: 2365ca76-159f-482d-b08d-6277a7daac74, subject [TEST] Sora callback: Furniture Assembly - Austin, created 20:09:12.344949Z. Notification 3f231c2e-fbd2-49c5-a41c-d4a1e9d0bc9e is delivered, delivered_at=20:09:14.393Z. Owner Dashboard > Cases visibly shows the saved details and DELIVERED, 1 attempt. Together with the earlier backend-only TEST, there are two clearly labeled test cases; neither is a real booking. No customer, booking, payment, payout or SMS was created/changed.
- Focused Sora and Operations Cases suites PASS; syntax and scoped diff checks PASS. Added prompt-contract assertions for no DIY, required catalog check, project-intake offer, combined consent and verified-save language. Only the prompt, its test file and this board changed locally in this follow-up; the website backend is the already-deployed release. No website deploy or unrelated dirty-file changes were required.

The earlier live-verification bullets below remain historical evidence and are superseded by this subsection where stated.

- API credential verified without displaying it. Dedicated 48-byte random tool credential stored in Telnyx integration secrets (`aae_sora_intake_20260906`) and Vercel production Secret (`TELNYX_AI_TOOL_SECRET`). No key committed or written to disk by the setup helper. Existing production Telnyx key not rotated.
- Production configuration now contains TELNYX_AI_INTAKE_ENABLED=true and TELNYX_AI_CALLBACKS_ENABLED=true. They take effect with the scoped production deployment; preview writes remain prohibited.
- Sora draft version 20260906T153456589927: recording OFF verified through a second API read. Main remains 20260906T152820512026. No public routing/canary changes.
- Draft now has get_service_catalog, get_service_items, request_callback, plus the unchanged Transfer and Hang Up tools. Prompt requires confirmed details and explicit callback permission, then actual tool success. It never calls a callback an appointment or promises email delivery.
- Callback tool presets Telnyx's documented call_control_id; the server validates and hashes it to a stable case reference. It is not chosen by the model. Missing/unresolved variables fail closed. The existing conversationId contract remains for trusted integrations/tests.
- Public +1 979-232-5139 voice settings verified: Always Forward to +1 737-290-6129, existing Web Dialer connection unchanged; CNAM listing enabled as ASSEMBLEATEASE.
- The original production baseline was d3a72710 (deployment dpl_8hVGUpW8tcT3AWJ5qwpA4jyk9ETV), ahead of the then-current origin/main. The clean release preserved its six already-live SMS/Google Ads files. PR #137 merged the scoped release into main as 4c59619012196cca71cc18528f8420c75088faa8. Current production dpl_2g5xAHaUCE1P6B4QYt5WLyNBqvGS is READY at that main commit; the direct release deployment dpl_BJ6FZtE4k8qxWwH3gXGJp738KfUj is also READY and has the same code tree. Clean release worktree: C:/Users/tgbiz/AppData/Local/Temp/aae-sora-production-20260906. Never deploy the dirty root worktree over this release.
- Fourteen focused suites passed in the release worktree, including Sora, SMS webhook, Ads, Cases, completion security/privacy, owner communications, payout synchronization and mutation safety. Syntax/focused lint pass. Full launch suite initially found the audit did not recognize the injected email adapter; the default adapter now explicitly calls sendEmail, retaining test injection and behavior. The full npm run test:launch rerun PASSED (exit 0), including lint, 776 inline blocks, source-of-truth, payment/payout/security regressions. Existing informational brand-blue variants and one unrelated unused eslint-disable warning remain.
- Production persistence and owner delivery now verified; the voice test FAILED the correct-version and recording checks (details below). No SQL/schema changes, deletions, test bookings, customer charges, or payouts.
- Cost warning: the existing shared outbound voice profile has no enabled daily spend cap. It was not silently changed because it also supports working calls. The approved one-call test used TimeLimit=60; an AI-specific production spending policy remains required before public activation. No additional call is authorized.

### Live verification, 2026-09-06

- Release eb55463d deployed successfully as dpl_DL4s7RDTJFz63yZek375mrjBG8BV, then redeployed unchanged as dpl_4YobJugnAQr2uNfbJ3UuiMVTrsAW after adding the missing existing Resend signing secret. Both were aliased to www.assembleatease.com. An earlier attempt dpl_8NBq82DU33FC85wm5rpngEkELbDJ was blocked by placeholder Git author metadata and never became live. A new release checkpoint used the project owner's existing verified deployment identity; no account permissions/security checks changed.
- Production POST /api/ai/receptionist: unauthenticated request returned 401; authenticated catalog returned 200, seven canonical categories, callbackRequestsEnabled=true. /book returned 200. Deployed cookie-consent.js SHA256 exactly matched the preserved, already-live Google Ads phone tracking file.
- Approved TEST callback returned 200 and created exactly one case: AAE-AI-MTQ7VHLQ-488C94A4, ID 805d1c12-affb-4ec8-9373-36179971b8d2, subject [TEST] Sora callback: Furniture Assembly - Austin. The test instructed no dispatch, booking, charge, or customer contact. Repeating the same confirmed request returned the same reference. Case creation and notification-attempt events were verified through a query limited to this case. Owner Dashboard > Cases visibly displayed it.
- Owner alert: notification e3a6e8fb-1656-44af-81b1-27ca1feb2595, Resend ID 98e6ad46-ffb8-437c-97f7-d333998816cd. Resend reported delivered. Initial dashboard status remained provider_accepted because RESEND_WEBHOOK_SECRET was absent from Vercel, causing real provider receipt requests to return 400. Retrieved the existing enabled Resend endpoint's signing secret privately and stored it as a production Secret; no webhook was duplicated or rotated. After redeployment, the provider retry updated the actual notification row to delivered, delivered_at=2026-09-06T19:40:46.764Z. No synthetic delivery event or manual database status was used.
- Owner timeline P1: a public case-status message was labeled Message sent even without evidence of email/SMS. Changed only that label to Customer-visible update; actual notification status remains provider-backed. Added a regression assertion.
- Final release verification: GitHub Constitution guards and Vercel checks passed before PR #137 was merged. Live owner/assets/cases.js returns 200 and contains Customer-visible update, with the old Message sent label absent. Live cookie-consent.js exactly matches the original d3a72710 Git blob; a local byte comparison differed only because Windows checkout uses CRLF while Git/live use LF. No Google Ads tracking change was introduced. The refreshed owner tab now requires the owner to sign in again; no login was automated. The TEST case and DELIVERED status were visibly verified before that refresh.
- Telnyx draft standalone tool test returned 404, Tool not found for assistant, both through the official API and the portal's Test Webhook button. Backend authentication/persistence success is NOT proof that Telnyx runtime invoked these tools.
- Exactly ONE outbound call to approved +1 737-290-6129, from +1 979-232-5139, submitted with AIAssistantVersion=20260906T153456589927, Record=false, TimeLimit=60, Timeout=20. Call leg 06d1bf7c-aa2b-11f1-ae95-3af7875816e4, conversation 14bce401-4435-4131-8a8d-a327cdcc4107. Provider reported answered, 55-second duration (19:42:20Z to 19:43:15Z), normal clearing, and is_alive=false. No second call or transfer made. Balance moved from $27.79 to $27.73 (observed $0.06 change; final invoice remains provider truth).
- P0 WRONG VERSION: the dial event recorded the requested Sora draft, but conversation metadata explicitly reports assistant_version_id=20260906T152820512026 (old main). The actual greeting and replies were generic DIY guidance, not the professional booking receptionist. No tools ran. Do not call this an end-to-end pass or route customers to it.
- P0 RECORDING: despite Record=false and the draft's saved recording_settings.enabled=false, the wrong-main test generated recording_saved, ID f219efa0-7391-417f-bd75-84d5ef61ac33, dual-channel MP3. Main has recording enabled. No audio was downloaded, played, or published, and public_recording_urls was empty. Recording was NOT deleted under the owner's no-delete constraint. Stop further calls until the version-selection/recording conflict is corrected and a bounded retest is approved. Never describe the test as unrecorded.
- Additional draft-only repair: inherited blank workflow node used tools_mode=replace and exposed only Hang Up, hiding all global tools. Replaced that empty node configuration with a named Sora receptionist start node, instructions_mode=append, tools_mode=append, and no node-specific tool override. GET verified five global tools, append mode, and recording=false. Main and public-number forwarding remained unchanged. This fixes the hidden-tools conflict; it does not prove the wrong-version runtime issue resolved.
- Owner clarified the assistant must collect booking/project details, not teach DIY. Added an explicit no-DIY / arrange-paid-service rule to the Sora draft only. A second provider GET verified the saved prompt exactly matches the local file, all five tools and workflow are unchanged, recording remains false, and main's version/instructions remain unchanged. Always Forward to +17372906129 and connection 3040104147199198769 were reverified. No second call was placed. This clarifies behavior but does not repair or certify runtime routing.
- No canary configuration exists (GET returned 404); none was created. A test-number-only routing rule is a documented possible workaround but has not been authorized/applied in this release. Do not broaden into public routing or promote Sora to main.
- Portal workflow-editor warning inspected: the three new webhook tools are inline rather than in the shared Tools Library, so the portal refuses workflow editing until they are shared. No library migration was performed. Telnyx's [Tools Library documentation](https://developers.telnyx.com/docs/inference/ai-assistants/tools-library) says legacy inline tools remain functional; this UI editing limitation is not proof of the wrong-version call's cause. Do not conflate it with successful runtime tool execution. Sora's Agent tab was left open showing the saved receptionist draft and NOT LIVE status.
- Remaining before public AI launch: correct-version, no-recording, real tool invocation and transfer/voicemail retests; deterministic business-hours handling; every-call/abandoned-call reporting and reconciliation; AI-specific spend controls; existing booking end-to-end handoff. Voice-only booking is not implemented. Keep the existing working forwarding in place.

## Board: do not call this finished until every required row has proof

### Historical connection audit before approved production setup, 2026-09-06

The bullets in this historical subsection describe the earlier pre-approval state, not the current state. Current tools, recording flags, production deployment, TEST persistence, and delivered owner alert are documented above.

- Preview commit `ed44fecb` built successfully in Vercel. This is not a live AI activation.
- P0 test-isolation finding: read-only inspection of current hosted configuration confirms preview uses the production Supabase project and a live Stripe key. Do not create test bookings, complete jobs, capture payments, or treat this full website preview as a financial sandbox. No such mutation was performed.
- Local follow-up fix: catalog access and callback persistence now have separate activation controls. `TELNYX_AI_CALLBACKS_ENABLED=true` is also required, and callback writes are refused outside Vercel production even when both flags are set. Catalog responses report `callbackRequestsEnabled`; an assistant must not offer a callback when false. This blocks AI callback writes only, not unrelated website APIs.
- No isolated callback sandbox is configured. A future sandbox must use a verified separate database and notification setup before extending the preview write guard; do not simply remove the guard to make a test pass.
- Current Telnyx draft still has Transfer and Hang Up only, and displays Not live. No catalog/callback tool has been attached or falsely described as operational.
- API access is now verified: the owner supplied TELNYX_API_KEY in the Git-ignored local environment file. A read-only Telnyx request returned HTTP 200 for the exact Sora draft version. The key was not displayed, committed, uploaded, or used to change routing. The original production Vercel Secret was not replaced or revoked.
- A read-only Supabase schema inspection confirms operations_cases, operations_case_events, notification_log, create_operations_case_v1 and append_operations_case_event_v1 are exposed. Owner-email and email-provider configuration are present. No customer rows were read, no records were written, and actual persistence/email delivery remains untested. No new SQL is currently required merely to attempt the existing callback flow.
- Read-only Telnyx API inspection confirms the selected Sora version remains separate from main, with Transfer and Hang Up only, 300-second maximum duration, 45-second idle timeout, recording enabled, retention enabled, and post-conversation processing disabled. These findings do not constitute a call test or proof of full operation.
- Next approval boundary: a scoped production integration release and one explicitly labeled TEST callback/owner notification are needed to verify the actual backend without misrepresenting the current preview as an isolated sandbox. A short owner-directed voice test also needs a bounded test budget and a recording decision. Keep public-number forwarding unchanged during that verification; live AI phone routing remains a separate go-live decision.
- Vercel preview protection requires authentication and prevents an unauthenticated Telnyx webhook tool from reaching this preview. Do not disable deployment protection or share a broad bypass credential merely to connect the tool.
- Live recording/privacy choice, modest call-test budget, every-call reporting, and actual owner-email delivery remain unverified. Existing public-number forwarding remains untouched.

| Process | Canonical record / owner visibility | Current status | Completion evidence required |
|---|---|---|---|
| Assistant configuration | Telnyx version 20260906T153456589927; owner-number-only routing | Correct voice version and no-recording checks PASS; no public routing | Complete revised voice intake and transfer tests, AI-specific cost controls |
| Service selection | Existing booking catalog, not a second AI price list | Actual Telnyx catalog and item tools PASS in chat | Verify revised mandatory catalog step during a complete voice intake |
| Customer booking | Existing /book, server pricing, Stripe, bookings/booking_items | Existing path inspected; no live test performed | Customer chooses items/address/time, reviews fees/terms, completes secure checkout, sees actual status |
| AI callback / booking-help request | Existing operations_cases + initial event; Owner Dashboard > Cases | Telnyx synthetic TEST invocation/persistence/display PASS; earlier duplicate retry PASS | Complete voice intake remains unproven because test reached its duration limit |
| Owner callback alert | Existing notification_log linked by operation_case_id | Telnyx synthetic TEST alert delivered; dashboard visibly DELIVERED, 1 attempt | Continue monitoring failures and delayed receipts |
| Every AI call ends | Telnyx conversation and a verified completion event/summary | NOT CONNECTED | Include no-lead, silence, hangup, interrupted tool, transfer, busy and error cases; reconcile missing events |
| Missed-call follow-up | Open case assigned to owner; acknowledgement/resolution in existing Cases | Callback cases supported locally; automatic missed-call intake NOT CONNECTED | Owner can see, acknowledge and resolve; callback deadline and backup agreed |
| Booking/dispatch/acceptance/en-route/arrival | Existing bookings, dispatch_offers, activity_logs | Code/source checks only | One real/test-mode job shows consistent customer, Easer and owner views at each step |
| Job completion and photos | Existing completion APIs + booking_evidence + bookings | Easer-completion notification/timeline fixes deployed; regression PASS | No real job was completed to test this change |
| Payment capture | Stripe + verified booking financial projection | UNCHANGED | Stripe amount/status agrees with dashboard; failure does not become paid |
| Easer earnings/payout | Existing payout ledger/manual payout flow | UNCHANGED; sync regression PASS | Completed does not mean paid; payout evidence/status is independent |
| Cancellation/refund/damage | Existing authorized workflows and Cases | UNCHANGED | No AI account disclosure, mutation, fee promise or refund approval |
| After-hours and Easer problems | Owner-approved schedule / on-call path | Prompt-only instructions, NOT hard-enforced | Agreed human availability and urgent non-emergency fallback |
| SMS booking link | Existing consent + messaging infrastructure | NOT ENABLED | Explicit consent, confirmed delivery, STOP/START/HELP tests; no inference from callback consent |
| Owner catches failures | Cases, notification logs, booking timeline, Live Ops | Existing surfaces reused; not every path proven | Disconnect/email/webhook failure testing and reconciliation alerts |

## PASS / WARNING / FAIL matrix

- PASS (local): canonical service mapping, service-deep-link compatibility, default-off AI gate, constant-time tool-secret check, durable rate-limit requirement, input allowlist, caller-confirmation checks, case idempotency, fixed owner recipient, HTML escaping, no transactional AI actions.
- PASS (local): operations case tests, completion evidence/privacy/security checks, Easer/owner payout synchronization, service-addition flow, owner communications/dashboard checks, manual payouts, operations truth, crew split, mutation safety, external-copy checks, focused lint and syntax checks.
- PASS (production TEST only): canonical catalog response, one durable case, duplicate retry, owner board display, and provider-confirmed email delivery synchronized to the dashboard. This is a backend test, not a successful voice tool invocation.
- WARNING: financial/Easer regressions use mocks/static checks, not live Stripe transactions. No financial test booking was created. Broad real-world concurrency and provider failure recovery remain unproven.
- PASS (follow-up): correct Sora version on the second actual call, service-intake dialogue instead of DIY, and no recording events after the call ended. Telnyx chat actually invoked all three webhook tools; the synthetic callback saved one TEST case and delivered one owner alert.
- WARNING (voice completion): the second call hit its explicit 120-second test cutoff before final callback consent; the full revised voice intake is not yet proven. There were two phone calls total, not three. The synthetic chat test is separate proof, not a substitute claim about the actual voice call.
- FAIL for public AI launch: every-call/abandoned-call completion capture, AI-specific spending controls, deterministic hours/transfer behavior, and complete voice intake/booking handoff remain unverified. Existing public forwarding is preserved.

## P0 issues and business impact

1. AI call completion is not job completion. Confusing these can fabricate completed jobs or payments. The new endpoint has no booking/payment/payout mutations and always returns bookingCreated=false.
2. Not every completed or abandoned AI call reaches the website. A callback tool alone cannot guarantee this: the caller may hang up before the tool runs. Implement and verify a provider-origin call/conversation completion path with signature verification, replay protection, bounded payloads, idempotency and reconciliation before live activation. Do not accept an unsigned insight merely because it claims to come from Telnyx. A documented insight event is not proof of this account's exact signed payload.
3. No production customer should depend on an untested alert. The new callback path persists the case and first event before email. The owner sees an open case even if email fails. Email provider acceptance is never called delivered.
4. Version selection and recording behavior were corrected and verified in the second test. The unwanted recording from the first test is retained under the no-delete constraint. Do not route public callers to Sora until the remaining full-intake, every-call reporting and operational checks pass.

## P1 issues and fixes

- Easer-completion owner email lacked bookingId/notificationType/recipientType. Fixed and deployed so its notification row can be joined to the correct booking.
- Two Easer completion timelines were fire-and-forget. Both are now awaited; logging remains nonfatal and cannot recapture payment or undo completed work.
- Owner-completion email failures in these paths now create a linked notification_failed timeline entry. Underlying notification delivery remains in notification_log.
- Case alerts are intentionally not re-sent on duplicate tool calls. This prevents duplicate alerts from concurrent requests. A crash after case creation but before alert leaves an open case requiring review; a durable outbox/reconciliation worker remains a launch consideration. Do not claim guaranteed email delivery or exactly-once email.
- Existing homepage cancellation FAQ is less specific than detailed terms/chatbot. Sora must use current secure terms rather than calculate fees or promise eligibility.

## Clear service selection

Use the exact canonical service returned by action=catalog. Sora should ask what needs assembling/installing, then confirm the item and category, rather than read a seven-option menu to every caller.

| Caller need | Catalog category |
|---|---|
| Beds, dressers, sofas, tables, media consoles | Furniture Assembly |
| TV mounting, mirrors, shelves, wall hanging | Mounting & Hanging |
| Cameras, locks, compatible smart devices | Smart Home |
| Patio/backyard structures and playsets | Outdoor & Playsets |
| Office desks, chairs, workstations | Office Assembly |
| Treadmills, exercise bikes, racks, benches | Fitness Equipment |
| Unlisted/uncertain/complex project | Other (spoken label: Custom project / not sure) |

Some home-office items exist in Furniture Assembly as well as dedicated Office Assembly. Do not assume differently named items/prices are equivalent or choose the cheaper path for the caller. Confirm their scope and use the matching catalog entry. Fitness equipment stays separate from furniture. No prices/items/categories were changed.

## Automated booking: supported scope

Intended initial flow:

1. Sora retrieves the current catalog, identifies the requested service and clarifies scope.
2. Sora provides the existing service-specific secure booking URL. The API adds voice/Sora attribution only; it does not change prices or create a booking.
3. Customer chooses actual items, supplies the service address, checks available options and reviews fees/taxes/terms in the existing flow.
4. Customer completes secure payment authorization/checkout as required. Never dictate card numbers to the assistant.
5. Existing verified booking, dispatch and Easer workflows control status, not the conversation transcript.
6. Owner follows the same booking and timeline through completion, capture, and the separately recorded Easer payout.

The implemented optional callback request is for people who need help or cannot finish online. It is not a phone booking, payment, reservation, calendar hold, or promise of availability. Full voice-only booking is NOT implemented or enabled.

## Scoped release files (relative to the original live baseline)

- `api/booking/assembler-complete.js`: notification metadata, owner-alert failure log, awaited completion timeline; no pricing/capture/payout formula or status guard changed.
- `api/ai/receptionist.js`: new disabled-by-default authenticated catalog and callback-request handler; reuses existing pricing catalog and Cases APIs/RPCs.
- `scripts/test-ai-receptionist.mjs`: new network-disabled mocked/contract tests.
- `owner/assets/cases.js`: accurate Customer-visible update label; delivery remains separately provider-backed.
- `scripts/test-operations-cases.mjs`: regression assertion for the timeline label.
- `scripts/sora-approved-setup.mjs`: guarded operator-only secure setup; no automatic calling or public routing. It refuses an existing integration-secret identifier rather than rotating it.
- `business-artifacts/telnyx-sora-receptionist-prompt-2026-09-06.txt`: professional receptionist prompt and verified-tool boundaries.
- This board.

The local board is maintained after release with acceptance evidence. The follow-up draft-prompt clarification explicitly forbids DIY coaching and prioritizes service intake; its provider save was verified by exact read-back. The updated board and this prompt clarification are local follow-up artifacts, not part of the already-merged website release. They do not require another website deployment.

Existing unrelated dirty files, including the SMS webhook, .env.example, vercel.json and business backlog, were not edited in this turn. They must not be bundled into deployment unintentionally.

## Current connection contract: production backend enabled; AI phone routing not enabled

Endpoint: POST /api/ai/receptionist, JSON, Authorization: Bearer <dedicated tool secret>. Never put the secret in the prompt, URL, customer client code, or a database owner's password field.

Approved server configuration:

- TELNYX_AI_INTAKE_ENABLED=true is saved in production under the owner's explicit approval.
- TELNYX_AI_CALLBACKS_ENABLED=true is saved in production under the owner's explicit approval. Preview writes remain blocked. Callback persistence requires VERCEL_ENV=production and no conflicting VERCEL_TARGET_ENV.
- TELNYX_AI_TOOL_SECRET: a dedicated high-entropy secret at least 32 characters, generated/stored via an approved secure setup. It is not the Telnyx API key, Supabase service-role key, or owner password.
- Existing Supabase configuration and migration 053 Cases RPC must be present; this task did not apply SQL.
- Existing durable Upstash rate limiting must be configured. Callback intake fails closed if missing/unavailable; current default limiter bounds this path to 10 requests per minute for the assistant-wide key. This is not an AI spend cap.
- Existing email configuration and the actual NOTIFY_EMAIL destination must be verified; no email destination changed.

Catalog request: {"action":"catalog"}. Initial response contains categories/group names; request {"action":"catalog","service":"Furniture Assembly"} for that category's item details. No invented prices, taxes or totals.

Callback request shape (fictional example):

```json
{
  "action": "request_callback",
  "conversationId": "conv_fictional_123456",
  "service": "Furniture Assembly",
  "name": "Test Customer",
  "phone": "+15125550100",
  "city": "Austin",
  "project": "One queen bed frame to assemble.",
  "preferredTime": "Next Tuesday morning, if available",
  "detailsConfirmed": true,
  "callbackConsent": true
}
```

The attached callback tool instead presets callControlId={{call_control_id}}; the server validates and hashes that provider call reference. The conversationId example above remains a supported trusted-integration contract, and the two identifiers are mutually exclusive. Neither may be chosen by a caller or model. Prompt instructions must obtain and read back name, phone, category, city, scope and requested time and ask callback permission before invoking. Callback permission is NOT SMS, marketing, recording or payment consent.

No direct booking, completion, cancellation, refund, payout, arbitrary-recipient, customer-record lookup or arbitrary URL action is supported. Unknown fields/actions are rejected. Success means the request is durable; it never means the owner read the email or a job is booked.

Current Sora draft describes the three attached tools and requires successful tool results before claiming a callback is saved. This does not prove the voice runtime invokes that version; the actual one-call test selected old main and failed.

## Recommended fix order and launch decision

1. Complete an approved voice-intake test with enough time for confirmation, using the already-verified owner-number-only rule. Correct version and no-recording are now PASS. No public promotion is authorized.
2. Implement/verify completion and abandoned-call reporting so an interrupted intake cannot disappear from owner visibility. Do not turn an incomplete request into consent or a booking.
3. Recheck the owner case and delivery for the completed voice request. Telnyx's separate synthetic tool-to-case-to-delivered-alert test is already PASS, but is not a substitute for a complete voice test. Preserve the unwanted first TEST recording unless its exact deletion is approved.
4. Decide after-hours/on-call policy and hard-enforce the permitted transfer path. Test declined transfer, voicemail, silence and interrupted calls.
5. Add and test every-call completion reporting and missed-event reconciliation. Keep customer claims limited until this works.
6. Test customer booking handoff and a complete customer/Easer/owner workflow in a genuinely isolated financial test environment; current previews are not payment sandboxes.
7. Verify AI-specific spending boundaries, then obtain the exact public routing approval (all calls / missed calls / after-hours). Only then activate.

The scoped backend release is deployed and its TEST intake/delivery checks PASS. Public AI activation is NOT approved or certified. Preserve manual payouts and existing forwarding. No financial logic or Stripe Connect switch changed.

Official references inspected: [Telnyx webhook tools](https://developers.telnyx.com/docs/inference/ai-assistants/no-code-voice-assistant), [insight-group completion delivery](https://developers.telnyx.com/docs/inference/ai-insights/insight-groups). These describe available mechanisms, not proof that our production integration is configured or delivering.
