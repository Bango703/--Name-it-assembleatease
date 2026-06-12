# AssembleAtEase Operational Details for Financial Strategy

Prepared from the live customer booking catalog in assets/js/booking-source-of-truth.js. This is not a projection model yet; it is the operating catalog and platform structure Theodore asked for.

## Platform Overview

- Business: Austin-first assembly and mounting services platform.
- Service area rule in current catalog: Austin, TX, ZIP prefixes 786-788.
- Customer flow: choose service(s), choose time, enter address/details, authorize card, AssembleAtEase confirms/dispatches, Easer accepts, Easer completes, customer is charged after job completion, Easer is paid, platform keeps margin.
- Worker model: workers are called Easers. Easer onboarding supports application, services offered, tools/transportation questions, contractor agreement acknowledgement, application fee, and Stripe Identity verification flow.
- Current platform stack: custom HTML/CSS/JavaScript frontend, Node/Vercel serverless APIs, Supabase database/auth, Stripe payments, Resend email, HubSpot contact/deal integration, Upstash rate limiting, web push notifications, and scheduled cron jobs.

## Service Catalog Summary

| Service | Groups | Items | Add-ons | Custom quote items | Current low | Current high |
| --- | --- | --- | --- | --- | --- | --- |
| Furniture Assembly | 7 | 56 | 5 | 0 | 29 | 325 |
| TV Mounting | 6 | 40 | 12 | 0 | 15 | 175 |
| Smart Home | 6 | 36 | 4 | 0 | 15 | 375 |
| Outdoor & Playsets | 3 | 14 | 4 | 0 | 75 | 375 |
| Office Assembly | 4 | 18 | 4 | 0 | 25 | 425 |
| Fitness Equipment | 3 | 13 | 4 | 1 | 35 | 349 |
| Other | 1 | 1 | 0 | 1 |  |  |

## Financial Model Rules to Test

- Do not lock the business into one fixed Easer payout percentage yet. Use platform gross profit floors first.
- Rule 1: every completed job should target at least $35 platform gross before overhead.
- Rule 2: complex jobs should target $50-$75+ platform gross before overhead.
- Rule 3: no standalone booking should leave less than $30 platform gross after payment processing.
- Rule 4: $75 standalone jobs are likely too thin unless they are bundled, repeat-customer work, or add-ons.
- Rule 5: test a $99-$119 minimum standalone booking.

## Recommended Pricing Buckets for Modeling

| Bucket | Time | Examples | Financial target |
| --- | --- | --- | --- |
| Quick jobs | 15-45 min | Doorbell, smart lock, office chair, curtain rod | $99-$119 minimum booking |
| Standard jobs | 45-90 min | TV mount, dresser, simple desk, bookcase | $35-$50 platform gross |
| Premium jobs | 90-180 min | Treadmill, standing desk, PAX unit, camera system | $50-$75 platform gross |
| Complex jobs | 3+ hours | Playsets, gazebos, sheds, home gyms, office buildouts | $75-$150+ platform gross |

## Exact Service and Pricing Catalog

### Furniture Assembly

