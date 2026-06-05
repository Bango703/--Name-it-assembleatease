// Phase 1 foundation: booking catalog and service area rules.
// This file is the customer-booking source of truth for subcategories and ZIP range.

window.AAE_BOOKING_SOURCE = {
  serviceArea: {
    city: 'Austin',
    state: 'TX',
    zipPrefixMin: 786,
    zipPrefixMax: 788,
  },
  subcategories: {
    'Furniture Assembly': [
      { group: 'Seating & Sofas', items: [
        { name: 'Accent chair / armchair', price: 79 },
        { name: 'Sofa (2–3 seat, standard)', price: 109 },
        { name: 'Sectional sofa (L-shape)', price: 139, priceMax: 169, popular: true },
        { name: 'Sectional sofa (U-shape / oversized)', price: 189, priceMax: 229 },
        { name: 'Sleeper sofa / sofa bed', price: 119 },
        { name: 'Ottoman (storage)', price: 69 },
        { name: 'Bench (entryway or bedroom)', price: 69 }
      ]},
      { group: 'Bedroom', items: [
        { name: 'Bed frame — twin / full', price: 89 },
        { name: 'Bed frame — queen', price: 109, popular: true },
        { name: 'Bed frame — king / cal king', price: 129 },
        { name: 'Bed frame with storage drawers', price: 149 },
        { name: 'Platform bed with upholstered headboard', price: 159 },
        { name: 'Bunk bed / loft bed', price: 179 },
        { name: 'Trundle bed', price: 119 },
        { name: 'Crib / toddler bed', price: 89 },
        { name: 'Nightstand (single)', price: 69 },
        { name: 'Dresser (up to 6 drawers)', price: 99 },
        { name: 'Dresser (7+ drawers / double)', price: 119 },
        { name: 'Wardrobe / armoire (freestanding)', price: 119, priceMax: 149 },
        { name: 'IKEA PAX wardrobe (single unit)', price: 149, popular: true },
        { name: 'IKEA PAX wardrobe (per additional unit)', price: 89, addon: true },
        { name: 'Vanity with mirror', price: 109 }
      ]},
      { group: 'Home Office & Study', items: [
        { name: 'Desk (simple, flat-pack)', price: 89 },
        { name: 'Desk (L-shape / corner)', price: 119 },
        { name: 'Standing desk (electric)', price: 129 },
        { name: 'Office chair (standard)', price: 79 },
        { name: 'Bookcase / shelving unit (up to 5 shelves)', price: 89 },
        { name: 'Bookcase / shelving unit (6+ shelves)', price: 109 },
        { name: 'File cabinet (2–4 drawer)', price: 79 }
      ]},
      { group: 'Dining & Kitchen', items: [
        { name: 'Dining table (standard)', price: 99 },
        { name: 'Dining table (extendable / large)', price: 119 },
        { name: 'Dining chairs (per 2 chairs)', price: 59 },
        { name: 'Dining chairs (set of 4–6)', price: 99 },
        { name: 'Bar stool (per 2 stools)', price: 59 },
        { name: 'Kitchen island (freestanding)', price: 109 },
        { name: 'China cabinet / hutch', price: 129 },
        { name: 'Buffet / sideboard', price: 109 }
      ]},
      { group: 'Living Room', items: [
        { name: 'Coffee table (simple)', price: 79 },
        { name: 'Coffee table (lift-top / storage)', price: 89 },
        { name: 'Side / end table', price: 59 },
        { name: 'TV stand / media console', price: 99 },
        { name: 'Entertainment center (large)', price: 145 },
        { name: 'Console table', price: 79 }
      ]},
      { group: 'Outdoor & Patio', items: [
        { name: 'Outdoor dining set (table + 4 chairs)', price: 129 },
        { name: 'Outdoor dining set (table + 6+ chairs)', price: 159 },
        { name: 'Outdoor lounge set (sofa + 2 chairs)', price: 149 },
        { name: 'Adirondack chairs (per 2)', price: 89 },
        { name: 'Patio umbrella + base', price: 79 },
        { name: 'Pergola / gazebo (kit assembly)', price: 299, priceMax: 449 },
        { name: 'Fire pit (assembly only)', price: 89 },
        { name: 'Grill (gas / charcoal assembly)', price: 99 },
        { name: 'Storage shed (small kit)', price: 269, priceMax: 399 }
      ]},
      { group: 'Add-ons', items: [
        { name: 'Furniture disposal (per piece)', price: 45, addon: true },
        { name: 'Move to another room (per piece)', price: 29, addon: true },
        { name: 'Broken hardware repair / replacement', price: 35, addon: true },
        { name: 'Rush / same-day assembly', price: 49, addon: true }
      ]}
    ],
    'Mounting & Hanging': [
      { group: 'TV Mounting by Size', items: [
        { name: 'TV up to 40" (standard wall)', price: 89 },
        { name: 'TV 41"–55" (standard wall)', price: 109, popular: true },
        { name: 'TV 56"–65" (standard wall)', price: 129 },
        { name: 'TV 66"–75" (standard wall)', price: 149 },
        { name: 'TV 76"–85" (standard wall)', price: 179 },
        { name: 'TV 86"+ / commercial display', price: 219, priceMax: 279 },
        { name: 'Second TV (same visit)', price: 59, addon: true }
      ]},
      { group: 'Wall Type Upgrades', items: [
        { name: 'Brick or concrete wall', price: 65, addon: true },
        { name: 'Tile wall', price: 55, addon: true },
        { name: 'Steel stud / metal framing', price: 45, addon: true },
        { name: 'Above fireplace mount', price: 75, addon: true }
      ]},
      { group: 'Cable & Cord Management', items: [
        { name: 'Surface cord cover (raceway, up to 6 ft)', price: 79 },
        { name: 'In-wall cord concealment', price: 169, popular: true },
        { name: 'In-wall cord concealment (brick / concrete)', price: 229 },
        { name: 'Cable management box / hub install', price: 69 }
      ]},
      { group: 'Shelves & Wall Items', items: [
        { name: 'Floating shelf — single (up to 36")', price: 79 },
        { name: 'Floating shelf — single (37"–60")', price: 99 },
        { name: 'Floating shelves — set of 3', price: 129 },
        { name: 'Floating shelves — set of 5+', price: 189 },
        { name: 'Heavy-duty shelf (sawtooth / bracket, per shelf)', price: 89 },
        { name: 'Gallery wall — up to 5 pieces', price: 99 },
        { name: 'Gallery wall — 6–10 pieces', price: 149, popular: true },
        { name: 'Gallery wall — 11–20 pieces', price: 219 },
        { name: 'Single framed picture / mirror (up to 30 lbs)', price: 59 },
        { name: 'Heavy mirror / artwork (30–80 lbs)', price: 119 },
        { name: 'Full-length mirror (floor lean / anchor)', price: 69 }
      ]},
      { group: 'Window Treatments', items: [
        { name: 'Curtain rod — 1 window', price: 79 },
        { name: 'Curtain rod — 2 windows', price: 109, popular: true },
        { name: 'Curtain rod — 3 windows', price: 139 },
        { name: 'Curtain rod — 4 windows', price: 165 },
        { name: 'Curtain rod — 5+ windows (per additional)', price: 29, addon: true },
        { name: 'Double curtain rod (per window)', price: 19, addon: true },
        { name: 'Blind install — 1 window', price: 79 },
        { name: 'Blind install — per additional window', price: 29, addon: true },
        { name: 'Cellular shade / roller shade install (per window)', price: 89 },
        { name: 'Motorized blind / shade install (per window)', price: 129 }
      ]},
      { group: 'Mounting Add-ons', items: [
        { name: 'TV mount hardware (if not provided)', price: 35, addon: true },
        { name: 'HDMI / cable routing to components', price: 29, addon: true },
        { name: 'Soundbar mount (below/above TV)', price: 49, addon: true },
        { name: 'Patch drywall after unmount (small)', price: 55, addon: true }
      ]}
    ],
    'Smart Home': [
      { group: 'Climate Control', items: [
        { name: 'Smart thermostat — Nest, Ecobee, Honeywell', price: 89, popular: true },
        { name: 'Smart thermostat (no C-wire, adapter install)', price: 119 },
        { name: 'Smart vent install (per vent)', price: 49 },
        { name: 'Smart AC controller (window / mini-split)', price: 79 },
        { name: 'Multi-zone thermostat setup (per additional zone)', price: 89 }
      ]},
      { group: 'Security & Access', items: [
        { name: 'Smart doorbell — wireless / battery-powered', price: 79, popular: true },
        { name: 'Smart doorbell (hardwired replacement)', price: 109 },
        { name: 'Smart lock — deadbolt replacement', price: 99 },
        { name: 'Smart lock — lever handle', price: 89 },
        { name: 'Smart lock + deadbolt combo', price: 149 },
        { name: 'Smart garage door opener / controller', price: 99 },
        { name: 'Keypad entry install (outdoor)', price: 109 }
      ]},
      { group: 'Cameras', items: [
        { name: 'Indoor security camera (plug-in)', price: 59 },
        { name: 'Indoor camera (mount + cable manage)', price: 79 },
        { name: 'Outdoor camera — eave / soffit mount', price: 99 },
        { name: 'Outdoor camera — brick / concrete', price: 129 },
        { name: 'Camera system — 2 cameras', price: 149 },
        { name: 'Camera system — 4 cameras', price: 229, popular: true },
        { name: 'Camera system — 6+ cameras', price: 319, priceMax: 429 },
        { name: 'NVR / DVR setup + camera config', price: 119 }
      ]},
      { group: 'Lighting', items: [
        { name: 'Smart bulb install + app setup (per room, up to 4 bulbs)', price: 59 },
        { name: 'Smart switch install (per switch)', price: 79 },
        { name: 'Smart dimmer install (per switch)', price: 89 },
        { name: 'Smart plug install + setup (per 2 plugs)', price: 49 },
        { name: 'LED strip lighting — per 10 ft run', price: 89 },
        { name: 'Outdoor smart lighting (per fixture)', price: 99 }
      ]},
      { group: 'Network & Hubs', items: [
        { name: 'Wi-Fi router setup + optimization', price: 89 },
        { name: 'Wi-Fi extender / mesh node install (per node)', price: 79 },
        { name: 'Mesh network (3-node setup, full home)', price: 149 },
        { name: 'Smart home hub setup (Alexa, Google, Apple)', price: 79 },
        { name: 'Smart home hub + device automation setup', price: 129 },
        { name: 'TV streaming device setup (Apple TV, Roku, Fire)', price: 59 }
      ]},
      { group: 'Add-ons', items: [
        { name: 'App setup + walkthrough (per platform)', price: 25, addon: true },
        { name: 'Voice assistant integration (Alexa / Google)', price: 29, addon: true },
        { name: 'Automation / routine programming (per device)', price: 19, addon: true },
        { name: 'Device migration (old to new system)', price: 45, addon: true }
      ]}
    ],
    'Outdoor & Playsets': [
      { group: 'Playsets & Backyard Structures', items: [
        { name: 'Swing set / backyard playset assembly', price: 279, priceMax: 349, popular: true },
        { name: 'Trampoline assembly', price: 179 },
        { name: 'Pergola / gazebo kit assembly', price: 349, priceMax: 549 },
        { name: 'Storage shed (small kit)', price: 299, priceMax: 449 },
        { name: 'Monkey bars / climbing frame', price: 249 },
        { name: 'Sandbox / outdoor playhouse', price: 159 }
      ]},
      { group: 'Sports & Recreation', items: [
        { name: 'Basketball hoop assembly', price: 199 },
        { name: 'Outdoor swing / glider set', price: 149 },
        { name: 'Patio swing / hanging chair', price: 129 },
        { name: 'Portable pickleball / sports net setup', price: 89 }
      ]},
      { group: 'Add-ons', items: [
        { name: 'Anchoring / leveling / safety hardware', price: 89, addon: true },
        { name: 'Disassembly before move or pickup', price: 109, addon: true },
        { name: 'Same-day / rush outdoor assembly', price: 89, addon: true },
        { name: 'Heavy-duty material haul-away', price: 99, addon: true }
      ]}
    ],
    'Office Assembly': [
      { group: 'Desks & Workstations', items: [
        { name: 'Desk (simple flat-pack)', price: 89 },
        { name: 'Desk (L-shape / executive)', price: 159, popular: true },
        { name: 'Standing desk (electric)', price: 179 },
        { name: 'Cubicle workstation / multi-desk setup', price: 349, priceMax: 549 }
      ]},
      { group: 'Seating & Storage', items: [
        { name: 'Office chair (standard)', price: 79 },
        { name: 'Office chair (ergonomic / heavy-duty)', price: 99 },
        { name: 'Bookcase / shelving unit (up to 5 shelves)', price: 89 },
        { name: 'Bookcase / shelving unit (6+ shelves)', price: 119 },
        { name: 'File cabinet (2–4 drawer)', price: 79 },
        { name: 'Credenza / sideboard', price: 139 }
      ]},
      { group: 'Conference & Specialty', items: [
        { name: 'Conference table', price: 199, priceMax: 299 },
        { name: 'Reception desk / front counter', price: 349, priceMax: 549 },
        { name: 'Wall-mounted storage / overhead cabinet', price: 109 },
        { name: 'Office partition / divider install', price: 169 }
      ]},
      { group: 'Add-ons', items: [
        { name: 'Cable management / cord routing', price: 35, addon: true },
        { name: 'Wall anchoring / anti-tip hardware', price: 39, addon: true },
        { name: 'Rush / same-day office assembly', price: 65, addon: true },
        { name: 'Furniture disposal / haul-away', price: 55, addon: true }
      ]}
    ],
    'Fitness Equipment': [
      { group: 'Cardio Equipment', items: [
        { name: 'Treadmill assembly', price: 169, popular: true },
        { name: 'Exercise bike / Peloton-style bike', price: 149 },
        { name: 'Elliptical machine', price: 189 },
        { name: 'Rowing machine', price: 159 }
      ]},
      { group: 'Strength Equipment', items: [
        { name: 'Weight bench', price: 109 },
        { name: 'Power rack / squat rack', price: 199 },
        { name: 'Dumbbell / weight set assembly', price: 129 },
        { name: 'Home gym / cable machine', price: 279, priceMax: 399 },
        { name: 'Multi-station gym', price: 0, customQuote: true }
      ]},
      { group: 'Add-ons', items: [
        { name: 'Disassembly before move or storage', price: 59, addon: true },
        { name: 'Floor leveling / placement support', price: 39, addon: true },
        { name: 'Safety anchoring / wall securing', price: 49, addon: true },
        { name: 'Same-day / rush fitness assembly', price: 75, addon: true }
      ]}
    ],
    'Other': [
      { group: 'Custom Project', items: [
        { name: 'Describe your project in the notes below (custom quote)', price: 0, customQuote: true }
      ]}
    ]
  }
};
