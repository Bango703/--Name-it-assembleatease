# Google Ads change set: Houston (prepared, NOT applied)

> **Status 2026-11-20:** sections 3 (all six ad groups and ads), 3g (8 service links), 3h (Services snippet, callouts) and 4 (negatives) are applied in the paused campaign, plus real job photos, the business name and Excellent ad strength on all six ads. Details: competitor-scan-2026-11-20.md. Sections 1 (conversion goals) and 2 (Greater Houston targeting) are **not** applied and wait for the owner's explicit yes. The campaign stays paused.

Account 293-675-5780, campaign "Houston | Assembly & TV Mounting | Search" (ID 24490173783). Prepared 2026-11-18. **Nothing here had been applied when this was written.** Apply only after the owner approves, after the code branches are deployed, and after the $99.35 balance is paid. Unchanged on purpose: $10/day budget, Maximize clicks with the $4 max CPC, schedule every day 7:00 AM-10:00 PM Central, no hourly bid adjustments, Search only, AI Max / text customization / final URL expansion off, Presence location option.

## 1. Conversion goals (fix the six Primary goals)

| Conversion action | Today | Change to | Why |
|---|---|---|---|
| Book appointment (website) | Primary | **Primary (only one)** | Fires on the booking confirmation; after `fix/ads-conversion-value` deploys it carries the platform's share (no tax) as the value and the booking ref as the transaction ID |
| Add to cart (1) (website, counts every) | Primary | Secondary | Not a booking |
| Calls from Smart Campaign Ads | Primary | Secondary | Smart campaign removed |
| Smart campaign ad clicks to call | Primary | Secondary | Smart campaign removed |
| Conversation started (Google hosted) | Primary | Secondary | Not a booking |
| Lead form - Submit (Google hosted) | Primary | Secondary | Not a booking; no lead form in use |
| Quote Request (website) | Secondary | Secondary (no change) | No value until priced |
| Website calls (60+ seconds) | Secondary | Secondary (no change) | |

Keep "Book appointment" value setting "Use different values". Do not turn on enhanced conversions until the General Counsel consent decision (backlog BOOKING-SOURCE-COVERAGE).

## 2. Location targeting (Greater Houston)

Remove: **Houston, Texas (city)**.

Add (Presence): **Harris, Fort Bend, Montgomery, Brazoria, Galveston, Liberty, Waller, Chambers, Austin, San Jacinto** counties.

Exclude these postal codes. They sit inside those counties but outside the platform's Houston market (ZIPs 770-775), so a booking there is statewide (owner-assigned), not automatic:

| ZIP | Place | County |
|---|---|---|
| 77617 | Gilchrist | Galveston |
| 77623 | High Island | Galveston |
| 77650 | Port Bolivar / Crystal Beach | Galveston |
| 77661 | Stowell | Chambers |
| 77665 | Winnie | Chambers |
| 78931 | Bleiblerville | Austin |
| 78933 | Cat Spring | Austin |
| 78944 | Industry | Austin |
| 78950 | New Ulm | Austin |

Verification (2026-11-18): GeoNames postal-code lists per county. Harris (200 codes), Fort Bend (22), Montgomery (25), Brazoria (21), Liberty (11), Waller (5) and San Jacinto (4) are entirely 770-775; the nine codes above are the only exceptions in Galveston, Chambers and Austin counties. 77650, 77665 and 78950 were cross-checked on zip-codes.com. Re-check in Google's location picker when applying: each exclusion should show inside its county.

## 3. Ad groups

Final URL suffix (unchanged): `utm_source=google&utm_medium=cpc&utm_campaign=houston_search`. Each final URL below is the booking page for that service, so the booking records its source without cookies.

### 3a. TV Mounting (re-aimed at larger setups; keep its existing keywords)
Final URL: `https://www.assembleatease.com/book?service=Mounting+%26+Hanging`

Add keywords (phrase and exact): mount tv above fireplace, tv mounting above fireplace, fireplace tv mounting, large tv mounting, 75 inch tv mounting, 85 inch tv mounting, tv mounting with cable concealment, tv and soundbar mounting.

Responsive search ad (replace the current one). Headlines (all 30 characters or fewer, checked):
Houston TV Mounting · Large TV Mounting From $189 · Above-Fireplace TV Mounting · 75" and 85" TVs Mounted · One Upfront Price, Tax Shown · Book Online, Pick Your Time · ID-Verified Local Pros · Soundbar & Cable Routing · Second TV Same Visit +$69 · Katy, Spring, Sugar Land · You Pay After the Job · Brick & Tile Walls Welcome · Flat Prices, No Hourly Meter · See Your Total Before Booking · Greater Houston TV Installers

