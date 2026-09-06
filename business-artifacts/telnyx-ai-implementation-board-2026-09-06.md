# Telnyx AI + booking + owner dashboard implementation board

Updated: 2026-09-06. "Board" is provisionally interpreted as Owner Dashboard. Both call completion and job completion are explicitly covered below. This file is a work/acceptance checklist, not a second source of customer booking status.

## Executive summary

The new Telnyx receptionist remains a non-live draft. The website already supports customer self-service booking. A voice assistant can guide service selection and hand the customer to that same secure booking flow; it must not create a separate payment, availability, or completion system.

Implemented: a gated callback-request/catalog API and Easer-completion notification/timeline fixes. On 2026-09-06 the owner approved the scoped production integration, one labeled TEST callback/owner email, and one short call to the approved owner destination with a $1 testing limit and recording off. Public-number forwarding must stay unchanged. This does not approve promoting Sora to main or directing public calls to it. The implementation is not yet end-to-end certified.

## Current approved production integration (supersedes historical preview-only notes below)

- API credential verified without displaying it. Dedicated 48-byte random tool credential stored in Telnyx integration secrets (`aae_sora_intake_20260906`) and Vercel production Secret (`TELNYX_AI_TOOL_SECRET`). No key committed or written to disk by the setup helper. Existing production Telnyx key not rotated.
- Production configuration now contains TELNYX_AI_INTAKE_ENABLED=true and TELNYX_AI_CALLBACKS_ENABLED=true. They take effect with the scoped production deployment; preview writes remain prohibited.
- Sora draft version 20260906T153456589927: recording OFF verified through a second API read. Main remains 20260906T152820512026. No public routing/canary changes.
- Draft now has get_service_catalog, get_service_items, request_callback, plus the unchanged Transfer and Hang Up tools. Prompt requires confirmed details and explicit callback permission, then actual tool success. It never calls a callback an appointment or promises email delivery.
- Callback tool presets Telnyx's documented call_control_id; the server validates and hashes it to a stable case reference. It is not chosen by the model. Missing/unresolved variables fail closed. The existing conversationId contract remains for trusted integrations/tests.
- Public +1 979-232-5139 voice settings verified: Always Forward to +1 737-290-6129, existing Web Dialer connection unchanged; CNAM listing enabled as ASSEMBLEATEASE.
- Active production baseline is d3a72710 (deployment dpl_8hVGUpW8tcT3AWJ5qwpA4jyk9ETV), NOT origin/main. Clean release worktree is C:/Users/tgbiz/AppData/Local/Temp/aae-sora-production-20260906, branch fix/sora-intake-production. Preserve its six already-live SMS/Google Ads files unchanged. Never deploy the dirty root worktree or old origin/main over these fixes.
- Fourteen focused suites passed in the release worktree, including Sora, SMS webhook, Ads, Cases, completion security/privacy, owner communications, payout synchronization and mutation safety. Syntax/focused lint pass. Full launch suite initially found the audit did not recognize the injected email adapter; the default adapter now explicitly calls sendEmail, retaining test injection and behavior. The full npm run test:launch rerun PASSED (exit 0), including lint, 776 inline blocks, source-of-truth, payment/payout/security regressions. Existing informational brand-blue variants and one unrelated unused eslint-disable warning remain.
- Actual production callback persistence, owner email delivery, and voice call are still pending; subsequent proof must be recorded here. No SQL/schema changes, deletions, test bookings, customer charges, or payouts.
- Cost warning: the existing shared outbound voice profile has no enabled daily spend cap. It is not being silently changed because it also supports working calls. The approved one-call test will use a short provider-enforced TimeLimit; an AI-specific production spending policy remains required before public activation.

## Board: do not call this finished until every required row has proof

