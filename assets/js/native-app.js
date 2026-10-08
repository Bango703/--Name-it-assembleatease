// Shared Customer / Easer app bridge. Inert on the website. Choosing a route
// never changes an account's role: the existing server remains authoritative.
// Job notifications are requested only for a signed-in Easer on an Easer page.
// The existing Easer application browser handoff is preserved.
(function () {
  'use strict';
  var cap = window.Capacitor;
  if (!cap || typeof cap.isNativePlatform !== 'function' || !cap.isNativePlatform()) return;
  if (window.__aaeNativeBridgeReady) return;
  window.__aaeNativeBridgeReady = true;
  var plugins = cap.Plugins || {};
  var currentUrl = new URL(window.location.href);
  var easerPage = /^\/assembler\/(?!apply(?:\.html)?\/?$)/.test(currentUrl.pathname);
  // The website homepage is the marketing site. In the app, home is /app.
  var WEBSITE_HOME = /^\/(?:index\.html)?$/;
  if (WEBSITE_HOME.test(currentUrl.pathname)) { window.location.replace('/app'); return; }
  // Lets native-app.css swap the website menu and footer for app navigation.
  if (document.documentElement) document.documentElement.classList.add('aae-native-app');

  // ── Customer tab bar: the app's own navigation on customer screens ──
  var APP_HOME = /^\/app(?:\.html)?\/?$/;
  var BOOK_PAGE = /^\/book(?:\.html)?\/?$/;
  var ICON = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
  var CUSTOMER_TABS = [
    { href: '/app', label: 'Home', match: APP_HOME, icon: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>' },
    { href: '/book', label: 'Book', match: BOOK_PAGE, icon: '<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>' },
    { href: '/track', label: 'Bookings', match: /^\/track(?:\.html)?\/?$/, icon: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/>' },
    { href: '/contact', label: 'Help', match: /^\/contact(?:\.html)?\/?$/, icon: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-5.1A8 8 0 1 1 21 12z"/>' },
  ];
  // Not on Easer or sign-in screens (Easers have their own tab bar), and not
  // while booking, where the booking page keeps its Continue bar at the bottom.
  var customerTabsShown = !/^\/(?:assembler|auth|owner)(?:\/|$)/.test(currentUrl.pathname) && !BOOK_PAGE.test(currentUrl.pathname);
  var tabRoot = CUSTOMER_TABS.some(function (tab) { return tab.match.test(currentUrl.pathname); });

  function mountTabs() {
    if (!customerTabsShown || !document.body || document.getElementById('aae-tabbar') || document.querySelector('.easer-nav')) return;
    var bar = document.createElement('nav');
    bar.id = 'aae-tabbar';
    bar.className = 'aae-tabbar';
    bar.setAttribute('aria-label', 'Main');
    CUSTOMER_TABS.forEach(function (tab) {
      var link = document.createElement('a');
      link.href = tab.href;
      link.className = 'aae-tab';
      if (tab.match.test(currentUrl.pathname)) link.setAttribute('aria-current', 'page');
      link.innerHTML = ICON + tab.icon + '</svg><span>' + tab.label + '</span>';
      bar.append(link);
    });
    document.body.append(bar);
    document.documentElement.classList.add('aae-has-tabs');
  }

  // ── Pull down to refresh on screens whose data changes (never while booking) ──
  var PULL_TO_REFRESH = easerPage || /^\/track(?:\.html)?\/?$/.test(currentUrl.pathname);
  var PULL_DISTANCE = 80;

  function mountPullToRefresh() {
    if (!PULL_TO_REFRESH || !document.body || document.getElementById('aae-pull')) return;
    var pill = document.createElement('div');
    pill.id = 'aae-pull';
    pill.className = 'aae-pull';
    pill.setAttribute('role', 'status');
    pill.hidden = true;
    document.body.append(pill);
    var startY = null;
    var ready = false;
    function busy(target) {
      if (target && target.closest && target.closest('[role="dialog"], [aria-modal="true"], input, textarea, select, [contenteditable="true"]')) return true;
      return (document.body.style && document.body.style.overflow === 'hidden') ||
        (document.documentElement.style && document.documentElement.style.overflow === 'hidden');
    }
    document.addEventListener('touchstart', function (event) {
      var touches = event.touches || [];
      startY = (window.scrollY <= 0 && touches.length === 1 && !busy(event.target)) ? touches[0].clientY : null;
      ready = false;
    }, { passive: true });
    document.addEventListener('touchmove', function (event) {
      if (startY === null) return;
      var pulled = event.touches[0].clientY - startY;
      if (pulled < 12 || window.scrollY > 0) { pill.hidden = true; ready = false; return; }
      ready = pulled >= PULL_DISTANCE;
      pill.textContent = ready ? 'Release to refresh' : 'Pull to refresh';
      pill.hidden = false;
    }, { passive: true });
    document.addEventListener('touchend', function () {
      if (startY !== null && ready) {
        pill.textContent = 'Refreshing';
        window.location.reload();
      } else {
        pill.hidden = true;
      }
      startY = null;
      ready = false;
    }, { passive: true });
  }

  function goBack() {
    if (window.history.length > 1) window.history.back();
    else window.location.assign('/app');
  }

  function mountNavigation() {
    if (!document.body || document.getElementById('aae-native-nav')) return;
    if (!document.querySelector('link[href^="/assets/css/native-app.css"]')) {
      var css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = '/assets/css/native-app.css?v=20261008c';
      document.head.appendChild(css);
    }
    var nav = document.createElement('nav');
    nav.id = 'aae-native-nav';
    nav.className = 'aae-native-nav';
    nav.setAttribute('aria-label', 'App navigation');
    var back = document.createElement('button');
    back.type = 'button';
    back.textContent = 'Back';
    back.addEventListener('click', goBack);
    back.hidden = /^\/app(?:\.html)?\/?$/.test(currentUrl.pathname);
    var home = document.createElement('a');
    home.href = '/app';
    home.textContent = 'App home';
    home.setAttribute('aria-label', 'App home: customer and Easer options');
    home.hidden = back.hidden;
    var error = document.createElement('p');
    error.id = 'aae-native-link-error';
    error.className = 'aae-native-link-error';
    error.setAttribute('role', 'alert');
    error.hidden = true;
    nav.append(back, home, error);
    // Tab screens and Easer screens navigate with their bottom tab bar instead.
    if (back.hidden || (customerTabsShown && tabRoot) || document.querySelector('.easer-nav')) nav.hidden = true;
    document.body.prepend(nav);
  }

  function showLinkError() {
    mountNavigation();
    var error = document.getElementById('aae-native-link-error');
    if (!error) return;
    document.getElementById('aae-native-nav').hidden = false;
    error.textContent = 'That link did not open. Please try again.';
    error.hidden = false;
  }

  function mountAppChrome() { mountNavigation(); mountTabs(); mountPullToRefresh(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountAppChrome);
  else mountAppChrome();

  // Android's hardware Back follows the same history as the on-screen control.
  if (plugins.App && typeof plugins.App.addListener === 'function') {
    plugins.App.addListener('backButton', function (event) {
      if (event && event.canGoBack) goBack();
      else if (!/^\/app(?:\.html)?\/?$/.test(currentUrl.pathname)) window.location.assign('/app');
    });
  }

  // ── Pages that open in Safari, never inside the app ──
  var OPEN_IN_BROWSER = [/^\/assembler\/apply(?:\.html)?\/?$/];
  function opensInBrowser(url) {
    return url.origin === window.location.origin && OPEN_IN_BROWSER.some(function (re) { return re.test(url.pathname); });
  }
  async function openInBrowser(url) {
    var launcher = plugins.AppLauncher;
    try {
      if (!launcher || typeof launcher.openUrl !== 'function') throw new Error('unavailable');
      var result = await launcher.openUrl({ url: url.href });
      if (result && result.completed === false) throw new Error('not opened');
      return true;
    } catch (_) { showLinkError(); return false; }
  }
  document.addEventListener('click', function (event) {
    if (event.defaultPrevented || event.button > 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    var link = event.target && event.target.closest ? event.target.closest('a[href]') : null;
    if (!link) return;
    var url;
    try { url = new URL(link.href, window.location.href); } catch (_) { return; }
    if (url.origin === window.location.origin && WEBSITE_HOME.test(url.pathname)) {
      event.preventDefault();
      window.location.assign('/app');
      return;
    }
    if (opensInBrowser(url) || ['tel:', 'mailto:'].indexOf(url.protocol) !== -1 ||
        (url.protocol === 'https:' && url.origin !== window.location.origin)) {
      event.preventDefault();
      openInBrowser(url);
    } else if (url.origin === window.location.origin && link.target === '_blank') {
      event.preventDefault();
      window.location.assign(url.pathname + url.search + url.hash);
    }
  }, true);
  // Only leave this screen after the browser confirms the handoff.
  if (opensInBrowser(currentUrl)) {
    openInBrowser(currentUrl).then(function (opened) {
      if (opened) window.location.replace('/app');
    });
    return;
  }

  var messaging = plugins.FirebaseMessaging;
  if (!messaging) return;

  var platform = typeof cap.getPlatform === 'function' ? cap.getPlatform() : '';
  var REGISTERED_KEY = 'aae_native_push_token';
  var currentToken = null;
  var lastBearer = null; // kept so sign-out can unregister before the session is revoked

  async function easerSession() {
    try {
      if (!easerPage || !window.APP || typeof window.APP.getAuth !== 'function') return null;
      var auth = await window.APP.getAuth();
      if (!auth || !auth.profile || auth.profile.role !== 'assembler') return null;
      return auth.session && auth.session.access_token ? auth : null;
    } catch (_) { return null; }
  }

  async function register(token) {
    if (!token) return;
    var auth = await easerSession();
    if (!auth) return; // customer/guest pages never register job notifications
    currentToken = token;
    var bearer = auth.session.access_token;
    lastBearer = bearer;
    var registrationKey = auth.user.id + ':' + token;
    try {
      if (sessionStorage.getItem(REGISTERED_KEY) === registrationKey) return;
    } catch (_) {}
    try {
      var appInfo = plugins.App && plugins.App.getInfo ? await plugins.App.getInfo() : null;
      var resp = await fetch('/api/assembler/native-push-register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + bearer },
        body: JSON.stringify({ token: token, platform: platform, appVersion: appInfo && appInfo.version }),
      });
      if (resp.ok) { try { sessionStorage.setItem(REGISTERED_KEY, registrationKey); } catch (_) {} }
    } catch (_) { /* retried on the next page load */ }
  }

  async function start() {
    try {
      if (!(await easerSession())) return;
      if (platform === 'android' && messaging.createChannel) {
        await messaging.createChannel({ id: 'jobs', name: 'Job offers and updates', importance: 5, visibility: 1, sound: 'default' }).catch(function () {});
      }
      var perm = await messaging.checkPermissions();
      if (perm.receive === 'prompt' || perm.receive === 'prompt-with-rationale') perm = await messaging.requestPermissions();
      if (perm.receive !== 'granted') return;
      var result = await messaging.getToken();
      await register(result && result.token);
    } catch (_) { /* notifications stay off; the app still works */ }
  }

  messaging.addListener('tokenReceived', function (event) { register(event && event.token); });

  // Job notifications can navigate only to known Easer screens. Their server
  // auth checks still determine which job/account details may be shown.
  messaging.addListener('notificationActionPerformed', function (event) {
    var data = (event && event.notification && event.notification.data) || {};
    var target = String(data.url || '');
    try {
      var url = new URL(target, window.location.origin);
      if (target && url.origin === window.location.origin && /^\/assembler\/(?:my-assignments|profile|payouts|index)?(?:\.html)?\/?$/.test(url.pathname)) {
        window.location.href = url.pathname + url.search + url.hash;
      }
    } catch (_) {}
  });

  // Sign-out: the session is still valid when clearPrivateSessionData runs, so
  // the device can be removed from this Easer's notifications first.
  function wrapSignOut() {
    if (!window.APP || typeof window.APP.clearPrivateSessionData !== 'function' || window.APP.__nativeSignOutWrapped) return;
    var original = window.APP.clearPrivateSessionData.bind(window.APP);
    window.APP.clearPrivateSessionData = function () {
      // Sent synchronously, before the caller revokes the session. If it is
      // missed, the next Easer to sign in on this phone takes the device over.
      if (currentToken && lastBearer) {
        fetch('/api/assembler/native-push-register', {
          method: 'DELETE',
          keepalive: true,
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + lastBearer },
          body: JSON.stringify({ token: currentToken }),
        }).catch(function () {});
      }
      try { sessionStorage.removeItem(REGISTERED_KEY); } catch (_) {}
      return original();
    };
    window.APP.__nativeSignOutWrapped = true;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { wrapSignOut(); start(); });
  } else { wrapSignOut(); start(); }
})();
