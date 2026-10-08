// Shared acquisition capture for customers, business inquiries and applicants.
(function () {
  var STORAGE_KEY = 'aaeAcquisitionAttribution';
  var acquisitionMemory = null;
  function clearAcquisition() {
    acquisitionMemory = null;
    try { sessionStorage.removeItem(STORAGE_KEY); sessionStorage.removeItem('aaeBookingAttribution'); } catch (e) {}
  }
  function acquisitionAllowed() {
    // This module can run before cookie-consent.js on application pages.
    var cap = window.Capacitor;
    if (cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform()) return false;
    if (navigator.globalPrivacyControl === true) return false;
    if (window.AAEAnalytics && window.AAEAnalytics.hasConsent) return window.AAEAnalytics.hasConsent();
    try { return localStorage.getItem('cookie-consent') === 'accepted' && localStorage.getItem('aae-analytics-internal') !== '1'; } catch (e) { return false; }
  }
  function acquisitionHost(value) {
    var host = String(value || '').toLowerCase().replace(/^www\./, '');
    if (!/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/.test(host)) return '';
    if (['assembleatease.com', 'stripe.com', 'klarna.com', 'resend.com'].some(function (domain) { return host === domain || host.endsWith('.' + domain); })) return '';
    return host;
  }
  function campaignIdentifier(value) {
    var label = String(value || '').trim().toLowerCase();
    return /^[a-z][a-z0-9_-]{0,79}$/.test(label) && label.replace(/\D/g, '').length < 7 && !/[a-f0-9]{24,}/.test(label) ? label : '';
  }
  function acquisitionPath() {
    try {
      // Canonical comes from the published page, never an arbitrary request path.
      var canonical = document.querySelector('link[rel="canonical"]');
      var url = new URL(canonical && canonical.href || '');
      if (url.hostname.replace(/^www\./, '') !== 'assembleatease.com') return '';
      return /^\/(?:[a-z0-9-]+\/)*[a-z0-9-]*\/?$/.test(url.pathname) ? url.pathname : '';
    } catch (e) { return ''; }
  }
  function sanitizeAcquisition(value) {
    var item = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    var result = {};
    var source = String(item.utmSource || '').trim().toLowerCase();
    var medium = String(item.utmMedium || '').trim().toLowerCase();
    result.utmSource = ['google', 'bing', 'duckduckgo', 'ecosia', 'ecosia.org', 'yahoo', 'google_jobs_apply', 'facebook', 'instagram', 'linkedin', 'nextdoor', 'buffer', 'partner', 'owner', 'sora', 'newsletter'].indexOf(source) !== -1 ? source : '';
    result.utmMedium = ['organic', 'social', 'organic_social', 'referral', 'email', 'voice', 'cpc', 'ppc', 'paidsearch', 'paid_search'].indexOf(medium) !== -1 ? medium : '';
    var campaign = campaignIdentifier(item.utmCampaign);
    // Mirrors api/_partners.js REF_CODE; the partner pipeline generates these.
    var rawCampaign = String(item.utmCampaign || '').trim().toLowerCase();
    var partnerCode = source === 'partner' && /^[a-z0-9]{6}$/.test(rawCampaign);
    result.utmCampaign = result.utmSource && (/^(?:gbp|rebook|partner|easer|organic|social|newsletter|sora|business|referral|austin|san_antonio|houston|dallas|tyler|texas)(?:[_-][a-z0-9]+)*$/.test(campaign) || partnerCode) ? (partnerCode ? rawCampaign : campaign) : '';
    var content = campaignIdentifier(item.utmContent);
    result.utmContent = result.utmSource && content.length <= 64 && (/^(website|book)$/.test(content) || (source === 'partner' && result.utmCampaign && content)) ? content : '';
    result.referrerHost = acquisitionHost(item.referrerHost);
    result.landingPath = /^\/(?:[a-z0-9-]+\/)*[a-z0-9-]*\/?$/.test(item.landingPath || '') ? item.landingPath : '';
    result.clickId = /^[a-z0-9_-]{1,180}$/i.test(item.clickId || '') ? item.clickId : '';
    result.clickIdType = ['gclid', 'msclkid', 'gbraid', 'wbraid'].indexOf(item.clickIdType) !== -1 ? item.clickIdType : '';
    return result;
  }
  function captureBookingAttributionEntry() {
    if (!acquisitionAllowed()) { clearAcquisition(); return {}; }
    var storageKey = STORAGE_KEY;
    if (!acquisitionPath() && document.readyState === 'loading') return {};
    var existing = acquisitionMemory;
    try { existing = JSON.parse(sessionStorage.getItem(storageKey) || sessionStorage.getItem('aaeBookingAttribution') || 'null') || existing; } catch (e) {}
    existing = sanitizeAcquisition(existing);
    // Internal navigation and payment/email-service returns cannot erase the entry source.
    if (existing.utmSource || existing.referrerHost || existing.clickId) {
      try { sessionStorage.setItem(storageKey, JSON.stringify(existing)); sessionStorage.removeItem('aaeBookingAttribution'); } catch (e) {}
      return existing;
    }
    var next = {};
    try {
      var params = new URLSearchParams(window.location.search || '');
      var referrerHost = '';
      try { referrerHost = document.referrer ? new URL(document.referrer).hostname : ''; } catch (e) {}
      var clickIdType = ['gclid', 'msclkid', 'gbraid', 'wbraid'].filter(function (key) { return params.has(key); })[0] || '';
      next = sanitizeAcquisition({
        utmSource: params.get('utm_source') || '',
        utmMedium: params.get('utm_medium') || '',
        utmCampaign: params.get('utm_campaign') || '',
        utmContent: params.get('utm_content') || '',
        utmTerm: params.get('utm_term') || '',
        clickId: params.get(clickIdType) || '',
        clickIdType: clickIdType,
        landingPath: acquisitionPath(),
        referrerHost: referrerHost,
      });
    } catch (e) {}
    if (!next.utmSource && !next.referrerHost && !next.clickId && existing.landingPath) next.landingPath = existing.landingPath;
    acquisitionMemory = next;
    try { sessionStorage.setItem(storageKey, JSON.stringify(next)); sessionStorage.removeItem('aaeBookingAttribution'); } catch (e) {}
    return next;
  }

  window.AAE_ATTRIBUTION = window.AAEAcquisition = { capture: captureBookingAttributionEntry, clear: clearAcquisition, STORAGE_KEY: STORAGE_KEY };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', captureBookingAttributionEntry);
  else captureBookingAttributionEntry();

})();
