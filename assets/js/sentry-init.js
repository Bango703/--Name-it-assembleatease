(function () {
  'use strict';

  var SENTRY_DSN = 'https://d5e773248c17d9f13dcf8b0a5f5dd73f@o4511934287249408.ingest.us.sentry.io/4511934297473024';
  var PRODUCTION_HOSTS = new Set(['assembleatease.com', 'www.assembleatease.com']);

  function redactText(value) {
    if (typeof value !== 'string') return value;
    return value
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email redacted]')
      .replace(/\b(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b/g, '[phone redacted]')
      .replace(/\bAAE-[A-Z0-9]+\b/gi, '[booking reference redacted]')
      .replace(/\bpi_[A-Za-z0-9]+\b/g, '[payment reference redacted]')
      .replace(/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]+\b/g, '[secret redacted]')
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[token redacted]');
  }

  function sanitizeUrl(value) {
    if (!value || typeof value !== 'string') return value;
    try {
      var url = new URL(value, window.location.origin);
      return url.origin + url.pathname;
    } catch (_) {
      return redactText(value.split(/[?#]/, 1)[0]);
    }
  }

  function sanitizeBreadcrumb(breadcrumb) {
    if (!breadcrumb || breadcrumb.category === 'console') return null;

    var clean = Object.assign({}, breadcrumb);
    if (clean.message) clean.message = redactText(clean.message);

    if (clean.data && typeof clean.data === 'object') {
      var safeData = {};
      ['method', 'status_code', 'type'].forEach(function (key) {
        if (clean.data[key] != null) safeData[key] = clean.data[key];
      });
      ['url', 'from', 'to'].forEach(function (key) {
        if (clean.data[key]) safeData[key] = sanitizeUrl(clean.data[key]);
      });
      clean.data = safeData;
    }

    return clean;
  }

  function sanitizeEvent(event) {
    if (!event || typeof event !== 'object') return event;

    event.user = undefined;
    event.extra = undefined;

    if (event.message) event.message = redactText(event.message);
    if (event.transaction) event.transaction = redactText(String(event.transaction).split(/[?#]/, 1)[0]);

    if (event.exception && Array.isArray(event.exception.values)) {
      event.exception.values.forEach(function (exception) {
        if (exception && exception.value) exception.value = redactText(exception.value);
      });
    }

    if (event.request) {
      event.request.url = sanitizeUrl(event.request.url);
      event.request.headers = undefined;
      event.request.cookies = undefined;
      event.request.data = undefined;
      event.request.query_string = undefined;
    }

    if (Array.isArray(event.breadcrumbs)) {
      event.breadcrumbs = event.breadcrumbs.map(sanitizeBreadcrumb).filter(Boolean);
    }

    return event;
  }

  window.sentryOnLoad = function () {
    if (!window.Sentry || window.__AAE_SENTRY_INITIALIZED__) return;
    window.__AAE_SENTRY_INITIALIZED__ = true;

    var isProduction = PRODUCTION_HOSTS.has(window.location.hostname.toLowerCase());

    window.Sentry.init({
      dsn: SENTRY_DSN,
      enabled: isProduction,
      environment: isProduction ? 'production' : 'development',
      sendDefaultPii: false,
      sampleRate: 1,
      tracesSampleRate: 0.1,
      replaysSessionSampleRate: 0,
      replaysOnErrorSampleRate: 0,
      maxBreadcrumbs: 50,
      tracePropagationTargets: [
        /^\/api\//,
        /^https:\/\/(?:www\.)?assembleatease\.com\/api\//
      ],
      beforeBreadcrumb: sanitizeBreadcrumb,
      beforeSend: sanitizeEvent,
      beforeSendTransaction: sanitizeEvent
    });
  };
})();
