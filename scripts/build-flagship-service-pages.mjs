// Transforms the 6 footer-linked Austin service pages to the flagship layout.
// Keeps each page's <head> (title/meta/canonical/base CSS), nav, mobile nav,
// footer, mobile sticky bar, cookie banner and scripts INTACT. Only:
//   1. injects the flagship .fa-* CSS before </head> (idempotent)
//   2. swaps the visible body (between <!-- HERO --> and <footer class="footer">)
//   3. points og:image / twitter:image at the service's real hero photo
//   4. normalizes the page entity to a Service supplied by one Organization
// Copy is location-NEUTRAL except the SEO spots (eyebrow, service-area, FAQ, links).
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { fitTitle } from './lib/seo-title.mjs';

// Austin is the reference market. Every other Texas city reuses this exact
// template through the same builders (see scripts/generate-location-pages.js),
// so there is ONE flagship layout and copy source for all city/service pages.
const AUSTIN = {
  name: 'Austin',
  citySlug: 'austin',
  linksAreNearby: true,
  bio: 'Austin combines downtown apartments, established neighborhoods, new construction, student housing, and growing office districts, so assembly visits can have very different access and setup requirements.',
  landmark: 'Barton Springs Pool and South Congress Avenue',
  bookingGuidance: 'Include the item count, parking or building access, stairs, room location, and any scheduling constraints so the appointment can be reviewed accurately.',
  nearby: [
    { slug: 'round-rock', name: 'Round Rock' },
    { slug: 'cedar-park', name: 'Cedar Park' },
    { slug: 'pflugerville', name: 'Pflugerville' },
    { slug: 'lakeway', name: 'Lakeway' },
  ],
};
const MAX_COMMON_JOBS = 4;

const SERVICE_PLANNING = {
  'furniture-assembly': {
    heading: 'Furniture assembly planning',
    summary: 'Common requests include flat-pack furniture, IKEA pieces, beds, dressers, desks, dining tables, shelving, and multi-item move-in setups. Share the brand or model, item count, box location, and final room for each piece so the appointment reflects the actual build.',
    requestTypes: 'Furniture assembly service, furniture installation, IKEA assembly, bed assembly, crib assembly, dresser assembly, wardrobe assembly, sofa assembly, and desk assembly are all handled through the same item-based booking catalog.',
    austinGuide: { href: '/blog/ikea-assembly-cost-austin', label: 'Compare current IKEA assembly prices in Austin' },
  },
  'tv-mounting': {
    heading: 'TV mounting planning',
    summary: 'TV installation details should include the screen size, mount style, wall material, mounting height, outlet location, and any soundbar or cable-management work. Fireplace, brick, concrete, tile, and steel-stud installations need to be identified before the visit.',
    requestTypes: 'TV mounting service requests can include TV wall mounting, standard TV installation, above-fireplace mounting, soundbar mounting, in-wall cord concealment, mirror hanging, shelves, and curtain rod installation.',
  },
  'smart-home-installation': {
    heading: 'Smart home installation planning',
    summary: 'Helpful details include the device brand and model, installation location, existing wiring or power, Wi-Fi availability, and the number of devices. Doorbells, cameras, locks, thermostats, hubs, and lighting each require different setup and testing steps.',
    requestTypes: 'Smart home installation service and setup requests include video doorbell installation, smart thermostat installation, security camera setup, smart lock installation, Wi-Fi and hub setup, plugs, and connected lighting.',
  },
  'fitness-equipment-assembly': {
    heading: 'Fitness equipment assembly planning',
    summary: 'For treadmills, bikes, benches, racks, and home gyms, include the model, box location, final room, stairs, doorway clearance, and floor surface. Large or heavy equipment may require extra handling space or more than one person.',
    requestTypes: 'Fitness equipment assembly service and gym equipment assembly include treadmill assembly, exercise bike setup, elliptical assembly, rowing machine assembly, benches, squat rack assembly, power cages, and multi-station home gyms.',
  },
  'office-furniture-assembly': {
    heading: 'Office furniture assembly planning',
    summary: 'List the quantity and model of every desk, chair, cabinet, bookcase, or workstation, along with loading access, elevators, suite details, and the intended room layout. Complete counts are especially important for office moves and multi-station setups.',
    requestTypes: 'Office furniture assembly service and installation can cover desk and standing desk assembly, chairs, filing cabinets, conference table assembly, shelving, cubicle installation, and complete workstation setups.',
  },
  'playset-assembly': {
    heading: 'Playset and outdoor assembly planning',
    summary: 'For playsets, swing sets, trampolines, gazebos, pergolas, and patio pieces, share the product model, package count, finished dimensions, work-surface type, access path, and available clearance. Site photos help identify leveling, anchoring, and weather-sensitive setup needs.',
    requestTypes: 'Playset assembly service and outdoor installation requests include playset installation, swing set assembly, trampoline assembly, playground assembly, gazebo and pergola kits, shed assembly, basketball hoop assembly, and outdoor furniture assembly.',
  },
};