Descriptions (90 or fewer, checked):
1. Large TVs from $189; above-fireplace mounting adds $175. See your total before you book.
2. Pick your TV size and wall online. Local pros bring the tools. You pay after the job.
3. Serving Houston, Katy, Spring, Sugar Land, Pearland and the rest of Greater Houston.
4. Add a soundbar, cable routing or a second TV in the same visit. Flat prices, tax shown.

Prices quoted are catalog prices: TV 66-75" $189, 76-85" $229, above fireplace +$175, second TV +$69, soundbar mount +$55, cable routing +$35, brick +$110, tile +$65. No hardware, same-day, insurance or guarantee claims.

### 3b. Outdoor & Playsets (new ad group)
Final URL: `https://www.assembleatease.com/book?service=Outdoor+%26+Playsets`

Keywords (phrase and exact): swing set assembly, swing set installation, playset assembly, playset installation, trampoline assembly, trampoline installation, basketball hoop assembly, outdoor furniture assembly, patio furniture assembly, grill assembly, gazebo assembly, pergola assembly.

Headlines: Houston Playset Assembly · Swing Sets Assembled From $349 · Trampolines From $319 · Basketball Hoops From $249 · Patio Sets From $179 · One Upfront Price, Tax Shown · Book Online, Pick Your Day · ID-Verified Local Pros · You Pay After the Job · Katy, Spring, Cypress & More · Gazebo & Shed Quotes Online · Flat Prices, No Hourly Meter · Grills & Fire Pits From $119 · Greater Houston Backyard Pros · See Your Total Before Booking

Descriptions:
1. Swing sets from $349, trampolines from $319. See your full total before you book.
2. Pick the playset or patio set online and choose a day. Local pros bring the tools.
3. Serving Houston, Katy, Spring, Cypress, The Woodlands, Sugar Land and Pearland.
4. Gazebos, pergolas and sheds get a written quote first. You pay after the job.

Catalog prices: swing set / playset $349, trampoline $319 / $389 / $449, basketball hoop $249, outdoor dining set from $179, grill $129, fire pit $119; gazebo, pergola and shed are custom quotes.

### 3c. Furniture Assembly (revised 2026-11-20: keep running, aimed at bigger orders)
Final URL: `https://www.assembleatease.com/book?service=Furniture+Assembly`. Keep its 12 keywords. Replace the ad.
Headlines: Houston Furniture Assembly · Bed Frames From $99 · Sectionals From $159 · Move-In Setups, One Visit · Room-Ready Bundles · Bunk & Loft Beds From $229 · One Upfront Price, Tax Shown · Book Online, Pick Your Time · ID-Verified Local Pros · You Pay After the Job · Flat-Pack Furniture Built · Flat Prices, No Hourly Meter · Greater Houston Assembly Pros · See Your Total Before Booking · Katy, Spring, Sugar Land
Descriptions: Bed frames from $99, sofas from $119, sectionals from $159. See your total first. · Moving in? Book every room in one visit. Local pros bring the tools. You pay after. · Serving Houston, Katy, Spring, Sugar Land, Pearland and the rest of Greater Houston. · Dressers, desks, bunk beds and wardrobes too. Flat prices, tax shown before you book.

### 3d. Smart Home (new)
Final URL: `https://www.assembleatease.com/book?service=Smart+Home`
Keywords (phrase and exact): video doorbell installation, doorbell camera installation, ring doorbell installation, smart lock installation, smart thermostat installation, security camera installation, outdoor camera installation, home security camera install.
Headlines: Houston Smart Home Installs · Video Doorbells From $89 · Smart Locks Installed From $99 · Smart Thermostats From $99 · Camera Systems From $169 · Outdoor Cameras From $109 · One Upfront Price, Tax Shown · Book Online, Pick Your Time · ID-Verified Local Pros · You Pay After the Job · Keypad Entry From $119 · Flat Prices, No Hourly Meter · Greater Houston Installers · See Your Total Before Booking · Katy, Spring, Sugar Land
Descriptions: Video doorbells from $89, smart locks from $99, camera systems from $169. See your total. · Pick your devices online and choose a time. Local pros bring the tools. You pay after. · Serving Houston, Katy, Spring, Sugar Land, Pearland and the rest of Greater Houston. · Add a thermostat, keypad or sensors in the same visit. Flat prices, tax shown up front.

