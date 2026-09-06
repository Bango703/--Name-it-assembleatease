# Sora intake-only release: exact scope and activation gates

Status: LOCAL, TESTED, NOT PUSHED / DEPLOYED / ENABLED. Latest user scope supersedes full transactional voice booking. Do not deploy the earlier 12-runtime-file fix package as part of this request.

## 1. What changed

- Added independent `/api/ai/support` handler for detailed customer requests and Easer support. Nine topics per role; no privileged account/booking/payment actions.
- Added explicit structured project fields, optional-data handling, missing-detail list, active-job/safety priority, one-Case-per-call dedupe, fixed owner email and notification-attempt timeline.
- Prepared complete replacement prompt and two tool schemas with a three-node attachment plan. These are local files, not saved provider configuration.
- Prepared focused offline tests. Reused the previously local shared validator and network-denying test preload without changing them.

## 2. Why it changed

The old callback could not hold structured full-job details, and live Easer support intake was absent. A standalone endpoint isolates this change from the paused full-booking, payment and readiness changes. It protects customer expectations, Easer privacy, owner visibility and platform money.

## 3. Exact files

Runtime release (only these two):

1. `api/ai/support.js` — new this pass.
2. `api/_ai-intake-validation.js` — existing local shared helper; not yet in production baseline.

Tests/support files:

3. `scripts/test-sora-support-intake.mjs` — new this pass.
4. `scripts/sora-offline-test-preload.mjs` — existing local network blocker, unchanged this pass.

Configuration/review artifacts:

5. `business-artifacts/telnyx-sora-intake-only-prompt-2026-09-06.txt` — target global instructions, not active.
6. `business-artifacts/telnyx-sora-intake-tool-contract-2026-09-06.json` — tool contracts and name-based node attachment plan; not a directly submittable API payload and contains no secret.
7. `business-artifacts/telnyx-sora-intake-capabilities-2026-09-06.md` — 52-capability have/need inventory, risk review and test plan.
8. `business-artifacts/telnyx-sora-intake-release-2026-09-06.md` — this release checklist.

Documentation-only update in the original worktree: latest-scope note in `business-artifacts/telnyx-ai-implementation-board-2026-09-06.md`. Do not copy its unrelated accumulated history into a release commit just to publish this endpoint.

Clean test base: production `4c59619012196cca71cc18528f8420c75088faa8` in `C:\Users\tgbiz\AppData\Local\Temp\aae-intake-only-check-e1d75fda`. New files overlaid with no `.env` files; dependency directory is a junction, not a copied credential directory. No branch push or commit made.

## 4. What was not changed

- No live data, database schema, prices, fees, tax, discounts, rewards, Stripe, refunds, cancellations, payouts, dispatch, account readiness or identity logic changed.
- No phone route, Telnyx assistant version, recording setting, integration secret, production/preview variable or spending setting changed.
- No calls, texts, test emails or paid external tests initiated. Only read-only Telnyx configuration checks occurred in this pass.
- No website layout, customer/Easer UI or public copy deployed. No customer/pro records looked up or attached from claimed references.
- Earlier local `receptionist.js`, `_pro-support-intake.js`, `_booking-continuation.js`, booking/Connect guards, voice lifecycle webhook and owner UI improvements remain untouched and are NOT required dependencies of this release.
- No file or record deleted. Unrelated dirty files remain preserved.

## 5. Validation performed

Commands:

```text
node --check api/ai/support.js
node --check scripts/test-sora-support-intake.mjs
node node_modules/eslint/bin/eslint.js api/ai/support.js api/_ai-intake-validation.js scripts/test-sora-support-intake.mjs
node --import=./scripts/sora-offline-test-preload.mjs scripts/test-sora-support-intake.mjs
```