// Practical service details for priority markets and existing indexing follow-ups. These are preparation
// instructions, not claims of completed local jobs or guaranteed availability.
const METRO_SERVICE_GUIDES = {
  austin: {
    'furniture-assembly': {
      description: 'Book IKEA, Wayfair, and flat-pack furniture assembly in Austin. Compare item prices, plan a multi-item move-in, and check availability for your address.',
      workSummary: 'Furniture assembly examples: a nine-drawer dresser and an upholstered bed. Drawer alignment, a level frame, and securely fitted rails are details to check in the finished setup.',
      summary: 'Planning IKEA, Wayfair, or other flat-pack furniture assembly in Austin? Add each bed, dresser, nightstand, desk, or shelving unit separately. Include the product link or model, plus drawers, doors, and wardrobe fittings, so your price reflects the complete piece. A storage bed and a simple bed frame can require different work.',
      preparation: 'For a move-in, choose a visit after the full delivery is expected. Include any loading-zone instructions, stairs, elevator reservation, and the room for each item. Keep the hardware and instructions with their matching boxes, and make space for assembly in the final room.',
      extraGuide: { href: '/blog/why-hire-handyman-austin', label: 'Decide which setup tasks to handle yourself and which to book' },
      faq: { q: 'Can I book several furniture items for an Austin move-in?', a: 'Yes. Add each item and its quantity to the same booking, including the model or product link. Check that all packages will be available before the appointment. Share access instructions and the final room for each piece; delivery delays or extra items can change the work needed.' },
    },
    'tv-mounting': {
      summary: 'For TV mounting in an Austin apartment or home, select the screen size and share the TV model, wall-mount model, wall material, and desired location. A standard wall installation, fireplace position, soundbar, and cable concealment are different parts of the scope; include the options you want before choosing the appointment.',
      preparation: 'If you rent, check permission to drill and any move-out repair requirements first. A photo showing the full wall, nearby outlets, and media console helps explain the setup. Have your compatible mount and its hardware ready, and include building access or parking instructions.',
      guide: { href: '/blog/tv-mounting-in-apartment-austin-texas', label: 'Read the Austin apartment TV mounting checklist' },
      extraGuide: { href: '/blog/tv-mounting-tips-austin', label: 'Prepare your TV, mount, wall photos, and cable plan' },
      faq: { q: 'What should I check before mounting a TV in an Austin rental?', a: 'Check your lease or ask the property manager about drilling, wall restrictions, and move-out repairs. Include those requirements, the TV and mount models, and a photo of the intended wall in your request. Do not assume cable concealment or fireplace work is included in a standard mount.' },
    },
    // 2026-10-22: Search Console listed the Austin fitness page as "Crawled -
    // currently not indexed"; it and the smart home, office and playset pages
    // read 86% the same as their Round Rock pages. Each gets its own pricing
    // and preparation copy, every price taken from the booking catalog.
    'smart-home-installation': {
      description: 'Video doorbell, smart lock, thermostat and camera installation in Austin, priced per device: doorbells from $89, thermostats $99, locks from $99.',
      summary: 'Smart home work is priced per device. A battery video doorbell is $89 and a hardwired doorbell replacement is $119. A smart thermostat is $99, or $129 when it needs a C-wire adapter. Smart locks are $99 for a lever handle and $109 for a deadbolt replacement, and camera systems start at $169 for two cameras. Each visit ends with the device on your Wi-Fi and working in its app on your phone.',
      preparation: 'Before the visit, install the device app and sign in, check that Wi-Fi reaches the spot (doorbells and outdoor cameras are the usual weak points), and have the device with everything from its box. The work uses existing wiring and low-voltage connections; new circuits or outlets are for a licensed electrician.',
      guide: { href: '/blog/video-doorbell-installation-guide', label: 'Battery or wired: what video doorbell installation involves' },
      extraGuide: { href: '/blog/smart-thermostat-installation-and-c-wire', label: 'Check whether your thermostat needs a C-wire adapter' },
      faq: { q: 'Can a wired doorbell be replaced with a video doorbell in Austin?', a: 'Yes, when an existing doorbell button and chime are in place. The new doorbell connects to the wires already there for $119. Without doorbell wiring, a battery model installs on any door frame for $89.' },
    },
    'fitness-equipment-assembly': {
      description: 'Treadmill, Peloton-style bike, rower and power rack assembly in Austin with item prices up front: treadmills $219, bikes $179, racks $279.',
      summary: 'The fitness equipment assembly service is priced per machine, so pick the exact one. A treadmill is $219, an exercise or Peloton-style bike $179, a rowing machine $189, elliptical assembly $239 and squat rack assembly for a power or squat rack $279. For larger gym equipment assembly, a home gym or cable machine is $399, and a multi-station gym is priced by custom quote. Add-ons cover wall anchoring ($69), floor leveling ($59) and moving the finished machine to another room on the same floor ($79).',
      preparation: 'Treadmills and racks arrive in large, heavy boxes, so have them in or near the room where the machine will live and check that it fits through the doorway once built. Note the floor surface (carpet, tile or garage concrete), the nearest outlet for powered equipment, and the ceiling height for a rack with a pull-up bar. Taking a machine apart before a move is $89.',
      faq: { q: 'Can a treadmill be assembled upstairs in an Austin home?', a: 'Yes. Choose treadmill assembly and note the stairs and doorway in the booking. Have the boxes in or near the final room, since a built treadmill is hard to carry upstairs. Moving it to another room on the same floor afterwards is a $79 add-on.' },
    },
    'office-furniture-assembly': {
      description: 'Desk, standing desk, office chair and workstation assembly in Austin, priced per piece: desks from $99, electric standing desks $199, chairs $89.',
      summary: 'The office furniture assembly service is priced per piece, so a home office and a business suite are booked the same way. A simple flat-pack desk is $99, an L-shape or executive desk $179, standing desk assembly for an electric frame $199, a standard office chair $89 and an ergonomic or heavy-duty chair $109. Conference table assembly is $229, and workstation setups with a cubicle or several desks are $399. Monitor arm installs and cable routing are $39 add-ons.',
      preparation: 'For a business, list every piece with its room, plus delivery hours, suite number, loading dock and elevator access. For a home office, check that a standing desk sits within reach of an outlet. Box breakdown and packaging cleanup is a $35 add-on, and haul-away of old furniture is $59.',
      faq: { q: 'Can a whole office be set up in one Austin visit?', a: 'List every desk, chair, cabinet and workstation with its quantity in one booking. Larger setups can need more than one pro or a longer visit, and that is confirmed before the appointment is scheduled.' },
    },
    'playset-assembly': {
      description: 'Swing set, trampoline, basketball hoop and patio furniture assembly in Austin with prices up front: playsets $349, trampolines from $319.',
      summary: 'Backyard assembly is priced by the item. A swing set or backyard playset is $349. Trampolines are $319 up to 10 feet, $389 from 11 to 14 feet and $449 at 15 feet and up. A portable basketball hoop is $249, a grill $129 and an outdoor dining set with four chairs $179. Pergolas, gazebos, sheds and in-ground hoops are priced by custom quote.',
      preparation: 'Choose a level spot with the clearance the instructions list on every side, and check that the boxes can reach the yard through the gate. Summer afternoons are hot, so morning appointments suit long outdoor builds. Anchoring and leveling is a $119 add-on.',
      faq: { q: 'Can a trampoline be moved to a new house in Austin?', a: 'Trampoline relocation, with disassembly, transport and reassembly, is priced by custom quote. Disassembly only, when you handle the transport, is a $149 add-on.' },
    },
  },
  dallas: {
    'furniture-assembly': {
      summary: 'Book Dallas furniture assembly by the exact item: a bed frame, dresser, desk, bookcase, or wardrobe. For IKEA and other modular furniture, include the series, dimensions, number of frames, drawers, and doors. A product link is more useful than a general description such as bedroom set.',
      preparation: 'For an apartment or condo appointment, include the loading entrance, parking instructions, elevator reservation, and floor. If several rooms are involved, match each boxed item to its final room and note any pieces that require wall anchoring under the manufacturer instructions.',
      faq: { q: 'How should I describe a wardrobe or multi-item furniture booking in Dallas?', a: 'List each item and quantity, with the product link or model. For a modular wardrobe, include frame count, dimensions, doors, drawers, and interior fittings. Note the final room, wall-anchoring requirements, and building access so the scope reflects the complete setup.' },
    },
    'tv-mounting': {
      summary: 'Plan a Dallas TV mounting visit around the screen, mount, and wall together. Share the TV size and model, the fixed, tilt, or full-motion mount you have, and whether the wall is drywall, masonry, tile, or another surface. Include soundbars, shelves, or additional TVs as separate items.',
      preparation: 'For a condo or apartment, check building permission and access requirements before booking. Include a wall photo, the outlet position, media-console height, and your preferred viewing position. If the wall material or mount compatibility is unknown, describe that before the appointment.',
      faq: { q: 'Can I include more than one TV in a Dallas appointment?', a: 'Add every TV separately with its size, mount, wall material, and room location. Include soundbars or cable-management options for the relevant TV. Different walls and mounting heights can require different work, even when the screens are the same size.' },
    },
    // 2026-10-22: the Dallas smart home, fitness, office and playset pages read
    // 88-93% the same as the other hub cities. Each gets its own pricing and
    // preparation; every price is taken from the booking catalog.
    'smart-home-installation': {
      description: 'Smart lock, keypad, camera and lighting installation in Dallas, priced per device: deadbolt smart locks $109, four-camera systems $279.',
      summary: 'Dallas smart home requests are priced per device. A smart lock that replaces the deadbolt is $109, an outdoor keypad entry is $119 and a floodlight camera that replaces a wired fixture is $169. Camera systems are $279 for four cameras, with recorder setup at $129. Smart switches are $89 each, dimmers $99, and LED strip lighting $99 per ten-foot run.',
      preparation: 'In a condo or apartment, check building and HOA rules on door hardware, exterior cameras and drilling before booking, and keep the original lock for move-out if the lease asks for it. List each device with its brand and model, its room, the app you want to use and whether the spot already has power. Sign in to the apps on your own phone during setup.',
      faq: { q: 'Can a smart lock be installed in a Dallas apartment?', a: 'Often, with the building\'s approval. A lock that replaces the deadbolt is $109, and the original lock can go back on at move-out. Check the lease and any HOA rules first, and include the door type in the booking.' },
    },
    'fitness-equipment-assembly': {
      description: 'Rowing machine, exercise bike, elliptical and cable machine assembly in Dallas, priced per machine: rowers $189, bikes $179, ellipticals $239.',
      summary: 'This fitness equipment assembly service prices each machine on its own. A rowing machine is $189, an exercise bike $179 and elliptical assembly $239. An inversion table is $139, and squat rack assembly for a power rack is $279. For a full gym equipment assembly, a cable machine is $399. Floor leveling is a $59 add-on, and moving the finished machine to another room on the same floor is $79.',
      preparation: 'In a high-rise or apartment, reserve the freight elevator and check quiet hours and any floor rules before a treadmill or rack is delivered. Have the boxes in the room where the machine will stay, and note a nearby outlet for powered equipment. For a house, say whether the gym is upstairs, in a spare room or in the garage.',
      faq: { q: 'Can fitness equipment be assembled in a Dallas high-rise?', a: 'Yes. Book the machine and include the floor, freight elevator reservation and building access in the booking. Have the boxes in the final room before the visit, because a built machine is hard to move through hallways.' },
    },
    'office-furniture-assembly': {
      description: 'Office workstation, conference table and reception desk assembly in Dallas, priced per piece: workstation setups $399, conference tables $229.',
      summary: 'The office furniture assembly service is priced per piece, which suits a corporate suite as well as a home office. Workstation setups with a cubicle or several desks are $399, conference table assembly is $229, a reception desk or front counter is $399 and an office partition $189. Standing desk assembly for an electric frame is $199, and an ergonomic chair $109. Monitor arms and cable routing are $39 add-ons, and haul-away of old furniture is $59.',
      preparation: 'For a suite, include the building, floor, loading dock, freight elevator, delivery hours and the person who will let the pro in, and list every piece by room. After-hours or weekend work should be requested in the booking. For a home office, note the room and the nearest outlet for a standing desk.',
      faq: { q: 'Can a Dallas office be set up outside business hours?', a: 'Request the time you need in the booking and include building access, the loading dock and freight elevator. Larger setups with many workstations can need more than one pro, and that is confirmed before the appointment is scheduled.' },
    },
    'playset-assembly': {
      description: 'Swing set, trampoline, sports goal and patio set assembly in Dallas with prices up front: playsets $349, trampolines up to 14 ft $389.',
      summary: 'Backyard work in Dallas is priced per item. A swing set or backyard playset is $349, and a trampoline from 11 to 14 feet is $389. Soccer goals and portable pickleball nets are $119 each. On the patio, a dining set with six or more chairs is $219, a lounge set with a sofa and two chairs $199 and a patio umbrella with its base $109. Anchoring and leveling is a $119 add-on.',
      preparation: 'Check the HOA rules on backyard structures before the kit arrives, and pick a level spot with the clearance the instructions list. Make sure the boxes can reach the yard through the gate, and say whether the ground is grass, turf or concrete. Pergolas, gazebos and sheds are priced by custom quote.',
      faq: { q: 'Does a backyard playset in Dallas need HOA approval?', a: 'Some neighborhoods require it for structures above a set height or visible from the street. Check with the HOA before ordering, then book the playset assembly at $349 with the model and a photo of the spot.' },
    },
  },
  houston: {
    'playset-assembly': {
      includeMarketContext: true,
      // Owner audit 2026-10-07: completed outdoor job in Spring/Houston.
      // No customer identity, private media or association with gallery images.
      completedWork: 'Completed outdoor assembly work in the Houston area includes a Spring appointment.',
      summary: 'Plan a Houston outdoor assembly visit with the model, full package count, finished dimensions, and a photo of the intended work area. List each playset, swing set, or trampoline separately so the request describes the complete kit. Include the manufacturer clearances and base requirements before choosing the position.',
      preparation: 'Share the gate opening, path from the delivered boxes, surface, and any unfinished site preparation. For a gazebo, shed, or outdoor furniture kit, include anchoring instructions and the location of the prepared base. Mention an existing structure, missing parts, or repair work in a custom-quote request. Appointment availability is confirmed for the service address and complete scope.',
      guide: { href: '/book?service=Other', label: 'Request a quote for a gazebo or custom outdoor setup' },
      faq: { q: 'What information is needed for a Houston gazebo assembly quote?', a: 'Send the model or product link, kit dimensions and package count, site photos, base type, and manufacturer anchoring requirements. Include delivery location and gate access. Describe any unfinished base work or existing structure so the requested work can be confirmed before scheduling.' },
    },
    'furniture-assembly': {
      summary: 'For furniture assembly in Houston, choose each bed, dresser, desk, dining table, or storage item and include its model or product link. For a townhome or multi-level setup, identify the final floor and room for every piece so the request describes the complete job.',
      preparation: 'Tell us where the boxes will be when the visit begins and whether any heavy items need to travel upstairs. Do not assume delivery or moving is included in assembly. Include gate instructions, parking, elevator access where relevant, and enough clear space in the room to build and position each piece.',
      faq: { q: 'Does a Houston furniture assembly booking include moving boxes upstairs?', a: 'Describe any stairs or heavy-box handling in the booking; do not assume it is included in standard assembly. Share the item models, where the boxes are, and the final room before the visit so handling needs and service scope can be confirmed.' },
    },
    'tv-mounting': {
      summary: 'For a Houston TV mounting request, include the TV size, model, wall-mount model, wall surface, and the room or floor. Standard drywall mounting, above-fireplace work, soundbars, and cable concealment require different details. Select the relevant work for each TV instead of describing all of it as one basic mount.',
      preparation: 'Photograph the full wall and nearby outlets, including any tile, brick, or fireplace surround. Identify where streaming devices, a soundbar, and other cables will sit. Share parking and access instructions, and have the compatible mount and supplied hardware ready before the appointment.',
      faq: { q: 'What details are needed for a Houston fireplace TV installation?', a: 'Include a photo of the fireplace and surrounding wall, the wall material, TV and mount models, desired height, and nearby outlets. Fireplace placement and cable routing need a scope check before the visit; do not assume they are part of standard wall mounting.' },
    },
    // 2026-10-22: the Houston smart home, fitness and office pages read 90-93%
    // the same as the other hub cities. Each gets its own pricing and preparation;
    // every price is taken from the booking catalog.
    'smart-home-installation': {
      description: 'Outdoor camera, garage opener, sensor and window AC controller installation in Houston, priced per device: outdoor cameras from $109.',
      summary: 'Houston smart home work is priced per device. An outdoor camera on an eave or soffit is $109, or $139 on brick or concrete, and a six-camera system is $379. A floodlight camera that replaces a wired fixture is $169. A smart garage door opener or controller is $109, door and window sensors are $89 for up to four, battery smart smoke and CO detectors are $79, and a smart controller for a window or mini-split AC is $89.',
      preparation: 'Heat and humidity are hard on outdoor electronics, so choose cameras and doorbells rated for outdoor use and mount them under an eave where you can. List each device with its location, whether power is already there and the app you want, and check that Wi-Fi reaches the garage and the yard.',
      faq: { q: 'Can a smart garage door opener be installed in Houston?', a: 'Yes. A smart garage door opener or controller is $109. Include the opener brand and model and check that Wi-Fi reaches the garage, since the controller needs a steady connection.' },
    },
    'fitness-equipment-assembly': {
      description: 'Garage gym, power rack, treadmill and stair climber assembly in Houston, priced per machine: power racks $279, treadmills $219, home gyms $399.',
      summary: 'The fitness equipment assembly service is priced per machine, and garage gyms are common. Squat rack assembly for a power or squat rack is $279, a weight bench $149 and a dumbbell or weight set $159. A treadmill is $219, a stair climber $219 and elliptical assembly $239. For larger gym equipment assembly, a home gym or cable machine is $399. Wall anchoring is a $69 add-on.',
      preparation: 'For a garage gym, clear the floor and lay mats before the visit; humidity rusts bare steel and concrete is hard on equipment feet. For a townhome, say which floor the machine goes on and whether the stairs turn, and have the boxes in the final room.',
      faq: { q: 'Can a power rack be set up in a Houston garage?', a: 'Yes. Power rack assembly is $279. Measure the ceiling height for the pull-up bar, note the floor surface, and add wall anchoring at $69 if the rack\'s instructions call for it.' },
    },
    'office-furniture-assembly': {
      description: 'Home office and business office assembly in Houston, priced per piece: L-shape desks $179, standing desks $199, storage cabinets $129.',
      summary: 'The office furniture assembly service is priced per piece for homes and businesses alike. An L-shape or executive desk is $179, standing desk assembly for an electric frame is $199 and a standard office chair is $89. A bookcase with up to five shelves is $99, an office storage cabinet or lateral file is $129 and a wall-mounted overhead cabinet is $119. Conference table assembly is $229, and workstation setups for several desks are $399.',
      preparation: 'For a multi-story townhome office, say which floor and whether the stairs turn. For a business, include the suite, delivery hours, parking and access. Box breakdown and packaging cleanup is a $35 add-on, which keeps the cardboard out of the room.',
      faq: { q: 'Can office furniture be assembled on an upper floor of a Houston townhome?', a: 'Yes. Book each piece and say which floor it goes on and how the stairs turn. Have the boxes on that floor before the visit, since a built desk is hard to carry up a turning stair.' },
    },
  },
  'san-antonio': {
    'furniture-assembly': {
      // Owner audit 2026-10-07: completed furniture job in San Antonio.
      completedWork: 'Completed work in San Antonio includes furniture assembly.',
      summary: 'Book San Antonio furniture assembly for the exact bed, dresser, desk, table, or storage unit you need built. Share the brand, model or product link, item count, and final room. Include drawers, storage compartments, and wardrobe fittings so the request captures the complete piece.',
      preparation: 'For a gated property or apartment, include entry, parking, stairs, and elevator details. Check the manufacturer instructions for furniture that needs wall anchoring, and mention the wall surface or rental restrictions. Keep all packages, instructions, and hardware together in a clear work area.',
      faq: { q: 'What should I include for a dresser or wardrobe assembly in San Antonio?', a: 'Share the model or product link, dimensions, drawer or door count, and the final room. Mention any required wall anchoring and the wall surface if known. If you rent, check permission for anchoring. Include stairs and where the boxes are located so the visit can be scoped accurately.' },
    },
    'tv-mounting': {
      summary: 'Plan TV mounting in San Antonio with the screen size, TV model, mount model, and wall material ready. Identify brick, stone, tile, a fireplace position, or any uncertain wall construction before the visit. Soundbar mounting and cable concealment should be included as their own requested options.',
      preparation: 'A full-wall photo showing outlets and furniture helps explain the intended placement. If you rent, check permission to drill. Include gated-community or building entry instructions, parking, and the floor; have the mount and compatible hardware available for the appointment.',
      faq: { q: 'Can I request TV mounting on a brick or stone wall in San Antonio?', a: 'Describe the surface and include a clear wall photo, TV model, and mount model before booking. Masonry, tile, and fireplace installations require a different scope from standard drywall mounting. Cable routing and suitable hardware also need to match the actual wall.' },
    },
    // 2026-10-22: the San Antonio smart home, fitness, office and playset pages
    // read 88-92% the same as the other hub cities. Each gets its own pricing and
    // preparation; every price is taken from the booking catalog.
    'smart-home-installation': {
      description: 'Video doorbell, smart lock, thermostat and indoor camera setup in San Antonio, priced per device: doorbells from $89, plug-in cameras $79.',
      summary: 'San Antonio smart home setups are priced per device. A battery video doorbell is $89, a plug-in indoor camera $79 and a pair of smart plugs $69. A smart lock on a lever handle is $99, a smart thermostat $99, or $129 with a C-wire adapter, and Wi-Fi router setup and optimization $99. Battery devices and plug-in cameras suit rentals and military housing, since they leave the walls and wiring alone.',
      preparation: 'For base or privatized military housing, check the housing office rules on doorbells, locks and cameras, and include gate access in the booking. For any home, install the device app beforehand and check that Wi-Fi reaches the front door. Keep the original hardware if it has to go back on when you move out.',
      guide: { href: '/blog/video-doorbell-installation-guide', label: 'Battery or wired: what video doorbell installation involves' },
      faq: { q: 'Can a video doorbell be installed in San Antonio military housing?', a: 'Usually, with a battery model that needs no wiring, installed for $89. Check the housing office rules first and include gate access in the booking.' },
    },
    'fitness-equipment-assembly': {
      description: 'Home gym, weight bench, power rack and treadmill assembly in San Antonio, priced per machine: benches $149, power racks $279, treadmills $219.',
      summary: 'The fitness equipment assembly service is priced per machine. A weight bench is $149, a dumbbell or weight set $159, a punching bag stand $149 and squat rack assembly for a power rack $279. A treadmill is $219 and elliptical assembly $239. For a full gym equipment assembly, a home gym or cable machine is $399. Wall anchoring is a $69 add-on.',
      preparation: 'Garage gyms get hot in the afternoon, so morning appointments suit them. If you are moving in or out, keep every bolt and the manual from the machine together; taking a machine apart before a move or for storage is an $89 add-on. Have the boxes in the room where the equipment will stay.',
      faq: { q: 'Can a home gym be reassembled after a move to San Antonio?', a: 'Yes. Book each machine by type at the new home, such as a treadmill at $219 or a power rack at $279, and keep the bolts and manual from the disassembly together for the visit.' },
    },
    'office-furniture-assembly': {
      description: 'Home office and small business furniture assembly in San Antonio, priced per piece: credenzas $149, lateral files $129, reception desks $399.',
      summary: 'The office furniture assembly service is priced per piece. A credenza or sideboard is $149, an office storage cabinet or lateral file $129, a two to four drawer file cabinet $89 and a bookcase with six or more shelves $129. Standing desk assembly for an electric frame is $199 and conference table assembly $229. For a front office, a reception desk or counter is $399, and workstation setups for several desks are $399.',
      preparation: 'For a small business, include the suite, opening hours and the best time to work, and list every piece by room. For a home office in a spare bedroom, measure the wall where the desk and storage will stand before ordering. Haul-away of old furniture is a $59 add-on.',
      faq: { q: 'Can a small office in San Antonio be set up before opening day?', a: 'Book every desk, chair, cabinet and counter with its quantity and the date you need it done. Larger setups can need more than one pro, and that is confirmed before the appointment is scheduled.' },
    },
    'playset-assembly': {
      description: 'Swing set, trampoline, basketball hoop and backyard furniture assembly in San Antonio with prices up front: playsets $349, trampolines from $319.',
      summary: 'Backyard assembly in San Antonio is priced per item. A swing set or backyard playset is $349, monkey bars or a climbing frame $299 and a sandbox or outdoor playhouse $199. A 15 foot or larger trampoline is $449, an outdoor swing or glider $179, a patio swing $159 and a fire pit $119. Anchoring and leveling is a $119 add-on.',
      preparation: 'Many yards here have rocky or caliche ground under the topsoil, so tell us whether the spot is soil, rock or turf, since that changes how a playset is anchored. Pick a level spot with the clearance the instructions list, and check that the boxes can reach the yard through the gate. Summer afternoons are hot, so morning appointments suit long builds.',
      faq: { q: 'Can a playset be anchored in rocky San Antonio ground?', a: 'Usually, with anchors suited to the ground. Tell us whether the spot is soil, rock or caliche when you book the playset at $349, and add anchoring and leveling at $119. The anchors themselves come with the kit or are bought separately.' },
    },
  },
  'round-rock': {
    'furniture-assembly': {
      includeMarketContext: true,
      summary: 'Plan a Round Rock bedroom or home-office setup from the exact items being delivered. For a bed, include its size and any storage drawers; for a desk, note an electric frame or return; for a wardrobe, list frames, doors, and interior fittings. Add each item and quantity instead of using one general description for a whole room.',
      preparation: 'Schedule after all packages arrive and compare the box count with the delivery instructions. For an upstairs room, share the floor, stair access, and where the boxes will be. Keep matching hardware together and leave space for the finished furniture as well as the build. Mention manufacturer-required wall anchoring and any rental restrictions before the visit.',
      guide: { href: '/blog/ikea-pax-wardrobe-assembly', label: 'Plan a modular wardrobe before booking assembly' },
      faq: { q: 'Can I book a bed, dresser, and desk together in Round Rock?', a: 'Yes. Add every item and quantity, with its product link or model and final room. Check that all boxes have arrived. Include stairs, box locations, and any required wall anchoring. Your selected items and options determine the total shown before you confirm.' },
    },
  },
  manor: {
    'playset-assembly': {
      includeMarketContext: true,
      summary: 'For a Manor playset, swing set, or trampoline appointment, start with the product link, model, and full package count. Say whether this is a new kit or work on an existing structure. Share the finished footprint and the manufacturer clearance requirements with photos of the intended location.',
      preparation: 'Show the access path from the boxes to the yard, gate opening, surface, and nearby fences or branches. Note any missing parts, slope, or site preparation still needed before scheduling. For a gazebo, shed, or outdoor furniture kit, include the base and anchoring instructions. Existing damage or a replacement slide needs its own scope check before an appointment is confirmed.',
      guide: { href: '/book?service=Other', label: 'Request a quote for repairs, replacement parts, or unusual outdoor work' },
      faq: { q: 'Is replacing a damaged slide the same as new playset assembly in Manor?', a: 'No. Describe the existing structure, the damaged part, and the replacement model, and include clear photos in a custom-quote request. Compatibility, condition, and the work needed must be confirmed before scheduling. A new-build assembly selection does not describe that repair.' },
    },
  },
  buda: {
    'playset-assembly': {
      includeMarketContext: true,
      summary: 'For a Buda backyard assembly appointment, compare the finished dimensions with the usable space before booking. A playset or swing set needs the manufacturer clearances as well as the frame footprint. For a trampoline, send the model, package count, surface, and a wide photo showing the proposed position.',
      preparation: 'Identify where the boxes will be delivered and the route through any gate to the work area. Share the manufacturer base and anchoring requirements, and describe any site preparation that remains. A gazebo, shed, or outdoor furniture kit has different base and access needs. For an existing structure or an incomplete kit, request a quote with photos so the work can be confirmed first.',
      guide: { href: '/book?service=Other', label: 'Get a quote for a gazebo, incomplete kit, or custom outdoor project' },
      faq: { q: 'What should be ready before a Buda backyard assembly appointment?', a: 'Have the complete kit and instructions available, a clear access path, and a work area that meets the manufacturer preparation requirements. Send site photos and describe slope, surface, missing parts, or unfinished base work before the visit. Your appointment is confirmed after the work and availability are checked.' },
    },
  },
  pearland: {
    'smart-home-installation': {
      includeMarketContext: true,
      summary: 'For smart-home setup in Pearland, list each device model and whether it replaces an existing device or goes in a new location. Doorbells, thermostats, security cameras, and smart locks need different compatibility details. Include the current device, power source, mounting surface, and the app or hub you want to use.',
      preparation: 'Check the manufacturer compatibility information before buying. Have access to your own device account and Wi-Fi on your phone during the visit; do not put passwords in booking notes. Photograph the existing location without removing wiring. Mention rental permission, inaccessible mounting positions, or new wiring needs before choosing the appointment so the supported work can be confirmed.',
      guide: { href: '/blog/smart-home-installation-austin', label: 'Review device, account, and compatibility preparation' },
      faq: { q: 'What should I share before replacing a smart device in Pearland?', a: 'Provide the old and new device models, a photo of the existing location, and your preferred app or hub. Tell us whether the device already has suitable power and Wi-Fi. Keep passwords private and available on your own phone during setup. New wiring or uncertain compatibility needs a scope check first.' },
    },
  },
  'san-angelo': {
    'smart-home-installation': {
      includeMarketContext: true,
      summary: 'Plan a San Angelo smart-home visit by room and device. List doorbells, thermostats, security cameras, and smart locks separately, including each model and quantity. For several devices, identify the app or hub they must work with and whether setup is at an existing or new mounting location.',
      preparation: 'Check the manufacturer requirements for power, Wi-Fi, and compatible equipment. Note which devices and accessories you already have, where they will be installed, and any hard-to-reach positions. Have your own phone and device-account access ready for testing. Do not send passwords in booking notes. Tell us about unfinished wiring or site preparation before scheduling; availability and the supported work are confirmed for your address.',
      guide: { href: '/blog/smart-home-installation-austin', label: 'Prepare compatible devices and the information needed for setup' },
      faq: { q: 'Can I request several smart-home devices in one San Angelo visit?', a: 'List each device and quantity with its model, room, existing power, and preferred app or hub. Include accessories and any new-location work. Compatibility, access, and appointment availability need to be confirmed for the complete request. Keep account passwords private and sign in on your own device during setup.' },
    },
  },
};

