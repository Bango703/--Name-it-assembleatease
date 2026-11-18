# Houston Google Ads: launch-readiness checklist

Status as of 2026-11-18, checked against the live Google Ads account, the production database and the code on `main` (commit 58538ace). Operating model (owner, 2026-11-18): automatic dispatch across the whole Houston service market; Easer capacity, availability and Easer ZIP codes are not launch conditions; demand above supply triggers recruitment. Nothing below is changed without the owner's approval. Details and evidence: `root-causes-and-plan-2026-11-18.md`.

**PASS** = verified ready. **FAIL** = must change before launch. **WARNING** = launch possible, but money or trust is at risk until fixed. **TEST** = needs a live check.

## Must be true before the campaign is enabled

| # | Item | Status | Evidence | Who acts |
|---|---|---|---|---|
| 1 | Google Ads balance paid ($99.35 overdue) | FAIL | Account banner: "Your ads aren't running - Make a payment" | Owner |
| 2 | Houston bookings dispatch automatically, as the operating model says | FAIL | `AUTOMATIC_DISPATCH_ZIP_PREFIXES` = 782, 787; Houston bookings saved with `needs_manual_dispatch = true`; auto-dispatch cron skips them; Houston median 535 min to assignment vs San Antonio 6 min | Owner authorizes; then code change on a PR (critical module) |
| 3 | Customer confirmation email for Houston bookings matches automatic dispatch | FAIL (follows #2) | Today it says "Our team is reviewing local Easer availability ... the appointment is not assigned until then." | Resolved by #2 |
| 4 | Location targeting covers Greater Houston | FAIL | Campaign targets "Houston (city)" only; Spring, Katy, Cypress are separate Google targets. Proposed: 10 metro counties (Harris, Fort Bend, Montgomery, Brazoria, Galveston, Liberty, Waller, Chambers, Austin, San Jacinto), Presence | Owner approves; then one setting |
| 5 | One Primary conversion, "Book appointment", valued at the platform's share | FAIL | Six Primary goals today; value sent is the tax-inclusive total ($1 in May) | Owner approves account change; small code change for the value |
| 6 | Phone booking step shows a total and Continue after an item is picked | FAIL | 390 px walkthrough: Continue 2.5 screens below, not pinned; extra notes screen; 7 of 40 measured /book visitors finished choosing items | Code on a branch; owner approves push |
| 7 | Paid bookings are recorded with their ad source, without cookies | PASS | #467 merged: tagged /book links store `utm_source/medium/campaign`; campaign final URL suffix is `utm_source=google&utm_medium=cpc&utm_campaign=houston_search` | - |
| 8 | End-to-end attribution proof | TEST | One test booking from a tagged link, marked as a test, must show `houston_search` in the booking row | Engineering, with owner's okay |

## Ready now (verified in the account)

| # | Item | Status | Evidence |
|---|---|---|---|
| 9 | Network | PASS | Search only; Display and partners off |
| 10 | Automation that buys unwanted traffic | PASS | AI Max, text customization and final URL expansion off |
| 11 | Schedule | PASS | Every day 7:00 AM-10:00 PM Central; account clock Central; no hourly bid adjustments (no evidence supports any) |
| 12 | Bidding and budget | PASS as configured | Maximize clicks, $4 max CPC, $10/day. Raising bids is not recommended (economics in plan section 6); budget is the owner's call |
| 13 | Location option | PASS | Presence (people in or regularly in the area), so Korea- or Kenya-type clicks are excluded |
| 14 | Landing page speed | PASS | PageSpeed mobile 96; content visible in 2.0 s |
| 15 | Price shown in ads matches the catalog | PASS | "TV Mounting From $99" matches the $99 item; $5 service call and tax are added at checkout |

## Recommended before launch (owner approval needed)

| # | Item | Status | Note |
|---|---|---|---|
| 16 | Ad groups aimed at jobs that can pay for a click | WARNING | Today: TV Mounting + Furniture. Proposed: TV Mounting (copy toward larger setups), new Outdoor & Playsets group, Furniture paused. A single $124 TV cart keeps $33 |
| 17 | Negative keywords | WARNING | 33 in place; add competitor names seen in search terms (for example "d riggs") as they appear |
| 18 | Profitability stop-loss agreed | WARNING | Proposed: pause and review at $300 spent with no completed paid job, or 60 days. A money rule, not a capacity rule |
| 19 | Dispatch health panel | WARNING | Stranded-booking alerts exist (45 min). Missing per-market acceptance rate, time to assignment, cancellations by reason, fulfillment rate (plan section 11) |
| 20 | Recruitment triggers written down | PASS (documented) | Plan section 11: acceptance below 60%, median assignment above 60 min, any "no Easer" cancellation, daily-cap hits, or about 5+ paid bookings a week per active Houston Easer |
| 21 | GA4 shows real customers only | WARNING | 10 of 57 /book opens came from Sweden/Ireland; add internal and non-US filters |

## After launch: what gets watched

| When | What | Source |
|---|---|---|
| Daily, first 2 weeks | Spend pacing (is the budget gone by noon?), any unassigned Houston booking, any booking flagged for manual dispatch | Google Ads; stranded-bookings alert |
| Weekly | Search terms and new negatives; user-location report by county; paid-search bookings and completions from our database; cost per completed paid job vs what those jobs kept; offer acceptance and time to assignment | Google Ads; bookings table; dispatch_offers |
| At $300 spent or 60 days | Stop-loss review; scale or re-aim | Plan section 10 |
| Whenever a trigger fires | Houston recruitment push | Plan section 11 |
