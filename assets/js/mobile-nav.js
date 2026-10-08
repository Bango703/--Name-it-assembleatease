(function () {
  var acquisitionMemory = null;
  function clearAcquisition() {
    acquisitionMemory = null;
    try { sessionStorage.removeItem('aaeBookingAttribution'); } catch (e) {}
  }
  function acquisitionAllowed() {
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
    var partnerCode = source === 'partner' && /^[a-z][a-z0-9]{5}$/.test(campaign) && /\d/.test(campaign);
    result.utmCampaign = result.utmSource && (/^(?:gbp|rebook|partner|organic|social|newsletter|sora|business|referral|austin|san_antonio|houston|dallas|tyler|texas)(?:[_-][a-z0-9]+)*$/.test(campaign) || partnerCode) ? campaign : '';
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
    var storageKey = 'aaeBookingAttribution';
    var existing = acquisitionMemory;
    try { existing = JSON.parse(sessionStorage.getItem(storageKey) || 'null') || existing; } catch (e) {}
    existing = sanitizeAcquisition(existing);
    // Internal navigation and payment/email-service returns cannot erase the entry source.
    if (existing.utmSource || existing.referrerHost || existing.clickId) return existing;
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
    try { sessionStorage.setItem(storageKey, JSON.stringify(next)); } catch (e) {}
    return next;
  }

  window.AAEAcquisition = { capture: captureBookingAttributionEntry, clear: clearAcquisition };

  var runtimeErrorState = {
    sent: Object.create(null),
    sessionId: null,
  };

  function getRuntimeSessionId() {
    if (runtimeErrorState.sessionId) return runtimeErrorState.sessionId;
    try {
      var stored = window.sessionStorage && sessionStorage.getItem('aae_runtime_session_id');
      if (stored) {
        runtimeErrorState.sessionId = stored;
        return stored;
      }
    } catch (e) {}
    var created = 'sess_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
    try {
      if (window.sessionStorage) sessionStorage.setItem('aae_runtime_session_id', created);
    } catch (e) {}
    runtimeErrorState.sessionId = created;
    return created;
  }

  function sendRuntimeError(payload) {
    try {
      var body = JSON.stringify(payload);
      if (navigator.sendBeacon) {
        var blob = new Blob([body], { type: 'application/json' });
        navigator.sendBeacon('/api/observability/runtime-error', blob);
        return;
      }
      fetch('/api/observability/runtime-error', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body,
        keepalive: true,
      }).catch(function () {});
    } catch (e) {}
  }

  function captureRuntimeError(kind, detail) {
    try {
      var message = String((detail && detail.message) || 'Unknown runtime error').slice(0, 300);
      var source = String((detail && detail.source) || '').slice(0, 240);
      var line = Number(detail && detail.line) || 0;
      var column = Number(detail && detail.column) || 0;
      var fingerprint = [kind, message, source, line, column, window.location.pathname].join('|');
      if (runtimeErrorState.sent[fingerprint]) return;
      runtimeErrorState.sent[fingerprint] = true;
      sendRuntimeError({
        clientEventId: 'rt_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10),
        kind: kind,
        message: message,
        source: source,
        line: line,
        column: column,
        stack: detail && detail.stack ? String(detail.stack).slice(0, 1800) : '',
        pagePath: window.location.pathname || '/',
        pageHref: window.location.href || '',
        userAgent: navigator.userAgent || '',
        viewport: {
          width: window.innerWidth || null,
          height: window.innerHeight || null,
        },
        sessionId: getRuntimeSessionId(),
      });
    } catch (e) {}
  }

  function initRuntimeMonitor() {
    if (window.__AAE_RUNTIME_MONITOR_READY__) return;
    window.__AAE_RUNTIME_MONITOR_READY__ = true;

    window.addEventListener('error', function (event) {
      captureRuntimeError('window_error', {
        message: event.message,
        source: event.filename,
        line: event.lineno,
        column: event.colno,
        stack: event.error && event.error.stack,
      });
    });

    window.addEventListener('unhandledrejection', function (event) {
      var reason = event.reason;
      captureRuntimeError('unhandled_rejection', {
        message: reason && reason.message ? reason.message : String(reason || 'Unhandled promise rejection'),
        stack: reason && reason.stack,
      });
    });
  }

  function getRetryableImageSrc(img) {
    if (!img || !img.getAttribute) return null;
    var rawSrc = img.getAttribute('src');
    if (!rawSrc) return null;
    try {
      var url = new URL(rawSrc, window.location.href);
      if (url.origin !== window.location.origin) return null;
      if (url.pathname.indexOf('/images/') !== 0) return null;
      return url;
    } catch (e) {
      return null;
    }
  }

  function retryImage(img) {
    var url = getRetryableImageSrc(img);
    if (!url) return;
    var attempts = Number(img.dataset.imgRetryAttempt || '0');
    if (attempts >= 1) return;
    img.dataset.imgRetryAttempt = String(attempts + 1);
    url.searchParams.set('img_retry', Date.now().toString(36));
    img.src = url.pathname + url.search;
  }

  function bindImageRecovery(img) {
    if (!img || img.dataset.imgRecoveryBound === '1') return;
    img.dataset.imgRecoveryBound = '1';
    img.addEventListener('error', function () {
      retryImage(img);
    });
  }

  function isPriorityImage(img) {
    if (!img) return false;
    var loading = (img.getAttribute('loading') || '').toLowerCase();
    var fetchpriority = (img.getAttribute('fetchpriority') || '').toLowerCase();
    return loading !== 'lazy' || fetchpriority === 'high';
  }

  function inspectBrokenImages(root) {
    var scope = root && root.querySelectorAll ? root : document;
    var images = scope.querySelectorAll ? scope.querySelectorAll('img') : [];
    for (var i = 0; i < images.length; i += 1) {
      var img = images[i];
      bindImageRecovery(img);
      if (img.complete && img.naturalWidth === 0) retryImage(img);
    }
  }

  function inspectStalledPriorityImages() {
    var images = document.querySelectorAll ? document.querySelectorAll('img') : [];
    for (var i = 0; i < images.length; i += 1) {
      var img = images[i];
      if (!isPriorityImage(img)) continue;
      bindImageRecovery(img);
      if (!img.complete || img.naturalWidth === 0) retryImage(img);
    }
  }

  function initImageRecovery() {
    inspectBrokenImages(document);

    if (window.MutationObserver) {
      var observer = new MutationObserver(function (mutations) {
        for (var i = 0; i < mutations.length; i += 1) {
          var added = mutations[i].addedNodes || [];
          for (var j = 0; j < added.length; j += 1) {
            var node = added[j];
            if (!node || node.nodeType !== 1) continue;
            if (node.tagName === 'IMG') bindImageRecovery(node);
            inspectBrokenImages(node);
          }
        }
      });
      observer.observe(document.documentElement || document.body, { childList: true, subtree: true });
    }

    window.addEventListener('load', function () {
      window.setTimeout(function () {
        inspectBrokenImages(document);
      }, 250);
    });

    window.setTimeout(inspectStalledPriorityImages, 1800);
    window.setTimeout(inspectStalledPriorityImages, 4500);
  }

  function isMobileNavViewport() {
    return !!(window.matchMedia && window.matchMedia('(max-width: 1023px)').matches);
  }

  function normalizeServicesAnchor() {
    if (!isMobileNavViewport()) return;
    if (window.location.hash !== '#services-hdr') return;
    var mobileServices = document.getElementById('services');
    if (!mobileServices) return;
    if (window.history && window.history.replaceState) {
      window.history.replaceState(null, '', window.location.pathname + '#services');
    } else {
      window.location.hash = '#services';
    }
    window.setTimeout(function () {
      mobileServices.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 40);
  }

  function routeMobileServicesLink(event) {
    if (!isMobileNavViewport()) return;
    var link = event.target.closest('a[href]');
    if (!link) return;
    var href = link.getAttribute('href');
    if (href !== '/#services-hdr' && href !== '#services-hdr') return;
    event.preventDefault();
    if (window.location.pathname === '/' || /\/index\.html$/i.test(window.location.pathname || '')) {
      var target = document.getElementById('services');
      if (!target) {
        window.location.assign('/#services');
        return;
      }
      if (window.history && window.history.replaceState) {
        window.history.replaceState(null, '', window.location.pathname + '#services');
      } else {
        window.location.hash = '#services';
      }
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    window.location.assign('/#services');
  }

  function initMobileNav() {
    var button = document.getElementById('hamburger');
    var menu = document.getElementById('mobileNav');
    if (!button || !menu) return;

    function setOpen(open) {
      button.classList.toggle('open', open);
      menu.classList.toggle('open', open);
      button.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (document.body) document.body.classList.toggle('nav-open', open);
    }

    setOpen(false);

    button.addEventListener('click', function (event) {
      event.preventDefault();
      setOpen(!menu.classList.contains('open'));
    });

    menu.addEventListener('click', function (event) {
      if (event.target.closest('a')) setOpen(false);
    });

    document.addEventListener('click', function (event) {
      if (!menu.classList.contains('open')) return;
      if (button.contains(event.target) || menu.contains(event.target)) return;
      setOpen(false);
    });

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') setOpen(false);
    });

    window.addEventListener('resize', function () {
      if (!isMobileNavViewport()) setOpen(false);
    });
  }

  captureBookingAttributionEntry();
  initRuntimeMonitor();
  initImageRecovery();
  document.addEventListener('click', routeMobileServicesLink);
  document.addEventListener('DOMContentLoaded', function () {
    initMobileNav();
    normalizeServicesAnchor();
  });
})();