// Local housing facts per city (U.S. Census ACS 5-year, scripts/lib/city-housing.json).
// They change what a customer should prepare: renters need drilling/anchoring
// permission, apartment buildings need elevator and loading plans, older homes
// have older walls and wiring. Austin reference pages are left unchanged.
const HOUSING = JSON.parse(readFileSync(new URL('./lib/city-housing.json', import.meta.url), 'utf8'));

function joinList(items) {
  return items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}` : items[0] || '';
}

function housingGuide(cfg, city) {
  if (city.citySlug === 'austin') return null;
  const h = HOUSING.cities[city.citySlug];
  if (!h) return null;
  const n = city.name;
  const counties = h.counties.map((c) => c.replace(/ County$/, ''));
  const countyText = `${joinList(counties)} ${counties.length > 1 ? 'counties' : 'County'}`;
  const facts = `${n} (${countyText}): ${h.renterPct}% of households rent, ${h.apartment5PlusPct}% of homes are in buildings with five or more units, ${h.detachedPct}% are detached houses, and the median home was built in ${h.medianYearBuilt}.`;
  const renters = h.renterPct >= 40;
  const apartments = h.apartment5PlusPct >= 25;
  const older = h.builtBefore1980Pct >= 30;
  const advice = {
    'furniture-assembly': [
      apartments
        ? 'In a larger apartment building, include the floor, elevator reservation, and loading-zone rules so moving boxes to each room is planned.'
        : 'In a detached house, the usual planning points are stairs, the room for each piece, and where the boxes will be staged.',
      renters
        ? 'If you rent, check whether the lease allows wall anchoring for dressers and tall bookcases.'
        : 'Tall dressers and bookcases should be anchored to the wall under the manufacturer instructions; mention the wall type if you know it.',
    ],
    'tv-mounting': [
      older
        ? `${h.builtBefore1980Pct}% of homes here were built before 1980, when plaster and older framing were more common, so describe the wall and add a photo if it is not standard drywall.`
        : 'Newer homes usually have drywall over wood studs; still flag tile, brick, stone, or a fireplace surround.',
      renters
        ? 'With this many renters, check drilling and move-out repair rules before booking.'
        : 'If you rent, check drilling and move-out repair rules before booking.',
    ],
    'smart-home-installation': [
      older || h.medianYearBuilt < 1990
        ? `Older homes are more likely to lack a thermostat common wire (C-wire) or a working doorbell transformer, and ${h.builtBefore1980Pct}% of homes here were built before 1980. Share photos of the thermostat wiring and doorbell chime.`
        : 'Newer wiring usually suits smart thermostats and doorbells; confirm the C-wire and doorbell power before buying a device.',
      'Renters usually need landlord approval to replace locks, doorbells, or thermostats.',
    ],
    'fitness-equipment-assembly': [
      apartments
        ? 'In an apartment building, check elevator size, doorway width, and any floor-load or quiet-hours rules before a treadmill or rack arrives.'
        : 'In a detached house, many home gyms go in a garage or spare room; tell us the floor surface and whether the room is upstairs.',
    ],
    'office-furniture-assembly': [
      apartments
        ? 'For a home office in an apartment building, include elevator and loading details; for a business suite, include delivery hours and suite access.'
        : 'For a home office in a detached house, list every desk, chair, and cabinet with its room so a multi-piece setup is scheduled correctly.',
    ],
    'playset-assembly': [
      h.detachedPct >= 60
        ? 'Detached houses are the homes most likely to have a yard; share the yard slope, ground surface, and gate width so the kit can reach the build site.'
        : 'Where larger buildings are common, confirm HOA or property rules and the available ground area before ordering an outdoor kit.',
      ...(renters ? ['If you rent, confirm permission for ground anchors.'] : []),
    ],
  }[cfg.prefix];
  if (!advice) return null;
  return { facts, advice: advice.join(' '), source: HOUSING.source.replace(/, via Census Reporter$/, '') };
}

// Responsive WebP versions of the service photos (scripts/lib/service-image-variants.json,
// made from the originals in /images). The original stays as the <img> fallback, and
// width/height reserve the box so the photo cannot shift the layout when it loads.
const IMAGE_VARIANTS = JSON.parse(readFileSync(new URL('./lib/service-image-variants.json', import.meta.url), 'utf8'));

function picture(src, alt, sizes, attrs) {
  const v = IMAGE_VARIANTS[src];
  const img = `<img src="/images/${src}" alt="${alt}"${v ? ` width="${v.w}" height="${v.h}"` : ''}${attrs}/>`;
  if (!v) return img;
  const base = src.replace(/\.(jpe?g|png)$/i, '');
  const srcset = v.variants.map((w) => `/images/${base}-${w}.webp ${w}w`).join(', ');
  return `<picture><source type="image/webp" srcset="${srcset}" sizes="${sizes}"/>${img}</picture>`;
}

function metroServiceGuide(cfg, city) {
  return METRO_SERVICE_GUIDES[city.citySlug]?.[cfg.prefix];
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

// Derive the per-city page slug from the service prefix, e.g.
// furniture-assembly + dallas -> furniture-assembly-dallas-tx.
function pageSlug(cfg, city) {
  return `${cfg.prefix}-${city.citySlug}-tx`;
}

// The service headline is stored Austin-form ("X in Austin,<br><em>Y</em>").
// Split it so the same selling promise (Y) travels to every city while only the
// "in {City}" label changes. Parsing (not editing the data) keeps Austin output
// byte-identical after this refactor.
function splitHeroTitle(heroTitle) {
  const match = String(heroTitle).match(/^(.*?) in Austin,<br><em>(.*?)<\/em>$/);
  if (!match) throw new Error(`Unexpected heroTitle shape: ${heroTitle}`);
  return { lead: match[1], tail: match[2] };
}

// The location FAQ is city-specific. Some statewide markets have roster-backed
// neighbors while others link to major Texas markets for crawl discovery; the
// wording must distinguish those cases instead of calling distant cities nearby.
function locationFaq(city) {
  if (city.citySlug === 'san-antonio') {
    return {
      q: 'Can I request service outside San Antonio?',
      a: 'New Braunfels is another listed service area near San Antonio. Other Texas service areas are listed on our Locations page. Enter your service address during booking to check current availability for your location, service, and appointment.',
    };
  }
  const names = city.nearby.map((c) => c.name);
  const list = names.length > 1
    ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
    : names[0] || 'the surrounding area';
  if (!city.linksAreNearby) {
    return {
      q: 'Do you serve other Texas cities too?',
      a: `Yes. customers can also request appointments in ${list}. Enter your service address during booking to confirm current availability.`,
    };
  }
  return {
    q: 'Do you serve nearby cities too?',
    a: `Yes. beyond ${city.name}, we cover ${list} and the surrounding area. Enter your service address during booking to confirm current availability.`,
  };
}

function costFaq(cfg, city) {
  return {
    q: `What does ${cfg.faqNoun} cost in ${city.name}?`,
    a: `Common ${cfg.faqNoun} pricing starts at ${cfg.fromPrice}. The page shows typical jobs and price ranges; choose the matching service and add the exact item, installation, access, and site details so the scope can be confirmed before the appointment.${metroServiceGuide(cfg, city) ? ' Your selected options and final total are shown in booking before you confirm.' : ''}`,
  };
}

// The service copy carries an Austin-specific work caption on one service; keep
// it for Austin, neutralize it elsewhere (captions are brand copy, not an
// allowed city-name slot).
function neutralizeNote(noteStrong, city) {
  if (city.name === 'Austin') return noteStrong;
  return noteStrong.replace(' around Austin', '');
}

// Service FAQs = the neutral service questions plus the city nearby question.
// Austin keeps its exact approved FAQs (the reference pages are never modified);
// every other city swaps the 4th FAQ for its own real neighbors.
function serviceFaqs(cfg, city) {
  const localGuide = metroServiceGuide(cfg, city);
  const primaryFaqs = cfg.faqs.slice(0, 3);
  if (cfg.prefix === 'furniture-assembly' && ['austin', 'houston', 'san-antonio', 'dallas'].includes(city.citySlug)) {
    primaryFaqs[2] = {
      q: `Do you assemble IKEA, Wayfair, and Amazon furniture in ${city.name}?`,
      a: 'Yes. We assemble furniture from IKEA, Wayfair, Amazon, Ashley, Target, Costco, CB2, Pottery Barn, West Elm and more. Common jobs include beds, dressers, desks, bookcases, and TV stands. Share the item model or product link when booking.',
    };
  }
  return [...primaryFaqs, ...(localGuide ? [localGuide.faq] : []), costFaq(cfg, city), locationFaq(city)];
}

function decodeHtmlText(value) {
  return String(value || '')
    .replaceAll('&ndash;', '–')
    .replaceAll('&mdash;', '—')
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&rsquo;', '’')
    .replaceAll('&#39;', "'");
}

function buildServiceSchema(cfg, city) {
  const url = `https://www.assembleatease.com/${pageSlug(cfg, city)}`;
  return `<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Service',
    '@id': `${url}#service`,
    name: `AssembleAtEase — ${cfg.eyebrow} in ${city.name}`,
    serviceType: cfg.eyebrow,
    image: `https://www.assembleatease.com/images/${cfg.heroPhoto}`,
    url,
    provider: {
      '@type': 'Organization',
      '@id': 'https://www.assembleatease.com/#organization',
      name: 'AssembleAtEase',
      url: 'https://www.assembleatease.com',
      telephone: '+19792325139',
      email: 'service@assembleatease.com',
    },
    areaServed: {
      '@type': 'City',
      name: city.name,
      containedInPlace: { '@type': 'State', name: 'Texas' },
    },
    hasOfferCatalog: {
      '@type': 'OfferCatalog',
      name: cfg.eyebrow,
      itemListElement: cfg.offers.map((offer, index) => ({
        '@type': 'Offer',
        position: index + 1,
        name: decodeHtmlText(offer.n),
        description: decodeHtmlText(offer.p),
      })),
    },
  }).replace(/<\//g, '<\\/')}</script>`;
}

