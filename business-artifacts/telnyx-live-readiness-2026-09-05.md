# Telnyx and phone-lead readiness - September 5, 2026

## 1. What changed

### Live account settings

- Public number **(979) 232-5139** always forwards to **+1 737 290 6129**. Telnyx Voice Mail is disabled. The owner previously confirmed the forwarding/voicemail issue on his handset was resolved.
- Outbound caller-name listing **ASSEMBLEATEASE** was saved and rechecked. Recording and inbound caller-name lookup remain off.
- Messaging profile **4001a044-c74b-4753-8d32-da87d3a0ef02** is enabled; primary webhook is https://www.assembleatease.com/api/webhooks/telnyx.
- STOP/START/HELP replies were reloaded with Save/Reset disabled:
  - STOP: AssembleAtEase: You have opted out of text messages. Reply START to resume.
  - START: AssembleAtEase: Text messages are active again. Reply STOP to opt out or HELP for help.
  - HELP: AssembleAtEase support: Reply with your booking question or email service@assembleatease.com. Reply STOP to opt out.
- 10DLC campaign **C7Y2XG9** / 4b3001a0-456d-9e31-9bab-2133f16f0444 is **Active** and the public number is **Assigned**. An older rejection note about the phone/consent field remains displayed. The current campaign message flow and website code have the separate optional unchecked SMS checkbox. No resubmission or review fee was triggered.
- Telnyx's public webhook key exactly matches current Vercel production. Protected API-key/from-number/profile variables were not exposed or independently compared.

### Website repairs now live

- Failed consent/inbox/delivery persistence returns 503 for provider retries.
- Signed timestamps and atomic conditions preserve the newest consent/delivery state; STOP wins an exact tie.
- Duplicate inbound events have one stable inbox ID. Early receipts retry when the sender's log is absent; late sent events cannot downgrade final status.
- Log errors are checked without resending accepted messages or blocking bookings.
- STOP ALL and UNSTOP match carrier behavior; conversational YES does not reverse opt-out.
- Phone-click measurement is separate from connected calls and bookings.
- New website-call tag waits for consent, updates displayed public numbers and mobile dialing together, preserves markup/other people's numbers, restores public numbers after withdrawal, and ignores stale callbacks. GPC remains respected.
- Specific Google measurement origins and call-library paths were added to CSP; no wildcard script permission or unsafe-eval was added.

### Google Ads

- Active account **293-675-5780**, assembleatease@gmail.com. The separate legacy account was not modified.
- Created **Website calls (60+ seconds)**, ID 7749682528, tag **AW-16551666395/NyDNCOCKq-8cENvFudQ9**.
- Calls from website; destination (979) 232-5139; count One; minimum 60 seconds; 30-day click window; no revenue value.
- Creation initially disabled Secondary and described the goal as non-default, but the saved result was account-default/Primary. This was detected and corrected. **Secondary action was verified after saving and reloading.** Do not describe the account goal itself as excluded.
- No campaign budget, bidding strategy, ad text or geography setting changed in this pass. No fake conversion or paid ad click was generated.

## 2. Why it changed

- **P0:** silently acknowledging failed opt-outs can leave customer/Easer consent wrong and hide message failures.
- **P1:** duplicates, stale delivery status and confusing call metrics undermine owner follow-up and lead attribution.
- **P1:** number substitution must not break mobile dialing, overwrite markup, alter other people's numbers or survive consent withdrawal.
- The computer-use skill guided live browser checks. Saved settings were reloaded rather than trusting unsaved forms. This is not a whole-platform audit.

## 3. Files changed and release record

### Six deployed files

1. api/_sms.js
2. api/webhooks/telnyx.js
3. assets/js/cookie-consent.js
4. scripts/test-google-ads-conversion.mjs
5. scripts/test-telnyx-webhook.mjs
6. vercel.json

Base: previously live commit 88d7c418219a84364f6a672e6d60bfe7174e3cbf.

- SMS commit: cb64a2fb27ac2babe6b5711be222f205bcc7e9ce; deployment dpl_Au6gHh1Wr2DaHRyY47EagEMj3SEg.
- **Current live commit: d3a72710a4c6e21eeae2d3e66340fd82a1f95b8a.**
- **Current deployment: dpl_8hVGUpW8tcT3AWJ5qwpA4jyk9ETV.**
- Release URL: https://name-it-assembleatease-c74zpa0n2-bango703s-projects.vercel.app.
- Promoted successfully to https://www.assembleatease.com.
- Local branch: fix/telnyx-phone-readiness-20260905.
- Clean isolated worktree: C:/Users/tgbiz/AppData/Local/Temp/aae-telnyx-release-514213df2699.

**Not pushed to GitHub.** Repository rules require the owner explicitly to say "push". A later deployment from unchanged remote source can undo this repair. Push/merge the scoped release before deploying that old source.

Two earlier author-identity-blocked deployments never became live. The owner completed Vercel login. Successful release commits use the existing GitHub owner's email verified against the previous production commit; global Git configuration was not changed.

### Local only, excluded from deployment

- .env.example: SMS variable documentation.
- scripts/seo_new_pages.py and scripts/seo_p0_fixes.py: canonical public phone, not private forwarding number.
- business-artifacts/owner-ops-card.md: internal callback/safety/log-review routine.
- This internal report.

## 4. What was not changed

