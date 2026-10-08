# Organic growth fixes: October 7, 2026

This is the implementation receipt for the October 7 organic audit. Scope is unpaid acquisition, truthful measurement, customer content and fulfillment follow-up. It is not a whole-platform launch, legal, insurance or financial certification. The single prioritized backlog remains `business-artifacts/backlog.md`.

## What changed and why

1. **Protect accepted work.** An internal follow-up note is saved on the accepted October 16 Bullard booking. Local code restores manual assignment outside the canonical automatic-dispatch area when releasing an unaccepted assignment, clears obsolete offer tokens, rejects concurrent assignment/schedule/payment changes, includes saved-card assignments in owner acceptance visibility, and puts missing arrival evidence in Live Ops independently of email delivery. The arrival alert uses the same existing 60-minute rule as the cron and does not assert a physical no-show. These address customer/Easer uncertainty and stranded-work risk; they do not establish the cause of the two Tyler cancellations.
2. **Measure distinct outcomes.** Three GA4 key events are configured: `booking_confirmed`, `quote_requested` and `business_inquiry_submitted`, all without a default monetary value. Five event-scoped dimensions are saved: audience type, booking type, outcome stage, requested service city and requested service market. Website code emits the distinct events, deduplicates confirmations, separates recruitment/support traffic, scrubs raw query data and preserves safe first-source evidence. The old `booking_completed` event remains explicitly deprecated for compatibility. Confirming a form is not completed work or captured payment.
3. **Show genuine business outcomes.** An authenticated, read-only acquisition report is added to the existing owner Market Demand view. It groups booking creation cohorts by original recorded channel and requested service city, excludes explicit tests, distinguishes completed/cancelled/open jobs, and links to existing booking records. It uses canonical Financials projections plus observed amount evidence. Missing data stays unknown; self-referrals and historical source-only labels do not become invented organic revenue. Chicago-day date boundaries, partial datasets, repeat contacts and estimated processing fees are explicit.
4. **Correct the public contact route.** Google Business Profile's editor now shows the owner-confirmed 979-232-5139. The website and appointment links have consistent Google/organic/GBP tags with `website` or `book` content labels. The editor no longer shows a pending badge for the phone/website changes; the public Google Search result still displayed the old number at the last check, so public propagation remains unverified. Both old Python page generators are corrected so rerunning them cannot restore the retired public number. Current website public call links were already correct.
5. **Improve existing customer pages.** Nine service pages and two Austin guides now contain more useful scope/preparation details, relevant internal links and accurately bounded local job facts where owner-confirmed. No new city pages were added. All 412 sitemap URLs remain; only the 11 changed content pages receive new last-modified dates. Canonicals, existing prices, image labels, service schemas and booking CTAs are preserved.
6. **Prepare earned referrals and follow-through.** Three tailored partner introductions and two Bullard confirmation messages are prepared. Four public directory listings are confirmed to show the old phone. Their correction routes are documented; BBB, Yelp and YellowPages business login tabs are open. No messages, paid listing purchases or directory support submissions have been sent.

## Owner clarification and baseline correction

The owner confirmed that the May 18 $153 job and July $374 and $110 jobs were real customer work. All six recorded completed jobs are therefore treated as genuine in this audit. No live test flags needed changing. They reconcile in aggregate to $1,846.16 in inspected successful Stripe payments; the $454.16 displayed platform gross is before overhead/reserves and includes some estimated processing fees. Original acquisition sources remain partly unknown. This confirmation does not manufacture organic attribution or establish net profit.

The only public business number is 979-232-5139. Historical private forwarding configuration and owner test fixtures were not bulk-rewritten. Live forwarding, voicemail and answered-call outcomes were not tested by placing calls.

## Validation and boundaries

