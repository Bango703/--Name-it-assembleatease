// AssembleAtEase Easer Service Worker
const CACHE = 'aae-easer-v3';
const OFFLINE_URL = '/assembler/';

// ── Install: cache the core Easer shell ──────────────────────────────
self.addEventListener('install', function(e) {
  e.waitUntil(
    caches.open(CACHE).then(function(cache) {
      return cache.addAll([
        '/assembler/',
        '/assembler/my-assignments',
        '/assets/css/dashboard.css',
        '/images/logo.jpg',
        '/images/logo.webp',
      ]).catch(function() { /* non-fatal */ });
    })
  );
  self.skipWaiting();
});

// ── Activate: clean old caches ────────────────────────────────────────
self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(k) { return k !== CACHE; }).map(function(k) { return caches.delete(k); })
      );
    })
  );
  self.clients.claim();
});

// ── Fetch: only handle same-origin requests ───────────────────────────
self.addEventListener('fetch', function(e) {
  var url = new URL(e.request.url);
  // Skip all cross-origin requests — let browser handle Supabase, fonts, CDNs etc.
  if (url.origin !== self.location.origin) return;
  // Always go network for API calls
  if (url.pathname.startsWith('/api/')) return;
  // Network-first for navigation
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).catch(function() {
        return caches.match(OFFLINE_URL);
      })
    );
    return;
  }
  // Cache-first for static assets
  e.respondWith(
    caches.match(e.request).then(function(cached) {
      return cached || fetch(e.request).then(function(resp) {
        if (resp && resp.status === 200) {
          var clone = resp.clone();
          caches.open(CACHE).then(function(cache) { cache.put(e.request, clone); });
        }
        return resp;
      });
    })
  );
});

// ── Push: show notification when server sends a job alert ─────────────
self.addEventListener('push', function(e) {
  var data = {};
  try { data = e.data ? e.data.json() : {}; } catch(err) {}

  var title = data.title || 'New Job Available!';
  var body  = data.body  || 'A new job has been assigned to you.';
  var url   = data.url   || '/assembler/my-assignments';
  var jobId = data.jobId || String(Date.now());

  // Keep options minimal for maximum iOS/Android compatibility.
  // iOS ignores vibrate/requireInteraction/actions — including them
  // can silently prevent the notification from showing on some versions.
  var options = {
    body: body,
    icon: '/images/logo.webp',
    tag:  'aae-job-' + jobId,
    data: { url: url },
  };

  e.waitUntil(
    self.registration.showNotification(title, options).catch(function(err) {
      // Fallback: try with no options at all if showNotification rejects
      return self.registration.showNotification(title, { body: body });
    })
  );
});

// ── Notification click: open or focus the app ─────────────────────────
self.addEventListener('notificationclick', function(e) {
  e.notification.close();
  if (e.action === 'dismiss') return;

  var targetUrl = (e.notification.data && e.notification.data.url)
    ? e.notification.data.url
    : '/assembler/my-assignments';

  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(list) {
      // If app is already open, focus it and navigate
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if (c.url.includes('/assembler') && 'focus' in c) {
          c.focus();
          c.navigate(targetUrl);
          return;
        }
      }
      // Otherwise open a new window
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
});
