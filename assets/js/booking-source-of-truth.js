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
        { name: 'Accent chair / armchair', price: 69 },
        { name: 'Sofa (2–3 seat, standard)', price: 89 },
        { name: 'Sectional sofa (L-shape)', price: 125, priceMax: 155, popular: true },
        { name: 'Sectional sofa (U-shape / oversized)', price: 179 },
        { name: 'Sleeper sofa / sofa bed', price: 109 },
        { name: 'Ottoman (storage)', price: 55 },
        { name: 'Bench (entryway or bedroom)', price: 55 }
      ]},
      { group: 'Bedroom', items: [
        { name: 'Bed frame — twin / full', price: 85 },
        { name: 'Bed frame — queen', price: 95, popular: true },
        { name: 'Bed frame — king / cal king', price: 109 },
        { name: 'Bed frame with storage drawers', price: 125 },
        { name: 'Platform bed with upholstered headboard', price: 135 },
        { name: 'Bunk bed / loft bed', price: 149 },
        { name: 'Trundle bed', price: 109 },
        { name: 'Crib / toddler bed', price: 85 },
        { name: 'Nightstand (single)', price: 55 },
        { name: 'Dresser (up to 6 drawers)', price: 85 },
        { name: 'Dresser (7+ drawers / double)', price: 109 },
        { name: 'Wardrobe / armoire (freestanding)', price: 109, priceMax: 135 },
        { name: 'IKEA PAX wardrobe (single unit)', price: 139, popular: true },
        { name: 'IKEA PAX wardrobe (per additional unit)', price: 79, addon: true },
        { name: 'Vanity with mirror', price: 95 }
      ]},
      { group: 'Home Office & Study', items: [
        { name: 'Desk (simple, flat-pack)', price: 69 },
        { name: 'Desk (L-shape / corner)', price: 109 },
        { name: 'Standing desk (electric)', price: 109 },
        { name: 'Office chair (standard)', price: 55 },
        { name: 'Bookcase / shelving unit (up to 5 shelves)', price: 69 },
        { name: 'Bookcase / shelving unit (6+ shelves)', price: 89 },
        { name: 'File cabinet (2–4 drawer)', price: 55 }
      ]},
      { group: 'Dining & Kitchen', items: [
        { name: 'Dining table (standard)', price: 79 },
        { name: 'Dining table (extendable / large)', price: 109 },
        { name: 'Dining chairs (per 2 chairs)', price: 39 },
        { name: 'Dining chairs (set of 4–6)', price: 75, priceMax: 95 },
        { name: 'Bar stool (per 2 stools)', price: 39 },
        { name: 'Kitchen island (freestanding)', price: 95 },
        { name: 'China cabinet / hutch', price: 109 },
        { name: 'Buffet / sideboard', price: 85 }
      ]},
      { group: 'Living Room', items: [
        { name: 'Coffee table (simple)', price: 55 },
        { name: 'Coffee table (lift-top / storage)', price: 69 },
        { name: 'Side / end table', price: 49 },
        { name: 'TV stand / media console', price: 75 },
        { name: 'Entertainment center (large)', price: 125 },
        { name: 'Console table', price: 59 }
      ]},
      { group: 'Outdoor & Patio', items: [
        { name: 'Outdoor dining set (table + 4 chairs)', price: 109 },
        { name: 'Outdoor dining set (table + 6+ chairs)', price: 139 },
        { name: 'Outdoor lounge set (sofa + 2 chairs)', price: 125 },
        { name: 'Adirondack / Adirondack set (per 2)', price: 59 },
        { name: 'Patio umbrella + base', price: 59 },
        { name: 'Pergola / gazebo (kit assembly)', price: 225, priceMax: 325 },
        { name: 'Fire pit (assembly only)', price: 75 },
        { name: 'Grill (gas / charcoal assembly)', price: 85 },
        { name: 'Storage shed (small kit)', price: 225, priceMax: 325 }
      ]},
      { group: 'Add-ons', items: [
        { name: 'Furniture disposal (per piece)', price: 45, addon: true },
        { name: 'Move to another room (per piece)', price: 29, addon: true },
        { name: 'Broken hardware repair / replacement', price: 29, addon: true },
        { name: 'Rush / same-day assembly', price: 39, addon: true }
      ]}
    ],
    'TV Mounting': [
      { group: 'TV Mounting by Size', items: [
        { name: 'TV up to 40” (standard wall)', price: 69 },
        { name: 'TV 41”–55” (standard wall)', price: 79, popular: true },
        { name: 'TV 56”–65” (standard wall)', price: 89 },
        { name: 'TV 66”–75” (standard wall)', price: 99 },
        { name: 'TV 76”–85” (standard wall)', price: 115 },
        { name: 'TV 86”+ / commercial display', price: 135, priceMax: 175 },
        { name: 'Second TV (same visit)', price: 25, addon: true }
      ]},
      { group: 'Wall Type Upgrades', items: [
        { name: 'Brick or concrete wall', price: 45, addon: true },
        { name: 'Tile wall', price: 45, addon: true },
        { name: 'Steel stud / metal framing', price: 35, addon: true },
        { name: 'Above fireplace mount', price: 55, addon: true }
      ]},
      { group: 'Cable & Cord Management', items: [
        { name: 'Surface cord cover (raceway, up to 6 ft)', price: 55 },
        { name: 'In-wall cord concealment', price: 99, popular: true },
        { name: 'In-wall cord concealment (brick / concrete)', price: 115 },
        { name: 'Cable management box / hub install', price: 45 }
      ]},
      { group: 'Shelves & Wall Items', items: [
        { name: 'Floating shelf — single (up to 36”)', price: 55 },
        { name: 'Floating shelf — single (37”–60”)', price: 69 },
        { name: 'Floating shelves — set of 3', price: 115 },
        { name: 'Floating shelves — set of 5+', price: 155 },
        { name: 'Heavy-duty shelf (sawtooth / bracket, per shelf)', price: 65 },
        { name: 'Gallery wall — up to 5 pieces', price: 75 },
        { name: 'Gallery wall — 6–10 pieces', price: 105, popular: true },
        { name: 'Gallery wall — 11–20 pieces', price: 155 },
        { name: 'Single framed picture / mirror (up to 30 lbs)', price: 45 },
        { name: 'Heavy mirror / artwork (30–80 lbs)', price: 65 },
        { name: 'Full-length mirror (floor lean / anchor)', price: 45 }
      ]},
      { group: 'Window Treatments', items: [
        { name: 'Curtain rod — 1 window', price: 55 },
        { name: 'Curtain rod — 2 windows', price: 85, popular: true },
        { name: 'Curtain rod — 3 windows', price: 110 },
        { name: 'Curtain rod — 4 windows', price: 135 },
        { name: 'Curtain rod — 5+ windows (per additional)', price: 25, addon: true },
        { name: 'Double curtain rod (per window)', price: 15, addon: true },
        { name: 'Blind install — 1 window', price: 45 },
        { name: 'Blind install — per additional window', price: 25, addon: true },
        { name: 'Cellular shade / roller shade install (per window)', price: 45 },
        { name: 'Motorized blind / shade install (per window)', price: 65 }
      ]},
      { group: 'Mounting Add-ons', items: [
        { name: 'TV mount hardware (if not provided)', price: 25, addon: true },
        { name: 'HDMI / cable routing to components', price: 25, addon: true },
        { name: 'Soundbar mount (below/above TV)', price: 35, addon: true },
        { name: 'Patch drywall after unmount (small)', price: 45, addon: true }
      ]}
    ],
    'Smart Home': [
      { group: 'Climate Control', items: [
        { name: 'Smart thermostat — Nest, Ecobee, Honeywell', price: 79, popular: true },
        { name: 'Smart thermostat (no C-wire, adapter needed)', price: 99 },
        { name: 'Smart vent install (per vent)', price: 45 },
        { name: 'Smart AC controller (window / mini-split)', price: 55 },
        { name: 'Whole-home thermostat multi-zone (per zone)', price: 75 }
      ]},
      { group: 'Security & Access', items: [
        { name: 'Smart doorbell — Ring, Nest, Eufy', price: 85, popular: true },
        { name: 'Smart doorbell (hardwired replacement)', price: 95 },
        { name: 'Smart lock — deadbolt replacement', price: 95 },
        { name: 'Smart lock — lever handle', price: 95 },
        { name: 'Smart lock + deadbolt combo', price: 135 },
        { name: 'Smart garage door opener / controller', price: 75 },
        { name: 'Keypad entry install (outdoor)', price: 75 }
      ]},
      { group: 'Cameras', items: [
        { name: 'Indoor security camera (plug-in)', price: 55 },
        { name: 'Indoor camera (mount + cable manage)', price: 79 },
        { name: 'Outdoor camera — eave / soffit mount', price: 95 },
        { name: 'Outdoor camera — brick / concrete', price: 95 },
        { name: 'Camera system — 2 cameras', price: 135 },
        { name: 'Camera system — 4 cameras', price: 225, popular: true },
        { name: 'Camera system — 6+ cameras', price: 295, priceMax: 375 },
        { name: 'NVR / DVR setup + camera config', price: 95 }
      ]},
      { group: 'Lighting', items: [
        { name: 'Smart bulb install + app setup (per room, up to 4 bulbs)', price: 45 },
        { name: 'Smart switch install (per switch)', price: 55 },
        { name: 'Smart dimmer install (per switch)', price: 60 },
        { name: 'Smart plug install + setup (per 2 plugs)', price: 35 },
        { name: 'LED strip lighting — per 10 ft run', price: 55 },
        { name: 'Outdoor smart lighting (per fixture)', price: 65 }
      ]},
      { group: 'Network & Hubs', items: [
        { name: 'Wi-Fi router setup + optimization', price: 65 },
        { name: 'Wi-Fi extender / mesh node install (per node)', price: 55 },
        { name: 'Mesh network (3-node setup, full home)', price: 125 },
        { name: 'Smart home hub setup (Alexa, Google, Apple)', price: 75 },
        { name: 'Smart home hub + device automation setup', price: 115 },
        { name: 'TV streaming device setup (Apple TV, Roku, Fire)', price: 45 }
      ]},
      { group: 'Add-ons', items: [
        { name: 'App setup + walkthrough (per platform)', price: 25, addon: true },
        { name: 'Voice assistant integration (Alexa / Google)', price: 25, addon: true },
        { name: 'Automation / routine programming (per device)', price: 15, addon: true },
        { name: 'Device migration (old to new system)', price: 35, addon: true }
      ]}
    ],
    'Outdoor & Playsets': [
      { group: 'Playsets & Backyard Structures', items: [
        { name: 'Swing set / backyard playset assembly', price: 249, popular: true },
        { name: 'Trampoline assembly', price: 165 },
        { name: 'Pergola / gazebo kit assembly', price: 275, priceMax: 375 },
        { name: 'Storage shed (small kit)', price: 249, priceMax: 349 },
        { name: 'Monkey bars / climbing frame', price: 225 },
        { name: 'Sandbox / outdoor playhouse', price: 145 }
      ]},
      { group: 'Sports & Recreation', items: [
        { name: 'Basketball hoop assembly', price: 179 },
        { name: 'Outdoor swing / glider set', price: 145 },
        { name: 'Patio swing / hanging chair', price: 125 },
        { name: 'Portable pickleball / sports net setup', price: 95 }
      ]},
      { group: 'Add-ons', items: [
        { name: 'Anchoring / leveling / safety hardware', price: 75, addon: true },
        { name: 'Disassembly before move or pickup', price: 95, addon: true },
        { name: 'Same-day / rush outdoor assembly', price: 75, addon: true },
        { name: 'Heavy-duty material haul-away', price: 85, addon: true }
      ]}
    ],
    'Office Assembly': [
      { group: 'Desks & Workstations', items: [
        { name: 'Desk (simple flat-pack)', price: 95 },
        { name: 'Desk (L-shape / executive)', price: 145, popular: true },
        { name: 'Standing desk (electric)', price: 155 },
        { name: 'Cubicle workstation / multi-desk setup', price: 275, priceMax: 395 }
      ]},
      { group: 'Seating & Storage', items: [
        { name: 'Office chair (standard)', price: 65 },
        { name: 'Office chair (ergonomic / heavy-duty)', price: 85 },
        { name: 'Bookcase / shelving unit (up to 5 shelves)', price: 85 },
        { name: 'Bookcase / shelving unit (6+ shelves)', price: 105 },
        { name: 'File cabinet (2–4 drawer)', price: 75 },
        { name: 'Credenza / sideboard', price: 125 }
      ]},
      { group: 'Conference & Specialty', items: [
        { name: 'Conference table', price: 175, priceMax: 225 },
        { name: 'Reception desk / front counter', price: 275, priceMax: 425 },
        { name: 'Wall-mounted storage / overhead cabinet', price: 95 },
        { name: 'Office partition / divider install', price: 145 }
      ]},
      { group: 'Add-ons', items: [
        { name: 'Cable management / cord routing', price: 25, addon: true },
        { name: 'Wall anchoring / anti-tip hardware', price: 35, addon: true },
        { name: 'Rush / same-day office assembly', price: 55, addon: true },
        { name: 'Furniture disposal / haul-away', price: 45, addon: true }
      ]}
    ],
    'Fitness Equipment': [
      { group: 'Cardio Equipment', items: [
        { name: 'Treadmill assembly', price: 149, popular: true },
        { name: 'Exercise bike / Peloton-style bike', price: 139 },
        { name: 'Elliptical machine', price: 159 },
        { name: 'Rowing machine', price: 149 }
      ]},
      { group: 'Strength Equipment', items: [
        { name: 'Weight bench', price: 95 },
        { name: 'Power rack / squat rack', price: 179 },
        { name: 'Dumbbell / weight set assembly', price: 115 },
        { name: 'Home gym / cable machine', price: 249, priceMax: 349 },
        { name: 'Multi-station gym', price: 0, customQuote: true }
      ]},
      { group: 'Add-ons', items: [
        { name: 'Disassembly before move or storage', price: 49, addon: true },
        { name: 'Floor leveling / placement support', price: 35, addon: true },
        { name: 'Safety anchoring / wall securing', price: 45, addon: true },
        { name: 'Same-day / rush fitness assembly', price: 65, addon: true }
      ]}
    ],
    'Other': [
      { group: 'Custom Project', items: [
        { name: 'Describe your project in the notes below (custom quote)', price: 0, customQuote: true }
      ]}
    ]
  }
};
