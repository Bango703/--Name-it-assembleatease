/**
 * Remember the page someone arrived on, so a later form can report it.
 *
 * FIRST PAGE WINS. Someone finds easer-jobs-san-antonio-tx in search, reads
 * it, clicks through to /assembler/apply, and submits. If capture ran on the
 * apply page it would record /assembler/apply for everyone, which is the same
 * as recording nothing. So the first page of the visit writes to
 * sessionStorage and every later page leaves it alone.
 *
 * This is why the script belongs on the RECRUITMENT pages, not only on the
 * form. A city page without it is invisible in the results.
 *
 * Mirrors captureBookingAttribution in book.html, and the payload is
 * sanitised server-side by api/_attribution.js — the same function that
 * handles bookings, so the two funnels stay comparable.
 */
(function (global) {
  'use strict';

  var STORAGE_KEY = 'aaeAcquisitionAttribution';

  function capture(fallbackPath) {
    // sessionStorage throws in some privacy modes. Attribution is analytics,
    // never a reason to break a form, so every path here degrades to a value.
    try {
      var existing = global.sessionStorage.getItem(STORAGE_KEY);
      if (existing) return JSON.parse(existing);
    } catch (e) { /* fall through and capture without persisting */ }

    var value;
    try {
      var params = new URLSearchParams(global.location.search || '');
      var referrerHost = '';
      try {
        // Only the host. The full referrer URL can carry a search query or a
        // path that identifies a person, and none of that is needed to know
        // which channel worked.
        referrerHost = global.document.referrer ? new URL(global.document.referrer).hostname : '';
      } catch (e) { referrerHost = ''; }
      // Our own pages are not a referral source; that is just internal
      // navigation and would drown out the channel that actually brought them.
      if (referrerHost && global.location && referrerHost === global.location.hostname) referrerHost = '';
      value = {
        utmSource: params.get('utm_source') || '',
        utmMedium: params.get('utm_medium') || '',
        utmCampaign: params.get('utm_campaign') || '',
        utmContent: params.get('utm_content') || '',
        utmTerm: params.get('utm_term') || '',
        clickId: params.get('gclid') || params.get('msclkid') || '',
        landingPath: (global.location && global.location.pathname) || fallbackPath || '/',
        referrerHost: referrerHost,
      };
    } catch (e) {
      value = { landingPath: fallbackPath || '/' };
    }

    try { global.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(value)); } catch (e) { /* not persisted */ }
    return value;
  }

  global.AAE_ATTRIBUTION = { capture: capture, STORAGE_KEY: STORAGE_KEY };
  // Run on load so the landing page is recorded even if the visitor never
  // reaches a form on this page.
  capture();
})(typeof window !== 'undefined' ? window : globalThis);
