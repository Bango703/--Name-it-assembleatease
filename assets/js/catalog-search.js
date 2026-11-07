// Searching the booking catalog: one rule and one word list (owner, 2026-11-06).
//
// "mount tv", "couch" and "ikea dresser" found nothing, and "art" found 42 items
// because it matched inside "smart". Search was a plain run of letters in the
// app and on the website alike.
//
// Who reads this file:
//   book.html                 the item search on the booking page
//   api/_catalog-search.js    loads it on the server; api/booking/catalog.js
//                             ships each item's words and the stop words to the app
//   mobile/ios/Customer       matches the shipped words (CustomerHome.swift)
// scripts/test-catalog-search.mjs holds all three to this rule.
//
// The rule: every word typed (apart from filler such as "install" or "my")
// must be the start of a word the item answers to. An item answers to the words
// of its service, group and name, in singular and plural, plus the extra words
// below. Plain ES5 so it runs in every browser and in the server's sandbox.
(function (root) {
  'use strict';

  // Filler that says nothing about which item. Dropped from what is typed,
  // unless nothing else is left.
  var STOP_WORDS = [
    'a', 'an', 'and', 'the', 'my', 'our', 'to', 'for', 'of', 'in', 'on', 'at', 'with', 'from', 'by',
    'i', 'me', 'we', 'need', 'needs', 'want', 'get', 'help', 'please', 'someone', 'new', 'some',
    'install', 'installs', 'installed', 'installing', 'installation', 'installer',
    'assemble', 'assembled', 'assembling', 'assembly', 'put', 'together', 'build', 'setup', 'set', 'up',
    'inch', 'inches',
    // Where it was bought: "ikea dresser" means a dresser. "ikea" alone still
    // finds the IKEA items, because a query of only these words keeps them.
    'ikea', 'wayfair', 'amazon', 'target', 'costco', 'walmart'
  ];

  // Words customers use that the catalog does not. Each entry: a word that
  // appears in the item's own service, group or name (exact, after singular
  // and plural are matched), then the extra words that item answers to.
  var EXTRA_WORDS = [
    [['sofa', 'sectional'], ['couch', 'loveseat', 'settee', 'futon']],
    [['armchair', 'accent'], ['recliner', 'chair']],
    [['ottoman'], ['footstool', 'pouf']],
    [['bed'], ['headboard', 'bedframe']],
    [['crib', 'toddler'], ['baby', 'nursery', 'cot']],
    [['bunk', 'loft', 'trundle'], ['kids']],
    [['dresser'], ['chest', 'drawers', 'malm', 'hemnes', 'bureau']],
    [['nightstand'], ['bedside', 'night']],
    [['wardrobe', 'armoire', 'pax'], ['closet']],
    [['vanity'], ['makeup']],
    [['bookcase', 'shelving'], ['bookshelf', 'shelf', 'billy', 'kallax', 'hemnes']],
    [['cube', 'toy'], ['kallax', 'cubby']],
    [['desk'], ['table', 'workstation', 'computer']],
    [['standing'], ['uplift', 'flexispot', 'sit']],
    [['chair'], ['seat']],
    [['file'], ['filing']],
    [['dining'], ['kitchen']],
    [['stool'], ['counter']],
    [['island'], ['kitchen']],
    [['hutch', 'china', 'buffet', 'sideboard', 'credenza'], ['cabinet']],
    [['media', 'console', 'entertainment'], ['tv', 'stand']],
    [['closet'], ['elfa', 'organizer']],
    [['disposal', 'haul'], ['removal', 'junk', 'trash']],
    [['tv'], ['television', 'flatscreen', 'mount', 'hang', 'wall']],
    [['fireplace'], ['mantel', 'mantle']],
    [['cord', 'cable', 'raceway', 'concealment'], ['wires', 'hide', 'conceal']],
    [['soundbar'], ['sound', 'bar', 'speaker']],
    [['shelf', 'floating'], ['ledge']],
    [['picture', 'gallery', 'artwork', 'mirror'], ['art', 'picture', 'painting', 'frame', 'photo', 'hang', 'wall']],
    [['curtain'], ['drapes', 'drapery', 'rod']],
    [['blind', 'shade'], ['window', 'shades', 'blinds']],
    [['projector'], ['screen']],
    [['whiteboard', 'bulletin'], ['board']],
    [['hooks', 'coat'], ['hook', 'hanger']],
    [['gate'], ['childproof', 'baby']],
    [['mailbox'], ['address']],
    [['thermostat'], ['nest', 'ecobee', 'honeywell', 'temperature']],
    [['doorbell'], ['ring', 'nest', 'video', 'door', 'bell']],
    [['lock', 'deadbolt', 'keypad'], ['august', 'yale', 'schlage', 'door', 'keyless']],
    [['garage'], ['myq', 'opener']],
    [['camera', 'floodlight', 'nvr', 'dvr'], ['security', 'cctv', 'ring', 'arlo', 'blink', 'wyze', 'cam', 'surveillance']],
    [['smoke'], ['carbon', 'monoxide', 'alarm', 'detector']],
    [['bulb', 'lighting', 'led'], ['light', 'lights', 'hue', 'lamp']],
    [['switch', 'dimmer'], ['light', 'lutron']],
    [['plug'], ['outlet']],
    [['router', 'mesh', 'extender', 'wi'], ['wifi', 'internet', 'eero', 'orbi', 'network']],
    [['hub', 'alexa', 'google'], ['echo', 'homepod', 'nest', 'speaker', 'assistant']],
    [['streaming'], ['roku', 'firestick', 'fire', 'chromecast']],
    [['sprinkler'], ['rachio', 'irrigation']],
    [['swing', 'playset', 'monkey', 'climbing', 'playhouse', 'sandbox'], ['playground', 'jungle', 'gym', 'kids', 'backyard']],
    [['trampoline'], ['kids', 'backyard']],
    [['pergola', 'gazebo'], ['dome', 'canopy', 'pavilion', 'shade']],
    [['shed'], ['storage', 'outbuilding']],
    [['basketball'], ['hoop', 'goal']],
    [['pickleball', 'soccer'], ['net', 'goal', 'sports']],
    [['grill'], ['bbq', 'barbecue', 'smoker', 'weber', 'traeger', 'blackstone']],
    [['patio', 'adirondack', 'umbrella', 'lounge'], ['outdoor', 'deck', 'porch', 'yard']],
    [['treadmill'], ['running', 'walking', 'pad']],
    [['bike'], ['peloton', 'spin', 'cycle', 'stationary']],
    [['rowing'], ['rower', 'concept2', 'hydrow']],
    [['bench', 'rack', 'squat', 'dumbbell'], ['weights', 'barbell', 'cage']],
    [['gym', 'cable'], ['bowflex', 'machine']],
    [['monitor'], ['screen', 'arm']],
    [['cubicle', 'partition', 'divider'], ['office', 'panel']]
  ];

  // One word to its singular: "shelves" to "shelf", "curtains" to "curtain".
  function singular(word) {
    if (word.length > 4 && /ies$/.test(word)) return word.slice(0, -3) + 'y';
    if (word.length > 4 && /ves$/.test(word)) return word.slice(0, -3) + 'f';
    if (word.length > 4 && /(ches|shes|xes|zes|sses)$/.test(word)) return word.slice(0, -2);
    if (word.length > 3 && /s$/.test(word) && !/(ss|us|is)$/.test(word)) return word.slice(0, -1);
    return word;
  }

  // A singular word to its plural, so a customer who types either finds it.
  function plural(word) {
    if (/[^aeiou]y$/.test(word)) return word.slice(0, -1) + 'ies';
    if (/(s|x|z|ch|sh)$/.test(word)) return word + 'es';
    if (/f$/.test(word)) return word.slice(0, -1) + 'ves';
    return word + 's';
  }

  // Lower case, apostrophes dropped, split on anything that is not a letter or digit.
  function words(text) {
    return String(text || '').toLowerCase().replace(/['’]/g, '').split(/[^a-z0-9]+/).filter(Boolean);
  }

  function addForms(out, word) {
    if (/^[0-9]/.test(word)) { if (out.indexOf(word) === -1) out.push(word); return; }
    var one = singular(word);
    [word, one, plural(one)].forEach(function (form) { if (out.indexOf(form) === -1) out.push(form); });
  }

  // Every word one catalog item answers to: its own words (service, group,
  // name), then " | ", then the extra words its NAME earns. Keyed off the name
  // alone, so "Seating & Sofas" does not make an armchair answer to "couch".
  function searchText(service, group, name) {
    var own = [];
    words([service, group, name].join(' ')).forEach(function (word) { addForms(own, word); });
    var nameSingular = words(name).map(singular);
    var extra = [];
    EXTRA_WORDS.forEach(function (entry) {
      var hit = entry[0].some(function (key) { return nameSingular.indexOf(singular(key)) !== -1; });
      if (hit) entry[1].forEach(function (word) { if (own.indexOf(word) === -1) addForms(extra, word); });
    });
    return extra.length ? own.join(' ') + ' | ' + extra.join(' ') : own.join(' ');
  }

  // The words that matter in what the customer typed.
  function queryWords(query) {
    var all = words(query);
    var kept = all.filter(function (word) { return STOP_WORDS.indexOf(word) === -1; });
    return kept.length ? kept : all;
  }

  function startsAWord(list, word) {
    return list.some(function (candidate) { return candidate.indexOf(word) === 0; });
  }

  // How well an item answers what was typed: 0 by its own words, 1 only with
  // the extra words, -1 not at all. Results list 0 before 1, catalog order within.
  function rank(query, text) {
    var wanted = queryWords(query);
    if (!wanted.length) return 0;
    var parts = String(text || '').split(' | ');
    var own = parts[0].split(' ');
    var all = own.concat(parts[1] ? parts[1].split(' ') : []);
    if (wanted.every(function (word) { return startsAWord(own, word); })) return 0;
    if (wanted.every(function (word) { return startsAWord(all, word); })) return 1;
    return -1;
  }

  function matches(query, text) { return rank(query, text) !== -1; }

  root.AAE_CATALOG_SEARCH = {
    STOP_WORDS: STOP_WORDS,
    EXTRA_WORDS: EXTRA_WORDS,
    searchText: searchText,
    queryWords: queryWords,
    rank: rank,
    matches: matches,
    singular: singular,
    plural: plural
  };
})(typeof window !== 'undefined' ? window : this);
