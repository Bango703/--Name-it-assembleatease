// scripts/lib/texas-cities.mjs
// SINGLE SOURCE OF TRUTH for the Texas cities the platform markets.
// Lifted verbatim from generate-location-pages.js so customer service pages and
// Easer recruitment pages share ONE city list. CITIES = full metro data (Austin metro
// + Dallas); STATEWIDE_MARKETS = the broader Texas markets the platform accepts bookings
// in ("a local pro is confirmed for your city"). Recruitment must match this reach.
// NOTE (backlog): migrate generate-location-pages.js to import from here too, so the
// inline copy there is retired and this stays the only definition.

export const CITIES = [
  {
    name: 'Austin',
    slug: 'austin',
    zip: '78701',
    bio: 'Austin is the state capital of Texas and a booming tech and creative hub, home to the University of Texas, a vibrant live-music scene, and one of the fastest-growing professional populations in the country.',
    landmark: 'Barton Springs Pool and South Congress Avenue',
    nearby: ['Round Rock', 'Cedar Park', 'Pflugerville', 'Lakeway'],
    lat: '30.2672',
    lng: '-97.7431',
  },
  {
    name: 'Dallas',
    slug: 'dallas',
    zip: '75201',
    bio: 'Dallas customers can book furniture assembly online for apartments, single-family homes, offices, and multi-item move-in setups.',
    bookingGuidance: 'For Dallas apartment and multi-unit bookings, include parking or loading instructions, building access, the floor or elevator details, and where the boxes are located. For multi-item setups, list every item so the appointment can be reviewed and assigned accurately.',
    landmark: 'Downtown Dallas and the surrounding Dallas-Fort Worth communities',
    nearby: ['Irving', 'Garland', 'Plano', 'Fort Worth'],
    lat: '32.7767',
    lng: '-96.7970',
  },
  {
    name: 'Pflugerville',
    slug: 'pflugerville',
    zip: '78660',
    bio: 'Pflugerville is a fast-growing suburb northeast of Austin, known for its affordable family neighborhoods, excellent schools, and quick access to major employers along the SH-130 corridor.',
    landmark: 'Lake Pflugerville and Typhoon Texas waterpark',
    nearby: ['Austin', 'Round Rock', 'Hutto', 'Manor'],
    lat: '30.4349',
    lng: '-97.6200',
  },
  {
    name: 'Round Rock',
    slug: 'round-rock',
    zip: '78664',
    bio: 'Round Rock is a thriving suburb north of Austin, nationally recognized for its family-friendly neighborhoods and proximity to major employers along the I-35 corridor, including Dell Technologies headquarters.',
    landmark: 'Dell Diamond baseball stadium and Old Settlers Park',
    nearby: ['Austin', 'Georgetown', 'Pflugerville', 'Hutto'],
    lat: '30.5083',
    lng: '-97.6789',
  },
  {
    name: 'Cedar Park',
    slug: 'cedar-park',
    zip: '78613',
    bio: 'Cedar Park is a rapidly growing suburb northwest of Austin, popular with families and tech professionals for its top-rated schools, master-planned communities, and easy access to the 183A Toll Road.',
    landmark: 'H-E-B Center at Cedar Park and Brushy Creek Lake Park',
    nearby: ['Austin', 'Leander', 'Round Rock', 'Georgetown'],
    lat: '30.5052',
    lng: '-97.8203',
  },
  {
    name: 'Georgetown',
    slug: 'georgetown',
    zip: '78626',
    bio: 'Georgetown is a historic city north of Austin, celebrated for its beautifully preserved Victorian-era courthouse square, vibrant downtown dining scene, and one of the fastest population growth rates in the entire country.',
    landmark: 'Williamson County Courthouse Square and Blue Hole Regional Park',
    nearby: ['Round Rock', 'Cedar Park', 'Leander', 'Hutto'],
    lat: '30.6332',
    lng: '-97.6777',
  },
  {
    name: 'Leander',
    slug: 'leander',
    zip: '78641',
    bio: 'Leander is one of Austin\'s fastest-growing suburbs, situated along the MetroRail line northwest of the city and known for its master-planned communities, new construction homes, and family-oriented lifestyle.',
    landmark: 'Crystal Falls Golf Course and Leander MetroRail Station',
    nearby: ['Cedar Park', 'Georgetown', 'Austin', 'Round Rock'],
    lat: '30.5788',
    lng: '-97.8530',
  },
  {
    name: 'Hutto',
    slug: 'hutto',
    zip: '78634',
    bio: 'Hutto is a small but rapidly expanding city northeast of Austin along the SH-130 corridor, known for its tight-knit community feel, newer subdivisions, and proximity to major distribution and tech employers.',
    landmark: 'Hippo Stadium and historic Old Town Hutto',
    nearby: ['Round Rock', 'Pflugerville', 'Georgetown', 'Manor'],
    lat: '30.5432',
    lng: '-97.5467',
  },
  {
    name: 'Manor',
    slug: 'manor',
    zip: '78653',
    bio: 'Manor is a growing community just east of Austin, attracting families and first-time homebuyers with affordable new-construction neighborhoods and convenient access to downtown Austin via US-290.',
    landmark: 'Colorado River greenway and the ShadowGlen master-planned community',
    nearby: ['Austin', 'Pflugerville', 'Hutto', 'Round Rock'],
    lat: '30.3413',
    lng: '-97.5567',
  },
  {
    name: 'Bee Cave',
    slug: 'bee-cave',
    zip: '78738',
    bio: 'Bee Cave is an upscale community nestled in the Texas Hill Country just west of Austin, known for luxury master-planned developments, the Hill Country Galleria shopping center, and easy access to Lake Travis.',
    landmark: 'Hill Country Galleria and Falconhead Golf Club',
    nearby: ['Lakeway', 'Austin', 'Cedar Park', 'Leander'],
    lat: '30.3087',
    lng: '-97.9594',
  },
  {
    name: 'Lakeway',
    slug: 'lakeway',
    zip: '78734',
    bio: 'Lakeway is a scenic Lake Travis community in the Texas Hill Country west of Austin, prized for its stunning water views, resort-style amenities, and the sought-after Eanes ISD school district.',
    landmark: 'Lake Travis waterfront and the Lakeway Resort and Spa',
    nearby: ['Bee Cave', 'Austin', 'Cedar Park', 'Leander'],
    lat: '30.3522',
    lng: '-97.9780',
  },
  {
    name: 'Buda',
    slug: 'buda',
    zip: '78610',
    bio: 'Buda is a charming Hill Country gateway town south of Austin on I-35, known for its walkable historic downtown, strong community character, and some of the most sought-after family neighborhoods in the greater Austin metro.',
    landmark: 'Buda City Park and the historic Main Street district',
    nearby: ['Kyle', 'Austin', 'Cedar Park', 'Leander'],
    lat: '30.0852',
    lng: '-97.8397',
  },
  {
    name: 'Kyle',
    slug: 'kyle',
    zip: '78640',
    bio: 'Kyle is one of the fastest-growing cities in America, located south of Austin along I-35 and drawing families with its new master-planned communities, competitive home prices, and easy access to Austin\'s booming job market.',
    landmark: 'Plum Creek Trail System and Kyle\'s revitalized downtown district',
    nearby: ['Buda', 'Austin', 'Cedar Park', 'Leander'],
    lat: '29.9889',
    lng: '-97.8772',
  },
];

