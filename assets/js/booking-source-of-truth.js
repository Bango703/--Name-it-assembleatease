// Booking catalog — source of truth for service subcategories, pricing, and ZIP range.
// Prices reflect realistic Austin market rates. Booking totals add the flat
// service call fee, tax, and launch minimum guardrails in the booking/pricing flow.

window.AAE_BOOKING_SOURCE = {
  serviceArea: {
    city: 'Texas',
    state: 'TX',
    label: 'Statewide Texas service',
    statewideTexas: true,
    zipPrefixes: ['787'],
    zipCodes: [
      '78610', '78613', '78626', '78628', '78630', '78633', '78634',
      '78640', '78641', '78645', '78646', '78653', '78660', '78664',
      '78665', '78680', '78681', '78682', '78683', '78691',
    ],
  },
  // Room-Ready bundles — curated OUTCOMES built from existing catalog items.
  // Each `included`/`optionalAddons` entry references a real {service, name} in
  // `subcategories` below, so a bundle is priced exactly like hand-picked items —
  // no separate bundle pricing and no duplicate money truth. `/book?bundle=<slug>`
  // pre-selects the included items via toggleItem(); optional add-ons are suggested,
  // never auto-added. Copy is benefit-led and location-neutral (brand-level).
  bundles: [
    {
      id: 'bedroom-ready', slug: 'bedroom-ready', name: 'Bedroom Ready',
      outcome: 'Bed built, dresser assembled, nightstand placed — the bedroom handled in one visit.',
      active: true, displayOrder: 1,
      included: [
        { service: 'Furniture Assembly', name: 'Bed frame — queen' },
        { service: 'Furniture Assembly', name: 'Dresser (up to 6 drawers)' },
        { service: 'Furniture Assembly', name: 'Nightstand (single)' },
      ],
      optionalAddons: [
        { service: 'Office Assembly', name: 'Wall anchoring / anti-tip hardware' },
      ],
      seoTitle: 'Bedroom Ready Setup: Bed, Dresser and Nightstand Assembly | AssembleAtEase',
      seoDescription: 'Get the whole bedroom set up in one visit — bed frame, dresser, and nightstand assembled with flat, upfront pricing. No charge until the job is done.',
    },
    {
      id: 'living-room-ready', slug: 'living-room-ready', name: 'Living Room Ready',
      outcome: 'TV mounted, media console built, cords tidied — a living room that looks finished.',
      active: true, displayOrder: 2,
      included: [
        { service: 'Mounting & Hanging', name: 'TV 41"–55" (standard wall)' },
        { service: 'Furniture Assembly', name: 'TV stand / media console' },
      ],
      optionalAddons: [
        { service: 'Mounting & Hanging', name: 'In-wall cord concealment' },
      ],
      seoTitle: 'Living Room Ready: TV Mounting and Media Console Setup | AssembleAtEase',
      seoDescription: 'TV mounted, entertainment console assembled, and cords cleaned up in one visit. Flat, upfront pricing and no charge until the job is done.',
    },
    {
      id: 'home-office-ready', slug: 'home-office-ready', name: 'Home Office Ready',
      outcome: 'Desk and chair built, cables managed — sit down and get to work.',
      active: true, displayOrder: 3,
      included: [
        { service: 'Office Assembly', name: 'Desk (simple flat-pack)' },
        { service: 'Office Assembly', name: 'Office chair (standard)' },
      ],
      optionalAddons: [
        { service: 'Office Assembly', name: 'Monitor arm install (desk clamp)' },
        { service: 'Office Assembly', name: 'Cable management / cord routing' },
      ],
      seoTitle: 'Home Office Ready: Desk, Chair and Cable Setup | AssembleAtEase',
      seoDescription: 'Desk assembled, chair built, monitor arm and cables handled — your home office ready to work in one visit. Flat pricing, no charge until done.',
    },
    {
      id: 'move-in-ready', slug: 'move-in-ready', name: 'Move-In Setup',
      outcome: 'New place, handled — bed, sofa, and TV set up so you can settle in. Add anything else you need.',
      active: true, displayOrder: 4,
      included: [
        { service: 'Furniture Assembly', name: 'Bed frame — queen' },
        { service: 'Furniture Assembly', name: 'Sofa (2–3 seat, standard)' },
        { service: 'Mounting & Hanging', name: 'TV 41"–55" (standard wall)' },
      ],
      optionalAddons: [],
      seoTitle: 'Move-In Setup: Furniture, TV and Home Setup After Moving | AssembleAtEase',
      seoDescription: 'Just moved? Get furniture assembled, your TV mounted, and your new place set up in one visit. Add as much as you need with flat, upfront pricing.',
    },
    {
      id: 'smart-entry-setup', slug: 'smart-entry-setup', name: 'Smart Entry Setup',
      outcome: 'Video doorbell, smart lock, and a camera installed and set up on your phone.',
      active: true, displayOrder: 5,
      included: [
        { service: 'Smart Home', name: 'Smart doorbell — wireless / battery-powered' },
        { service: 'Smart Home', name: 'Smart lock — deadbolt replacement' },
        { service: 'Smart Home', name: 'Indoor security camera (plug-in)' },
      ],
      optionalAddons: [],
      seoTitle: 'Smart Entry Setup: Video Doorbell, Smart Lock and Camera | AssembleAtEase',
      seoDescription: 'Video doorbell, smart lock, and security camera installed and configured on your phone in one visit. Flat pricing, no charge until the job is done.',
    },
    {
      id: 'nursery-setup', slug: 'nursery-setup', name: 'Nursery Setup',
      outcome: 'Crib, dresser, and storage built and anchored — the nursery ready for baby.',
      active: true, displayOrder: 6,
      included: [
        { service: 'Furniture Assembly', name: 'Crib / toddler bed' },
        { service: 'Furniture Assembly', name: 'Dresser (up to 6 drawers)' },
        { service: 'Furniture Assembly', name: 'Toy storage / cube organizer' },
      ],
      optionalAddons: [
        { service: 'Office Assembly', name: 'Wall anchoring / anti-tip hardware' },
      ],
      seoTitle: 'Nursery Setup: Crib, Dresser and Storage Assembly | AssembleAtEase',
      seoDescription: 'Crib, dresser, and nursery storage assembled and safely anchored in one visit. Flat, upfront pricing and no charge until the job is done.',
    },
  ],
  subcategories: {
    'Furniture Assembly': [
      { group: 'Seating & Sofas', items: [
        { name: 'Accent chair / armchair', price: 89 },
        { name: 'Sofa (2–3 seat, standard)', price: 119 },
        { name: 'Sectional sofa (L-shape)', price: 159, priceMax: 199, popular: true },
        { name: 'Sectional sofa (U-shape / oversized)', price: 219, priceMax: 269 },
        { name: 'Sleeper sofa / sofa bed', price: 139 },
        { name: 'Ottoman (storage)', price: 79 },
        { name: 'Bench (entryway or bedroom)', price: 79 }
      ]},
      { group: 'Bedroom', items: [
        { name: 'Bed frame — twin / full', price: 99 },
        { name: 'Bed frame — queen', price: 119, popular: true },
        { name: 'Bed frame — king / cal king', price: 139 },
        { name: 'Bed frame with storage drawers', price: 159 },
        { name: 'Platform bed with upholstered headboard', price: 169 },
        { name: 'Bunk bed / loft bed', price: 199 },
        { name: 'Trundle bed', price: 129 },
        { name: 'Crib / toddler bed', price: 99 },
        { name: 'Nightstand (single)', price: 79 },
        { name: 'Dresser (up to 6 drawers)', price: 109 },
        { name: 'Dresser (7+ drawers / double)', price: 129 },
        { name: 'Wardrobe / armoire (freestanding)', price: 129, priceMax: 159 },
        { name: 'IKEA PAX wardrobe (single unit)', price: 169, popular: true },
        { name: 'IKEA PAX wardrobe (per additional unit)', price: 99, addon: true },
        { name: 'Vanity with mirror', price: 119 }
      ]},
      { group: 'Home Office Furniture', items: [
        { name: 'Home desk (simple, flat-pack)', price: 99 },
        { name: 'Home desk (L-shape / corner)', price: 129 },
        { name: 'Home standing desk (electric)', price: 149 },
        { name: 'Home office chair (standard)', price: 89 },
        { name: 'Home bookcase / shelving unit (up to 5 shelves)', price: 99 },
        { name: 'Home bookcase / shelving unit (6+ shelves)', price: 119 },
        { name: 'Home file cabinet (2–4 drawer)', price: 89 }
      ]},
      { group: 'Dining & Kitchen', items: [
        { name: 'Dining table (standard)', price: 109 },
        { name: 'Dining table (extendable / large)', price: 129 },
        { name: 'Dining chairs (per 2 chairs)', price: 69 },
        { name: 'Dining chairs (set of 4–6)', price: 109 },
        { name: 'Bar stool (per 2 stools)', price: 69 },
        { name: 'Kitchen island (freestanding)', price: 119 },
        { name: 'China cabinet / hutch', price: 139 },
        { name: 'Buffet / sideboard', price: 119 }
      ]},
      { group: 'Living Room', items: [
        { name: 'Coffee table (simple)', price: 89 },
        { name: 'Coffee table (lift-top / storage)', price: 99 },
        { name: 'Side / end table', price: 69 },
        { name: 'TV stand / media console', price: 109 },
        { name: 'Entertainment center (large)', price: 159 },
        { name: 'Console table', price: 89 }
      ]},
      { group: 'Storage & Entryway', items: [
        { name: 'Storage cabinet / pantry cabinet', price: 109 },
        { name: 'Shoe cabinet / entryway organizer', price: 89 },
        { name: 'Closet organizer system (basic kit)', price: 149, priceMax: 199 },
        { name: 'Bathroom cabinet / over-toilet storage', price: 89 },
        { name: 'Toy storage / cube organizer', price: 79 }
      ]},
      { group: 'Add-ons', items: [
        { name: 'Furniture disposal (per piece)', price: 49, addon: true, tags: ['convenience'], recoLabel: 'Haul away old furniture', recoWhy: 'We take the old piece' },
        { name: 'Move to another room (per piece)', price: 35, addon: true, tags: ['convenience'], recoLabel: 'Move it to another room', recoWhy: 'Placed exactly where you want' },
        { name: 'Broken hardware repair / replacement', price: 39, addon: true },
        { name: 'Rush / same-day assembly', price: 55, addon: true }
      ]}
    ],
    'Mounting & Hanging': [
      { group: 'TV Mounting by Size', items: [
        { name: 'TV up to 40" (standard wall)', price: 99 },
        { name: 'TV 41"–55" (standard wall)', price: 119, popular: true },
        { name: 'TV 56"–65" (standard wall)', price: 149 },
        { name: 'TV 66"–75" (standard wall)', price: 179 },
        { name: 'TV 76"–85" (standard wall)', price: 209 },
        { name: 'TV 86"+ / commercial display', price: 249, priceMax: 329 },
        { name: 'Second TV (same visit)', price: 69, addon: true, tags: ['convenience'], appliesTo: ['tv'], recoLabel: 'Add a second TV', recoWhy: 'Cheaper than booking another trip' }
      ]},
      { group: 'Wall Type Upgrades', items: [
        { name: 'Brick or concrete wall', price: 75, addon: true },
        { name: 'Tile wall', price: 65, addon: true },
        { name: 'Steel stud / metal framing', price: 55, addon: true },
        { name: 'Above fireplace mount', price: 85, addon: true }
      ]},
      { group: 'Cable & Cord Management', items: [
        { name: 'Surface cord cover (raceway, up to 6 ft)', price: 89, tags: ['upgrade'], appliesTo: ['tv'], recoLabel: 'Hide the cords', recoWhy: 'Cleaner finish without opening drywall' },
        { name: 'In-wall cord concealment', price: 189, popular: true, tags: ['upgrade'], appliesTo: ['tv'], recoLabel: 'In-wall cord concealment', recoWhy: 'Premium clean look for mounted TVs' },
        { name: 'In-wall cord concealment (brick / concrete)', price: 249, tags: ['upgrade'], appliesTo: ['tv','brick','concrete'], recoLabel: 'In-wall concealment for masonry', recoWhy: 'Premium finish for brick or concrete walls' },
        { name: 'Cable management box / hub install', price: 79, tags: ['convenience'], appliesTo: ['tv'], recoLabel: 'Tidy the media box', recoWhy: 'Keeps components and wires organized' }
      ]},
      { group: 'Shelves & Wall Items', items: [
        { name: 'Floating shelf — single (up to 36")', price: 89 },
        { name: 'Floating shelf — single (37"–60")', price: 109 },
        { name: 'Floating shelves — set of 3', price: 149 },
        { name: 'Floating shelves — set of 5+', price: 209 },
        { name: 'Heavy-duty shelf (sawtooth / bracket, per shelf)', price: 99 },
        { name: 'Gallery wall — up to 5 pieces', price: 109 },
        { name: 'Gallery wall — 6–10 pieces', price: 165, popular: true },
        { name: 'Gallery wall — 11–20 pieces', price: 239 },
        { name: 'Single framed picture / mirror (up to 30 lbs)', price: 79 },
        { name: 'Heavy mirror / artwork (30–80 lbs)', price: 129 },
        { name: 'Full-length mirror (floor lean / anchor)', price: 79 }
      ]},
      { group: 'Specialty Mounting', items: [
        { name: 'Projector mount (ceiling or wall)', price: 149 },
        { name: 'Whiteboard / bulletin board mount', price: 99 },
        { name: 'Coat rack / wall hooks', price: 89 },
        { name: 'Mailbox / house numbers mount', price: 79 },
        { name: 'Baby gate install (pressure or hardware mount)', price: 89 }
      ]},
      { group: 'Window Treatments', items: [
        { name: 'Curtain rod — 1 window', price: 89 },
        { name: 'Curtain rod — 2 windows', price: 119, popular: true },
        { name: 'Curtain rod — 3 windows', price: 149 },
        { name: 'Curtain rod — 4 windows', price: 179 },
        { name: 'Curtain rod — 5+ windows (per additional)', price: 35, addon: true },
        { name: 'Double curtain rod (per window)', price: 25, addon: true },
        { name: 'Blind install — 1 window', price: 89 },
        { name: 'Blind install — per additional window', price: 35, addon: true },
        { name: 'Cellular shade / roller shade install (per window)', price: 99 },
        { name: 'Motorized blind / shade install (per window)', price: 139 }
      ]},
      { group: 'Mounting Add-ons', items: [
        { name: 'TV mount hardware (if not provided)', price: 39, addon: true },
        { name: 'HDMI / cable routing to components', price: 35, addon: true, tags: ['convenience'], appliesTo: ['tv'], recoLabel: 'Route cables to components', recoWhy: 'Cleaner hookup to consoles and soundbars' },
        { name: 'Soundbar mount (below/above TV)', price: 55, addon: true, tags: ['convenience'], appliesTo: ['tv'], recoLabel: 'Mount a soundbar', recoWhy: 'Clean look under the TV' },
        { name: 'Patch drywall after unmount (small)', price: 65, addon: true }
      ]}
    ],
    'Smart Home': [
      { group: 'Climate Control', items: [
        { name: 'Smart thermostat — Nest, Ecobee, Honeywell', price: 99, popular: true },
        { name: 'Smart thermostat (no C-wire, adapter install)', price: 129 },
        { name: 'Smart vent install (per vent)', price: 79 },
        { name: 'Smart AC controller (window / mini-split)', price: 89 },
        { name: 'Multi-zone thermostat setup (per additional zone)', price: 99 }
      ]},
      { group: 'Security & Access', items: [
        { name: 'Smart doorbell — wireless / battery-powered', price: 89, popular: true },
        { name: 'Smart doorbell (hardwired replacement)', price: 119 },
        { name: 'Smart lock — deadbolt replacement', price: 109 },
        { name: 'Smart lock — lever handle', price: 99 },
        { name: 'Smart lock + deadbolt combo', price: 159 },
        { name: 'Smart garage door opener / controller', price: 109 },
        { name: 'Keypad entry install (outdoor)', price: 119 },
        { name: 'Door / window contact sensors (up to 4)', price: 89 },
        { name: 'Smart smoke / CO detector setup (battery-powered)', price: 79 }
      ]},
      { group: 'Cameras', items: [
        { name: 'Indoor security camera (plug-in)', price: 79 },
        { name: 'Indoor camera (mount + cable manage)', price: 89 },
        { name: 'Outdoor camera — eave / soffit mount', price: 109 },
        { name: 'Outdoor camera — brick / concrete', price: 139 },
        { name: 'Floodlight camera (hardwired replacement)', price: 149 },
        { name: 'Camera system — 2 cameras', price: 169 },
        { name: 'Camera system — 4 cameras', price: 249, popular: true },
        { name: 'Camera system — 6+ cameras', price: 349, priceMax: 449 },
        { name: 'NVR / DVR setup + camera config', price: 129 }
      ]},
      { group: 'Lighting', items: [
        { name: 'Smart bulb install + app setup (per room, up to 4 bulbs)', price: 69 },
        { name: 'Smart switch install (per switch)', price: 89 },
        { name: 'Smart dimmer install (per switch)', price: 99 },
        { name: 'Smart plug install + setup (per 2 plugs)', price: 69 },
        { name: 'LED strip lighting — per 10 ft run', price: 99 },
        { name: 'Outdoor smart lighting (per fixture)', price: 109 }
      ]},
      { group: 'Network & Hubs', items: [
        { name: 'Wi-Fi router setup + optimization', price: 99 },
        { name: 'Wi-Fi extender / mesh node install (per node)', price: 89 },
        { name: 'Mesh network (3-node setup, full home)', price: 159 },
        { name: 'Smart home hub setup (Alexa, Google, Apple)', price: 89 },
        { name: 'Smart home hub + device automation setup', price: 139 },
        { name: 'TV streaming device setup (Apple TV, Roku, Fire)', price: 79 },
        { name: 'Smart sprinkler controller setup', price: 119 }
      ]},
      { group: 'Add-ons', items: [
        { name: 'App setup + walkthrough (per platform)', price: 29, addon: true, tags: ['convenience'], recoLabel: 'App setup & walkthrough', recoWhy: 'Ready to use before we leave' },
        { name: 'Voice assistant integration (Alexa / Google)', price: 35, addon: true, tags: ['upgrade'], recoLabel: 'Voice assistant integration', recoWhy: 'Control devices hands-free before we leave' },
        { name: 'Automation / routine programming (per device)', price: 25, addon: true, tags: ['upgrade'], recoLabel: 'Set up automations', recoWhy: 'Schedules and routines ready to go' },
        { name: 'Device migration (old to new system)', price: 49, addon: true }
      ]}
    ],
    'Outdoor & Playsets': [
      { group: 'Playsets & Backyard Structures', items: [
        { name: 'Swing set / backyard playset assembly', price: 299, priceMax: 379, popular: true },
        { name: 'Trampoline assembly', price: 199 },
        { name: 'Pergola / gazebo kit assembly', price: 399, priceMax: 599 },
        { name: 'Storage shed (small kit)', price: 329, priceMax: 499 },
        { name: 'Monkey bars / climbing frame', price: 269 },
        { name: 'Sandbox / outdoor playhouse', price: 169 }
      ]},
      { group: 'Sports & Recreation', items: [
        { name: 'Basketball hoop assembly (portable)', price: 219 },
        { name: 'In-ground basketball hoop (custom quote)', price: 0, customQuote: true },
        { name: 'Outdoor swing / glider set', price: 159 },
        { name: 'Patio swing / hanging chair', price: 139 },
        { name: 'Portable pickleball / sports net setup', price: 99 },
        { name: 'Soccer goal / sports goal assembly', price: 99 }
      ]},
      { group: 'Outdoor Living', items: [
        { name: 'Grill (gas / charcoal assembly)', price: 109 },
        { name: 'Fire pit (assembly only)', price: 99 },
        { name: 'Patio heater assembly', price: 109 },
        { name: 'Deck box / outdoor storage bench', price: 89 },
        { name: 'Outdoor storage cabinet', price: 119 }
      ]},
      { group: 'Outdoor & Patio', items: [
        { name: 'Outdoor dining set (table + 4 chairs)', price: 149 },
        { name: 'Outdoor dining set (table + 6+ chairs)', price: 179 },
        { name: 'Outdoor lounge set (sofa + 2 chairs)', price: 169 },
        { name: 'Adirondack chairs (per 2)', price: 99 },
        { name: 'Patio umbrella + base', price: 89 }
      ]},
      { group: 'Add-ons', items: [
        { name: 'Anchoring / leveling / safety hardware', price: 99, addon: true, tags: ['safety'], appliesTo: ['playset','swing','trampoline','basketball','hoop','climbing','monkey','pergola','gazebo','shed','sandbox','playhouse'], recoLabel: 'Anchoring & leveling', recoWhy: 'Stable, level, safe install' },
        { name: 'Disassembly before move or pickup', price: 119, addon: true },
        { name: 'Same-day / rush outdoor assembly', price: 99, addon: true },
        { name: 'Heavy-duty material haul-away', price: 109, addon: true, tags: ['convenience'], recoLabel: 'Haul away packaging', recoWhy: 'No boxes left behind' }
      ]}
    ],
    'Office Assembly': [
      { group: 'Desks & Workstations', items: [
        { name: 'Desk (simple flat-pack)', price: 99 },
        { name: 'Desk (L-shape / executive)', price: 179, popular: true },
        { name: 'Standing desk (electric)', price: 199 },
        { name: 'Cubicle workstation / multi-desk setup', price: 399, priceMax: 599 }
      ]},
      { group: 'Seating & Storage', items: [
        { name: 'Office chair (standard)', price: 89 },
        { name: 'Office chair (ergonomic / heavy-duty)', price: 109 },
        { name: 'Bookcase / shelving unit (up to 5 shelves)', price: 99 },
        { name: 'Bookcase / shelving unit (6+ shelves)', price: 129 },
        { name: 'File cabinet (2–4 drawer)', price: 89 },
        { name: 'Office storage cabinet / lateral file', price: 129 },
        { name: 'Credenza / sideboard', price: 149 }
      ]},
      { group: 'Conference & Specialty', items: [
        { name: 'Conference table', price: 229, priceMax: 329 },
        { name: 'Reception desk / front counter', price: 399, priceMax: 599 },
        { name: 'Wall-mounted storage / overhead cabinet', price: 119 },
        { name: 'Office partition / divider install', price: 189 }
      ]},
      { group: 'Add-ons', items: [
        { name: 'Cable management / cord routing', price: 39, addon: true, tags: ['convenience'], recoLabel: 'Desk cable cleanup', recoWhy: 'Cleaner workstation finish before we go' },
        { name: 'Monitor arm install (desk clamp)', price: 39, addon: true, tags: ['upgrade'], recoLabel: 'Add a monitor arm', recoWhy: 'Better ergonomics and more desk space' },
        { name: 'Wall anchoring / anti-tip hardware', price: 45, addon: true, tags: ['safety'], appliesTo: ['bookcase','shelving','file cabinet','storage','credenza','wall-mounted','cabinet'], recoLabel: 'Anti-tip anchoring', recoWhy: 'Secures tall units to the wall' },
        { name: 'Box breakdown / packaging cleanup', price: 35, addon: true, tags: ['convenience'], recoLabel: 'Box & packaging cleanup', recoWhy: 'No mess left behind' },
        { name: 'Rush / same-day office assembly', price: 75, addon: true },
        { name: 'Furniture disposal / haul-away', price: 59, addon: true }
      ]}
    ],
    'Fitness Equipment': [
      { group: 'Cardio Equipment', items: [
        { name: 'Treadmill assembly', price: 189, popular: true },
        { name: 'Exercise bike / Peloton-style bike', price: 159 },
        { name: 'Elliptical machine', price: 209 },
        { name: 'Rowing machine', price: 169 },
        { name: 'Stair climber / stepper machine', price: 189 }
      ]},
      { group: 'Strength Equipment', items: [
        { name: 'Weight bench', price: 129 },
        { name: 'Inversion table', price: 119 },
        { name: 'Power rack / squat rack', price: 219 },
        { name: 'Punching bag stand', price: 129 },
        { name: 'Dumbbell / weight set assembly', price: 139 },
        { name: 'Home gym / cable machine', price: 299, priceMax: 429 },
        { name: 'Multi-station gym', price: 0, customQuote: true }
      ]},
      { group: 'Add-ons', items: [
        { name: 'Disassembly before move or storage', price: 65, addon: true },
        { name: 'Equipment move within home (same floor)', price: 55, addon: true },
        { name: 'Floor leveling / placement support', price: 45, addon: true, tags: ['safety'], recoLabel: 'Level and place it', recoWhy: 'Better stability before first use' },
        { name: 'Safety anchoring / wall securing', price: 55, addon: true, tags: ['safety'], appliesTo: ['rack','squat','home gym','cable machine','multi-station'], recoLabel: 'Safety anchoring', recoWhy: 'Secures heavy equipment safely' },
        { name: 'Same-day / rush fitness assembly', price: 85, addon: true }
      ]}
    ],
    'Other': [
      { group: 'Custom Project', items: [
        { name: 'Describe your project in the notes below (custom quote)', price: 0, customQuote: true }
      ]}
    ]
  }
};
