(function () {
  var GA_MEASUREMENT_ID = 'G-ZN45GP8D25';
  var ADS_MEASUREMENT_ID = 'AW-16551666395';
  var CONSENT_KEY = 'cookie-consent';
  var BANNER_ID = 'cookie-banner';
  var STYLE_ID = 'aae-cookie-consent-style';
  var GTAG_SCRIPT_ID = 'aae-gtag-script';
  var HUBSPOT_SCRIPT_ID = 'hs-script-loader';
  var analyticsLoaded = false;

  window.dataLayer = window.dataLayer || [];
  window.gtag = window.gtag || function gtag() { window.dataLayer.push(arguments); };
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

  function hideBanner() {
    var banner = getBanner();
    if (banner) banner.classList.add('hidden');
  }

  function showBanner() {
    var banner = getBanner();
    if (banner) banner.classList.remove('hidden');
  }

  function initGtag() {
    if (window.__AAE_GTAG_READY__) return;
    window.__AAE_GTAG_READY__ = true;
    window.dataLayer = window.dataLayer || [];
    if (!window.gtag) {
      window.gtag = function gtag() {
        window.dataLayer.push(arguments);
      };
    }
    window.gtag('js', new Date());
    window.gtag('config', GA_MEASUREMENT_ID);
    window.gtag('config', ADS_MEASUREMENT_ID);
  }

  function loadHubspot() {
    if (document.getElementById(HUBSPOT_SCRIPT_ID)) return;
    var script = document.createElement('script');
    script.id = HUBSPOT_SCRIPT_ID;
    script.async = true;
    script.defer = true;
    script.src = 'https://js-na2.hs-scripts.com/245917212.js';
    document.head.appendChild(script);
  }

  function loadAnalytics() {
    if (analyticsLoaded) return;
    analyticsLoaded = true;
    window.gtag('consent', 'update', {
      analytics_storage: 'granted',
      ad_storage: 'granted',
      ad_user_data: 'denied',
      ad_personalization: 'denied'
    });

    if (!document.getElementById(GTAG_SCRIPT_ID)) {
      var script = document.createElement('script');
      script.id = GTAG_SCRIPT_ID;
      script.async = true;
      script.src = 'https://www.googletagmanager.com/gtag/js?id=' + ADS_MEASUREMENT_ID;
      script.onload = initGtag;
      document.head.appendChild(script);
    }

    initGtag();
    loadHubspot();
  }

  function setConsent(value) {
    try {
      localStorage.setItem(CONSENT_KEY, value);
    } catch (error) {}
  }

  function acceptCookies() {
    setConsent('accepted');
    hideBanner();
    window._hsq = window._hsq || [];
    window._hsq.push(['doNotTrack', { track: true }]);
    loadAnalytics();
  }

  function declineCookies() {
    setConsent('declined');
    window.gtag('consent', 'update', {
      analytics_storage: 'denied',
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied'
    });
    window._hsq = window._hsq || [];
    window._hsq.push(['doNotTrack']);
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

  function initConsent() {
    injectStyles();
    updateBannerCopy();
    bindBannerActions();

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
      loadAnalytics();
      return;
    }

    if (storedConsent === 'declined') {
      hideBanner();
      return;
    }

    showBanner();
  }

  window.acceptCookies = acceptCookies;
  window.declineCookies = declineCookies;
  window.openCookiePreferences = openCookiePreferences;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initConsent);
  } else {
    initConsent();
  }
})();