// FAQPage schema built from the SAME faqs the visible body renders, so the
// structured data and the page never disagree (an SEO consistency requirement).
function buildFaqSchema(cfg, city) {
  return `<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: serviceFaqs(cfg, city).map((f) => ({
      '@type': 'Question',
      name: decodeHtmlText(f.q),
      acceptedAnswer: { '@type': 'Answer', text: decodeHtmlText(f.a) },
    })),
  }).replace(/<\//g, '<\\/')}</script>`;
}

function buildBreadcrumbSchema(cfg, city) {
  const url = `https://www.assembleatease.com/${pageSlug(cfg, city)}`;
  return `<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://www.assembleatease.com' },
      { '@type': 'ListItem', position: 2, name: 'Texas service areas', item: 'https://www.assembleatease.com/locations' },
      { '@type': 'ListItem', position: 3, name: `${cfg.linkLabel} in ${city.name}, TX`, item: url },
    ],
  }).replace(/<\//g, '<\\/')}</script>`;
}

function upsertJsonLdSchema(html, type, schema) {
  const pattern = new RegExp(`<script type="application\\/ld\\+json">(?:(?!<\\/script>)[\\s\\S])*?"@type"\\s*:\\s*"${type}"(?:(?!<\\/script>)[\\s\\S])*?<\\/script>`);
  if (pattern.test(html)) return html.replace(pattern, () => schema);
  return html.replace('</head>', `${schema}\n</head>`);
}

function parseStartingPrice(label) {
  const match = String(label || '').match(/\$(\d+)/);
  return match ? Number(match[1]) : NaN;
}

function assertVisibleStartPrice(service) {
  const expectedStart = parseStartingPrice(service.fromPrice);
  const visibleStarts = (service.offers || [])
    .slice(0, MAX_COMMON_JOBS)
    .map((offer) => parseStartingPrice(offer.p))
    .filter(Number.isFinite);
  const lowestVisible = visibleStarts.length ? Math.min(...visibleStarts) : NaN;

  if (!Number.isFinite(expectedStart) || !Number.isFinite(lowestVisible)) {
    throw new Error(`Unable to validate visible start price for ${service.slug}.`);
  }
  if (lowestVisible > expectedStart) {
    throw new Error(
      `${service.slug} starts at ${service.fromPrice}, but visible offers begin at $${lowestVisible}. Update the visible offers before generating pages.`,
    );
  }
}

