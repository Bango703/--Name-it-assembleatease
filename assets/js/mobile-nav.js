(function () {
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

  initRuntimeMonitor();
  initImageRecovery();
  document.addEventListener('click', routeMobileServicesLink);
  document.addEventListener('DOMContentLoaded', function () {
    initMobileNav();
    normalizeServicesAnchor();
  });
})();