- No pricing, tax, fees, payments, capture, refunds, payouts, Stripe settings, booking state or Easer readiness changes.
- No database migration, real booking, real outbound SMS, emergency call, new number or paid service.
- Existing protections retained: voice $10/day, two channels, $0.10 maximum destination rate, repeated-call guard; SMS $5/day, USA-only. These are **limits, not daily charges or a total monthly spending ceiling**.
- Unrelated original-worktree files were preserved/excluded: business-artifacts/backlog.md, _mobileframe.html, assets/css/booking-flow-mock.css, assets/js/booking-flow-mock.js, assets/js/easer-notifications.js, booking-flow-mock.html, tmp-fix-barry-b.sql.
- Removed only the two agent-created environment downloads from the isolated worktree. The user's existing cached environment file was untouched. Deployment manifest excluded environment downloads, unrelated new files and this report.

## 5. Validation performed

| Check | Result | Evidence and limit |
|---|---|---|
| Forwarding/CNAM | PASS configuration | Saved values rechecked; owner reported forwarding works. Handset greeting not independently heard. |
| Carrier registration | PASS configuration | Campaign Active, number Assigned; no resubmission. |
| Production public key/schema | PASS | Exact key match; zero-row queries verified required consent/log columns. |
| Customer/Easer consent handling | PASS local; WARNING end-to-end | Signed real-handler tests cover retries, ordering, STOP ALL, UNSTOP, HELP, YES and duplicates. No real handset sequence. |
| Owner SMS delivery truth | PASS local; WARNING end-to-end | Tests cover early receipts, failed writes and stale events; repaired code is live. |
| Recent SMS log | WARNING | All eight recent database entries were suppressed for no_consent_recorded, not carrier failure. No consent was overridden. Earlier Telnyx recent outbound/webhook searches had no message events. |
| Webhook security | PASS limited live | Unsigned empty POST returns 400 Missing Telnyx signature headers. Forged/expired signatures rejected locally. No real signed production receipt available. |
| Live release identity | PASS | Public script SHA256 exactly matches tested release; new call label present. |
| Call libraries | PASS browser | Google wcm/loader.js and call-tracking_9.js loaded after acceptance on staged and public contact pages. Organic phone links stayed correct. |
| Consent withdrawal | PASS browser/local | Privacy > Cookie choices > Decline, then reload: call libraries absent, public phone correct. Original accepted preference restored afterward. Unit tests cover restoration, stale callbacks and GPC. |
| Ads action | PASS settings; WARNING attribution | Reloaded Secondary, One, 60 seconds, no value. Genuine ad-originated call still needed. |
| Customer/Easer/owner smoke | PASS limited | /contact, /book, /assembler/apply, /owner HTTP 200; unauthenticated owner live-ops API 401. No new booking/payment test. |
| Focused tests | PASS | Telnyx behavioral tests, Ads source/behavior tests, ESLint, syntax and diff whitespace. No real SMS/network in behavioral tests. |
| Source-of-truth | PASS | 12 PASS, 0 WARNING, 0 FAIL. |
| Broad static smoke | PASS | Smoke checks; 776 inline scripts across 427 pages parse cleanly. |
| Existing legal regression | FAIL, pre-existing | scripts/test-legal-consent-and-privacy.mjs:79 expects agreement 2026-08-16; unchanged committed version is 2026-08-28. Full legal-suite pass is not claimed. |

## 6. Remaining warnings and operating behavior

1. **E911 disabled:** exact physical dispatch address/unit/ZIP is still needed; owner question unanswered. Displayed terms/costs also require approval. Do not assume a mailbox/business address is suitable. Never call 911 to test; 933 verification follows proper setup.
2. **Real SMS/HELP/STOP/START delivery unverified:** configuration and mock tests cannot prove handset/carrier delivery. The earlier handset-test request was declined. No SMS consent was fabricated and no real text sent.
3. **Mobile voicemail greeting unverified:** calls forward 24/7, including after hours. The mobile's ring/missed-call/voicemail behavior applies. No Telnyx business-hours schedule or separate after-hours greeting exists. Published hours: Mon-Fri 7 AM-5 PM, Sat 7 AM-1 PM Central.
4. **Git source synchronization pending:** current production repair exists on a local branch until explicit "push" instruction.
5. **Independent SMS failover blank:** needs an approved independent endpoint/storage and cost decision. Another route on the same Vercel deployment is not independent recovery.
6. **Website owner call/missed-call history not implemented:** use Telnyx call records and the mobile missed-call list with manual callback tracking for now.
7. **Genuine call/booking attribution unverified:** a click is not a call; a qualifying call is not a booking. Existing booking/quote conversions were not tested with a real customer this pass.
8. **No Houston/San Antonio numbers purchased:** the public number can serve all three cities; additional numbers are optional.
9. Existing base measurement/privacy wording was not comprehensively re-audited. Privacy checks above specifically prove the new call-library behavior, not a full legal/cookie compliance certification.

Suggested greeting, **not recorded/published**: "Thank you for calling AssembleAtEase. We cannot take your call right now. Please leave your name, phone number, city, and the service you need. You can also book at assembleatease.com. We will return your call during business hours."

## 7. Deployment and launch recommendation

**Scoped SMS and call-tracking repairs are deployed and listed checks pass. The complete phone/SMS operation is not yet fully tested.**

Keep email, direct forwarding and manual follow-up as the backstop until a real consented text/reply sequence and genuine ad-originated call are observed. No whole-marketplace/payment launch approval, increased budget, automated payout activation or paid telephony purchase is implied.

### Documentation used

- [Telnyx STOP/restart keywords](https://support.telnyx.com/en/articles/1270091-sms-opt-out-keywords-and-stop-words)
- [Telnyx receiving webhooks](https://developers.telnyx.com/docs/messaging/messages/receiving-webhooks)
- [Google website-call setup/mobile callback](https://support.google.com/google-ads/answer/6095883?hl=en)
- [Google tag CSP requirements](https://developers.google.com/tag-platform/security/guides/csp)
- Google's public wcm/loader.js and call-tracking_9.js sources were checked directly. Forum suggestions were not relied on as implementation authority.
