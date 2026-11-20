# Houston competitor scan and ad build (2026-11-20)

Written for the owner. What competitors show in Houston, what we built to beat them, and what is still waiting on you. Campaign "Houston | Assembly & TV Mounting | Search" (ID 24490173783) stays **PAUSED**. Budget ($10/day), bid cap ($4), schedule (7 AM to 10 PM Central) and location (Houston city) are unchanged.

## 1. What Houston searchers see today

Live Google results for Houston, read in Google Ads "Ad preview and diagnosis" on 2026-11-20 around 1:30 AM Central. Paid ads are thin at that hour, so treat the ad count as a floor, not the daytime picture.

| Search | Paid ads seen | Top organic and map results |
|---|---|---|
| tv mounting houston | 1: uSource ("TV Wall Mounting Houston - See prices and open dates"; sitelinks Pricing, TV Mounting Service, Hire a Local TV Mount Pro, Mount Your New TV) | Xpress TV Mounting ($85 up to 65"), TaskRabbit ($45/hr, 25,047 reviews), Houston TV Mounting Pros (same-day, 84"-100" TVs), Best Buy, Yelp, tvmountmaster.com (from $55, same-day, insured, 3-year warranty), TV Installation Houston ($75) |
| furniture assembly houston | none | Map pack: All Done Assembly 5.0 (132 reviews), VIP-Assembly 4.9 (109), Quick & easy Assembly 5.0 (111); Walmart furniture assembly; Mr. Handyman |

Published prices (vendor pages, checked 2026-11-20):

| Competitor | TV mounting price | Notes |
|---|---|---|
| Express Mounting (Houston) | $129 up to 54", $159 55-69", $209 70-79", $299 80-99" | Wire hiding +$99, brick or stone +$99, brackets extra |
| Tech Mounting Pros | $119 flat up to 85" | |
| QuickMountTV | from $98 | Claims same-day |
| HelloTech (Walmart, Target) | $79 standard, $129 large (Walmart); $99.99 (Target) | Mount not included |
| Puls | $69-$89 | $129.99 minimum service fee without subscription |
| TaskRabbit (furniture, TV) | about $35-$45/hr | Trust & Support fee 5-15% at checkout; many Taskers have a 2-hour minimum |

Our catalog: TV up to 40" $99, 41-55" $119, 56-65" $149, 66-75" $189, 76-85" $229, 86"+ $249; Houston adds a $5 service-call fee. No hard order minimum (api/booking.js takes the booking; MIN_PRETAX_BOOKING_BY_ZONE is informational), so "From $99" is a price a customer can actually book.

Sources: [Express Mounting](https://expressmounting.com/houston/), [Tech Mounting Pros](https://www.techmountingpros.com/), [QuickMountTV](https://quickmounttv.com/tv-mounting/downtown-houston/), [HelloTech on Walmart](https://www.walmart.com/ip/447958360), [Puls pricing](https://blog.puls.com/tv-mounting-price-how-much-should-it-cost-to-mount-my-tv), [TaskRabbit Houston](https://www.taskrabbit.com/locations/houston/furniture-assembly-setup), [TaskRabbit cost guide](https://www.taskrabbit.com/blog/how-much-does-it-cost-to-hire-a-tasker/), [Google image asset requirements](https://support.google.com/google-ads/answer/9566341).

## 2. Where we win, and the claims we can make

- **One flat price you see before booking, tax included in the total.** Competitors add surcharges after the fact (brackets, brick, wire hiding) or bill hourly with a checkout fee (TaskRabbit). Our callouts: "Tax Shown Before You Book", "Itemized Prices Online".
- **Pay after the job.** The card is held and captured at completion. Account callout "Pay After Job Is Done" already serves.
- **One visit for many jobs.** TV specialists do TVs only. We do TV, furniture, smart home, gym, office and outdoor in one booking. That now shows in the Services list and the 8 service links under every ad.
- **ID-verified local pros** (Easer readiness requires identity verification).
- **Free cancellation up to 24 hours** (CANCELLATION_POLICY.freeWindowHours = 24).
- **Cheaper than the closest paid-search competitor tier by tier** on TVs 55" to 85" (Express Mounting $159/$209/$299 against our $149/$189/$229).

Claims we deliberately do **not** make: same-day (fee flag is off), insured, warranty or guarantee, hardware or mounts included, "cheapest". Competitors lead on review counts; we have no review asset to match, so the ads lean on price clarity and pay-after instead.

## 3. Applied in the paused campaign (2026-11-20)

| Item | Result |
|---|---|
| 8 service links (sitelinks), campaign level, each with two description lines | See All Prices, Playsets & Outdoor, Smart Home Installs, Office Furniture, Gym Equipment Setup, TV Mounting, Furniture Assembly, Room-Ready Bundles. All Eligible. "TV Mounting" has no price in the link text (fewer prices per ad) |
| Old campaign links removed (association only; the assets stay in the library) | Track Your Booking, Apply Now (an Easer recruiting link on a customer ad), and the older See All Prices, TV Mounting From $99, Room-Ready Bundles, Furniture in Houston duplicates |
| 6 callouts, campaign level | Tax Shown Before You Book, ID-Verified Local Pros, Book Online Any Time, Free Cancellation 24 Hrs, Pros Bring the Tools, Itemized Prices Online. They serve alongside the three eligible account callouts (Pay After Job Is Done, Flat Rate Pricing, No Hidden Fees). Under review |
| Structured snippet, header "Service catalog" | TV Mounting, Furniture Assembly, Smart Home Installs, Playset Assembly, Gym Equipment Assembly, Office Furniture Setup, Outdoor Furniture, Camera Installation. Under review |
| Business name | "AssembleAtEase", Eligible. Business logo (AAE monogram, existing asset) was already Eligible |
| Real job photos, ad-group level, 29 images (square plus landscape crops) | TV 4, Furniture 4, Office 6, Fitness 2, Smart Home 4, Outdoor 9. No photo is used in two ad groups. Under review |
| Ad strength | All six ads Excellent. TV, Furniture and Fitness headlines (and two Fitness descriptions) rewritten to include their keywords; Smart Home, Office and Outdoor were already Excellent. Prices per ad stay at two |
| Negative keywords | Added "repair" and "replacement" (35 total). The other planned negatives were already among the 33 |

### Photos: where they came from and what was left out

- Source rule: `api/_website-photos.js` `photoUseForBooking` and Terms section 8 (2026-10-20). Only bookings under Terms 2026-10-20 or later, not opted out and not test bookings, may be used in marketing. Before that date the Terms said job photos "will not be used in public marketing without separate permission."
- Production `booking_evidence` (read-only query, 2026-11-20): 21 rows across 9 bookings. Only two bookings qualify: AAE-WWWTOIWDQH (Outdoor & Playsets, Fischer, 2 photos: playset with slide, dome climber with swing) and AAE-LP7HC5WZQS (catio, Katy, 1 photo). All three passed the privacy checklist (no people, house numbers, mail, documents or plates) and are unique by SHA-256.
- Not used: photos from AAE-EYXG5NSDUN (7, TV, Bullard), AAE-DVSNHXE4OO (4, Spring), AAE-RYABAGB8FS (2, Lubbock), AAE-ZWKCSJ5VRH (1, San Antonio), all under earlier Terms; two test bookings; damage-claim photos.
- Also used: 12 of the 16 real job photos already published on the site (images/real-*). Left out: real-furniture-bed-paneled and real-outdoor-gazebo (too small, would read as blurry), real-outdoor-sectional (low resolution), and real-tv-mount-console (MLB, YouTube and Amazon logos on the TV screen invite a trademark disapproval).
- Every upload was re-encoded through PIL, so EXIF and GPS data were removed (verified: 0 EXIF tags on each file). Never upscaled.

## 4. Waiting on the owner (not applied)

1. **Greater Houston targeting** (change set section 2): the 10 counties minus 9 ZIPs. Today the ads reach the City of Houston only, while the copy names Katy, Spring and Sugar Land, where most Houston-area customers were. The tool's safety check refused this change without your explicit yes, because you reserved geographic targeting earlier. **A Harris County addition is sitting UNSAVED in the open Google Ads settings tab. Do not press Save there; press Cancel or close the tab.** To approve, reply "apply the Greater Houston targeting".
2. **Conversion goals** (change set section 1): make "Book appointment" the campaign's only goal. The campaign currently uses the account default (Book appointments, Leads from messages, plus one more). This doesn't change what is spent under Maximize clicks; it makes the conversion count honest.
3. **Call asset:** Google asks for one because "phone calls" is a campaign goal. Which number belongs on ads is your call (979 business, 512 job calls, 877 automatic texts).
4. **Business Profile location asset (account level, "All locations selected")**: check which address the profile shows. If it is an Austin address, Houston ads may show directions to Austin.
5. **Turning the campaign on** after the live Houston test booking.