### Connection follow-up, 2026-09-06

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
| Assistant configuration | Telnyx non-live version 20260906T153456589927 | Saved in prior turn; NOT LIVE | Approved privacy settings, cost controls, voice/transfer tests |
| Service selection | Existing booking catalog, not a second AI price list | Local API + tests PASS | Live tool returns same categories and each link selects the correct service |
| Customer booking | Existing /book, server pricing, Stripe, bookings/booking_items | Existing path inspected; no live test performed | Customer chooses items/address/time, reviews fees/terms, completes secure checkout, sees actual status |
| AI callback / booking-help request | Existing operations_cases + initial event; Owner Dashboard > Cases | Local API + mocked tests PASS; disabled | Caller confirms name/phone/service/city/scope and callback permission; one durable case appears |
| Owner callback alert | Existing notification_log linked by operation_case_id | Local API + mocked tests PASS | Provider acceptance and actual delivery verified separately; failures visible |
| Every AI call ends | Telnyx conversation and a verified completion event/summary | NOT CONNECTED | Include no-lead, silence, hangup, interrupted tool, transfer, busy and error cases; reconcile missing events |
| Missed-call follow-up | Open case assigned to owner; acknowledgement/resolution in existing Cases | Callback cases supported locally; automatic missed-call intake NOT CONNECTED | Owner can see, acknowledge and resolve; callback deadline and backup agreed |
| Booking/dispatch/acceptance/en-route/arrival | Existing bookings, dispatch_offers, activity_logs | Code/source checks only | One real/test-mode job shows consistent customer, Easer and owner views at each step |
| Job completion and photos | Existing completion APIs + booking_evidence + bookings | Small local Easer-completion fixes; regression PASS | Correct Easer/evidence required; completed timeline persists; receipt/owner alert linked correctly |
| Payment capture | Stripe + verified booking financial projection | UNCHANGED | Stripe amount/status agrees with dashboard; failure does not become paid |
| Easer earnings/payout | Existing payout ledger/manual payout flow | UNCHANGED; sync regression PASS | Completed does not mean paid; payout evidence/status is independent |
| Cancellation/refund/damage | Existing authorized workflows and Cases | UNCHANGED | No AI account disclosure, mutation, fee promise or refund approval |
| After-hours and Easer problems | Owner-approved schedule / on-call path | Prompt-only instructions, NOT hard-enforced | Agreed human availability and urgent non-emergency fallback |
| SMS booking link | Existing consent + messaging infrastructure | NOT ENABLED | Explicit consent, confirmed delivery, STOP/START/HELP tests; no inference from callback consent |
| Owner catches failures | Cases, notification logs, booking timeline, Live Ops | Existing surfaces reused; not every path proven | Disconnect/email/webhook failure testing and reconciliation alerts |

## PASS / WARNING / FAIL matrix

- PASS (local): canonical service mapping, service-deep-link compatibility, default-off AI gate, constant-time tool-secret check, durable rate-limit requirement, input allowlist, caller-confirmation checks, case idempotency, fixed owner recipient, HTML escaping, no transactional AI actions.
- PASS (local): operations case tests, completion evidence/privacy/security checks, Easer/owner payout synchronization, service-addition flow, owner communications/dashboard checks, manual payouts, operations truth, crew split, mutation safety, external-copy checks, focused lint and syntax checks.
- WARNING: tests use mocks/static checks, not real Supabase, Telnyx, email or Stripe transactions. Mock concurrency tests do not replace testing the deployed database RPC.
- FAIL for live AI launch: every-call completion capture, actual owner alert delivery, privacy choice, AI-specific spending controls, live/draft-specific calling tests, deterministic hours/transfer behavior, end-to-end booking handoff.

## P0 issues and business impact

