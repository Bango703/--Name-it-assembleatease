# Persona for Easer identity verification

Date: 2026-11-21. Owner: "persona is open ... i need that setup". Status (2026-11-22, owner: "i need it ready"): ready except the owner-only password and secret steps in "Go-live state" below.

## Why
- Applicants stop at the ID step. The follow-up reminders (PR #475) fix the "nobody told them" half. Persona adds a second provider with more control over the flow.
- Cost: Persona's startup program is 500 free verifications a month, then $1 each, for up to 12 months ([withpersona.com/startups](https://withpersona.com/startups)). Stripe Identity charges per verification.
- One truth stays: `profiles.identity_verified`, written only by a provider's signed webhook.

## What is built (branch `feat/persona-identity`)
| Piece | File |
|---|---|
| Persona client, signature check, event meaning | `api/_persona.js` |
| Provider switch with automatic Stripe fallback | `api/_assembler-onboarding.js` `createIdentityVerificationSession` |
| Signed webhook | `api/webhook/persona.js` (`/api/webhook/persona`) |
| One outcome module for both providers | `api/_identity-outcome.js` (Stripe webhook now calls it too) |
| Follow-up reminders read Persona status | `api/cron/identity-followup.js`, `api/_identity-followup.js` |
| Columns | `api/migrations/133_persona_identity.sql` |
| Provider-neutral ID page copy | `assembler/verify-identity.html` |
| Guard | `scripts/test-persona-identity.mjs` |

Persona is used only when ALL are set: `IDENTITY_PROVIDER=persona`, `PERSONA_API_KEY`, `PERSONA_INQUIRY_TEMPLATE_ID`, and migration 133 applied. Anything missing or any Persona error gives the applicant a working Stripe check.

## Owner steps in the Persona dashboard (Sandbox first)
1. **Inquiries > Templates > Create template > "Government ID and Selfie"** (auto-detects the ID type, so the applicant picks nothing). Publish it and copy its ID (`itmpl_...`).
2. **Developers > API > create an API key** (Sandbox). Copy it once.
3. **Developers > Webhooks > Add webhook**: URL `https://www.assembleatease.com/api/webhook/persona`; events `inquiry.completed`, `inquiry.approved`, `inquiry.failed`, `inquiry.declined`, `inquiry.marked-for-review`, `inquiry.expired`. Copy the webhook secret.
4. **Vercel > Settings > Environment Variables (Production)**: `PERSONA_API_KEY`, `PERSONA_INQUIRY_TEMPLATE_ID`, `PERSONA_WEBHOOK_SECRET`. Leave `IDENTITY_PROVIDER` unset until the legal wording below is approved and a Sandbox test passes.
5. Run migration 133 in Supabase.
6. Production: apply for Persona's startup program, repeat steps 1-3 in the Production environment, replace the three values, then set `IDENTITY_PROVIDER=persona`.

## Legal wording to approve before go-live (General Counsel)
The contractor agreement and Privacy Notice name Stripe Identity as the biometric processor. Texas law (Capture or Use of Biometric Identifier Act) requires notice before capture, so the documents must name the provider actually used.

**Contractor agreement, section 6 "Identity Verification Requirement"** (requires a new `CONTRACTOR_AGREEMENT_VERSION`; Easers are prompted to acknowledge, not blocked):
> As a condition of activation and the right to receive job offers, the Contractor must complete identity verification through the third-party identity verification service the Company designates, currently Stripe Identity (operated by Stripe, Inc.) or Persona (operated by Persona Identities, Inc.). The provider may collect a government-issued identity document, images, and facial identifiers or other biometric information to compare the Contractor's identity document and selfie. The provider presents its own verification notice and consent flow. AssembleAtEase generally receives verification status and reference identifiers rather than copies of raw identity documents. Additional details, retention information, and a contact path for an alternative verification method are provided in the Privacy Notice.

**Privacy Notice** (requires a new `PRIVACY_NOTICE_VERSION`): replace "Stripe Identity" with "our identity verification provider (Stripe Identity or Persona)" in the data-collected list, the identity section, the retention paragraph ("The provider controls raw identity-document and selfie retention under its identity-data controls ...") and the redaction request ("request that we seek eligible redaction from the provider"). Keep Stripe named for payments.

## Not done here, and why
- The two legal documents are unchanged: wording and timing are the owner's decision.
- Persona dashboard setup: the template editor loads inside frames the browser automation could not read or click (2026-11-21), and API keys and secrets are entered by the owner.

## Go-live state (2026-11-22)
Done:
- Migration 133 applied in production (columns verified through the API; `platform_schema_state` row 133).
- Persona inquiry template "Government ID (with autoclassification) and Selfie", `itmpl_AS9QkdzFwWLRQCpnK41r3kM25XZd7Y`, published and deployed to Production and Sandbox.
- Production webhook form: URL `https://www.assembleatease.com/api/webhook/persona`; events inquiry.approved, completed, declined, expired, failed, marked-for-review; API version 2023-01-05 (the version `api/_persona.js` calls); key inflection kebab (`reference-id`, `name-first`). Saving it asks for the account password.
- The name on the ID must be the account's name, and 18+, for Stripe and Persona alike (PR #485).
- Privacy Notice names Persona, the ID name and age check, and provider-neutral retention and redaction (legal version 2026-11-22-identity-provider-v1). The owner's onboarding resend email says "identity verification" instead of "Stripe Identity".

Owner only (passwords and secrets are never entered by an agent):
1. Persona: type the password to save the webhook, then copy its secret.
2. Persona > API (Production): create an API key.
3. Vercel > Production: `PERSONA_API_KEY`, `PERSONA_WEBHOOK_SECRET`. `PERSONA_INQUIRY_TEMPLATE_ID` and `IDENTITY_PROVIDER=persona` are not secrets. Persona is used only once the key and the template are both present (`identityProvider()`), so setting the switch first is safe.
4. Redeploy (env changes apply to new deployments), then one real verification end to end.

Configured 2026-11-22 (after the steps above): webhook `wbh_AS9QkdzNBhsUgz48vZNp4CY71JdcNy` enabled in Production (Persona creates webhooks disabled; Enable needs the password); `PERSONA_API_KEY` and `PERSONA_WEBHOOK_SECRET` added by the owner, `PERSONA_INQUIRY_TEMPLATE_ID` and `IDENTITY_PROVIDER=persona` added as Config variables, all Production. Live once the next production deployment includes them.

Contractor agreement: unchanged on purpose. A new agreement version makes every Easer re-sign the whole agreement (sign prompt; price requests and membership wait for it; it counts as an inactivity reason). Persona applicants see Persona's own biometric notice and consent before capture, and the Privacy Notice names both providers, which covers Texas's notice-before-capture rule. The section 6 wording above goes in with the next substantive agreement change (backlog AGREEMENT-ID-PROVIDER-WORDING).
