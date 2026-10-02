// Easer app (App Store / Google Play) bridge. Loaded on Easer pages; does
// NOTHING on the website: the first check returns unless the page is running
// inside the installed Capacitor app.
//
// Inside the app it:
//   1. asks for notification permission once and registers this device for
//      native job notifications (api/assembler/native-push-register.js)
//   2. keeps the registration current when Firebase rotates the token
//   3. opens the right screen when an Easer taps a notification
//   4. signs the device out of notifications when the Easer signs out, so a
//      shared phone stops receiving the previous Easer's jobs
//   5. opens the Easer application in Safari. The application takes a card
//      payment (the application fee); inside an App Store app that payment
//      must not happen in the app itself, so the app hands it to the browser.
//      The website is unchanged.
(function () {
  'use strict';
  var cap = window.Capacitor;
  if (!cap || typeof cap.isNativePlatform !== 'function' || !cap.isNativePlatform()) return;
  var plugins = cap.Plugins || {};

  // ── Pages that open in Safari, never inside the app ──
  var OPEN_IN_BROWSER = [/^\/assembler\/apply(?:\.html)?\/?$/];
  function opensInBrowser(url) {
    return url.origin === window.location.origin && OPEN_IN_BROWSER.some(function (re) { return re.test(url.pathname); });
  }
  function openInBrowser(url) {
    var launcher = plugins.AppLauncher;
    if (!launcher || typeof launcher.openUrl !== 'function') return false;
    launcher.openUrl({ url: url.href }).catch(function () {});
    return true;
  }
  document.addEventListener('click', function (event) {
    var link = event.target && event.target.closest ? event.target.closest('a[href]') : null;
    if (!link) return;
    var url;
    try { url = new URL(link.href, window.location.href); } catch (_) { return; }
    if (opensInBrowser(url) && openInBrowser(url)) event.preventDefault();
  }, true);
  // Arrived on one of those pages some other way: send it to Safari and step back.
  if (opensInBrowser(new URL(window.location.href)) && openInBrowser(new URL(window.location.href))) {
    if (window.history.length > 1) window.history.back();
    else window.location.replace('/auth/login');
    return;
  }

  var messaging = plugins.FirebaseMessaging;
  if (!messaging) return;

  var platform = typeof cap.getPlatform === 'function' ? cap.getPlatform() : '';
  var REGISTERED_KEY = 'aae_native_push_token';
  var currentToken = null;
  var lastBearer = null; // kept so sign-out can unregister before the session is revoked

  async function accessToken() {
    try {
      if (typeof supabaseClient === 'undefined') return null;
      var result = await supabaseClient.auth.getSession();
      return (result && result.data && result.data.session && result.data.session.access_token) || null;
    } catch (_) { return null; }
  }

  async function register(token) {
    if (!token) return;
    currentToken = token;
    var bearer = await accessToken();
    if (!bearer) return; // not signed in yet; retried on the next page load
    lastBearer = bearer;
    try {
      if (sessionStorage.getItem(REGISTERED_KEY) === token) return;
    } catch (_) {}
    try {
      var appInfo = plugins.App && plugins.App.getInfo ? await plugins.App.getInfo() : null;
      var resp = await fetch('/api/assembler/native-push-register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + bearer },
        body: JSON.stringify({ token: token, platform: platform, appVersion: appInfo && appInfo.version }),
      });
      if (resp.ok) { try { sessionStorage.setItem(REGISTERED_KEY, token); } catch (_) {} }
    } catch (_) { /* retried on the next page load */ }
  }

  async function start() {
    try {
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

  // Tapping a notification opens the job it is about (same-origin paths only).
  messaging.addListener('notificationActionPerformed', function (event) {
    var data = (event && event.notification && event.notification.data) || {};
    var target = String(data.url || '');
    try {
      var url = new URL(target, window.location.origin);
      if (url.origin === window.location.origin) window.location.href = url.pathname + url.search + url.hash;
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