const FA_STYLE = `<style>
/* ===== Flagship service page ===== */
.fa-hero{position:relative;background:linear-gradient(180deg,#edf6fe 0%,#f6fbff 55%,#ffffff 100%);overflow:hidden;border-bottom:1px solid var(--border)}
.fa-hero::before{content:"";position:absolute;top:-28%;right:-8%;width:52%;height:130%;background:radial-gradient(circle at center,rgba(0,191,255,0.16),transparent 60%);pointer-events:none}
.fa-hero-grid{position:relative;z-index:1;max-width:1180px;margin:0 auto;display:grid;grid-template-columns:1.02fr 0.98fr;gap:3.5rem;align-items:center;padding:4.25rem 2rem 4.5rem}
.fa-eyebrow{display:inline-flex;align-items:center;gap:9px;flex-wrap:wrap;max-width:100%;font-size:0.72rem;font-weight:700;letter-spacing:0.15em;text-transform:uppercase;color:var(--cyan-dark);margin-bottom:1.25rem}
.fa-eyebrow::before{content:"";width:24px;height:2px;background:var(--cyan)}
.fa-title{font-family:var(--font-display);font-size:clamp(2.3rem,4.6vw,3.6rem);line-height:1.04;letter-spacing:-0.5px;color:var(--ink);margin-bottom:1.1rem;max-width:100%;overflow-wrap:anywhere;word-break:break-word}
.fa-title em{font-style:italic;color:var(--cyan-dark)}
.fa-sub{font-size:1.08rem;line-height:1.7;color:var(--ink-soft);max-width:31rem;margin-bottom:1.85rem}
.fa-cta-row{display:flex;flex-wrap:wrap;gap:0.9rem;margin-bottom:1.7rem}
.fa-btn-primary{display:inline-flex;align-items:center;gap:8px;background:var(--cyan);color:#03303f;font-weight:700;font-size:1rem;padding:0.95rem 1.95rem;border-radius:999px;text-decoration:none;transition:all .18s;box-shadow:0 12px 30px rgba(0,191,255,0.3)}
@media (hover: hover) and (pointer: fine){.fa-btn-primary:hover{background:var(--cyan-dark);color:#fff;transform:translateY(-2px)}}
.fa-btn-ghost{display:inline-flex;align-items:center;gap:8px;color:var(--ink);font-weight:600;font-size:1rem;padding:0.95rem 1.5rem;border-radius:999px;text-decoration:none;border:1.5px solid var(--border);transition:all .18s}
@media (hover: hover) and (pointer: fine){.fa-btn-ghost:hover{border-color:var(--cyan);color:var(--cyan-dark)}}
.fa-hero-media{position:relative}
.fa-hero-media picture{display:block}
.fa-shot .frame picture{display:block;width:100%;height:100%}
.fa-hero-media img{width:100%;height:auto;display:block;border-radius:20px;box-shadow:0 26px 55px rgba(2,32,43,0.22)}
.fa-media-chip{position:absolute;left:0.9rem;bottom:0.9rem;background:rgba(8,18,30,0.84);backdrop-filter:blur(6px);border:1px solid rgba(255,255,255,0.14);color:#fff;font-size:0.78rem;font-weight:600;padding:0.5rem 0.9rem;border-radius:999px;display:flex;align-items:center;gap:8px}
.fa-media-chip::before{content:"";width:7px;height:7px;border-radius:50%;background:#28d17c;box-shadow:0 0 0 4px rgba(40,209,124,0.25)}
.fa-section{padding:4.75rem 2rem}
.fa-wrap{max-width:1100px;margin:0 auto}
.fa-head{max-width:42rem;margin-bottom:0.5rem}
.fa-head--center{margin-left:auto;margin-right:auto;text-align:center}
.fa-kicker{font-size:0.72rem;text-transform:uppercase;letter-spacing:0.13em;color:var(--cyan-dark);font-weight:700;margin-bottom:0.55rem}
.fa-h2{font-family:var(--font-display);font-size:clamp(1.7rem,3.1vw,2.45rem);color:var(--ink);line-height:1.1}
.fa-lead{font-size:1rem;color:var(--muted);line-height:1.7;max-width:40rem;margin-top:0.7rem}
.fa-gallery{display:grid;grid-template-columns:1fr 1fr;gap:1.4rem;margin-top:2.5rem}
.fa-shot{border-radius:16px;overflow:hidden;background:var(--white);border:1px solid var(--border);box-shadow:var(--shadow)}
.fa-shot .frame{width:100%;aspect-ratio:7/5;overflow:hidden;background:#e9eef2}
.fa-shot .frame img{width:100%;height:100%;object-fit:cover;display:block;transition:transform .4s}
@media (hover: hover) and (pointer: fine){.fa-shot:hover .frame img{transform:scale(1.04)}}
.fa-shot .cap{padding:0.95rem 1.1rem;font-size:0.92rem;font-weight:700;color:var(--ink)}
.fa-shot .cap small{display:block;font-weight:500;color:var(--muted);font-size:0.77rem;margin-top:3px}
.fa-note{background:var(--off-white);border:1px solid var(--border);border-radius:16px;padding:1.7rem 1.5rem;color:var(--ink);display:flex;flex-direction:column;justify-content:center;min-height:200px}
.fa-note strong{font-family:var(--font-display);font-size:1.25rem;line-height:1.18;display:block;margin-bottom:0.55rem}
.fa-note p{font-size:0.92rem;line-height:1.6;color:var(--muted)}
.fa-price-shell{display:grid;grid-template-columns:minmax(240px,0.78fr) minmax(0,1.22fr);gap:1rem;align-items:stretch}
.fa-price-side{background:linear-gradient(180deg,#ffffff 0%,#f5fbfe 100%);border:1px solid rgba(15,23,42,0.08);border-radius:28px;padding:1.6rem 1.5rem;box-shadow:0 20px 48px rgba(15,23,42,0.08);display:flex;flex-direction:column;justify-content:space-between}
.fa-price-anchor{text-align:left;margin-bottom:1rem}
.fa-price-anchor .big{font-family:var(--font-display);font-size:clamp(2.4rem,5vw,3.1rem);color:var(--cyan-dark);line-height:1}
.fa-price-anchor .lbl{display:block;font-size:0.78rem;text-transform:uppercase;letter-spacing:0.12em;color:var(--muted);font-weight:700;margin-top:0.45rem}
.fa-price-note{font-size:0.92rem;line-height:1.72;color:var(--muted);margin:0}
.fa-menu{background:var(--white);border:1px solid rgba(15,23,42,0.08);border-radius:28px;padding:1rem;box-shadow:0 20px 48px rgba(15,23,42,0.08);display:grid;gap:0.75rem}
.fa-menu-row{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:1rem 1.05rem;border:1px solid rgba(15,23,42,0.08);border-radius:18px;background:linear-gradient(180deg,#ffffff 0%,#fbfdff 100%)}
.fa-menu-row .nm{font-size:0.96rem;font-weight:700;color:var(--ink);display:flex;align-items:center;gap:0.55rem;flex-wrap:wrap}
.fa-menu-row .tag{font-size:0.58rem;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:var(--cyan-dark);background:var(--cyan-light);border:1px solid var(--cyan-mid);border-radius:999px;padding:0.12rem 0.5rem}
.fa-menu-row .pr{font-family:var(--font-display);font-size:1.2rem;color:var(--cyan-dark);white-space:nowrap}
.fa-price-foot{margin-top:1rem;padding:1.2rem 1.35rem;border-radius:24px;background:linear-gradient(135deg,#0f3558 0%,#1a6a87 100%);display:flex;align-items:center;justify-content:space-between;gap:1rem}
.fa-price-copy{display:flex;flex-direction:column;gap:0.35rem;max-width:33rem}
.fa-price-copy strong{font-size:1.05rem;color:#fff}
.fa-price-copy span{font-size:0.88rem;line-height:1.7;color:rgba(255,255,255,0.82)}
.fa-price-actions{display:flex;flex-direction:column;align-items:flex-end;gap:0.8rem}
.fa-price-support{max-width:21rem;font-size:0.8rem;line-height:1.6;color:rgba(255,255,255,0.8);margin:0;text-align:right}
.fa-process{max-width:900px;margin:0 auto}
.fa-process-tabs{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:0.75rem}
.fa-process-tab{appearance:none;border:1.5px solid var(--border);background:var(--white);border-radius:16px;padding:0.95rem 1rem;text-align:left;cursor:pointer;transition:border-color .15s,box-shadow .15s,background .15s}
@media (hover: hover) and (pointer: fine){.fa-process-tab:hover{border-color:var(--cyan-mid)}}
.fa-process-tab.is-active{border-color:var(--cyan);background:#f7fcfe;box-shadow:0 10px 28px rgba(0,191,255,0.08)}
.fa-process-num{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:50%;background:var(--cyan);color:#fff;font-family:var(--font-display);font-size:1.05rem;margin-bottom:0.7rem}
.fa-process-tab.is-active .fa-process-num{background:var(--cyan-dark)}
.fa-process-label{display:block;font-size:0.94rem;font-weight:700;color:var(--ink)}
.fa-process-panel{margin-top:0.9rem;background:var(--off-white);border:1px solid var(--border);border-radius:18px;padding:1.15rem 1.25rem}
.fa-process-panel h3{font-size:1rem;font-weight:700;color:var(--ink);margin-bottom:0.4rem}
.fa-process-panel p{font-size:0.9rem;line-height:1.65;color:var(--muted)}
.fa-mini-facts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:0.8rem}
.fa-mini-fact{background:var(--white);border:1.5px solid var(--border);border-radius:16px;padding:1rem 1.05rem}
.fa-mini-fact strong{display:block;font-size:0.88rem;color:var(--ink);margin-bottom:0.3rem}
.fa-mini-fact span{display:block;font-size:0.82rem;line-height:1.55;color:var(--muted)}
.fa-faq-item{background:var(--white);border:1.5px solid var(--border);border-radius:var(--radius-lg);overflow:hidden;margin-bottom:0.75rem}
.fa-faq-q{width:100%;display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:1.05rem 1.3rem;background:none;border:none;cursor:pointer;font-family:var(--font-body);font-size:0.94rem;font-weight:600;color:var(--ink);text-align:left}
.fa-faq-a{display:none;padding:0 1.3rem 1.1rem;font-size:0.88rem;color:var(--muted);line-height:1.75}
.fa-chev{transition:transform .2s;flex-shrink:0;color:var(--cyan-dark);font-size:1.1rem}
.fa-citylinks{display:flex;flex-wrap:wrap;gap:0.6rem;justify-content:center}
.fa-citylinks a{display:inline-flex;align-items:center;background:var(--white);border:1px solid var(--cyan-mid);border-radius:999px;padding:0.55rem 1.15rem;font-size:0.875rem;font-weight:600;color:var(--cyan-dark);text-decoration:none;transition:all .15s}
@media (hover: hover) and (pointer: fine){.fa-citylinks a:hover{background:var(--cyan-light);border-color:var(--cyan)}}
.fa-share-kit{max-width:860px;margin:0 auto}
.fa-share-inner{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:1.15rem 1.25rem;background:var(--white);border:1px solid var(--border);border-radius:18px}
.fa-share-copy strong{display:block;font-size:1rem;color:var(--ink);margin-bottom:0.2rem}
.fa-share-copy span{display:block;font-size:0.88rem;line-height:1.6;color:var(--muted);max-width:34rem}
.fa-share-actions{display:flex;align-items:center;justify-content:flex-end;gap:0.6rem;flex-wrap:wrap}
.fa-share-btn{display:inline-flex;align-items:center;justify-content:center;width:46px;height:46px;border-radius:999px;border:1px solid var(--cyan-mid);background:var(--white);color:var(--cyan-dark);text-decoration:none;transition:background .15s,border-color .15s,color .15s,transform .15s}
@media (hover: hover) and (pointer: fine){.fa-share-btn:hover{background:var(--cyan-light);border-color:var(--cyan);transform:translateY(-1px)}}
.fa-share-btn svg{width:18px;height:18px;display:block}
.fa-sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
@media(max-width:900px){
  .fa-hero-grid{grid-template-columns:1fr;gap:2.2rem;padding:3rem 1.5rem 3.25rem}
  .fa-hero-media{order:-1;max-width:540px;margin:0 auto;width:100%}
  .fa-mini-facts{grid-template-columns:1fr}
  .fa-price-shell{grid-template-columns:1fr}
  .fa-price-foot{flex-direction:column;align-items:flex-start}
  .fa-price-actions{align-items:flex-start}
  .fa-price-support{text-align:left}
}
@media(max-width:560px){
  .fa-section{padding:3.4rem 1.4rem}
  .fa-title{font-size:clamp(2rem,10.5vw,2.6rem)}
  .fa-gallery{grid-template-columns:1fr}
  .fa-cta-row{flex-direction:column;align-items:stretch}
  .fa-btn-primary,.fa-btn-ghost{justify-content:center}
  .fa-menu{padding:0.8rem}
  .fa-process-tabs{gap:0.5rem}
  .fa-process-tab{padding:0.8rem 0.75rem}
  .fa-process-label{font-size:0.82rem}
  .fa-share-inner{display:block;padding:1.05rem 1rem}
  .fa-share-actions{justify-content:flex-start;margin-top:0.8rem}
}
</style>`;

