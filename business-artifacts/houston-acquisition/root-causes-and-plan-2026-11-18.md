# Houston acquisition: root causes and execution plan

Prepared 2026-11-18 from direct reads of the production database, the Google Ads account (293-675-5780), Google Keyword Planner, GA4, PageSpeed Insights, a phone-size walkthrough of the live booking page, and the code on `main`. Nothing in Google Ads was changed during this work (no budget, bid, location, conversion or campaign edits). The full strategy draft with external research is in `Houston customer acquisition system.md`; where the two disagree, this document wins because it rests on later, deeper checks.

Labels: **VERIFIED** (checked directly or by authoritative source), **BUSINESS DATA** (measured in our systems), **HYPOTHESIS** (reasoned, not proven), **TEST REQUIRED**.

---

## The short version

1. **At current prices, a single TV mount or furniture job bought through Google Search loses money on the first booking.** A $119 TV job leaves the platform $33 after card fees. Houston's top-of-page click prices for "tv mounting houston / near me / service" start at $6.18-$7.53. To break even at a $4 click, about 12 of every 100 clicks would have to become completed jobs; nothing in our data or the industry comparators supports that. (VERIFIED inputs, HYPOTHESIS conclusion.)
2. **The money is in bigger tickets, not more clicks.** Outdoor/playset jobs completed at $150-$695 and left $40-$186 each; they are our most-booked online category and their Houston keywords are cheaper. TV only pays when the cart is large (large TV, fireplace, soundbar, second TV).
3. **The booking page leaks phones.** On a phone, after a visitor ticks a TV, nothing on screen shows a total or a next step; the Continue button is about 2.5 screens down. Two-thirds of measured visitors are on phones; phones produced 1 of the 3 measured bookings. (VERIFIED UI fact; cause of the 7-of-40 drop is HYPOTHESIS until instrumented.)
4. **Measurement is weaker than Google's "Misconfigured" label suggests, and stronger than I first said.** The label only means no tag fired in 7 days (there were no bookings in 7 days). The real gaps: Google only counts a booking when the visitor clicked Accept, the value sent is the tax-inclusive total (or $1), and five irrelevant "primary" goals sit beside the real one. Our own database can measure paid bookings without any consent issue, using the tagged ad links shipped in #467.
5. **The old $380 bought one real, completed, paid job** ($153 total, May 18). Most of the waste was a Smart campaign (181 clicks, $104.61, nothing booked), app and website placements, and broad furniture terms.
6. **The current campaign targets the wrong map.** The Houston Easer's completed Houston-area jobs were in Spring (77389) and Katy (77449). Google lists Spring, Katy and Cypress as separate targets from "Houston (city)". Target the ZIPs he confirms instead.

**Recommendation to the owner:** do not turn the campaign on yet. Fix the phone booking step and the conversion goals first (days, not weeks), confirm the Easer's ZIPs and weekly capacity, then run a capped Houston test built around larger tickets with a hard stop-loss. Decisions needing your approval are listed at the end.

---

## 1. Conversion tracking, end to end

### What "Misconfigured" actually means (VERIFIED)
Google's diagnostic on "Book appointment": "Conversion has not received tag pings in the last 7 days." Our database shows the last booking of any kind on Nov 9. No bookings means no pings. The label does not prove a broken tag.