1. AI call completion is not job completion. Confusing these can fabricate completed jobs or payments. The new endpoint has no booking/payment/payout mutations and always returns bookingCreated=false.
2. Not every completed or abandoned AI call reaches the website. A callback tool alone cannot guarantee this: the caller may hang up before the tool runs. Implement and verify a provider-origin call/conversation completion path with signature verification, replay protection, bounded payloads, idempotency and reconciliation before live activation. Do not accept an unsigned insight merely because it claims to come from Telnyx. A documented insight event is not proof of this account's exact signed payload.
3. No production customer should depend on an untested alert. The new callback path persists the case and first event before email. The owner sees an open case even if email fails. Email provider acceptance is never called delivered.
4. Caller data and new authenticated access need an approved production setup. No secret created or uploaded, no recording/retention setting changed, and no live intake enabled.

## P1 issues and fixes

- Easer-completion owner email lacked bookingId/notificationType/recipientType. Fixed locally so its notification row can be joined to the correct booking.
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

## Files changed this turn

- `api/booking/assembler-complete.js`: notification metadata, owner-alert failure log, awaited completion timeline; no pricing/capture/payout formula or status guard changed.
- `api/ai/receptionist.js`: new disabled-by-default authenticated catalog and callback-request handler; reuses existing pricing catalog and Cases APIs/RPCs.
- `scripts/test-ai-receptionist.mjs`: new network-disabled mocked/contract tests.
- This board.

Existing unrelated dirty files, including the SMS webhook, .env.example, vercel.json and business backlog, were not edited in this turn. They must not be bundled into deployment unintentionally.

## Connection contract: not activated

Endpoint: POST /api/ai/receptionist, JSON, Authorization: Bearer <dedicated tool secret>. Never put the secret in the prompt, URL, customer client code, or a database owner's password field.

Required server setup after approval:

- TELNYX_AI_INTAKE_ENABLED remains false/unset until explicitly activated.
- TELNYX_AI_CALLBACKS_ENABLED remains false/unset until callback persistence is explicitly activated after testing/review. Enabling catalog access alone must not enable callback writes. Current callback persistence requires VERCEL_ENV=production and no conflicting VERCEL_TARGET_ENV.
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

Use a Telnyx-provided conversation identifier as a preset, not a caller/model-chosen value. Validate the actual format in the draft tool test before connecting it. Prompt instructions must obtain and read back name, phone, category, city, scope and requested time and ask callback permission before invoking. Callback permission is NOT SMS, marketing, recording or payment consent.

No direct booking, completion, cancellation, refund, payout, arbitrary-recipient, customer-record lookup or arbitrary URL action is supported. Unknown fields/actions are rejected. Success means the request is durable; it never means the owner read the email or a job is booked.

Current Sora draft still says these tools are unavailable. Do not remove that boundary until approved setup, tool attachment, privacy review and end-to-end tests are complete. No tool attachment was made this turn.

## Recommended fix order and launch decision

1. Confirm "board" means Owner Dashboard and decide the after-hours/on-call policy.
2. Scoped preview push approved on 2026-09-06. Isolate the four files listed above from unrelated dirty changes, validate the exact commit and verify the preview build. Production promotion and live AI activation are not approved by this preview release.
3. Complete approved secure configuration, record/privacy choice and modest test budget. Do not switch the working phone forwarding.
4. Test catalog/callback tool with fictional data in preview/test mode; verify one case, one timeline, owner notification and failure behavior in the actual system.
5. Add and test every-call completion reporting and missed-event reconciliation. Keep customer claims limited until this works.
6. Test customer booking handoff and one complete customer/Easer/owner workflow, including failed email, interrupted call, no response, declined transfer and voicemail.
7. Verify true AI/telephony cost boundaries, then obtain the exact live routing approval (all calls / missed calls / after-hours). Only then activate.

Safe to review locally and prepare a preview; NOT certified for live AI activation. Preserve manual payouts. No financial logic or Stripe Connect switch changed.

Official references inspected: [Telnyx webhook tools](https://developers.telnyx.com/docs/inference/ai-assistants/no-code-voice-assistant), [insight-group completion delivery](https://developers.telnyx.com/docs/inference/ai-insights/insight-groups). These describe available mechanisms, not proof that our production integration is configured or delivering.