| Group | Item | Price | Add-on | Popular | Custom quote |
| --- | --- | --- | --- | --- | --- |
| Seating & Sofas | Accent chair / armchair | $75 | No | No | No |
| Seating & Sofas | Sofa (2-3 seat, standard) | $89 | No | No | No |
| Seating & Sofas | Sectional sofa (L-shape) | $125-$155 | No | Yes | No |
| Seating & Sofas | Sectional sofa (U-shape / oversized) | $179 | No | No | No |
| Seating & Sofas | Sleeper sofa / sofa bed | $109 | No | No | No |
| Seating & Sofas | Ottoman (storage) | $75 | No | No | No |
| Seating & Sofas | Bench (entryway or bedroom) | $75 | No | No | No |
| Bedroom | Bed frame - twin / full | $85 | No | No | No |
| Bedroom | Bed frame - queen | $95 | No | Yes | No |
| Bedroom | Bed frame - king / cal king | $109 | No | No | No |
| Bedroom | Bed frame with storage drawers | $125 | No | No | No |
| Bedroom | Platform bed with upholstered headboard | $135 | No | No | No |
| Bedroom | Bunk bed / loft bed | $149 | No | No | No |
| Bedroom | Trundle bed | $109 | No | No | No |
| Bedroom | Crib / toddler bed | $85 | No | No | No |
| Bedroom | Nightstand (single) | $75 | No | No | No |
| Bedroom | Dresser (up to 6 drawers) | $85 | No | No | No |
| Bedroom | Dresser (7+ drawers / double) | $109 | No | No | No |
| Bedroom | Wardrobe / armoire (freestanding) | $109-$135 | No | No | No |
| Bedroom | IKEA PAX wardrobe (single unit) | $139 | No | Yes | No |
| Bedroom | IKEA PAX wardrobe (per additional unit) | $79 | Yes | No | No |
| Bedroom | Vanity with mirror | $95 | No | No | No |
| Home Office & Study | Desk (simple, flat-pack) | $75 | No | No | No |
| Home Office & Study | Desk (L-shape / corner) | $109 | No | No | No |
| Home Office & Study | Standing desk (electric) | $109 | No | No | No |
| Home Office & Study | Office chair (standard) | $75 | No | No | No |
| Home Office & Study | Bookcase / shelving unit (up to 5 shelves) | $75 | No | No | No |
| Home Office & Study | Bookcase / shelving unit (6+ shelves) | $89 | No | No | No |
| Home Office & Study | File cabinet (2-4 drawer) | $75 | No | No | No |
| Dining & Kitchen | Dining table (standard) | $79 | No | No | No |
| Dining & Kitchen | Dining table (extendable / large) | $109 | No | No | No |
| Dining & Kitchen | Dining chairs (per 2 chairs) | $75 | No | No | No |
| Dining & Kitchen | Dining chairs (set of 4-6) | $75-$95 | No | No | No |
| Dining & Kitchen | Bar stool (per 2 stools) | $75 | No | No | No |
| Dining & Kitchen | Kitchen island (freestanding) | $95 | No | No | No |
| Dining & Kitchen | China cabinet / hutch | $109 | No | No | No |
| Dining & Kitchen | Buffet / sideboard | $85 | No | No | No |
| Living Room | Coffee table (simple) | $75 | No | No | No |
| Living Room | Coffee table (lift-top / storage) | $79 | No | No | No |
| Living Room | Side / end table | $75 | No | No | No |
| Living Room | TV stand / media console | $75 | No | No | No |
| Living Room | Entertainment center (large) | $125 | No | No | No |
| Living Room | Console table | $75 | No | No | No |
| Outdoor & Patio | Outdoor dining set (table + 4 chairs) | $109 | No | No | No |
| Outdoor & Patio | Outdoor dining set (table + 6+ chairs) | $139 | No | No | No |
| Outdoor & Patio | Outdoor lounge set (sofa + 2 chairs) | $125 | No | No | No |
| Outdoor & Patio | Adirondack / Adirondack set (per 2) | $75 | No | No | No |
| Outdoor & Patio | Patio umbrella + base | $75 | No | No | No |
| Outdoor & Patio | Pergola / gazebo (kit assembly) | $225-$325 | No | No | No |
| Outdoor & Patio | Fire pit (assembly only) | $75 | No | No | No |
| Outdoor & Patio | Grill (gas / charcoal assembly) | $85 | No | No | No |
| Outdoor & Patio | Storage shed (small kit) | $225-$325 | No | No | No |
| Add-ons | Furniture disposal (per piece) | $45 | Yes | No | No |
| Add-ons | Move to another room (per piece) | $29 | Yes | No | No |
| Add-ons | Broken hardware repair / replacement | $29 | Yes | No | No |
| Add-ons | Rush / same-day assembly | $39 | Yes | No | No |

### TV Mounting