### Was the one recorded conversion a real paid booking? Yes (VERIFIED by elimination)
- Google Ads: one "Book appointment" conversion all time, credited to "Austin | Furniture Assembly | Search", from a **desktop** click in **Pflugerville**, clicked on a **Wednesday 11 AM-noon**, value **$1.00** (Google's default when no value is sent).
- Database: the only booking between May 1 and June 15, test bookings included, is May 18 (a Monday) at 6:44 PM: online, $153.00 charged, completed, captured, Easer paid.
- Reading: a customer clicked the ad on a Wednesday and booked five days later. This is our only real measurement of click-to-booking delay, and it argues for judging ads on 30-day conversion windows, not same-day results.

### The real defects (VERIFIED in code and account)
| # | Defect | Effect |
|---|---|---|
| 1 | `ad_user_data` is granted only after the visitor clicks Accept (assets/js/cookie-consent.js). The Ads booking conversion fires on the confirmation screen, but Google will not record it for visitors who never accepted. | Google cannot learn from most bookings. |
| 2 | The value sent is `BOOK._grandTotalCents`, the customer total including tax (book.html). In May it was missing ($1). | Google would value a $124 TV job at $134, about 4x what the business keeps ($33). Any value-based bidding would chase the wrong number. |
| 3 | Six goals are marked Primary: Book appointment, Add to cart (1) (counts every), Calls from Smart Campaign Ads, Smart campaign clicks to call, Conversation started, Lead form - Submit. | If the new campaign ever uses conversion bidding, Google optimizes toward add-to-carts and calls that never happen. |
| 4 | Enhanced conversions: not configured. No offline import of completed jobs. No retraction when a booking cancels. | Cancellations (8 of 22 unique bookings) would count as wins. |
| 5 | Old ads had no UTM tags, so the May 18 booking's `booking_attribution` is empty. | We could only prove the ad booking by elimination. |

### How to measure paid bookings accurately while respecting consent
**Layer 1, our own books (no consent needed, no data leaves us) - the decision metric.** Every ad click lands on a /book link tagged `utm_source=google&utm_medium=cpc&utm_campaign=houston_search`. Since #467 the booking stores those tags even without Accept (no click ID, no cookie). Cost per completed paid job = Google Ads spend / completed bookings carrying that campaign tag. This answers "is it profitable" for every visitor, consented or not. (VERIFIED design; TEST REQUIRED: one tagged test booking marked as a test, to confirm the tag lands in the row.)

**Layer 2, Google's learning (consented visitors only).** Keep the consent gate as is. Change the goal setup: one Primary goal, "Booking placed", counted once per booking ref (already sent as `transaction_id`), value = the platform's contribution (server-calculated), not the tax-inclusive total. Everything else Secondary. This is a configuration and code change; it needs your approval before I touch the account.

**Layer 3, completed jobs (later, consented visitors only).** When a consented visitor arrives from an ad, store the click ID with the booking; when the job is completed and captured, upload a "Job completed" conversion with the real contribution; retract cancelled bookings within Google's 54-day window. Needs a General Counsel decision on storing click IDs (backlog BOOKING-SOURCE-COVERAGE) and Google's Data Manager setup. Switch bidding to value-based only after 15+ completed paid jobs in 30 days.

**The consent question itself** (General Counsel, not marketing): the site asks US visitors to opt in before any ad measurement. Texas and federal law were not researched for this report; whether to keep opt-in or move to an opt-out model for US visitors is the single biggest lever on how much Google can learn. Until decided, Layer 1 is the truth.

---

## 2. The 273 clicks: what was useful and what was waste

All-time account history (VERIFIED, Google Ads, May 2, 2024 - Nov 18, 2026): **$380.08, 11,344 impressions, 273 clicks, 1 conversion.**

| Source of spend | Clicks | Cost | Result | Verdict |
|---|---|---|---|---|
| "Furniture Assembly Services" Smart campaign | 181 | $104.61 ($0.58/click) | 0 bookings | Waste. Cheap clicks, Google-chosen queries we cannot see. Never run a Smart campaign again. |
| Austin Search, people in the Austin metro (Austin 62, Pflugerville 7, Sunset Valley 5, Cedar Park 2, McNeil 2, Georgetown, Granite Shoals, Lakeway) | 81 | $240.49 | 1 completed job (Pflugerville, desktop) | The only useful spend. (6 Search clicks carry no city in Google's report.) |
| Display placements inside Search campaigns (Gallery photo app, Magic Tiles piano game, inspiredot.net, historyfacts.com, others) | 8 | $9.94 | 0 | Waste. The new campaign is Search-only (verified at build). |
| Clickers outside any market (South Korea, Kenya, Mansfield, Richardson) | 4 | ~$7 | 0 | Waste. Fixed by "Presence" targeting (new campaign has it). |
| Search clicks 10 PM-7 AM | 19 | $50.01 | 0 | No evidence of value; schedule now excludes these hours. |
| Old Houston Search | 1 | $5.89 | 0 | Too small to judge. |

**Devices (Search):** 79 mobile clicks $230.01, 0 bookings; 11 computer clicks $39.35, 1 booking; 1 tablet. (BUSINESS DATA; one conversion is not a pattern, but it matches the phone leak in section 3.)

**Landing pages (Search):** Austin TV page 26 clicks at **$1.98**; /book 26 clicks at $2.67; Austin furniture page 18 clicks at **$3.68**; /pricing 12; smart home 7. Old ads also showed links to `/repairs` (a removed service), `/assembler/apply`, `/track`, `/about` and `/locations` - pages that do not sell a job. (VERIFIED)

**Search terms:** Google hides most terms for privacy; 6 are visible (10 clicks): "furniture assembly near me" 3 clicks at **$11.23** each (the converting term), "ikea assembly service" 2 at $2.97, "wired ring doorbell installation" 2 at $3.73, "austin handyman service" 1, "handyman services in austin" 1, "d riggs handyman" 1 (a competitor's name: add as a negative).

**Visitor behavior after the click:** not available. The old ads carried no UTM tags and GA4 only records visitors who accepted cookies; the current GA4 property holds little history. (Gap, stated plainly.)

**What it teaches:** the spend that produced a job was a high-intent search, in the served area, on a computer, converting days later. The waste was automation choosing cheap traffic. Both point the same way: pay for intent, not volume.

---

## 3. Why only 7 of 40 visitors finished choosing items

### What the 40 actually are (VERIFIED)
- `job_plan_started` fires when /book loads. So "40 started" means 40 measured /book visitors, not 40 shoppers who began picking items.
- 10 of the 57 /book events came from Sweden (6) and Ireland (4): almost certainly not Texas customers (crawlers, monitoring, or our own tools). The real denominator is smaller.
- GA4 only counts visitors who accepted cookies; the database shows 8 bookings or quote requests in the same four weeks, GA4 saw 5.

### What the phone experience actually is (VERIFIED, live site, 390x844 viewport, today)
- An ad visitor for TV mounting lands directly on the TV size list. Prices are visible ($99-$249). No technical errors or warnings in the console through the whole step.
- After ticking "TV 41-55" ($119)", a quantity stepper appears. **Nothing on the screen shows a total or what to do next.** The Continue button ("Continue to notes") sits at 2,250 px on a 2,285 px page, about 2.5 screens below, not pinned. No sticky bar exists.
- Continue leads to a separate **notes screen** (optional notes and a "custom quote" checkbox); its button is again just below the fold (862 px on an 844 px screen).
- Only then does the visitor reach dates and times, with "Items subtotal $119" and "Any service-area fee and sales tax will be itemized before payment."
- Phones are two-thirds of measured visitors (52 of 78) but produced 1 of 3 measured bookings; computers 26 visitors, 2 bookings. (Tiny numbers.)

### Root cause, as far as the evidence goes
- **VERIFIED:** the phone layout hides the next step after selection and adds an extra optional screen. Both are friction for exactly the visitor ads bring (phone, cold, comparing).
- **HYPOTHESIS:** this is the main cause of the item-step drop. Other plausible causes we cannot yet separate: price-checkers who never meant to book, the non-Texas traffic above, and visitors who wanted a total before committing.
- **Why we cannot be sure:** the page records only "opened" and "finished step one". It does not record item selected, Continue tapped, or notes screen reached.

### Fix (critical, before any paid traffic)
1. A pinned bottom bar on phones during step one: running total ("1 item - $119") and the Continue button, visible the moment an item is ticked.
2. Merge the notes screen into the schedule step (notes stay optional), so ticking an item and pressing Continue reaches dates in one tap.
3. Add three events: `item_selected`, `items_continue`, `notes_continue` (or the merged equivalent), with device category.
4. Exclude internal and non-US traffic from GA4 reports (data filter) so the funnel is read on real customers.
5. Success measure: share of real /book visitors who reach the schedule step, before vs after, on phones. Judge after 100+ real phone visits, not after a week.

---

## 4. Geographic targeting vs real Easer coverage

**VERIFIED**
- The campaign targets "Houston, Texas (city)" with Presence. Google's picker lists **Spring (city, reach 158,000), Katy (262,000) and Cypress (1,050,000)** as separate targets. Google's "Houston (city)" reach estimate is 12.7 million, about 85% of the whole Houston TV market (14.9 million), so Google's Houston area is broader than the city limits - but the picker cannot show whether it includes Spring or Katy. Treat it as unknown.
- The Houston Easer is based in **77002** (downtown). His profile has no service-area or travel-radius field. His completed jobs: **Spring 77389, Katy 77449**, and far outside Houston: **Bullard 75757** (East Texas, the $1,353 job) and **Fischer 78623** (Hill Country, $695); a San Antonio $1,678 job was assigned and cancelled.
- The platform's own Houston market is ZIP prefixes 770-775 (`SERVICE_MARKETS.houston`): Houston, Katy, Spring, Cypress, Sugar Land, Pearland, Pasadena, Baytown, League City and Galveston.

**Implication (challenge to the current plan):** the only Houston Easer also travels statewide for large jobs, so his Houston capacity is shared with jobs 150-200 miles away. "One Easer in Houston" is less capacity than it sounds.

**Recommended structure (needs your approval and his answer):**
1. Ask the Easer two things in writing: which ZIPs or how many miles from 77002 he will take a $119-$200 job, and how many open slots per week (Fri/Sat especially).
2. Replace the city target with **ZIP code targets** for exactly those ZIPs, Presence only. ZIP targets remove the boundary guesswork and match how dispatch already works.
3. If he will not drive far for small jobs, use a tighter ring for TV/furniture ad groups and the wider ring only for outdoor/playset (bigger tickets justify the drive).
4. First-week check: Google Ads "user location" report must show clicks only from those ZIPs.

---

## 5. Current platform economics, verified from the business systems

### Rules in code today (VERIFIED, `main`)
- Catalog jobs: platform keeps **30%** of the pre-tax subtotal, Easer **70%**. The $5 service-call fee is inside that subtotal and split the same way.
- Custom quotes from an Easer's price: stepped take (30% of the first $500, 20% to $2,000, 15% above, after card fees), behind the `QUOTE_FEE_SCHEDULE=stepped` switch. No completed job has used it yet; whether the switch is on in production was not verified.
- Sales tax 8.25%: pass-through, never revenue. No hard minimum booking is enforced (docs say $149; code says informational only).
- Promotions reduce the subtotal before the split, so **the Easer bears 70% of every discount** (VERIFIED on the $695 Fischer job: $76.70 off, Easer paid 70% of the discounted amount).
- Lead fees: none are recorded anywhere in the system. The Katy job came through **Thumbtack**; whatever Thumbtack charged for that lead is invisible to our books.

### Actual money on the 9 completed jobs (BUSINESS DATA, `bookings` table)
| | Amount |
|---|---|
| Charged to customers (incl. tax) | $4,225.82 |
| Sales tax (pass-through) | $322.06 |
| Pre-tax sales | $3,903.76 |
| Paid to Easers | $2,766.28 (70.9%) |
| Card fees recorded | $120.25 (3.1%) |
| **Kept by the platform** | **$1,013.74 (26.0% of pre-tax)** |
| Per job | median $89.80, range $27.00-$333.13 |
| Repeat customers | 0 |

Per job kept: $27.00 (bed frame, price-matched), $33.01 (furniture), $38.22 (furniture, the ad booking), $39.99 (Katy, Thumbtack - before the unknown lead fee), $89.80 (trampoline), $105.53 (Spring playset), $160.60 (fitness quote), $186.46 (Fischer playset after a 10% promo), $333.13 (Bullard mounting; Easer was paid $30 above 70%).

Formula for catalog jobs (VERIFIED against the rows): **kept = 0.2686 x pre-tax subtotal - $0.30.**

---

## 6. TV mounting on its own numbers

### Demand (VERIFIED, Keyword Planner, Nov 2025-Oct 2026)
TV mounting is Houston's largest assembly-type search: "tv mounting" 1K-10K a month; "tv mounting houston / near me / service" 100-1K each. Furniture terms are mostly 10-100 in the city.

### Price of a click (VERIFIED estimates, Houston city)
| Term | Top-of-page bid, low - high |
|---|---|
| tv mounting houston | $6.68 - $18.86 |
| tv mounting near me | $7.53 - $18.13 |
| tv mounting service | $6.91 - $17.86 |
| tv wall mount installation | $5.90 - $17.00 |
| mount tv above fireplace | $2.77 - $8.65 |
| tv mounting (generic) | $2.42 - $11.30 |

Our own history: Austin TV page clicks cost $1.98 (26 clicks, below top of page). Keyword Planner shows what the top of the page costs, not what a lower position costs.

### What a TV job leaves the business (VERIFIED formula, catalog prices)
| Cart (pre-tax, incl. $5 service call) | Kept | With WELCOME25 |
|---|---|---|
| One TV 41-55" = $124 | $33.01 | $26.30 |
| One TV 56-65" = $154 | $41.06 | $34.35 |
| TV 41-55" + cable routing = $159 | $42.41 | $35.70 |
| TV 56-65" + soundbar = $209 | $55.84 | $49.13 |
| TV 66-75" above fireplace = $369 | $98.81 | $92.10 |

### Cost of one completed TV job from search (HYPOTHESIS ranges)
Inputs: click to booking 3% / 6% / 10% (our measured /book-to-booking is roughly 7.5% of measured visitors; the old search ads managed 1 in 92); booking to completion 50% (online history 6 of 19; Houston 2 of 3).

| Cost per click | 3% | 6% | 10% |
|---|---|---|---|
| $2.50 (lower positions) | $167 | $83 | $50 |
| $4.00 (current cap) | $267 | $133 | $80 |
| $6.50 (top of page) | $433 | $217 | $130 |

**Verdict (challenging the current plan):** a single-TV job ($33-$41 kept) does not pay for itself at any realistic combination above. Only large carts ($300+) come near break-even, and only at the good end of conversion. TV is the right **demand** to learn from in Houston, but it is not a profitable first-job channel at current prices unless order value rises. Raising bids to $7 for the top spot (the draft report's suggestion) makes the math worse, not better; I withdraw that recommendation.

What would change this: a measured click-to-completed rate above about 12% at $4 clicks for single-TV carts, or an average TV cart above about $300 in paid bookings.

**What to do instead:** keep TV in the test with a $4 cap (accept lower positions), write the ads and the landing toward larger setups (big TVs, above-fireplace, soundbar, second TV - all real catalog items), and judge TV on kept-per-click, not on clicks.

---

## 7. The 7 AM-10 PM schedule

**Evidence (BUSINESS DATA):**
- Bookings placed: 0 of 19 unique online bookings between 10 PM and 7 AM. If bookings were spread evenly over the day, about 7 would be expected in those 9 hours; seeing none makes it very unlikely overnight is a big booking window.
- Ad clicks: 19 Search clicks ($50) between 10 PM and 7 AM produced nothing; the only ad booking came from an 11 AM click.
- Booking happens later than the click (5 days in our one case), so the hour of booking is not the hour of the search.

**Decision: keep 7 AM-10 PM unchanged, with no hourly bid adjustments.** One conversion and 19 bookings cannot support raising or lowering any hour; the draft report's -20%/+20% suggestion is withdrawn.

**What would change it:** after 4 weeks live, if the campaign is not spending its full budget (no budget-limited impressions) and the hour report shows evening searches running out, test 24 hours for 2 weeks. If more than half the daily budget is spent before noon while bookings keep arriving in the afternoon and evening, test a later start (10 AM). Either change needs your approval.

---

## 8. Houston competitors: where we can win profitably

(External prices observed 2026-11-18 by the research pass; details and sources in the strategy draft.)

| Competitor | TV | Furniture | Note |
|---|---|---|---|
| Local TV specialists (Tech Mounting Pros, Express Mounting) | $119 flat up to 85"; $129-$159 | - | Flat and cheap on big TVs |
| Best Buy | $179.99 (56-90") | - | |
| Taskrabbit Houston | about $45/hr, many 2-hr minimums, plus fees (percent not published) | about $35/hr; IKEA flat per item, $52 minimum | Hourly meter, fees at checkout |
| Thumbtack (Houston cost page) | $119 example | $120-$150 typical | Pros pay per lead ($10-$30 per third-party estimates) |
| Retail add-ons (Walmart, Target) | $79 | $89-$92 | |

**Where we cannot win profitably:** single small TV or furniture jobs on price. We are at market on small TVs and above market on 66-85" TVs; retail add-ons and IKEA-Taskrabbit undercut small furniture.

**Where we can:**
1. **Outdoor, playsets, sheds, gazebos.** Our most-booked online category (8 of 22), completed tickets $150-$695, cheapest Houston clicks ($1.34-$7.55 top-of-page), fewer app competitors, real Houston proof (Spring playset). Search volume is small (10-100 a month per term), so it needs organic pages, partners and a dedicated ad group, not big budgets.
2. **Multi-item and bundle carts** (move-in, room setups): one visit, higher ticket, same travel. The bundles already exist on the site.
3. **One upfront total, booked online, paid after the job** - competitors meter by the hour or quote later. (Wording must follow the customer-language rules; no "authorized, not charged".)
4. **Thumbtack as a channel, measured.** We already won a Katy job there. If your Thumbtack lead costs are $10-$30 and one in three leads books, that beats Google Search on cost per job. Your Thumbtack account has the real numbers; they are the most important missing input.

---

## 9. Priorities by money, difficulty and confidence

| # | Fix | Expected financial impact | Difficulty | Confidence |
|---|---|---|---|---|
| 1 | Phone booking step: pinned total + Continue, merge notes screen, step events | High: every paid and organic phone visitor | Low-medium (one page) | Medium (UI fact verified; size of effect unproven) |
| 2 | Conversion goals: one primary "Booking placed", value = platform contribution, others secondary | High: prevents paying Google to chase the wrong thing | Low (account settings + small code change) | High |
| 3 | Confirm Easer ZIPs and weekly capacity; switch to ZIP targeting | High: no wasted clicks, no unfulfillable bookings | Low (one conversation, one setting) | High |
| 4 | Re-aim the test at bigger tickets (outdoor/playset ad group, large-TV messaging, furniture paused) | High: moves cost per job toward break-even | Low-medium | Medium |
| 5 | Record lead/ad cost per booking (Thumbtack fee, ad spend) | Medium: true profit per job | Medium | High |
| 6 | Get Thumbtack lead cost and win rate from your account | Medium-high: may be the cheapest channel | Low (you read it) | High |
| 7 | Decide who pays for promotions (Easer currently pays 70%) | Medium: Easer trust and margin | Low (decision) | High |
| 8 | Fix doc/code disagreement on the $149 minimum | Low money, high clarity | Low | High |
| 9 | Consent model for US visitors (General Counsel) | High long-term (Google learning) | Medium | Medium |
| 10 | Completed-job offline conversions, then value bidding | High later | High | Medium |

---

## 10. Execution plan

### A. Critical fixes before any ad spend (I can build 1, 2-code, 4, 5 now on a branch; nothing goes live until you say push)
1. **Phone booking step** (section 3 fixes 1-3). Tested on a 390 px phone, desktop, and the existing booking tests.
2. **Conversion setup:** code sends platform contribution as the value; in Google Ads, set "Book appointment" as the only Primary, demote the other five to Secondary. Account change needs your yes.
3. **Easer capacity and ZIPs:** you ask him; I set ZIP targeting after your yes.
4. **GA4 filter** for internal and non-US traffic.
5. **Tagged test booking** (marked as test) to prove `utm_campaign=houston_search` lands in the booking row.
6. **Pay the $99.35 balance** (you).

### B. Campaign ready to test, after A (each item needs your approval)
- Same campaign, $10/day, Search only, ZIP targets, Presence, schedule 7 AM-10 PM, no bid adjustments, **Maximize clicks with the $4 cap kept**.
- Ad groups: **TV Mounting** (copy and landing aimed at larger setups); **Outdoor & Playsets** (new: playset/swing set/trampoline/shed/gazebo assembly, landing on the outdoor booking link); **Furniture paused**.
- Negatives: add "d riggs", job/hiring terms, DIY/how-to (already in the 33), competitor brand names.
- Decision metric: kept-per-job minus ad cost, from our own database, read weekly.
- **Stop-loss:** pause at $300 spent with no completed paid job, or at 60 days, whichever first. **Scale gate:** 3+ completed paid jobs with total kept above total ad spend, and the Easer has open slots.

### C. Later growth (in order)
1. Thumbtack measured as a channel (your lead data first).
2. Google Business Profile and reviews for the Houston area (free, high intent, Maps).
3. Partners for big tickets: playset and shed sellers, apartment communities in the Inner Loop and Northwest Houston, movers.
4. A second Houston Easer before raising spend (the pending 775 applicant).
5. Completed-job conversion upload and value-based bidding after 15+ completed paid jobs in 30 days.
6. Microsoft Ads (imports the Google campaign; needs your approval under the Google-only rule).

---

## Decisions that are yours

1. Approve the phone booking-step fix and the conversion-value change (code, on a branch until you say push).
2. Approve setting "Book appointment" as the only Primary goal in Google Ads.
3. Get the Easer's ZIPs and weekly open slots; approve ZIP targeting.
4. Approve the re-aimed test: outdoor/playset ad group added, furniture paused, $4 cap kept, $300 stop-loss.
5. Share your Thumbtack lead cost and how many leads became jobs.
6. Decide whether the platform or the Easer pays for promotions.
7. Send the US consent question to General Counsel.

## Corrections to what I told you earlier today
- "Google can't see a single booking" overstated it. The "Misconfigured" label comes from no bookings in 7 days. The real limits are consent, the wrong value and the extra goals.
- "The old campaigns reached the wrong area" was mostly wrong: 81 of 92 Search clicks were in the Austin metro. Waste came from the Smart campaign, app placements and broad terms.
- The draft report's advice to raise TV bids to $7 and to add -20%/+20% hourly bid adjustments is withdrawn. The economics and the evidence do not support either.