export const STATEWIDE_MARKETS = [
  {
    name: 'Houston', slug: 'houston', nearby: ['Pasadena', 'Pearland', 'Sugar Land', 'Baytown'],
    bookingGuidance: 'For Houston appointments, include gate or building access, parking instructions, stairs or elevator details, and whether boxed items are already in the assembly room. For larger home or office setups, list every item so the correct appointment can be assigned.',
  },
  {
    name: 'San Antonio', slug: 'san-antonio', nearby: ['New Braunfels', 'Austin', 'Temple', 'Killeen'],
    bookingGuidance: 'For San Antonio bookings, include gated-community access, parking details, stairs, and the room where each item is located. Outdoor projects should include the surface type and a clear photo of the assembly area.',
  },
  {
    name: 'Fort Worth', slug: 'fort-worth', nearby: ['Dallas', 'Arlington', 'Grand Prairie', 'Denton'],
    bookingGuidance: 'For Fort Worth appointments, share apartment or community access instructions, parking or loading details, stairs, and the final room location. Multi-item and office projects should include a complete item count.',
  },
  {
    name: 'El Paso', slug: 'el-paso', nearby: ['Horizon City', 'Socorro', 'San Elizario', 'Canutillo'],
    bookingGuidance: 'For El Paso appointments, include cross-street or gated-community directions, stairs, parking access, and where the boxes are located. For outdoor assembly, note the surface, shade availability, and any wind-sensitive scheduling concerns.',
  },
  {
    name: 'Arlington', slug: 'arlington', nearby: ['Dallas', 'Fort Worth', 'Grand Prairie', 'Irving'],
    bookingGuidance: 'For Arlington appointments, include apartment, campus, or gated-community access, parking instructions, stairs, and the room where each item will be assembled. List all items for move-in and multi-room setups.',
  },
  {
    name: 'Corpus Christi', slug: 'corpus-christi', nearby: ['Portland', 'Robstown', 'Kingsville', 'Rockport'],
    bookingGuidance: 'For Corpus Christi bookings, provide building access, stairs, parking, and the final item location. Outdoor projects should include the surface type, product dimensions, and any coastal wind or covered-work-area considerations.',
  },
  {
    name: 'Plano', slug: 'plano', nearby: ['Dallas', 'Richardson', 'Allen', 'Frisco'],
    bookingGuidance: 'For Plano appointments, include apartment or gated-community access, parking, stairs, and whether items are already in the correct room. Office and multi-item bookings should include quantities and model details when available.',
  },
  {
    name: 'Lubbock', slug: 'lubbock', nearby: ['Wolfforth', 'Levelland', 'Slaton', 'Plainview'],
    bookingGuidance: 'For Lubbock appointments, share parking and entry details, stairs, item location, and a complete product list. For outdoor work, include the surface type and any wind-sensitive scheduling or anchoring details from the manufacturer.',
  },
  {
    name: 'Laredo', slug: 'laredo', nearby: ['Rio Bravo', 'El Cenizo', 'Encinal', 'Hebbronville'],
    bookingGuidance: 'For Laredo bookings, include gate access, parking, stairs, the final assembly room, and clear item photos or model names. Outdoor appointments should identify the work surface and whether a covered area is available.',
  },
  {
    name: 'Irving', slug: 'irving', nearby: ['Dallas', 'Grand Prairie', 'Arlington', 'Richardson'],
    bookingGuidance: 'For Irving apartment, hotel, or office appointments, include loading or parking instructions, building access, elevator reservations, and suite or unit details. Multi-item projects should include exact quantities.',
  },
  {
    name: 'Garland', slug: 'garland', nearby: ['Dallas', 'Plano', 'Richardson', 'Mesquite'],
    bookingGuidance: 'For Garland appointments, include gate or unit access, parking, stairs, and where boxes are located. For several rooms or products, provide a full item list so the visit can be reviewed accurately.',
  },
  {
    name: 'Frisco', slug: 'frisco', nearby: ['Plano', 'McKinney', 'Allen', 'Dallas'],
    bookingGuidance: 'For Frisco bookings, include gated-community or apartment access, parking, stairs, and final room placement. New-home and multi-room setups should list every item and note whether packaging has been moved inside.',
  },
  {
    name: 'McKinney', slug: 'mckinney', nearby: ['Frisco', 'Allen', 'Plano', 'Denton'],
    bookingGuidance: 'For McKinney appointments, share community access, parking, stairs, item locations, and a complete product list. For new-construction addresses, include any mapping or entry instructions that may not appear in navigation yet.',
  },
  {
    name: 'Amarillo', slug: 'amarillo', nearby: ['Canyon', 'Bushland', 'Panhandle', 'Hereford'],
    bookingGuidance: 'For Amarillo bookings, provide parking and entry details, stairs, final item placement, and product dimensions for larger equipment. Outdoor work should include surface and wind-sensitive scheduling details.',
  },
  {
    name: 'Grand Prairie', slug: 'grand-prairie', nearby: ['Dallas', 'Arlington', 'Irving', 'Fort Worth'],
    bookingGuidance: 'For Grand Prairie appointments, include apartment or gated access, parking, stairs, and where each boxed item is located. Multi-item home setups should include quantities and room assignments.',
  },
  {
    name: 'Brownsville', slug: 'brownsville', nearby: ['Harlingen', 'San Benito', 'Edinburg', 'McAllen'],
    bookingGuidance: 'For Brownsville bookings, include gate access, parking, stairs, item location, and model information when available. Outdoor projects should note the surface, work-area access, and any weather-sensitive scheduling needs.',
  },
  {
    name: 'Killeen', slug: 'killeen', nearby: ['Temple', 'Belton', 'Copperas Cove', 'Waco'],
    bookingGuidance: 'For Killeen appointments, provide community or installation access instructions, parking, stairs, and the final room location. If access is controlled, confirm that the customer can meet the Easer at the scheduled time.',
  },
  {
    name: 'Pasadena', slug: 'pasadena', nearby: ['Houston', 'Baytown', 'Pearland', 'League City'],
    bookingGuidance: 'For Pasadena appointments, include parking, gate or unit access, stairs, and where all products are located. For garage, patio, or outdoor projects, provide the surface type and clear work-area photos.',
  },
  {
    name: 'Mesquite', slug: 'mesquite', nearby: ['Dallas', 'Garland', 'Grand Prairie', 'Plano'],
    bookingGuidance: 'For Mesquite bookings, include apartment or gated-community access, parking, stairs, and final room placement. A complete item list helps multi-room and move-in appointments get reviewed correctly.',
  },
  {
    name: 'McAllen', slug: 'mcallen', nearby: ['Edinburg', 'Mission', 'Pharr', 'Brownsville'],
    bookingGuidance: 'For McAllen appointments, share community access, parking, stairs, and item location. Outdoor projects should include surface and shade details, while multi-item setups should list quantities and room placement.',
  },
  {
    name: 'Waco', slug: 'waco', nearby: ['Temple', 'Killeen', 'Bryan', 'College Station'],
    bookingGuidance: 'For Waco appointments, include apartment, campus, or gated-community access, parking, stairs, and item locations. Student housing and multi-item move-ins should include a complete product list.',
  },
  {
    name: 'Midland', slug: 'midland', nearby: ['Odessa', 'Big Spring', 'Andrews', 'San Angelo'],
    bookingGuidance: 'For Midland bookings, provide gate or building access, parking, stairs, and final room placement. Large fitness, office, and outdoor products should include dimensions and clear access-path details.',
  },
  {
    name: 'Denton', slug: 'denton', nearby: ['Dallas', 'Fort Worth', 'Frisco', 'McKinney'],
    bookingGuidance: 'For Denton appointments, include apartment or campus access, parking, elevator or stair details, and the unit location. Student move-ins and multi-item bookings should list all products and room assignments.',
  },
  {
    name: 'Abilene', slug: 'abilene', nearby: ['Sweetwater', 'Clyde', 'Baird', 'San Angelo'],
    bookingGuidance: 'For Abilene appointments, share parking and entry instructions, stairs, item location, and model details for larger products. Outdoor projects should identify the surface and available work area.',
  },
  {
    name: 'Beaumont', slug: 'beaumont', nearby: ['Port Arthur', 'Orange', 'Nederland', 'Houston'],
    bookingGuidance: 'For Beaumont bookings, include parking, gate or unit access, stairs, and where boxes are stored. Outdoor projects should include surface, covered-area, and weather-sensitive scheduling details.',
  },
  {
    name: 'Odessa', slug: 'odessa', nearby: ['Midland', 'Andrews', 'Monahans', 'Big Spring'],
    bookingGuidance: 'For Odessa appointments, provide access and parking instructions, stairs, final room location, and dimensions for larger items. For outdoor work, include surface and wind-sensitive scheduling details.',
  },
  {
    name: 'Richardson', slug: 'richardson', nearby: ['Dallas', 'Plano', 'Garland', 'Irving'],
    bookingGuidance: 'For Richardson home, apartment, or office appointments, include parking or loading details, building access, elevator reservations, and suite or unit information. List exact quantities for workplace setups.',
  },
  {
    name: 'Pearland', slug: 'pearland', nearby: ['Houston', 'Pasadena', 'League City', 'Sugar Land'],
    bookingGuidance: 'For Pearland bookings, include gated-community access, parking, stairs, and where items are located. New-home and multi-room setups should provide a complete item list and final room placement.',
  },
  {
    name: 'College Station', slug: 'college-station', nearby: ['Bryan', 'Waco', 'Temple', 'Houston'],
    bookingGuidance: 'For College Station appointments, include campus, apartment, or gated access, parking instructions, stairs, and unit details. Student move-ins should list every product and confirm that boxes are inside before arrival.',
  },
  {
    name: 'Tyler', slug: 'tyler', nearby: ['Longview', 'Lindale', 'Jacksonville', 'Dallas'],
    bookingGuidance: 'For Tyler appointments, include gate or building access, parking, stairs, and final room placement. For outdoor and multi-item projects, provide the surface type, quantities, and clear work-area photos.',
  },
  {
    name: 'Sugar Land', slug: 'sugar-land', nearby: ['Houston', 'Pearland', 'The Woodlands', 'Pasadena'],
    bookingGuidance: 'For Sugar Land bookings, include gated-community access, parking, stairs, and where each item is located. Multi-room and new-home setups should list all products and final room assignments.',
  },
  {
    name: 'League City', slug: 'league-city', nearby: ['Houston', 'Pasadena', 'Pearland', 'Baytown'],
    bookingGuidance: 'For League City appointments, provide community access, parking, stairs, item location, and product dimensions. Outdoor projects should include surface and weather-sensitive scheduling information. For multi-item home or office setups, include exact quantities and final room placement.',
  },
  {
    name: 'Allen', slug: 'allen', nearby: ['Plano', 'McKinney', 'Frisco', 'Dallas'],
    bookingGuidance: 'For Allen bookings, include gated or apartment access, parking, stairs, and final room placement. New-home and multi-item appointments should include a full item list and any entry instructions.',
  },
  {
    name: 'Edinburg', slug: 'edinburg', nearby: ['McAllen', 'Mission', 'Pharr', 'Brownsville'],
    bookingGuidance: 'For Edinburg appointments, share apartment, campus, or community access, parking, stairs, and item location. Outdoor bookings should include surface and covered-work-area details. Multi-item move-ins should list every product, package count, and final room assignment.',
  },
  {
    name: 'Conroe', slug: 'conroe', nearby: ['The Woodlands', 'Houston', 'College Station', 'Huntsville'],
    bookingGuidance: 'For Conroe bookings, include gate or community access, parking, stairs, and where items are located. Larger outdoor and move-in projects should include product dimensions, quantities, and site photos.',
  },
  {
    name: 'San Angelo', slug: 'san-angelo', nearby: ['Abilene', 'Midland', 'Odessa', 'Sweetwater'],
    bookingGuidance: 'For San Angelo appointments, provide parking and entry details, stairs, item location, and product dimensions for larger equipment. Outdoor work should include the surface and wind-sensitive scheduling details.',
  },
  {
    name: 'New Braunfels', slug: 'new-braunfels', nearby: ['San Antonio', 'Austin', 'Buda', 'Kyle'],
    bookingGuidance: 'For New Braunfels bookings, include gated-community or apartment access, parking, stairs, and final room placement. Outdoor projects should identify the surface, product footprint, and clear access path.',
  },
  {
    name: 'Temple', slug: 'temple', nearby: ['Killeen', 'Waco', 'Bryan', 'College Station'],
    bookingGuidance: 'For Temple appointments, share parking, building or community access, stairs, and where each item is located. Multi-item home and office setups should include exact quantities.',
  },
  {
    name: 'Bryan', slug: 'bryan', nearby: ['College Station', 'Waco', 'Temple', 'Houston'],
    bookingGuidance: 'For Bryan bookings, include apartment, campus, or community access, parking, stairs, and unit details. Multi-item move-ins should list every product and final room placement. Add model numbers and package locations when available so the full project scope can be reviewed.',
  },
  {
    name: 'Baytown', slug: 'baytown', nearby: ['Houston', 'Pasadena', 'League City', 'Beaumont'],
    bookingGuidance: 'For Baytown appointments, provide gate or building access, parking, stairs, and item locations. Outdoor bookings should include surface, covered-area, and weather-sensitive scheduling details. For larger or multi-item projects, list every product, package location, and final setup area.',
  },
  {
    name: 'The Woodlands', slug: 'the-woodlands', nearby: ['Houston', 'Conroe', 'Sugar Land', 'College Station'],
    bookingGuidance: 'For The Woodlands bookings, include community or building access, parking, stairs, and final room placement. New-home, office, and multi-room setups should include a complete product list.',
  },
];

export const ALL_TEXAS_CITIES = [...CITIES, ...STATEWIDE_MARKETS];