const ALL_SERVICES = [
  { label: 'Furniture Assembly', austin: '/furniture-assembly-austin-tx' },
  { label: 'TV Mounting', austin: '/tv-mounting-austin-tx' },
  { label: 'Smart Home Installation', austin: '/smart-home-installation-austin-tx' },
  { label: 'Fitness Equipment Assembly', austin: '/fitness-equipment-assembly-austin-tx' },
  { label: 'Office Furniture Assembly', austin: '/office-furniture-assembly-austin-tx' },
  { label: 'Playset Assembly', austin: '/playset-assembly-austin-tx' },
];
const NEAR_CITIES = [
  { slug: 'round-rock', name: 'Round Rock' },
  { slug: 'cedar-park', name: 'Cedar Park' },
  { slug: 'pflugerville', name: 'Pflugerville' },
  { slug: 'lakeway', name: 'Lakeway' },
];
const FLAGSHIP_STYLE_RE = /<style>\s*\/\* ===== Flagship[\s\S]*?<\/style>\s*/g;
const CITY_TEMPLATE_STYLE_RE = /<style>\s*\.pricing-shell\{[\s\S]*?#m-svc-bar\{display:none\}[\s\S]*?<\/style>\s*/g;

function gallerySection(cfg, city) {
  const noteStrong = neutralizeNote(cfg.noteStrong, city);
  const header = `    <div class="fa-head">
      <div class="fa-kicker">Recent work</div>
      <h2 class="fa-h2">${cfg.workHeadline}</h2>
      <p class="fa-lead">${escapeHtml(metroServiceGuide(cfg, city)?.workSummary || 'Recent job photos for this service.')}</p>
    </div>`;
  const shot = (g) => `      <figure class="fa-shot"><div class="frame">${picture(g.src, g.alt, '(max-width: 860px) 100vw, 380px', ` loading="lazy"${g.pos ? ` style="object-position:${g.pos}"` : ''}`)}</div><figcaption class="cap">${g.cap}<small>${g.sub}</small></figcaption></figure>`;
  const noteCell = `      <div class="fa-note"><strong>${noteStrong}</strong><p>${cfg.noteSpan}</p></div>`;
  let inner;
  if (cfg.gallery.length >= 2) {
    inner = `    <div class="fa-gallery">\n${cfg.gallery.slice(0, 2).map(shot).join('\n')}\n    </div>`;
  } else if (cfg.gallery.length === 1) {
    inner = `    <div class="fa-gallery">\n${shot(cfg.gallery[0])}\n${noteCell}\n    </div>`;
  } else {
    inner = `    <div class="fa-note"><strong>${noteStrong}</strong><p>${cfg.noteSpan}</p></div>`;
  }
  return `<section class="fa-section" style="background:var(--white)">
  <div class="fa-wrap">
${header}
${inner}
  </div>
</section>`;
}

function buildBody(cfg, city) {
  const bk = `/book?service=${cfg.bookingParam}`;
  const pageUrl = `https://www.assembleatease.com/${pageSlug(cfg, city)}`;
  const facebookShare = `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(pageUrl)}`;
  const linkedinShare = `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(pageUrl)}`;
  const { lead, tail } = splitHeroTitle(cfg.heroTitle);
  const heroTitle = `${lead} in ${city.name},<br><em>${tail}</em>`;
  const menu = cfg.offers
    .slice(0, MAX_COMMON_JOBS)
    .map((o) => `      <div class="fa-menu-row"><span class="nm">${o.n}${o.popular ? ' <span class="tag">Popular</span>' : ''}</span><span class="pr">${o.p}</span></div>`)
    .join('\n');
  const faqs = serviceFaqs(cfg, city).map((f) => `    <div class="fa-faq-item">
      <button class="fa-faq-q" onclick="var a=this.nextElementSibling;a.style.display=a.style.display==='block'?'none':'block';this.querySelector('.fa-chev').style.transform=a.style.display==='block'?'rotate(180deg)':'rotate(0)'">${f.q} <span class="fa-chev">&#8964;</span></button>
      <div class="fa-faq-a">${f.a}</div>
    </div>`).join('\n');
  const nearby = city.nearby.map((c) => `      <a href="/${cfg.prefix}-${c.slug}-tx">${c.name}</a>`).join('\n');
  const otherServices = SERVICES
    .filter((service) => service.prefix !== cfg.prefix)
    .map((service) => `      <a href="/${service.prefix}-${city.citySlug}-tx">${service.linkLabel}</a>`)
    .join('\n');
  const processId = `process-${pageSlug(cfg, city)}`;
  const projectLabel = city.name === 'Austin' ? 'Completed Austin project' : 'Example completed project';
  const locationLinksKicker = city.linksAreNearby ? 'Nearby cities' : 'Other Texas service areas';
  const locationLinksHeading = city.linksAreNearby
    ? `${cfg.linkLabel} outside ${city.name}`
    : `${cfg.linkLabel} across Texas`;
  const bookingGuidance = city.bookingGuidance
    || `Include the item count, access details, stairs, room location, and scheduling constraints when booking in ${city.name}.`;
  const servicePlanning = SERVICE_PLANNING[cfg.prefix];
  if (!servicePlanning) throw new Error(`Missing service planning content for ${cfg.prefix}.`);
  const localGuide = metroServiceGuide(cfg, city);
  const housing = housingGuide(cfg, city);
  const planningGuide = localGuide?.guide || (city.name === 'Austin' ? servicePlanning.austinGuide : null);
  const marketContext = city.bio
    ? `${city.bio}${city.landmark ? ` Addresses around ${city.landmark} can have different parking, entry, and item-move requirements.` : ''}`
    : bookingGuidance;

  return `<!-- HERO -->
<section class="fa-hero">
  <div class="fa-hero-grid">
    <div class="fa-hero-copy">
      <span class="fa-eyebrow">${city.name}, TX &middot; ${cfg.eyebrow}</span>
      <h1 class="fa-title">${heroTitle}</h1>
      <p class="fa-sub">${cfg.heroSub}</p>
      <div class="fa-cta-row">
        <a class="fa-btn-primary" href="${bk}">${cfg.ctaVerb} &rarr;</a>
        <a class="fa-btn-ghost" href="#fa-pricing">See pricing</a>
      </div>
    </div>
    <div class="fa-hero-media">
      ${picture(cfg.heroPhoto, cfg.heroAlt, '(max-width: 860px) 100vw, 540px', ' loading="eager" fetchpriority="high"')}
      <div class="fa-media-chip">${projectLabel}</div>
    </div>
  </div>
</section>

<!-- OUR WORK -->
${gallerySection(cfg, city)}

<!-- PRICING -->
<section class="fa-section" id="fa-pricing" style="background:var(--off-white);border-top:1px solid var(--border);border-bottom:1px solid var(--border)">
  <div class="fa-wrap">
    <div class="fa-head fa-head--center">
      <div class="fa-kicker">Pricing</div>
      <h2 class="fa-h2">Simple, flat pricing</h2>
    </div>
    <div class="fa-price-shell">
      <div class="fa-price-side">
        <div class="fa-price-anchor"><span class="big">From ${cfg.fromPrice}</span><span class="lbl">${cfg.fromLabel}</span></div>
        <p class="fa-price-note">Common jobs and starting points for this service. Choose the matching service type, then add the exact setup details in booking so we can confirm the scope before the visit.</p>
      </div>
      <div class="fa-menu">
${menu}
      </div>
    </div>
    <div class="fa-price-foot">
      <div class="fa-price-copy">
        <strong>Need a different setup?</strong>
        <span>Tell us the exact items, wall conditions, or room layout and we will line up the right visit for the job.</span>
      </div>
      <div class="fa-price-actions">
        <a href="${bk}" class="fa-btn-primary">Check availability &amp; book &rarr;</a>
        <p class="fa-price-support">Add item count, wall details, or room notes in booking and we will confirm the setup before the visit.</p>
      </div>
    </div>
  </div>
</section>

<!-- HOW IT WORKS -->
<section class="fa-section" style="background:var(--white);border-bottom:1px solid var(--border)">
  <div class="fa-wrap" style="max-width:900px">
    <div class="fa-head fa-head--center" style="margin-bottom:1.4rem">
      <div class="fa-kicker">Simple process</div>
      <h2 class="fa-h2">Three quick steps.</h2>
    </div>
    <div class="fa-process" id="${processId}">
      <div class="fa-process-tabs" role="tablist" aria-label="Simple process">
        <button type="button" class="fa-process-tab is-active" role="tab" aria-selected="true" onclick="aaeSetProcessStep('${processId}', this, 'Tell us what you need', 'Choose the items or options for this job and pick a time that works for you.')"><span class="fa-process-num">1</span><span class="fa-process-label">Pick</span></button>
        <button type="button" class="fa-process-tab" role="tab" aria-selected="false" onclick="aaeSetProcessStep('${processId}', this, 'We confirm the details', 'We review availability, confirm the visit, and reach out if anything needs clarification before the appointment.')"><span class="fa-process-num">2</span><span class="fa-process-label">Confirm</span></button>
        <button type="button" class="fa-process-tab" role="tab" aria-selected="false" onclick="aaeSetProcessStep('${processId}', this, 'We complete the setup', 'Your pro arrives ready for the job, finishes the setup carefully, and leaves the space ready to use.')"><span class="fa-process-num">3</span><span class="fa-process-label">Done</span></button>
      </div>
      <div class="fa-process-panel">
        <h3>Tell us what you need</h3>
        <p>Choose the items or options for this job and pick a time that works for you.</p>
      </div>
    </div>
  </div>
</section>

<!-- WHAT TO EXPECT -->
<section class="fa-section" style="background:var(--off-white);border-bottom:1px solid var(--border)">
  <div class="fa-wrap" style="max-width:900px">
    <div class="fa-head fa-head--center" style="margin-bottom:1.5rem">
      <div class="fa-kicker">${escapeHtml(city.name)} service guide</div>
      <h2 class="fa-h2">${escapeHtml(servicePlanning.heading)} in ${escapeHtml(city.name)}</h2>
      <p class="fa-lead" style="margin-left:auto;margin-right:auto">${escapeHtml(localGuide?.summary || servicePlanning.summary)}</p>
      <p class="fa-lead" style="margin-left:auto;margin-right:auto">${escapeHtml(localGuide?.preparation || servicePlanning.requestTypes)}</p>
${localGuide?.completedWork ? `      <p class="fa-lead" style="margin-left:auto;margin-right:auto">${escapeHtml(localGuide.completedWork)}</p>\n` : ''}${[planningGuide, localGuide?.extraGuide].filter(Boolean).map((guide) => `      <p class="fa-lead" style="margin-left:auto;margin-right:auto"><a href="${guide.href}">${escapeHtml(guide.label)}</a>.</p>\n`).join('')}${localGuide && !localGuide.includeMarketContext ? '' : `      <p class="fa-lead" style="margin-left:auto;margin-right:auto"><strong style="color:var(--ink-soft)">Planning your ${escapeHtml(city.name)} appointment:</strong> ${escapeHtml(marketContext)}${city.bio ? ` ${escapeHtml(bookingGuidance)}` : ''}</p>\n`}${housing ? `      <p class="fa-lead" style="margin-left:auto;margin-right:auto"><strong style="color:var(--ink-soft)">Local homes:</strong> ${escapeHtml(housing.facts)} ${escapeHtml(housing.advice)}</p>\n      <p class="fa-lead" style="margin-left:auto;margin-right:auto;font-size:0.8rem;color:var(--muted)">Source: ${escapeHtml(housing.source)}.</p>\n` : ''}    </div>
    <div class="fa-mini-facts">
      <div class="fa-mini-fact"><strong class="fa-mini-fact-title">Trusted local pros</strong><span>Assigned and confirmed before the visit.</span></div>
      <div class="fa-mini-fact"><strong class="fa-mini-fact-title">Careful setup</strong><span>Built, mounted, or installed with the finish details checked.</span></div>
      <div class="fa-mini-fact"><strong class="fa-mini-fact-title">Ready to use</strong><span>We leave the space clean and the job ready for the next step.</span></div>
    </div>
  </div>
</section>

<!-- FAQ -->
<section class="fa-section" style="background:var(--white);border-bottom:1px solid var(--border)">
  <div class="fa-wrap" style="max-width:700px">
    <div class="fa-head fa-head--center" style="margin-bottom:2.4rem">
      <div class="fa-kicker">FAQ</div>
      <h2 class="fa-h2">Common questions about ${cfg.faqNoun} in ${city.name}</h2>
    </div>
${faqs}
  </div>
</section>

<!-- LOCATION AND SERVICE LINKS -->
<section class="fa-section" style="background:var(--off-white);border-bottom:1px solid var(--border)">
  <div class="fa-wrap" style="max-width:760px;text-align:center">
    <div class="fa-head fa-head--center" style="margin-bottom:1.6rem">
      <div class="fa-kicker">${locationLinksKicker}</div>
      <h2 class="fa-h2">${locationLinksHeading}</h2>
    </div>
    <div class="fa-citylinks">
${nearby}
    </div>
    <div class="fa-head fa-head--center" style="margin:2.2rem auto 1.2rem">
      <div class="fa-kicker">More ways we can help</div>
      <h2 class="fa-h2">Other services in ${city.name}</h2>
    </div>
    <div class="fa-citylinks">
${otherServices}
    </div>
  </div>
</section>

<!-- SHARE -->
<section class="fa-section" style="background:var(--white)">
  <div class="fa-share-kit" aria-label="Share this service page">
    <div class="fa-share-inner">
      <div class="fa-share-copy">
        <strong>Share this service page.</strong>
        <span>Send it to someone planning this kind of job.</span>
      </div>
      <div class="fa-share-actions">
        <a class="fa-share-btn" href="${facebookShare}" target="_blank" rel="noopener" aria-label="Share on Facebook">
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M13.5 21v-7.3H16l.4-3h-2.9V8.8c0-.9.2-1.5 1.5-1.5h1.6V4.6c-.3 0-1.2-.1-2.3-.1-2.3 0-3.8 1.4-3.8 4v2.2H8v3h2.5V21h3z"/></svg>
          <span class="fa-sr-only">Facebook</span>
        </a>
        <a class="fa-share-btn" href="${linkedinShare}" target="_blank" rel="noopener" aria-label="Share on LinkedIn">
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6.94 8.5a1.72 1.72 0 1 1 0-3.44 1.72 1.72 0 0 1 0 3.44ZM8.5 19H5.38V9.86H8.5V19Zm10.12 0h-3.1v-4.45c0-1.06-.02-2.42-1.48-2.42-1.49 0-1.72 1.16-1.72 2.34V19H9.2V9.86h3v1.25h.04c.42-.8 1.44-1.65 2.96-1.65 3.16 0 3.74 2.08 3.74 4.78V19Z"/></svg>
          <span class="fa-sr-only">LinkedIn</span>
        </a>
        <a class="fa-share-btn" href="#" data-copy-url="${pageUrl}" onclick="return aaeCopyShareLink(this)" aria-label="Copy page link">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.07 0l2.83-2.83a5 5 0 0 0-7.07-7.07L11.2 4.72"/><path d="M14 11a5 5 0 0 0-7.07 0L4.1 13.83a5 5 0 0 0 7.07 7.07L12.8 19.28"/></svg>
          <span class="fa-sr-only">Copy link</span>
        </a>
      </div>
    </div>
  </div>
</section>

<script>
function aaeSetProcessStep(groupId, btn, title, copy){
  var group=document.getElementById(groupId);
  if(!group) return;
  var tabs=group.querySelectorAll('.fa-process-tab');
  tabs.forEach(function(tab){
    tab.classList.remove('is-active');
    tab.setAttribute('aria-selected','false');
  });
  btn.classList.add('is-active');
  btn.setAttribute('aria-selected','true');
  var panel=group.querySelector('.fa-process-panel');
  if(!panel) return;
  panel.innerHTML='<h3>'+title+'</h3><p>'+copy+'</p>';
}
function aaeCopyShareLink(link){
  var url=link.getAttribute('data-copy-url');
  if(!url) return false;
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(url).then(function(){
      link.setAttribute('aria-label','Link copied');
      link.title='Link copied';
    });
  }
  return false;
}
</script>

`;
}

const SERVICES = [
  {
    slug: 'furniture-assembly-austin-tx', prefix: 'furniture-assembly', linkLabel: 'Furniture assembly',
    titleLabel: 'Furniture Assembly',
    eyebrow: 'Furniture Assembly', faqNoun: 'furniture assembly', bookingParam: 'Furniture+Assembly',
    fromPrice: '$69', fromLabel: 'per item', ctaVerb: 'Book furniture assembly',
    heroTitle: 'Furniture Assembly in Austin,<br><em>built right the first time.</em>',
    heroSub: 'Beds, dressers, desks, sectionals and storage pieces assembled cleanly and left ready to use. Tools and cleanup are included.',
    heroPhoto: 'real-furniture-dresser-wood.jpg', heroAlt: 'Two-tone six-drawer dresser assembled in a finished bedroom',
    workHeadline: 'Built right. Left clean.',
    noteStrong: 'Furniture assembly examples.', noteSpan: 'Beds, dressers, desks and storage pieces assembled, leveled and cleaned up before we leave.',
    gallery: [
      { src: 'real-furniture-dresser-white.png', alt: 'Nine-drawer white dresser assembled and leveled in a finished bedroom', cap: '9-drawer modern dresser', sub: 'Drawers aligned, frame leveled, packaging removed' },
      { src: 'real-furniture-bed-paneled.png', alt: 'Upholstered paneled platform bed assembled in a bedroom', cap: 'Upholstered platform bed', sub: 'Headboard, rails and slats torqued to spec', pos: 'center 26%' },
    ],
    offers: [
      { n: 'Side / end table', p: '$69' },
      { n: 'Nightstand (single)', p: '$79' },
      { n: 'Bed frame (queen)', p: '$119', popular: true },
      { n: 'Dresser / chest of drawers', p: '$109&ndash;$149' },
      { n: 'IKEA PAX wardrobe (single unit)', p: '$199' },
    ],
    faqs: [
      { q: 'How long does furniture assembly take?', a: 'Most single items take 30&ndash;90 minutes. A full bedroom set or several pieces can take longer. We&rsquo;ll give you a time estimate when confirming your booking.' },
      { q: 'Do you bring your own tools?', a: 'Yes. Our Easers arrive with the tools needed for standard flat-pack furniture assembly.' },
      { q: 'Can you assemble any brand?', a: 'Yes. IKEA, Wayfair, Amazon, Ashley, Target, Costco, CB2, Pottery Barn, West Elm and more.' },
      { q: 'Do you serve Round Rock too?', a: 'Yes. in addition to Austin, we cover Round Rock, Cedar Park, Pflugerville, Lakeway, and the surrounding metro. Book online and we&rsquo;ll confirm the details.' },
    ],
  },
  {
    slug: 'tv-mounting-austin-tx', prefix: 'tv-mounting', linkLabel: 'TV Mounting',
    eyebrow: 'TV Mounting', faqNoun: 'TV mounting', bookingParam: 'Mounting+%26+Hanging',
    fromPrice: '$99', fromLabel: 'standard TV, pictures &amp; mirrors from $79', ctaVerb: 'Book TV mounting',
    heroTitle: 'TV Mounting in Austin,<br><em>level and clean.</em>',
    heroSub: 'TVs, soundbars, mirrors and art, mounted level, anchored to studs, cables hidden. You supply the mount and hardware; we bring the tools and the steady hands for a clean, level wall.',
    heroPhoto: 'real-tv-mount-console.jpg', heroAlt: 'Large flat-screen TV wall-mounted above a media console',
    workHeadline: 'Mounted level. Wires gone.',
    noteStrong: 'TV mounting examples.', noteSpan: 'Bedrooms, great rooms, offices and patios. Mounts, soundbars and cable concealment, cleaned up and leveled.',
    gallery: [
      { src: 'real-tv-dawg-days.jpg', alt: 'Large TV mounted on a great-room wall above a soundbar', cap: 'Great-room TV + soundbar', sub: 'Leveled, soundbar mounted, cables out of sight' },
      { src: 'real-tv-setup-console.jpg', alt: 'Flat TV flush-mounted over a black media console', cap: 'Flush mount over a console', sub: 'Tilt set, cords concealed, ready to watch' },
    ],
    offers: [
      { n: 'Single framed picture / mirror', p: '$79' },
      { n: 'TV up to 40" (standard wall)', p: '$99' },
      { n: 'TV 41"&ndash;55" (standard wall)', p: '$119', popular: true },
      { n: 'In-wall cord concealment', p: '$199' },
    ],
    faqs: [
      { q: 'How long does TV mounting take?', a: 'Most standard wall mounts take 60&ndash;90 minutes. Cord concealment, brick or stone, and above-fireplace jobs take a little longer. We&rsquo;ll give you a time estimate when we confirm your booking.' },
      { q: 'Do you provide the TV mount?', a: 'No. please have your wall mount and any hardware ready before the visit. Our pros bring the tools and do the install. Not sure which mount fits your TV and wall? Message your pro after booking and they&rsquo;ll point you to the right one.' },
      { q: 'Can you hide the cables in the wall?', a: 'Yes. in-wall cord concealment runs the cables behind the drywall for a clean look on standard walls. On brick, stone or surfaces where in-wall isn&rsquo;t possible, we use a paintable cable raceway.' },
      { q: 'Do you serve Round Rock too?', a: 'Yes. we currently serve participating ZIP codes in Round Rock, Cedar Park, Pflugerville, and Lakeway. Enter the service address during booking to confirm current availability.' },
    ],
  },
  {
    slug: 'smart-home-installation-austin-tx', prefix: 'smart-home-installation', linkLabel: 'Smart Home Installation',
    eyebrow: 'Smart Home Setup', faqNoun: 'smart home setup', bookingParam: 'Smart+Home',
    fromPrice: '$69', fromLabel: 'per device, installed &amp; tested', ctaVerb: 'Book smart home setup',
    heroTitle: 'Smart Home Installation in Austin,<br><em>installed and tested.</em>',
    heroSub: 'Thermostats, video doorbells, cameras, locks and plugs, installed, connected to your Wi-Fi, and tested before we leave. No app headaches, no half-finished setup.',
    heroPhoto: 'real-smarthome-doorbell-vivint.png', heroAlt: 'Smart video doorbell installed beside a front door',
    workHeadline: 'Installed, connected, tested.',
    noteStrong: 'Set up and working before we leave.', noteSpan: 'Doorbells, thermostats, cameras, locks and plugs, wired where needed, connected to your app, and tested with you.',
    gallery: [
      { src: 'real-smarthome-doorbell-adt.jpg', alt: 'Smart video doorbell mounted on exterior siding', cap: 'Video doorbell install', sub: 'Mounted, wired, connected and tested' },
    ],
    offers: [
      { n: 'Smart plug install + setup (per 2 plugs)', p: '$69' },
      { n: 'Smart Thermostat (Nest, Ecobee)', p: '$99', popular: true },
      { n: 'Smart Doorbell (wireless)', p: '$89' },
      { n: 'Camera System (4 cameras)', p: '$279' },
    ],
    faqs: [
      { q: 'What can you install?', a: 'Thermostats, video doorbells, cameras, smart locks, plugs, switches and hubs. If it connects to an app, we can usually mount it, wire it, and set it up.' },
      { q: 'Do I need to buy the device first?', a: 'Yes. have your device and any subscription ready. We handle mounting, wiring where needed, app setup and testing on your Wi-Fi.' },
      { q: 'Will it work with my existing setup?', a: 'We connect new devices to your Wi-Fi and your existing app or ecosystem (Google, Alexa, Apple Home where supported) and test everything before we leave.' },
      { q: 'Do you serve Round Rock too?', a: 'Yes. we currently serve participating ZIP codes in Round Rock, Cedar Park, Pflugerville, and Lakeway. Enter the service address during booking to confirm current availability.' },
    ],
  },
  {
    slug: 'fitness-equipment-assembly-austin-tx', prefix: 'fitness-equipment-assembly', linkLabel: 'Fitness Equipment Assembly',
    eyebrow: 'Fitness Equipment Assembly', faqNoun: 'fitness equipment assembly', bookingParam: 'Fitness+Equipment',
    fromPrice: '$139', fromLabel: 'per machine, assembled &amp; leveled', ctaVerb: 'Book fitness assembly',
    heroTitle: 'Fitness Equipment Assembly in Austin,<br><em>ready to train.</em>',
    heroSub: 'Treadmills, ellipticals, racks and full home gyms, assembled solid, leveled, and wiped down. We bring the tools and break down the boxes so you can start day one.',
    heroPhoto: 'real-fitness-home-gym.jpg', heroAlt: 'Home gym with assembled cardio machines and a power rack',
    workHeadline: 'Heavy gear, assembled right.',
    noteStrong: 'From a single treadmill to a full home gym.', noteSpan: 'Cardio machines, racks, benches and cable systems, built to spec, leveled, stable, and wiped down before we go.',
    gallery: [],
    offers: [
      { n: 'Inversion Table', p: '$139' },
      { n: 'Treadmill Assembly', p: '$219', popular: true },
      { n: 'Elliptical Machine', p: '$239' },
      { n: 'Squat Rack / Power Cage', p: '$279' },
    ],
    faqs: [
      { q: 'How long does equipment assembly take?', a: 'Most treadmills and ellipticals take 1&ndash;2 hours; racks, cages and full home gyms can take longer. We&rsquo;ll give you a time estimate when we confirm your booking.' },
      { q: 'Do you bring tools?', a: 'Yes. our Easers arrive fully equipped. You don&rsquo;t need to provide any tools or equipment.' },
      { q: 'Can you assemble any brand?', a: 'Yes. Peloton, NordicTrack, Bowflex, Sole, Rogue, Titan and more. If it shipped in a box with instructions, we can build it.' },
      { q: 'Do you serve Round Rock too?', a: 'Yes. we currently serve participating ZIP codes in Round Rock, Cedar Park, Pflugerville, and Lakeway. Enter the service address during booking to confirm current availability.' },
    ],
  },
  {
    slug: 'office-furniture-assembly-austin-tx', prefix: 'office-furniture-assembly', linkLabel: 'Office Furniture Assembly',
    eyebrow: 'Office Furniture Assembly', faqNoun: 'office furniture assembly', bookingParam: 'Office+Assembly',
    fromPrice: '$89', fromLabel: 'per piece, built square &amp; leveled', ctaVerb: 'Book office assembly',
    heroTitle: 'Office Furniture Assembly in Austin,<br><em>back to work.</em>',
    heroSub: 'Desks, chairs, cabinets and full workstations, built square, leveled, and ready to use. Tools and cleanup included, whether it&rsquo;s one desk or a whole floor.',
    heroPhoto: 'real-office-home-ldesk.jpg', heroAlt: 'Assembled wooden L-shaped desk and storage in a home office',
    workHeadline: 'Built square. Ready to work.',
    noteStrong: 'Home offices to full floors.', noteSpan: 'Desks, standing desks, chairs, cabinets, bookcases and multi-seat workstations, built square, leveled and cleaned up.',
    gallery: [
      { src: 'real-office-workstations.jpg', alt: 'Row of assembled office workstations with dividers', cap: 'Multi-seat workstations', sub: 'Desks, dividers and pedestals, aligned and leveled' },
      { src: 'real-office-cabinets.jpg', alt: 'Pair of assembled glass-door storage cabinets', cap: 'Storage cabinets', sub: 'Built, leveled and anchored where needed' },
    ],
    offers: [
      { n: 'Office Chair / File Cabinet', p: '$89' },
      { n: 'Simple Flat-Pack Desk', p: '$99' },
      { n: 'L-Shape / Executive Desk', p: '$179', popular: true },
      { n: 'Electric Standing Desk', p: '$199' },
    ],
    faqs: [
      { q: 'How long does office assembly take?', a: 'A single desk or chair is usually 45&ndash;90 minutes; a full workstation or several pieces takes longer. We&rsquo;ll give you a time estimate when we confirm your booking.' },
      { q: 'Do you bring tools?', a: 'Yes. fully equipped, including for electric standing desks. You don&rsquo;t need to provide any tools or equipment.' },
      { q: 'Can you do a whole office?', a: 'Yes. desks, chairs, cabinets, bookcases and full workstation sets. Bundle the pieces into one visit and we&rsquo;ll knock it out in a single trip.' },
      { q: 'Do you serve Round Rock too?', a: 'Yes. we currently serve participating ZIP codes in Round Rock, Cedar Park, Pflugerville, and Lakeway. Enter the service address during booking to confirm current availability.' },
    ],
  },
  {
    slug: 'playset-assembly-austin-tx', prefix: 'playset-assembly', linkLabel: 'Playset Assembly',
    eyebrow: 'Outdoor & Playset Assembly', faqNoun: 'playset & outdoor assembly', bookingParam: 'Outdoor+%26+Playsets',
    fromPrice: '$349', fromLabel: 'playsets, smaller outdoor items from $109', ctaVerb: 'Book outdoor assembly',
    heroTitle: 'Playset Assembly in Austin,<br><em>ready for the backyard.</em>',
    heroSub: 'Playsets, swing sets, trampolines, gazebos and patio sets, built to spec, anchored safe, and checked over before anyone climbs on. Tools and cleanup included.',
    heroPhoto: 'service-outdoor-playsets.jpg', heroAlt: 'Assembler building a backyard playset frame with the completed set behind him',
    workHeadline: 'Built safe. Ready to play.',
    noteStrong: 'Outdoor assembly examples.', noteSpan: 'Swing sets, trampolines, playhouses and gazebos, built to spec, anchored, and safety-checked before play.',
    gallery: [
      { src: 'work-outdoor-playset.jpg', alt: 'Assembler working on a backyard playset frame', cap: 'Playset build in progress', sub: 'Frame squared up, hardware staged, setup underway' },
      { src: 'real-outdoor-gazebo.png', alt: 'Assembled backyard gazebo structure', cap: 'Completed gazebo kit', sub: 'Leveled, tightened, and ready for the backyard' },
    ],
    offers: [
      { n: 'Deck box / outdoor storage bench', p: '$109' },
      { n: 'Patio umbrella + base', p: '$109' },
      { n: 'Trampoline Assembly (up to 10 ft)', p: '$319', popular: true },
      { n: 'Swing Set / Backyard Playset', p: '$349' },
      { n: 'Pergola / Gazebo Kit', p: 'Custom quote' },
    ],
    faqs: [
      { q: 'How long does a playset take?', a: 'A trampoline or sandbox is often 1&ndash;2 hours; a large swing set or playset can take 3&ndash;5 hours or more. We&rsquo;ll give you a time estimate when we confirm your booking.' },
      { q: 'Do you anchor it safely?', a: 'Yes. we build to the manufacturer&rsquo;s spec, anchor per the instructions, and check stability before anyone gets on.' },
      { q: 'Can you assemble any brand?', a: 'Yes. Backyard Discovery, Gorilla, Lifetime, Rainbow, Springfree and more, plus pergola and gazebo kits and patio furniture.' },
      { q: 'Do you serve Round Rock too?', a: 'Yes. we currently serve participating ZIP codes in Round Rock, Cedar Park, Pflugerville, and Lakeway. Enter the service address during booking to confirm current availability.' },
    ],
  },
];

// Transform one existing page in place: keep its <head> SEO (title, canonical,
// meta, breadcrumb schema), inject the flagship CSS, swap the visible body, and
// point social media at the real hero, and resync Service, BreadcrumbList, and
// FAQPage schema to the visible page. This is the ONE code path for Austin and
// every city.
export function applyFlagshipToPage(html, cfg, city) {
  html = html.replace(FLAGSHIP_STYLE_RE, '');
  html = html.replace(CITY_TEMPLATE_STYLE_RE, '');
  html = html.replace('</head>', `${FA_STYLE}\n</head>`);

  const pageTitle = fitTitle(`${cfg.titleLabel || cfg.linkLabel} in ${city.name}, TX — From ${cfg.fromPrice}`);
  html = html.replace(/<title>[^<]*<\/title>/, `<title>${pageTitle}</title>`);
  html = html.replace(/<meta property="og:title" content="[^"]*"\/>/, `<meta property="og:title" content="${pageTitle}"/>`);
  html = html.replace(/<meta name="twitter:title" content="[^"]*"\/>/, `<meta name="twitter:title" content="${pageTitle}"/>`);

  const start = html.indexOf('<!-- HERO -->');
  const end = html.indexOf('<footer class="footer">');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('Body markers (<!-- HERO --> / <footer class="footer">) not found');
  }
  html = html.slice(0, start) + buildBody(cfg, city) + html.slice(end);

  const heroUrl = `https://www.assembleatease.com/images/${cfg.heroPhoto}`;
  html = html.replace('<meta property="og:image" content="https://www.assembleatease.com/images/logo.jpg"/>', `<meta property="og:image" content="${heroUrl}"/>`);
  html = html.replace('<meta name="twitter:card" content="summary"/>', '<meta name="twitter:card" content="summary_large_image"/>');
  html = html.replace('<meta name="twitter:image" content="https://www.assembleatease.com/images/logo.jpg"/>', `<meta name="twitter:image" content="${heroUrl}"/>`);

  // Replace the FIRST ld+json (the Service block on both Austin and city pages).
  // Function replacement so literal "$69" prices are never read as $-patterns.
  html = html.replace(
    /<script type="application\/ld\+json">[\s\S]*?<\/script>/,
    () => buildServiceSchema(cfg, city),
  );
  html = upsertJsonLdSchema(html, 'BreadcrumbList', buildBreadcrumbSchema(cfg, city));
  html = upsertJsonLdSchema(html, 'FAQPage', buildFaqSchema(cfg, city));
  return applyGuideDescription(html, cfg, city);
}