| Perspective / check | Result |
| --- | --- |
| Customer | Focused booking/quote/lead confirmation, consent, deduplication and source-handling tests; service CTA opens the preselected Furniture Assembly flow in a local browser. No real booking or card submission was used as a test. |
| Easer / operations | 46 targeted fulfillment checks pass: market gate, stale token, acceptance/schedule/financial-lock races, saved-card visibility and arrival review. Existing assignment, readiness, dispatch and payout regressions pass. Actual October 16 availability/travel/backup still needs human confirmation. |
| Owner / data / security | 58 acquisition checks plus UI behavior checks pass: owner authorization, private no-store responses, XSS escaping, stale sessions, overlapping periods, failed storage, unknown amounts, financial fallback and partial results. Local synthetic-data render at 390px and 1100px has no page overflow; table details expand. This is not live production API reconciliation. |
| SEO / content | 324 service pages / 54 cities, 17 article schemas and all 412 sitemap entries pass the SEO audit. Every changed page preserves original prices, images, service schema and booking CTAs. New FAQ text matches schema; all internal targets resolve. |
| Review requests | Three existing offline suites pass. Tests, open cases, return visits, opt-outs and already reviewed work are suppressed appropriately. The May/July jobs exceed the automatic 30-day window; no retroactive review messages were sent. |
| Release gates | Final gate results will be recorded below after the consent follow-up. |
| Payments / Stripe | No charge/refund/payout operations changed or exercised live. Pricing, fee formulas, tax calculations, payment timing and payout rails are unchanged. Regression success is not a new live Stripe certification. |

## What remains before completion

- **Release:** local code is not deployed. The isolated branch is `codex/organic-fixes-20261007` at `C:\Users\tgbiz\aae-organic-fixes-20261007`, based on `5f99fb9c`. The original workspace's unrelated dirty files remain intact. Review only this manifest; do not overwrite or deploy the unrelated 354-URL sitemap change.
- **Production observation:** after an explicitly approved release, verify the live file revisions, unauthenticated report rejection, owner source/finance reconciliation, consent behavior and new GA4 events. Browser attribution remains subject to consent and blockers; historical GA4 data is not backfilled. Custom dimensions require new event data and processing.
- **Indexing:** seven excluded service/guide URLs are strengthened locally. Request selective recrawl after those changes are live and recheck Search Console. Privacy, terms and the unavailable Setup Club offer are lower acquisition priorities, not reasons to invent content or demand that private pages be indexed. Google controls inclusion; 402/412 was the latest verified sitemap indexing result, not 412/412.
- **Contact listings:** Google public propagation and BBB/Yelp/Yahoo/MapQuest corrections remain open. Three editors require account login; MapQuest offers a free issue-reporting route while its direct claiming/editing service is paid. Use the prepared correction text and existing owner accounts; no purchase is needed for this task.
- **Operational commitment:** obtain actual customer and Easer replies for Bullard, confirm scope/travel and a feasible backup, and review scheduled authorization before travel. The internal note and draft messages do not meet that requirement by themselves.
- **Distribution:** partner introductions need explicit outbound instruction, followed by actual relationships and measured referrals. Prepared drafts are not earned links or new bookings. No paid campaigns or publishing settings were enabled.

## Weekly outcome review

Use matched complete periods within each system. Compare GSC customer service-page clicks separately from recruitment pages; GA4 organic new users and the three distinct key events; GBP call/website actions separately from answered qualified calls; owner source/city booking cohorts, completions, cancellations and recorded payments. Review unknown attribution, unresolved customer scope/arrival exceptions, actual labor/travel costs and new genuine reviews. No automated schedule was created. Consistency must be demonstrated by completed jobs over time.

## Rollback and release discipline

The work is isolated from unrelated changes and uses existing database columns/tables. There is no migration or new payout rail. Revert only the approved code/content batch if necessary; do not revert live financial records. GA4 additions can be unmarked or archived separately if necessary. Keep the corrected public phone even if rolling back website code. Existing old Analytics events remain compatible.

The repository's deployment rules require explicit permission before push/deploy; all preparation and verification happen first. Its instructions warn that a push can trigger production deployment. A branch push must therefore be treated as a release action unless the actual hosting configuration proves otherwise.

## Chairman / Owner's Office ruling