### 3e. Fitness Equipment (new)
Final URL: `https://www.assembleatease.com/book?service=Fitness+Equipment`
Keywords: treadmill assembly, home gym assembly, gym equipment assembly, exercise equipment assembly, peloton assembly, elliptical assembly, squat rack assembly, rowing machine assembly, weight bench assembly.
Headlines: Houston Gym Equipment Assembly · Treadmills Assembled From $219 · Home Gyms From $399 · Squat Racks From $279 · Exercise Bikes From $179 · Ellipticals From $239 · One Upfront Price, Tax Shown · Book Online, Pick Your Time · ID-Verified Local Pros · You Pay After the Job · Built Where You Want It · Flat Prices, No Hourly Meter · Greater Houston Fitness Pros · See Your Total Before Booking · Katy, Spring, Cypress & More
Descriptions: Treadmills from $219, home gyms from $399, bikes from $179. See your total first. · Pick your equipment online and choose a day. Local pros bring the tools. You pay after. · Serving Houston, Katy, Spring, Cypress, The Woodlands, Sugar Land and Pearland. · Racks, rowers, benches and cable machines too. Flat prices, tax shown before you book.

### 3f. Office Furniture (new)
Final URL: `https://www.assembleatease.com/book?service=Office+Assembly`
Keywords: office furniture assembly, office furniture installation, desk assembly, standing desk assembly, cubicle installation, office chair assembly, conference table assembly.
Headlines: Houston Office Furniture Setup · Standing Desks From $199 · Cubicle Setups From $399 · Office Chairs From $89 · Conference Tables From $229 · Desks Assembled From $99 · One Upfront Price, Tax Shown · Book Online, Pick Your Time · ID-Verified Local Pros · Quotes for Larger Offices · Flat Prices, No Hourly Meter · Home Offices & Small Offices · Greater Houston Office Pros · See Your Total Before Booking · You Pay After the Job
Descriptions: Desks from $99, standing desks from $199, cubicle setups from $399. See your total first. · Book online for home or small offices. Local pros bring the tools. You pay after the job. · Serving Houston, Katy, Spring, Sugar Land, Pearland and the rest of Greater Houston. · Larger office build-outs get a written quote first. Flat prices, tax shown up front.

### 3g. Sitelinks (campaign level, replace the four)
See All Prices (/pricing) · Playsets & Outdoor (/book?service=Outdoor+%26+Playsets) · Smart Home Installs (/book?service=Smart+Home) · Office Furniture (/book?service=Office+Assembly) · Gym Equipment Setup (/book?service=Fitness+Equipment) · TV Mounting From $99 (/book?service=Mounting+%26+Hanging) · Furniture Assembly (/book?service=Furniture+Assembly) · Room-Ready Bundles (/bundles)

### 3h. Structured snippet and callouts (campaign level, show under every ad)
Structured snippet, header **Services**: TV Mounting · Furniture Assembly · Smart Home Installs · Playset Assembly · Gym Equipment Assembly · Office Furniture Setup · Outdoor Furniture · Camera Installation (each 25 characters or fewer).
Callouts: Flat Prices, Tax Shown · You Pay After the Job · ID-Verified Local Pros · Book Online Any Time · Free Cancellation 24 Hrs (free window verified: CANCELLATION_POLICY.freeWindowHours = 24).

Guardrail per ad group (owner: maximize coverage; marketing: let the data decide): after $75 spent in one ad group with no booking from it in our own records, pause that ad group; the rest keep running. Budget, bid cap and schedule unchanged.

## 4. Negative keywords to add (if not already among the 33)
d riggs, diy, how to, instructions, manual, parts, replacement parts, jobs, hiring, careers, salary.

## 5. Order of operations after approval
1. Deploy `feat/houston-auto-dispatch`, `fix/ads-conversion-value`, `fix/mobile-booking-continue`, then `feat/houston-dispatch-health` (owner approves each PR).
2. One tagged test booking (marked as test) to confirm `houston_search` lands in the booking row and the Ads value equals the platform share.
3. Apply sections 1 to 4.
4. Pay the balance; enable the campaign.
5. Day 1-14: watch the Greater Houston dispatch card and the stranded-booking alerts daily; weekly search terms and user-location report.