All PASS; focused suite reports 373 checks. It includes the real Case helper with a fake RPC boundary. Full `npm run test:launch` also PASS in the isolated production-based worktree with the network-denying preload. Final prompt/contract tests and scoped lint rerun PASS after documentation/test refinements. Existing root `npm run test:sora` also PASS. The deliberate email/timeline failure fixtures print warnings; they did not touch live services.

Existing unrelated full-suite warnings: one unused ESLint-disable in `apply-flagship-cities.mjs` and informational brand-blue variants. No new lint errors.

## 6. Remaining warnings / integration instructions

Feature gates:

- Existing `TELNYX_AI_INTAKE_ENABLED=true` and dedicated `TELNYX_AI_TOOL_SECRET` are required.
- Existing `TELNYX_AI_CALLBACKS_ENABLED=true` is required.
- NEW `TELNYX_AI_SUPPORT_ENABLED=true` must be explicitly activated after deployment approval. Absent/false disables new request writes.
- `VERCEL_ENV` must be `production`, and custom `VERCEL_TARGET_ENV` must be absent or `production`. Preview cannot write requests even if credentials are shared.
- Existing durable rate limiter and owner notification settings remain required. Both old and new intake use `telnyx-ai:intake` bucket, not independently bypassable quotas.

After approved deployment:

1. Verify disabled/unauthenticated behavior without submitting real intake. Never expose the shared secret in a report, command output or tool description.
2. Create two new Telnyx shared webhook tools from the local contract, using the existing protected Authorization header/secret reference. Preset actions; preset `callControlId={{call_control_id}}`. Never expose either as a model-controlled field.
3. Connect only the approved test version first. Replace its global prompt, not append to the old conflicting prompt. Replace all node-specific policies/tool scopes with the name-based attachment plan resolved to actual shared tool IDs. Preserve routing edges and the fixed transfer/hangup settings. Do not delete old shared tools or promote to public routing.
4. Exclude `request_callback`, the earlier Pro-intake tool and `prepare_booking` from the new version. A model cannot use an older tool to work around a conflict or disabled flag. The new endpoint intentionally shares the `telnyx-ai:<call hash>` namespace across both roles to reject duplicate/cross-role submissions for one call.
5. Read back saved assistant/version/node/tool configuration and verify exact prompt, preset fields, auth reference and endpoint. Check options and all supported topics. A green save badge is not proof of working tool calls.
6. With approved synthetic-live scope, submit a clearly labeled test customer request and a test Easer request. Verify one Case/owner alert each, full data in Case detail and actual delivery receipt. Do not create real bookings or payments.
7. Obtain a bounded paid voice-test approval; do not infer it from source-code deployment. Test full calls, transfer and after-hours paths before requesting public-routing approval.

Known limitations:

- New route/flag/tool behavior has not been tested in production yet.
- Owner alert is attempted after Case save. No durable outbox closes the crash gap; daily open-Case monitoring is required. Initial Case+creation event is atomic, email is not.
- No signed voice-lifecycle integration is included here. It is incorrect to say all abandoned calls become consented requests.
- Transfer-hour result is server-calculated but does not hard-disable Telnyx's separate transfer tool. Until deterministic gating exists, do not promise impossible after-hours transfers.
- Recording-off is not a no-transcript/no-log guarantee. Pattern rejection is defense in depth, not complete secret redaction. Do not collect credentials in the first place.
- One confirmed request per call. Correcting after save or a second independent issue requires human/contact follow-up, not silent overwrite.
- Preferred dates are preserved as caller text, not converted into guaranteed appointments. Items are descriptions/quantities, not a priced cart.

## 7. Is it safe to deploy?

The isolated intake-only code is ready for an explicitly approved, default-off deployment and controlled integration testing. It is NOT approved for public traffic solely from offline tests. No push/deploy/activation was performed because current scope did not explicitly approve those operations.

Do not commit or deploy the dirty original worktree wholesale. Stage only this exact new-file scope from a clean production-based release branch. Full phone booking/payment remains paused, not silently enabled by this release.