function applyGuideDescription(html, cfg, city) {
  const description = metroServiceGuide(cfg, city)?.description;
  if (!description) return html;
  return html.replace(/(<meta\s+(?:name="(?:description|twitter:description)"|property="og:description")\s+content=")[^"]*(")/g,
    (_match, before, after) => before + escapeHtml(description) + after);
}

// Content-only refresh for existing pages: keeps the governed shell, pricing,
// booking links, existing local evidence, photos and scripts unchanged.
// Both full builds and this narrow path render from METRO_SERVICE_GUIDES.
export function applyServiceGuideToPage(html, cfg, city) {
  if (!metroServiceGuide(cfg, city)) throw new Error(`No reviewed guide for ${pageSlug(cfg, city)}`);
  const body = buildBody(cfg, city);
  for (const marker of ['WHAT TO EXPECT', 'FAQ']) {
    const section = new RegExp(`<!-- ${marker} -->[\\s\\S]*?(?=<!-- [A-Z ]+ -->)`);
    const previous = html.match(section)?.[0];
    let replacement = body.match(section)?.[0];
    if (!previous || !replacement) throw new Error(`Missing ${marker} block in ${pageSlug(cfg, city)}`);
    // Other reviewed processes may add local planning and cited evidence here.
    // Keep that reviewed copy and its source together. The full generator now
    // renders housing guidance too, so replace that generated copy rather than
    // appending a second version during a narrow content refresh.
    if (marker === 'WHAT TO EXPECT') {
      const evidencePattern = /^[ \t]*<p\b[^>]*>(?:(?!<\/p>)[\s\S])*?(?:Local homes:|Planning your [^<]+ appointment:|Source: U\.S\. Census Bureau)(?:(?!<\/p>)[\s\S])*?<\/p>\n?/gm;
      const evidence = previous.match(evidencePattern) || [];
      if (evidence.length) {
        replacement = replacement.replace(evidencePattern, '');
        replacement = replacement.replace('    </div>\n    <div class="fa-mini-facts">',
          evidence.map((paragraph) => `      ${paragraph.trim()}\n`).join('') + '    </div>\n    <div class="fa-mini-facts">');
      }
    }
    html = html.replace(section, () => replacement);
  }
  const workSummary = metroServiceGuide(cfg, city)?.workSummary;
  if (workSummary) html = html.replace(/(<!-- OUR WORK -->[\s\S]*?<p class="fa-lead">)[\s\S]*?(<\/p>)/,
    (_match, before, after) => before + escapeHtml(workSummary) + after);
  html = upsertJsonLdSchema(html, 'FAQPage', buildFaqSchema(cfg, city));
  return applyGuideDescription(html, cfg, city);
}

// Direct run = regenerate the 6 Austin flagship pages. Importing this module
// (from the city generator) reuses the builders WITHOUT running this loop.
function generateAustinFlagshipPages() {
  const selectedServices = selectServices(process.argv.slice(2));
  for (const cfg of selectedServices) assertVisibleStartPrice(cfg);
  // Build and validate every result before writing any selected page.
  const pages = selectedServices.map((cfg) => {
    const file = `${cfg.slug}.html`;
    const refresh = process.argv.includes('--content-only') ? applyServiceGuideToPage : applyFlagshipToPage;
    const html = refresh(readFileSync(file, 'utf8'), cfg, AUSTIN);
    return { file, html };
  });
  for (const { file, html } of pages) {
    writeFileSync(file, html);
    console.log(`built ${file}`);
  }
  console.log(`Done: ${pages.length} pages.`);
}

// Repeat --service=<prefix> to regenerate only the reviewed service pages.
export function selectServices(args) {
  const selected = args.filter((arg) => arg.startsWith('--service=')).map((arg) => arg.slice('--service='.length));
  const unknown = selected.filter((prefix) => !SERVICES.some((cfg) => cfg.prefix === prefix));
  if (unknown.length) throw new Error(`Unknown service: ${unknown.join(', ')}`);
  return selected.length ? SERVICES.filter((cfg) => selected.includes(cfg.prefix)) : SERVICES;
}

export { SERVICES, AUSTIN, FA_STYLE, buildBody, buildServiceSchema, buildBreadcrumbSchema, buildFaqSchema, assertVisibleStartPrice, pageSlug };

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  generateAustinFlagshipPages();
}