Prioritize completion reliability, truthful measurement and useful existing customer pages. The prepared code can be considered for a scoped release only after the final gates pass. Public indexing, directory propagation, customer commitments and consistent bookings are external outcomes that remain open until observed; they must not be marked fixed merely because code or drafts exist.

## Related evidence

- October 7 organic audit: `organic-growth-audit-2026-10-07.md`.
- Prepared referral introductions and directory correction routes: `organic-partner-outreach-2026-10-07.md`.
- Prepared customer/Easer confirmations: `organic-operations-messages-2026-10-07.md`.
- Single prioritized backlog: `backlog.md`.

## Buffer evidence: October 7, 2026

Read-only inspection of the logged-in Buffer account verified active publishing. The account is on the Free plan with three connected channels: Facebook Page, Google Business Profile and the founder's LinkedIn profile. A separate LinkedIn company Page is locked; Instagram is not connected. No reconnect or publishing error appeared in the visited queue/settings. This does not establish that every historical post succeeded.

Buffer displayed 276 sent posts, two queued and one draft across the account. The first 20 visible sent posts, October 3–7, comprised six GBP, nine Facebook and five LinkedIn posts, including GBP and Facebook posts today. The queue contained a LinkedIn TV-mounting guide for October 7 at 4:27 PM and a Facebook garage-shelving guide for October 8 at 8:50 AM, Chicago time; GBP had no queued posts at inspection. These are a point-in-time queue and all-account sent count, not matched-period growth metrics.

Seven Facebook posts from October 3–6 with populated metrics each showed zero to three impressions and zero clicks, reactions, comments and shares. Today's two Facebook posts did not yet have impression/click metrics. Four LinkedIn posts from October 3–5 showed 14–99 impressions and 13–77 reach, with no reactions/comments. This small recent sample demonstrates limited observed distribution, not a lifetime result or proof that social traffic generated no bookings. Most sampled posts promoted Austin educational articles.

Expanded post text and visible destination links showed no query attribution in these examples; the destination websites were not opened, avoiding extra audit visits:

| State / channel / Chicago publication time | Visible destination |
| --- | --- |
| Sent GBP, October 7 at 10:44 AM | `https://www.assembleatease.com/blog/outdoor-tv-installation-austin-texas` |
| Sent Facebook, October 7 at 9:14 AM | `https://www.assembleatease.com/blog/tv-mounting-costs-austin` |
| Sent LinkedIn, October 6 at 9:41 PM | `https://www.assembleatease.com/blog/crate-and-barrel-furniture-assembly-austin` |
| Queued LinkedIn, October 7 at 4:27 PM | `https://www.assembleatease.com/blog/tv-mounting-tips-austin` |
| Queued Facebook, October 8 at 8:50 AM | `https://www.assembleatease.com/blog/garage-shelving-installation-austin` |

GBP General settings showed **No Shortening**. GBP and Facebook both required choosing a link shortener before enabling Buffer campaign tracking; their queue-pause switches were Off. Repository inspection independently found that `api/_social-automation.js` passes the original article URL to content generation/publication and `api/_social-publisher.js` reuses it without adding campaign tags. A deterministic, channel-specific first-party tagging fix at the publisher boundary is the proposed local correction; no Buffer settings, queued/sent posts or publishing behavior were changed during this inspection.

The initial Community badge of two refreshed to one after the inbox loaded. The remaining unanswered LinkedIn comment was displayed as 23 days old on the September 13 TV-mounting post. It offered HDMI-cabling suggestions and introduced a supplier; it contained no customer booking/service question. GBP said all reviews had been addressed, and the four displayed review threads already had business replies. No comments were replied to, liked or resolved. The initial badge is not evidence of two missed customer inquiries.

Keep Buffer as the publishing hub. Prioritize genuine completed-work proof, relevant service calls to action and consistently tagged links; assess qualified visits, inquiries and completed jobs before increasing posting volume. Account upgrades or the locked company Page are not established causes of inconsistent bookings.
