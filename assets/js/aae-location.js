/* AssembleAtEase — location-aware brand layer.
 *
 * Makes visible brand copy adapt to the visitor's city WITHOUT ever promising a
 * city we don't actually serve. SEO tags (title/meta/JSON-LD) and city pages stay
 * Austin; this only personalizes brand-level copy.
 *
 * Default (unknown visitor): copy is city-neutral, so the brand looks expandable.
 * Known visitor: copy reads "... in {City}".
 *
 * City is resolved from, in order:
 *   1) ?city=<name>  (only honored if it's a served city)  — great for ad links
 *   2) ?zip=<zip>    (mapped to a served metro)
 *   3) localStorage 'aae_city' (set on a prior visit or by the booking flow)
 *
 * Markup hooks:
 *   <span data-loc-in></span>        -> " in Austin"  (or "" when unknown)
 *   <span data-loc-city data-loc-default="your area"></span> -> "Austin" / default
 *
 * To turn on a new metro later: add it to SERVED (+ its ZIP prefixes in zipCity),
 * ship that metro's city pages + service ZIPs, and the brand layer adapts itself.
 */
(function () {
  // Served cities only. Keys are lowercase for matching; values are display form.
  var SERVED = {
    'austin': 'Austin',
    'round rock': 'Round Rock', 'cedar park': 'Cedar Park', 'georgetown': 'Georgetown',
    'pflugerville': 'Pflugerville', 'kyle': 'Kyle', 'buda': 'Buda', 'lakeway': 'Lakeway',
    'bee cave': 'Bee Cave', 'manor': 'Manor', 'leander': 'Leander', 'hutto': 'Hutto'
  };

  // ZIP prefix -> served display city (matches the backend service area: 786/787/788).
  function zipCity(zip) {
    var p = String(zip || '').replace(/\D/g, '').slice(0, 3);
    if (p === '787' || p === '786' || p === '788') return 'Austin';
    return null;
  }

  function norm(s) { return String(s || '').trim().toLowerCase().replace(/\s+/g, ' '); }

  function store(city) { try { localStorage.setItem('aae_city', city); } catch (e) {} }

  function resolve() {
    try {
      var qs = new URLSearchParams(window.location.search);
      var q = norm(qs.get('city'));
      if (q && SERVED[q]) { store(SERVED[q]); return SERVED[q]; }
      var z = zipCity(qs.get('zip'));
      if (z) { store(z); return z; }
      var saved = localStorage.getItem('aae_city');
      if (saved) return saved;
    } catch (e) {}
    return null;
  }

  function apply(city) {
    var inEls = document.querySelectorAll('[data-loc-in]');
    for (var i = 0; i < inEls.length; i++) inEls[i].textContent = city ? (' in ' + city) : '';
    var cityEls = document.querySelectorAll('[data-loc-city]');
    for (var j = 0; j < cityEls.length; j++) {
      cityEls[j].textContent = city || (cityEls[j].getAttribute('data-loc-default') || '');
    }
    document.documentElement.setAttribute('data-loc-known', city ? '1' : '0');
  }

  var city = resolve();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { apply(city); });
  } else {
    apply(city);
  }

  // Booking flow can call this once a serviceable ZIP/city is confirmed.
  window.AAELocation = {
    set: function (zipOrCity) {
      var c = /^\s*\d/.test(String(zipOrCity)) ? zipCity(zipOrCity) : (SERVED[norm(zipOrCity)] || null);
      if (c) { store(c); apply(c); }
      return c;
    },
    get: function () { try { return localStorage.getItem('aae_city'); } catch (e) { return null; } }
  };
})();
