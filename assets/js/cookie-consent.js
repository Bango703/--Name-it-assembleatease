(function () {
  var GA_MEASUREMENT_ID = 'G-ZN45GP8D25';
  var ADS_MEASUREMENT_ID = 'AW-16551666395';
  var CONSENT_KEY = 'cookie-consent';
  var BANNER_ID = 'cookie-banner';
  var STYLE_ID = 'aae-cookie-consent-style';
  var GTAG_SCRIPT_ID = 'aae-gtag-script';
  var HUBSPOT_SCRIPT_ID = 'hs-script-loader';
  var PHONE_CLICK_EVENT = 'phone_call_click';
  var PHONE_CALL_CONVERSION = 'AW-16551666395/NyDNCOCKq-8cENvFudQ9';
  // Kept in sync with page-governance/site-governance.json by the Ads tests.
  var BUSINESS_PHONE = '+19792325139';
  var BUSINESS_PHONE_DISPLAY = '(979) 232-5139';
  var measurementLoaded = false;
  var phoneTrackingActive = false;
  var phoneTrackingGeneration = 0;
  var phoneReplacements = [];
  var trackedEvents = Object.create(null);
  var measurementConfigured = false;
  var measurementTagLoaded = false;
  var consentChoice = null;
  var attributionLoadAttempted = false;
  try { consentChoice = localStorage.getItem(CONSENT_KEY); } catch (e) {}

  function analyticsAllowed() {
    return consentChoice === 'accepted' && !globalPrivacyControlEnabled() && !measurementExcluded();
  }

  function audienceType() {
    var path = window.location.pathname || '';
    if (/^\/owner(?:\/|$|\.html)/.test(path)) return 'internal';
    if (/^\/(?:assembler|easer-jobs-|become-an-easer)/.test(path)) return 'easer';
    if (/^\/(?:track|review)(?:\/|$|\.html)/.test(path)) return 'customer_support';
    return 'customer';
  }
  function measurementExcluded() {
    if (!/^(?:www\.)?assembleatease\.com$/.test(window.location.hostname || '')) return true;
    if (/^\/(?:owner|auth)(?:\/|$|\.html)/.test(window.location.pathname || '')) return true;
    if (/^\/assembler(?:\/|$)/.test(window.location.pathname || '') && !/^\/assembler\/apply(?:\.html)?\/?$/.test(window.location.pathname || '')) return true;
    try { return localStorage.getItem('aae-analytics-internal') === '1'; } catch (e) { return false; }
  }
  function safePagePath() {
    try {
      var canonical = document.querySelector('link[rel="canonical"]');
      var url = new URL(canonical && canonical.href || '');
      return /^(?:www\.)?assembleatease\.com$/.test(url.hostname)
        && /^\/(?:[a-z0-9-]+\/)*[a-z0-9-]*\/?$/.test(url.pathname) ? url.pathname : '/unknown';
    } catch (e) { return '/unknown'; }
  }
  function safeReferrer() {
    try { return document.referrer ? new URL(document.referrer).origin + '/' : ''; } catch (e) { return ''; }
  }

  window.AAEAnalytics = {
    isExcluded: measurementExcluded,
    hasConsent: analyticsAllowed,
    setInternalTraffic: function (excluded) {
      try { if (excluded) localStorage.setItem('aae-analytics-internal', '1'); else localStorage.removeItem('aae-analytics-internal'); } catch (e) {}
      window['ga-disable-' + GA_MEASUREMENT_ID] = !analyticsAllowed();
    },
    trackOnce: function (eventName, params, key) {
      if (!analyticsAllowed() || !measurementConfigured) return false;
      var storageKey = 'aaeAnalytics:v2:' + String(key || eventName);
      if (trackedEvents[storageKey]) return false;
      try { if (sessionStorage.getItem(storageKey)) return false; } catch (e) {}
      var safe = { page_path: safePagePath(), audience_type: audienceType(), measurement_version: '2' };
      // Do not forward addresses, emails, contact data, booking-link tokens or arbitrary parameters.
      ['booking_type', 'booking_flow', 'outcome_stage', 'service_market', 'service_city'].forEach(function (name) {
        var value = String(params && params[name] || '');
        if (/^[a-zA-Z][a-zA-Z_ -]{0,59}$/.test(value)) safe[name] = value;
      });
      ['service_count', 'days_ahead'].forEach(function (name) {
        var value = params && params[name];
        if (Number.isFinite(value) && value >= 0 && value <= 100) safe[name] = value;
      });
      if (params && params.deprecated_event === true) safe.deprecated_event = true;
      // A checkout preview is not captured revenue. Outcome events carry no monetary value.
      if (eventName === 'begin_checkout' && params && Number.isFinite(params.value) && params.value >= 0) {
        safe.value = params.value; safe.currency = 'USD';
      }
      window.gtag('event', eventName, safe);
      trackedEvents[storageKey] = true;
      try { sessionStorage.setItem(storageKey, '1'); } catch (e) {}
      return true;
    }
  };

  window.dataLayer = window.dataLayer || [];
  var existingGtag = window.gtag;
  window.gtag = function gtag() {
    if (arguments[0] !== 'consent' && !analyticsAllowed()) return;
    if (existingGtag) return existingGtag.apply(window, arguments);
    window.dataLayer.push(arguments);
  };
  window['ga-disable-' + GA_MEASUREMENT_ID] = !analyticsAllowed();
  window.gtag('consent', 'default', {
    analytics_storage: 'denied',
    ad_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
    wait_for_update: 500
  });

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent =
      '#cookie-banner{position:fixed;bottom:0;left:0;right:0;background:#0d1117;color:#fff;padding:1rem 2rem;z-index:9999;display:flex;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap;font-size:0.85rem;box-shadow:0 -4px 20px rgba(0,0,0,0.2)}' +
      '#cookie-banner a{color:#00BFFF;text-decoration:underline}' +
      '#cookie-banner.hidden{display:none}' +
      '.cookie-btns{display:flex;gap:0.75rem;flex-shrink:0}' +
      '.cookie-btn{padding:0.5rem 1.25rem;border-radius:999px;font-size:0.8rem;font-weight:600;cursor:pointer;border:none}' +
      '.cookie-accept{background:#00BFFF;color:#fff}' +
      '.cookie-decline{background:transparent;color:#fff;border:1.5px solid rgba(255,255,255,0.3)}' +
      '@media(max-width:680px){#cookie-banner{left:0.75rem;right:0.75rem;bottom:0.75rem;border-radius:14px;padding:0.85rem;display:block;font-size:0.78rem;line-height:1.45}.cookie-btns{display:flex;gap:0.5rem;margin-top:0.75rem}.cookie-btn{flex:1;min-height:44px;padding:0.55rem 0.8rem}}';
    document.head.appendChild(style);
  }

  function getBanner() {
    return document.getElementById(BANNER_ID);
  }

  function updateBannerCopy() {
    var banner = getBanner();
    var copy = banner && banner.querySelector('span');
    if (copy) copy.innerHTML = 'Optional analytics, advertising measurement, and CRM cookies help us improve booking. You can accept or decline them. See our <a href="/privacy">Privacy Notice</a>.';
  }

  // The bar is position:fixed, so whatever sits at the bottom of the page stays
  // underneath it until someone answers. On mobile it is a ~130px floating card
  // and it was covering a service card on the homepage and a service row on
  // /book. Reserving the same height at the end of the document keeps every
  // page fully reachable while the choice is still open.
  function reserveSpaceForBanner() {
    if (!document.body) return;
    var banner = getBanner();
    if (!banner || banner.classList.contains('hidden')) {
      document.body.style.removeProperty('padding-bottom');
      return;
    }
    var height = banner.getBoundingClientRect().height;
    if (!height) return;
    document.body.style.setProperty('padding-bottom', Math.ceil(height + 16) + 'px');
  }

  function hideBanner() {
    var banner = getBanner();
    if (banner) banner.classList.add('hidden');
    reserveSpaceForBanner();
  }

  function showBanner() {
    var banner = getBanner();
    if (!banner) return;
    banner.classList.remove('hidden');
    // Measure after the browser has laid the bar out, not before.
    if (window.requestAnimationFrame) window.requestAnimationFrame(reserveSpaceForBanner);
    else reserveSpaceForBanner();
    if (!showBanner.resizeBound) {
      showBanner.resizeBound = true;
      window.addEventListener('resize', reserveSpaceForBanner);
    }
  }

  function initGtag() {
    if (!analyticsAllowed()) return;
    if (window.__AAE_GTAG_READY__) return;
    window.__AAE_GTAG_READY__ = true;
    window.dataLayer = window.dataLayer || [];
    if (!window.gtag) {
      window.gtag = function gtag() {
        window.dataLayer.push(arguments);
      };
    }
    window.gtag('js', new Date());
    var measurementContext = { page_location: 'https://www.assembleatease.com' + safePagePath(), page_referrer: safeReferrer(), audience_type: audienceType() };
    // Keep deliberate campaign tags while replacing the raw URL, which may
    // contain booking tokens or personal data. These are GA4 config fields:
    // https://developers.google.com/analytics/devguides/collection/ga4/reference/config
    try {
      var acquisition = window.AAE_ATTRIBUTION && window.AAE_ATTRIBUTION.capture();
      [['utmSource', 'campaign_source'], ['utmMedium', 'campaign_medium'], ['utmCampaign', 'campaign_name'], ['utmContent', 'campaign_content']].forEach(function (fields) {
        if (acquisition && acquisition.utmSource && acquisition[fields[0]]) measurementContext[fields[1]] = acquisition[fields[0]];
      });
    } catch (e) { /* Campaign measurement cannot block page use. */ }
    window.gtag('set', measurementContext);
    window.gtag('config', GA_MEASUREMENT_ID);
    window.gtag('config', ADS_MEASUREMENT_ID);
    measurementConfigured = true;
    window.dispatchEvent(new Event('aae-analytics-ready'));
  }

  function loadHubspot() {
    if (!analyticsAllowed()) return;
    if (document.getElementById(HUBSPOT_SCRIPT_ID)) return;
    var script = document.createElement('script');
    script.id = HUBSPOT_SCRIPT_ID;
    script.async = true;
    script.defer = true;
    script.src = 'https://js-na2.hs-scripts.com/245917212.js';
    document.head.appendChild(script);
  }

  function loadMeasurement() {
    if (!analyticsAllowed()) return;
    if (measurementLoaded) { initGtag(); return; }
    measurementLoaded = true;
    if (!document.getElementById(GTAG_SCRIPT_ID)) {
      var script = document.createElement('script');
      script.id = GTAG_SCRIPT_ID;
      script.async = true;
      script.src = 'https://www.googletagmanager.com/gtag/js?id=' + ADS_MEASUREMENT_ID;
      script.onload = function () { measurementTagLoaded = true; initGtag(); };
      document.head.appendChild(script);
    }

    initGtag();
  }

  function grantAnalytics() {
    if (!analyticsAllowed()) return;
    // Applications/recruitment include this canonical module directly. Other
    // public pages obtain it here before optional tags need campaign context.
    if (!window.AAE_ATTRIBUTION && !attributionLoadAttempted) {
      attributionLoadAttempted = true;
      var attributionScript = document.createElement('script');
      attributionScript.src = '/assets/js/attribution.js';
      attributionScript.onload = grantAnalytics;
      attributionScript.onerror = grantAnalytics;
      document.head.appendChild(attributionScript);
      return;
    }
    window['ga-disable-' + GA_MEASUREMENT_ID] = false;
    window._hsq = window._hsq || [];
    window._hsq.push(['doNotTrack', { track: true }]);
    window.gtag('set', 'url_passthrough', true);
    window.gtag('set', 'ads_data_redaction', true);
    // ad_user_data must be granted for Google Ads to RECORD a conversion. It was
    // denied here even after the visitor pressed Accept, so Ads set the cookie and
    // was then forbidden from using it to measure. Every campaign read 0
    // conversions, the primary "Book appointment" action showed "Needs attention",
    // and Smart Bidding sat in Learning with no signal to learn from - while the
    // account kept spending.
    //
    // This only ever runs after an explicit Accept. Nothing changes for a visitor
    // who ignores or declines the banner - the defaults above stay denied.
    // ad_personalization stays denied on purpose: measurement does not require it,
    // and this business does not run remarketing.
    window.gtag('consent', 'update', {
      analytics_storage: 'granted',
      ad_storage: 'granted',
      ad_user_data: 'granted',
      ad_personalization: 'denied'
    });
    loadMeasurement();
    enableWebsiteCallTracking();
    loadHubspot();
  }

  function setConsent(value) {
    consentChoice = value;
    try {
      localStorage.setItem(CONSENT_KEY, value);
    } catch (error) {}
  }

  function acceptCookies() {
    if (globalPrivacyControlEnabled()) {
      declineCookies();
      return;
    }
    setConsent('accepted');
    hideBanner();
    grantAnalytics();
    window.dispatchEvent(new Event('aae-analytics-consent-changed'));
  }

  function declineCookies() {
    phoneTrackingActive = false;
    phoneTrackingGeneration += 1;
    restoreBusinessPhone();
    setConsent('declined');
    window['ga-disable-' + GA_MEASUREMENT_ID] = true;
    // A tag still downloading must never replay accepted-session events after
    // withdrawal. Already-sent events cannot be recalled; future calls are gated.
    if (!measurementTagLoaded) {
      window.dataLayer.length = 0;
      measurementConfigured = false;
      window.__AAE_GTAG_READY__ = false;
    }
    if (window.AAE_ATTRIBUTION) window.AAE_ATTRIBUTION.clear();
    try { sessionStorage.removeItem('aaeAcquisitionAttribution'); sessionStorage.removeItem('aaeBookingAttribution'); } catch (e) {}
    window.gtag('consent', 'update', {
      analytics_storage: 'denied',
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied'
    });
    window._hsq = window._hsq || [];
    window._hsq.push(['doNotTrack']);
    window.dispatchEvent(new Event('aae-analytics-consent-changed'));
    hideBanner();
  }

  function globalPrivacyControlEnabled() {
    return navigator.globalPrivacyControl === true;
  }

  function openCookiePreferences() {
    injectStyles();
    updateBannerCopy();
    bindBannerActions();
    showBanner();
  }

  function bindBannerActions() {
    document.querySelectorAll('[data-cookie-accept]').forEach(function (button) {
      if (button.dataset.cookieConsentBound === 'true') return;
      button.dataset.cookieConsentBound = 'true';
      button.addEventListener('click', acceptCookies);
    });
    document.querySelectorAll('[data-cookie-decline]').forEach(function (button) {
      if (button.dataset.cookieConsentBound === 'true') return;
      button.dataset.cookieConsentBound = 'true';
      button.addEventListener('click', declineCookies);
    });
  }

  function normalizedPhone(value) {
    var digits = String(value || '').replace(/\D/g, '');
    return '+' + (digits.length === 10 ? '1' + digits : digits);
  }

  function restoreBusinessPhone() {
    phoneReplacements.forEach(function (change) {
      if (change.attribute) {
        if (change.node.getAttribute(change.attribute) === change.replacement) {
          change.node.setAttribute(change.attribute, change.original);
        }
      } else if (change.node.nodeValue === change.replacement) {
        change.node.nodeValue = change.original;
      }
    });
    phoneReplacements = [];
  }

  function replaceBusinessPhone(formattedNumber, mobileNumber) {
    // Only accept a valid North American forwarding number from Google's callback.
    if (!phoneTrackingActive || globalPrivacyControlEnabled() ||
        typeof mobileNumber !== 'string' || !/^\+1\d{10}$/.test(mobileNumber) ||
        typeof formattedNumber !== 'string' || !/^[+()\d .-]+$/.test(formattedNumber) ||
        normalizedPhone(formattedNumber) !== mobileNumber) return;

    restoreBusinessPhone();
    document.querySelectorAll('a[href^="tel:"]').forEach(function (link) {
      if (normalizedPhone(link.getAttribute('href').slice(4)) !== BUSINESS_PHONE) return;
      var replaceText = function (value) {
        return value.replace(/(?:\+?1[- .]?)?(?:\(979\)[ .-]?|979[- .])232[- .]5139/g, formattedNumber);
      };
      ['href', 'aria-label', 'title'].forEach(function (attribute) {
        var original = link.getAttribute(attribute);
        if (original === null) return;
        var replacement = attribute === 'href' ? 'tel:' + mobileNumber : replaceText(original);
        if (replacement === original) return;
        phoneReplacements.push({ node: link, attribute: attribute, original: original, replacement: replacement });
        link.setAttribute(attribute, replacement);
      });
      // Preserve icons, nested markup, labels such as "Call us", and event handlers.
      var walker = document.createTreeWalker(link, NodeFilter.SHOW_TEXT);
      var textNode;
      while ((textNode = walker.nextNode())) {
        var original = textNode.nodeValue;
        var replacement = replaceText(original);
        if (replacement === original) continue;
        phoneReplacements.push({ node: textNode, original: original, replacement: replacement });
        textNode.nodeValue = replacement;
      }
    });
  }

  function enableWebsiteCallTracking() {
    if (phoneTrackingActive || !analyticsAllowed()) return;
    phoneTrackingActive = true;
    var generation = ++phoneTrackingGeneration;
    window.gtag('config', PHONE_CALL_CONVERSION, {
      phone_conversion_number: BUSINESS_PHONE_DISPLAY,
      phone_conversion_callback: function (formattedNumber, mobileNumber) {
        if (generation !== phoneTrackingGeneration) return;
        replaceBusinessPhone(formattedNumber, mobileNumber);
      }
    });
  }

  function bindPhoneCallTracking() {
    if (document.documentElement.dataset.phoneCallTrackingBound === 'true') return;
    document.documentElement.dataset.phoneCallTrackingBound = 'true';

    document.addEventListener('click', function (event) {
      var target = event.target;
      var link = target && target.closest ? target.closest('a[href^="tel:"]') : null;
      if (!link || typeof window.gtag !== 'function') return;

      var location = link.closest('header, nav')
        ? 'header'
        : link.closest('footer')
          ? 'footer'
          : 'content';

      window.gtag('event', PHONE_CLICK_EVENT, {
        contact_method: 'phone',
        link_location: location,
        page_path: safePagePath(),
        audience_type: audienceType(),
        measurement_version: '2'
      });
    });
  }

  function initConsent() {
    injectStyles();
    updateBannerCopy();
    bindBannerActions();
    bindPhoneCallTracking();

    var storedConsent = null;
    try {
      storedConsent = localStorage.getItem(CONSENT_KEY);
    } catch (error) {}

    if (globalPrivacyControlEnabled()) {
      setConsent('declined');
      declineCookies();
      return;
    }

    if (storedConsent === 'accepted') {
      hideBanner();
      grantAnalytics();
      return;
    }

    if (storedConsent === 'declined') {
      declineCookies();
      return;
    }

    showBanner();
  }

  window.acceptCookies = acceptCookies;
  window.declineCookies = declineCookies;
  window.openCookiePreferences = openCookiePreferences;
  window.addEventListener('storage', function (event) {
    if (event.key !== CONSENT_KEY) return;
    consentChoice = event.newValue;
    if (analyticsAllowed()) grantAnalytics();
    else declineCookies();
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initConsent);
  } else {
    initConsent();
  }
})();
