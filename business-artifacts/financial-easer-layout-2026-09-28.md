# Financials Easer identity and manual payout preference

## Executive summary

The Easer Payout Ledger places tier badges directly after names, so different name lengths move their starting position. A previous badge-width repair in PR226 does not change this inline Financials layout. The ledger also labels a manual-only profile preference as a general payout method and colors a missing preference red. That is misleading for an Easer whose earnings use Stripe.

This is a presentation repair: a fixed tier slot with a narrow-screen stack, and truthful manual-preference labels. No financial API, earning, payment, payout, routing, readiness or profile data is changed.

## PASS / WARNING / FAIL matrix

| Perspective | Status | Evidence / limitation |
|---|---|---|
| Owner: identity and tier layout | PASS scripted; visual check pending | Actual ledger renderer and stylesheet contract; independent responsive-wrapper review |
| Owner: manual preference meaning | PASS | Twelve known, null, absent and unsupported value cases; Connect/manual/mixed earnings |
| Owner: payout amounts, record/review actions | PASS | Same ten columns; baseline/current comparison preserved money, dates, controls and totals |
| Easer / customer money and notifications | Unchanged | No API, calculation, payment, profile or sender edits; no live mutations |
| Rendered 1440 / 768 / 375 layout | WARNING | Browser inventory call timed out and reset the session; no rendered or accessibility certification |
| Full launch and CI-only checks | PASS locally | `npm run test:launch`, lint, inline syntax, SEO/sitemap, voice-call and Sora intake checks |
| Brand-color audit | WARNING, non-blocking | Existing 39 app-shell blue variants; this repair adds no palette change |
| Release | Not deployed | Protected main requires Constitution guards; prior repairs are blocked by GitHub account billing |

## Audit findings and business impact

- **P1: manual preference looks like a payout failure.** `owner/index.html` maps `payout_method_preference` from `/api/owner/payouts` to red “Not selected.” `api/owner/payouts.js` reads a profile preference; it does not verify a connected account or payout capability. The Easer manual-preference picker in `assembler/payouts.html` is hidden when Connect is enabled. An absent manual preference can therefore be expected, not a broken payout. Confusing this could prompt unnecessary Easer follow-up or a mistaken manual payment. Actual route and payout status stay attached to each earning.
- **P2: badges move with name length.** The Financials renderer concatenates the name and tier as inline content. Matching badge widths alone cannot align their positions. The repair gives the name and tier separate grid slots inside the existing Easer cell, retaining contact and closure information below them. On narrow screens, the tier stacks below the name. All six owner tier render locations were inspected; Financials is the repeated inline name/tier case.

No P0 money/security defect was identified in this bounded display audit. No customer or Easer booking state changes. No charge, transfer, manual payout, message or profile update was executed. This is not completion of the wider platform audit.

## Before → after

| Before | After |
|---|---|
| Tier starts wherever the person's name ends | Tier occupies the same fixed slot in each desktop row |
| Long name and Professional badge compete for space | Name wraps; narrow-screen tier sits below the name |
| “Preferred Method” | “Manual payout preference” |
| Stored empty preference shown as red “Not selected” | Neutral “Not provided” |
| Absent or unsupported response value looks like an unchosen preference | “Unknown” |

The table explains that preferences apply to manual payouts and Stripe payout setup is managed separately. It does not infer “Stripe ready” from the current global mode or from account existence. Historical manual and Connect earnings can coexist. Tier values continue to come from the existing earnings source; this change does not alter an Easer's tier.

## Files and smallest safe fix

- `owner/index.html`: manual preference label/helper, explanatory copy and explicit name/tier layout within the existing ledger cell.
- `owner/assets/owner.css`: Financials-only identity grid, equal tier slot width, wrapping and <=800px stacking.
- `scripts/test-owner-payout-ledger-presentation.mjs`: actual mocked ledger renderer checks, preference states, escaping, amounts/actions and failure behavior; stylesheet contract checks are not a rendered layout test.
- `package.json`: run the focused regression in the launch suite.
- This report and `business-artifacts/backlog.md`: audit and release tracking.

## Validation and release recommendation

Run the actual ledger loader with varied names and Starter/Professional/Elite badges, manual/Connect/mixed unpaid jobs, every supported preference, null/missing/invalid values and read failures. Preserve ten financial cells, contacts, closure status, exact money formatting and record/review actions. Run full launch and CI-only checks before pushing the isolated branch. Verify real geometry at 1440/768/375 when browser access recovers.

Review this repair with the other pending owner changes before merging. Production release still requires the protected GitHub check to run successfully. Keep the backlog item in progress until deployed and validated.

Local launch validation completed with exit code 0. Log: `C:/Users/tgbiz/aae-financial-layout-qa-20260928/launch-validation.log`. Independent review also executed the actual old and new ledger loaders with fictional records and found the amount/date/action cells and totals byte-identical. No live requests were needed for this repair.