| Group | Item | Price | Add-on | Popular | Custom quote |
| --- | --- | --- | --- | --- | --- |
| TV Mounting by Size | TV up to 40" (standard wall) | $99 | No | No | No |
| TV Mounting by Size | TV 41"-55" (standard wall) | $119 | No | Yes | No |
| TV Mounting by Size | TV 56"-65" (standard wall) | $149 | No | No | No |
| TV Mounting by Size | TV 66"-75" (standard wall) | $179 | No | No | No |
| TV Mounting by Size | TV 76"-85" (standard wall) | $209 | No | No | No |
| TV Mounting by Size | TV 86"+ / commercial display | $249-$329 | No | No | No |
| TV Mounting by Size | Second TV (same visit) | $69 | Yes | No | No |
| Wall Type Upgrades | Brick or concrete wall | $75 | Yes | No | No |
| Wall Type Upgrades | Tile wall | $65 | Yes | No | No |
| Wall Type Upgrades | Steel stud / metal framing | $55 | Yes | No | No |
| Wall Type Upgrades | Above fireplace mount | $85 | Yes | No | No |
| Cable & Cord Management | Surface cord cover (raceway, up to 6 ft) | $75 | No | No | No |
| Cable & Cord Management | In-wall cord concealment | $99 | No | Yes | No |
| Cable & Cord Management | In-wall cord concealment (brick / concrete) | $115 | No | No | No |
| Cable & Cord Management | Cable management box / hub install | $75 | No | No | No |
| Shelves & Wall Items | Floating shelf - single (up to 36") | $75 | No | No | No |
| Shelves & Wall Items | Floating shelf - single (37"-60") | $79 | No | No | No |
| Shelves & Wall Items | Floating shelves - set of 3 | $115 | No | No | No |
| Shelves & Wall Items | Floating shelves - set of 5+ | $155 | No | No | No |
| Shelves & Wall Items | Heavy-duty shelf (sawtooth / bracket, per shelf) | $75 | No | No | No |
| Shelves & Wall Items | Gallery wall - up to 5 pieces | $75 | No | No | No |
| Shelves & Wall Items | Gallery wall - 6-10 pieces | $105 | No | Yes | No |
| Shelves & Wall Items | Gallery wall - 11-20 pieces | $155 | No | No | No |
| Shelves & Wall Items | Single framed picture / mirror (up to 30 lbs) | $75 | No | No | No |
| Shelves & Wall Items | Heavy mirror / artwork (30-80 lbs) | $75 | No | No | No |
| Shelves & Wall Items | Full-length mirror (floor lean / anchor) | $75 | No | No | No |
| Window Treatments | Curtain rod - 1 window | $75 | No | No | No |
| Window Treatments | Curtain rod - 2 windows | $85 | No | Yes | No |
| Window Treatments | Curtain rod - 3 windows | $110 | No | No | No |
| Window Treatments | Curtain rod - 4 windows | $135 | No | No | No |
| Window Treatments | Curtain rod - 5+ windows (per additional) | $25 | Yes | No | No |
| Window Treatments | Double curtain rod (per window) | $25 | Yes | No | No |
| Window Treatments | Blind install - 1 window | $75 | No | No | No |
| Window Treatments | Blind install - per additional window | $25 | Yes | No | No |
| Window Treatments | Cellular shade / roller shade install (per window) | $75 | No | No | No |
| Window Treatments | Motorized blind / shade install (per window) | $79 | No | No | No |
| Mounting Add-ons | TV mount hardware (if not provided) | $25 | Yes | No | No |
| Mounting Add-ons | HDMI / cable routing to components | $25 | Yes | No | No |
| Mounting Add-ons | Soundbar mount (below/above TV) | $35 | Yes | No | No |
| Mounting Add-ons | Patch drywall after unmount (small) | $45 | Yes | No | No |

### Smart Home

| Group | Item | Price | Add-on | Popular | Custom quote |
| --- | --- | --- | --- | --- | --- |
| Climate Control | Smart thermostat - Nest, Ecobee, Honeywell | $79 | No | Yes | No |
| Climate Control | Smart thermostat (no C-wire, adapter needed) | $99 | No | No | No |
| Climate Control | Smart vent install (per vent) | $75 | No | No | No |
| Climate Control | Smart AC controller (window / mini-split) | $75 | No | No | No |
| Climate Control | Whole-home thermostat multi-zone (per zone) | $75 | No | No | No |
| Security & Access | Smart doorbell - Ring, Nest, Eufy | $85 | No | Yes | No |
| Security & Access | Smart doorbell (hardwired replacement) | $95 | No | No | No |
| Security & Access | Smart lock - deadbolt replacement | $95 | No | No | No |
| Security & Access | Smart lock - lever handle | $95 | No | No | No |
| Security & Access | Smart lock + deadbolt combo | $135 | No | No | No |
| Security & Access | Smart garage door opener / controller | $75 | No | No | No |
| Security & Access | Keypad entry install (outdoor) | $75 | No | No | No |
| Cameras | Indoor security camera (plug-in) | $75 | No | No | No |
| Cameras | Indoor camera (mount + cable manage) | $79 | No | No | No |
| Cameras | Outdoor camera - eave / soffit mount | $95 | No | No | No |
| Cameras | Outdoor camera - brick / concrete | $95 | No | No | No |
| Cameras | Camera system - 2 cameras | $135 | No | No | No |
| Cameras | Camera system - 4 cameras | $225 | No | Yes | No |
| Cameras | Camera system - 6+ cameras | $295-$375 | No | No | No |
| Cameras | NVR / DVR setup + camera config | $95 | No | No | No |
| Lighting | Smart bulb install + app setup (per room, up to 4 bulbs) | $75 | No | No | No |
| Lighting | Smart switch install (per switch) | $75 | No | No | No |
| Lighting | Smart dimmer install (per switch) | $79 | No | No | No |
| Lighting | Smart plug install + setup (per 2 plugs) | $75 | No | No | No |
| Lighting | LED strip lighting - per 10 ft run | $75 | No | No | No |
| Lighting | Outdoor smart lighting (per fixture) | $79 | No | No | No |
| Network & Hubs | Wi-Fi router setup + optimization | $75 | No | No | No |
| Network & Hubs | Wi-Fi extender / mesh node install (per node) | $75 | No | No | No |
| Network & Hubs | Mesh network (3-node setup, full home) | $125 | No | No | No |
| Network & Hubs | Smart home hub setup (Alexa, Google, Apple) | $75 | No | No | No |
| Network & Hubs | Smart home hub + device automation setup | $115 | No | No | No |
| Network & Hubs | TV streaming device setup (Apple TV, Roku, Fire) | $75 | No | No | No |
| Add-ons | App setup + walkthrough (per platform) | $25 | Yes | No | No |
| Add-ons | Voice assistant integration (Alexa / Google) | $25 | Yes | No | No |
| Add-ons | Automation / routine programming (per device) | $25 | Yes | No | No |
| Add-ons | Device migration (old to new system) | $35 | Yes | No | No |

### Outdoor & Playsets

| Group | Item | Price | Add-on | Popular | Custom quote |
| --- | --- | --- | --- | --- | --- |
| Playsets & Backyard Structures | Swing set / backyard playset assembly | $249 | No | Yes | No |
| Playsets & Backyard Structures | Trampoline assembly | $165 | No | No | No |
| Playsets & Backyard Structures | Pergola / gazebo kit assembly | $275-$375 | No | No | No |
| Playsets & Backyard Structures | Storage shed (small kit) | $249-$349 | No | No | No |
| Playsets & Backyard Structures | Monkey bars / climbing frame | $225 | No | No | No |
| Playsets & Backyard Structures | Sandbox / outdoor playhouse | $145 | No | No | No |
| Sports & Recreation | Basketball hoop assembly | $179 | No | No | No |
| Sports & Recreation | Outdoor swing / glider set | $145 | No | No | No |
| Sports & Recreation | Patio swing / hanging chair | $125 | No | No | No |
| Sports & Recreation | Portable pickleball / sports net setup | $95 | No | No | No |
| Add-ons | Anchoring / leveling / safety hardware | $75 | Yes | No | No |
| Add-ons | Disassembly before move or pickup | $95 | Yes | No | No |
| Add-ons | Same-day / rush outdoor assembly | $75 | Yes | No | No |
| Add-ons | Heavy-duty material haul-away | $85 | Yes | No | No |

### Office Assembly

| Group | Item | Price | Add-on | Popular | Custom quote |
| --- | --- | --- | --- | --- | --- |
| Desks & Workstations | Desk (simple flat-pack) | $95 | No | No | No |
| Desks & Workstations | Desk (L-shape / executive) | $145 | No | Yes | No |
| Desks & Workstations | Standing desk (electric) | $155 | No | No | No |
| Desks & Workstations | Cubicle workstation / multi-desk setup | $275-$395 | No | No | No |
| Seating & Storage | Office chair (standard) | $75 | No | No | No |
| Seating & Storage | Office chair (ergonomic / heavy-duty) | $85 | No | No | No |
| Seating & Storage | Bookcase / shelving unit (up to 5 shelves) | $99 | No | No | No |
| Seating & Storage | Bookcase / shelving unit (6+ shelves) | $129 | No | No | No |
| Seating & Storage | File cabinet (2-4 drawer) | $89 | No | No | No |
| Seating & Storage | Credenza / sideboard | $149 | No | No | No |
| Conference & Specialty | Conference table | $229-$329 | No | No | No |
| Conference & Specialty | Reception desk / front counter | $399-$599 | No | No | No |
| Conference & Specialty | Wall-mounted storage / overhead cabinet | $119 | No | No | No |
| Conference & Specialty | Office partition / divider install | $189 | No | No | No |
| Add-ons | Cable management / cord routing | $39 | Yes | No | No |
| Add-ons | Wall anchoring / anti-tip hardware | $45 | Yes | No | No |
| Add-ons | Rush / same-day office assembly | $55 | Yes | No | No |
| Add-ons | Furniture disposal / haul-away | $45 | Yes | No | No |

### Fitness Equipment

| Group | Item | Price | Add-on | Popular | Custom quote |
| --- | --- | --- | --- | --- | --- |
| Cardio Equipment | Treadmill assembly | $149 | No | Yes | No |
| Cardio Equipment | Exercise bike / Peloton-style bike | $139 | No | No | No |
| Cardio Equipment | Elliptical machine | $159 | No | No | No |
| Cardio Equipment | Rowing machine | $149 | No | No | No |
| Strength Equipment | Weight bench | $95 | No | No | No |
| Strength Equipment | Power rack / squat rack | $179 | No | No | No |
| Strength Equipment | Dumbbell / weight set assembly | $115 | No | No | No |
| Strength Equipment | Home gym / cable machine | $249-$349 | No | No | No |
| Strength Equipment | Multi-station gym | Custom quote | No | No | Yes |
| Add-ons | Disassembly before move or storage | $49 | Yes | No | No |
| Add-ons | Floor leveling / placement support | $35 | Yes | No | No |
| Add-ons | Safety anchoring / wall securing | $45 | Yes | No | No |
| Add-ons | Same-day / rush fitness assembly | $65 | Yes | No | No |

### Other

| Group | Item | Price | Add-on | Popular | Custom quote |
| --- | --- | --- | --- | --- | --- |
| Custom Project | Describe your project in the notes below (custom quote) | Custom quote | No | No | Yes |

## Fields Theodore Should Add to the Financial Model

| Field | Purpose |
| --- | --- |
| Estimated labor minutes | Separates fast profitable jobs from time-draining jobs. |
| Travel minutes | Prevents underpricing small jobs across Austin. |
| Easer payout dollars | Better than only using payout percentage. |
| Payment processing fee | Needed for true gross after payment costs. |
| CAC allocation | Shows whether paid ads make each service profitable. |
| Rework reserve | Suggested 1%-3% of revenue. |
| Refund reserve | Tracks customer satisfaction risk. |
| Platform gross after processing | Main unit economics check. |
| Net operating contribution | Gross minus CAC, support, insurance, software, and reserves. |
| Recommended action | Keep, raise price, bundle, add-on only, or custom quote. |

## Known Strategic Flags

- Many currently listed items sit at $75, which may be too low for standalone work after payment fees, CAC, support, rework reserve, and travel time.
- Some add-ons are priced very low ($25-$35) and should be modeled as same-visit incremental revenue, not standalone services.
- Outdoor, office, multi-camera, and home gym work likely offer better platform gross dollars per job than one-off quick jobs.
- Business accounts should be modeled separately from one-time residential work because repeat demand can lower CAC materially.
