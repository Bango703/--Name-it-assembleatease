# Sora Service Pro support: scoped connection checklist

Status: LOCAL IMPLEMENTATION TESTED, NOT DEPLOYED OR ATTACHED TO TELNYX.

The later "FIX ALL PLEASE" pass expanded the local release beyond these three files. Use the [current exact release manifest](telnyx-sora-fix-pass-2026-09-06.md); do not deploy the newer receptionist without its booking-continuation import and shared browser validator. This earlier checklist still describes the Pro tool contract.

## Release scope

Runtime files:

- `api/_ai-intake-validation.js`: shared existing call-reference/phone/text validation.
- `api/ai/receptionist.js`: preserve customer callback/catalog; delegate two authenticated Pro-support actions before catalog lookup.
- `api/ai/_pro-support-intake.js`: unverified Pro support options/intake, Cases persistence, owner email and notification-attempt event.

Regression file: `scripts/test-ai-receptionist.mjs`. Existing customer tests plus Pro feature gating, strict input validation, case labeling, lack of identity/profile/booking linkage, rate-limit failure, idempotency, retry conflict, concurrent duplicate, email/timeline failure, HTML escaping and accidental sensitive-digit rejection.

No schema migration, record deletion, pricing/tax/payout change, booking mutation, bank/identity processing, SMS action or public-routing change. The simple sensitive-digit detector is defense in depth, not a PCI/redaction system. Keep sensitive data out of the conversation itself.

## Configuration required after scoped deployment approval

- Reuse the existing dedicated `TELNYX_AI_TOOL_SECRET` / Telnyx integration secret reference. Do not rotate or expose it.
- Require existing `TELNYX_AI_INTAKE_ENABLED=true`, `TELNYX_AI_CALLBACKS_ENABLED=true`, durable rate limiter and production environment.
- Separately enable `TELNYX_AI_PRO_SUPPORT_ENABLED=true` only for the approved Pro-intake activation. Omitted/false fails closed. Preview still cannot persist real cases.
- Do not edit the dirty `.env.example` or `vercel.json` merely to document/activate this flag.
- Create no new Telnyx tool until the deployed handler and response gate are verified. Attach tools only to the already approved test version. Preserve five existing global tools and their credentials.

## Proposed tools (not currently attached)

`get_pro_support_options`: POST the existing `/api/ai/receptionist` endpoint with preset body `{"action":"support_options"}` and the same secret-backed Authorization configuration as the existing catalog tool. It returns enabled state, six accepted topics and `accountAccessEnabled=false`. This action does not need the furniture catalog, database or email to succeed.

`request_pro_support`: same endpoint/auth; preset `action=request_pro_support` and provider `callControlId={{call_control_id}}`. The model must not choose the call reference. Required model fields:

- `name`, `phone`, `city`
- `topic`: `application`, `account`, `assigned_job`, `access_or_parts`, `safety`, or `earnings`
- `issue`: non-sensitive issue summary, 10-1500 characters
- `preferredTime`: requested callback time, not promised availability
- `detailsConfirmed`: literal boolean true after readback
- `callbackConsent`: literal boolean true after explicit callback permission

Strict JSON schema: reject additional properties; do not allow booking/profile IDs, verified role, arbitrary email recipient, amount, card, password or payout fields. No existing-account lookup is implied by the topic. Emergency instruction takes precedence over collection; this intake is not an emergency dispatch tool.

Keep customer callback unavailable in the Pro node. Give the Pro node the two Pro tools plus the existing fixed transfer/hangup. Entry may read support options but should not save either kind of request. Role selection does not establish account access.

## Required prompt change after tool attachment

Replace the current truthful "no Pro support intake tool" limitation only after the tool is genuinely usable. Check support-options capability first, ask permission to collect necessary contact/issue details, read them back once and ask whether they are correct and the team may call. Save only after both confirmations. Confirm saved only after `success=true`. Explain it is a support request, not an application submission, approval, job update or payout action. Never promise response time or email delivery from an API success.

## Acceptance before marking the connection complete

1. Unauthenticated deployed request is denied; Pro actions remain disabled until the separate flag is approved/enabled.
2. Options request returns six topics and correct enabled state without needing the customer service catalog.
3. In one clearly labeled synthetic operator fixture, actual Telnyx tool invocation creates exactly one Pro case and one owner alert. Use the already approved owner destination only; no real applicant or job.
4. Owner Cases list and detail show Service Pro, unverified identity, contact/issue in the description, and no false customer/profile/booking linkage. Verify delivered from the real provider receipt, not a manual status write.
5. Repeat the exact request: same reference, no duplicate email. Changed retry: conflict, no overwritten original.
6. Verify a complete bounded voice intake after separate call-test approval. No extra outbound call is implied by deploying code.
7. Keep all-call ingestion, after-hours fallback, caller authentication and financial booking gates OPEN. This release does not finish those features.

Release must use a clean worktree containing only approved changes. Do not push or deploy the unrelated dirty root worktree. Explicit approval is still required before website deployment and enabling the new live workflow.
