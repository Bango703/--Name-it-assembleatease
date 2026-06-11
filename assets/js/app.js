// ============================================
//  ASSEMBLEATEASE — app.js
//  Auth helpers, nav builder, UI utilities
// ============================================

const APP = {

  // ── AUTH ────────────────────────────────────────────────

  // Get the current session and profile. Returns null if not logged in.
  async getAuth() {
    const attempt = async () => {
      try {
        const { data: { session }, error } = await supabaseClient.auth.getSession();
        if (error || !session) return null;

        const { data: profile, error: profileError } = await supabaseClient
          .from('profiles')
          .select('*')
          .eq('id', session.user.id)
          .single();

        if (profileError || !profile) return null;
        return { user: session.user, session, profile };
      } catch {
        return null;
      }
    };

    // First attempt
    let result = await attempt();
    if (result) return result;

    // Retry once after 800ms — handles Supabase session load race condition
    // where createClient() hasn't finished restoring the session from storage yet
    await new Promise(r => setTimeout(r, 800));
    return attempt();
  },

  // Require auth + optional role check. Redirects to login if not authenticated.
  // Usage: const auth = await APP.requireAuth(['assembler']);
  async requireAuth(allowedRoles = []) {
    const auth = await this.getAuth();

    if (!auth) {
      const returnTo = window.location.pathname + window.location.search + window.location.hash;
      window.location.href = '/auth/login?return=' + encodeURIComponent(returnTo);
      return null;
    }

    if (allowedRoles.length && !allowedRoles.includes(auth.profile.role)) {
      const role = auth.profile.role;
      window.location.href = role === 'assembler' ? '/assembler/'
        : role === 'owner' ? '/owner/' : '/';
      return null;
    }

    return auth;
  },

  // Require auth + verified assembler (tier != pending AND identity_verified).
  // Unverified assemblers are redirected to the dashboard which shows status banners.
  async requireVerifiedAssembler() {
    const auth = await this.requireAuth(['assembler']);
    if (!auth) return null;
    if (auth.profile.tier === 'pending' || auth.profile.identity_verified !== true) {
      window.location.href = '/assembler/';
      return null;
    }
    return auth;
  },

  // Redirect already-logged-in users away from auth pages
  async redirectIfLoggedIn() {
    const auth = await this.getAuth();
    if (!auth) return;
    const role = auth.profile.role;
    window.location.href = role === 'assembler' ? '/assembler/'
      : role === 'owner' ? '/owner/' : '/';
  },

  // ── PATH HELPERS ────────────────────────────────────────

  // Resolve paths relative to the site root regardless of current directory depth
  _rootPath(path) {
    const depth = window.location.pathname.split('/').filter(Boolean).length - 1;
    const prefix = depth > 0 ? '../'.repeat(depth) : '';
    return prefix + path;
  },

  _authPath(page) {
    return this._rootPath('auth/' + page);
  },

  // ── NAV BUILDER ─────────────────────────────────────────

  // Builds the top nav bar and injects it into #main-nav.
  // role: 'assembler' | 'customer' | null (public)
  async buildNav(role = null) {
    const navEl = document.getElementById('main-nav');
    if (!navEl) return;

    const root = this._rootPath('');
    const logoHref = role ? root + (role === 'assembler' ? 'assembler/' : 'customer/') : root;

    let links = '';
    let actions = '';

    if (role === 'assembler') {
      links = `
        <li><a href="/assembler/my-assignments">My Assignments</a></li>
        <li><a href="/assembler/payouts">Payouts</a></li>
      `;
      actions = `
        <a href="/assembler/profile" class="btn btn-ghost btn-sm">Profile</a>
        <button class="btn btn-outline btn-sm" id="nav-logout">Log out</button>
      `;
    } else {
      actions = `
        <a href="/auth/login" class="btn btn-ghost btn-sm">Log in</a>
      `;
    }

    navEl.innerHTML = `
      <div class="nav-inner">
        <a href="${logoHref}" class="nav-logo">Assemble<span>AtEase</span></a>
        <ul class="nav-links">${links}</ul>
        <div class="nav-actions">${actions}</div>
      </div>
    `;

    // Logout handler
    document.getElementById('nav-logout')?.addEventListener('click', async () => {
      await supabaseClient.auth.signOut();
      window.location.href = root;
    });

    this._highlightActiveNavLink();
  },

  // Highlight nav link that matches current URL
  _highlightActiveNavLink() {
    const current = window.location.pathname;
    document.querySelectorAll('.nav-links a, .sidebar-nav a').forEach(link => {
      const href = link.getAttribute('href');
      if (!href) return;
      const isActive = current.endsWith(href) || current.endsWith(href.replace('../', ''));
      if (isActive) link.classList.add('active');
    });
  },

  // Alias kept for backward compatibility with existing pages
  setActiveSidebarLink() {
    this._highlightActiveNavLink();
  },

  // ── ALERTS ──────────────────────────────────────────────

  // showAlert('auth-alert', 'Something went wrong', 'error')
  showAlert(id, message, type = 'error') {
    const el = document.getElementById(id);
    if (!el) return;
    el.className = `alert alert-${type}`;
    el.textContent = message;
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  },

  hideAlert(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.className = 'alert hidden';
    el.textContent = '';
  },

  // ── LOADING STATE ───────────────────────────────────────

  // setLoading('submit-btn', true, 'Saving...')
  setLoading(btnId, isLoading, label) {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    btn.disabled = isLoading;
    btn.textContent = label;
  },

  // ── FORM VALIDATION HELPERS ─────────────────────────────

  fieldError(inputId, message) {
    const input = document.getElementById(inputId);
    const errEl = document.getElementById(`${inputId}-error`);
    input?.classList.add('error');
    if (errEl) { errEl.textContent = message; errEl.classList.add('visible'); }
  },

  clearFieldErrors(formId) {
    const scope = formId ? document.getElementById(formId) : document;
    scope?.querySelectorAll('.form-control').forEach(el => el.classList.remove('error'));
    scope?.querySelectorAll('.field-error').forEach(el => {
      el.textContent = ''; el.classList.remove('visible');
    });
  },

  isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  },

  // ── STRING / DATE HELPERS ───────────────────────────────

  truncate(str, len = 80) {
    if (!str) return '';
    return str.length > len ? str.substring(0, len) + '…' : str;
  },

  timeAgo(dateStr) {
    if (!dateStr) return '';
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins  = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days  = Math.floor(diff / 86400000);
    if (mins < 1)   return 'Just now';
    if (mins < 60)  return `${mins}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days === 1) return 'Yesterday';
    if (days < 30)  return `${days}d ago`;
    return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  },

  formatCurrency(amount, currency = 'USD') {
    if (amount == null) return '—';
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(amount);
  },

  // ── RENDER HELPERS ──────────────────────────────────────

  renderError(message) {
    return `<div class="error-state"><span>⚠️</span>${message}</div>`;
  },

  renderEmpty(message, linkHref, linkText) {
    return `
      <div class="empty-state">
        <p>${message}</p>
        ${linkHref ? `<a href="${linkHref}" class="btn btn-ghost btn-sm">${linkText || 'View all'}</a>` : ''}
      </div>`;
  },

  getBadgeClass(status) {
    const map = {
      pending:   'badge-pending',
      accepted:  'badge-accepted',
      rejected:  'badge-rejected',
      withdrawn: 'badge-default',
      open:      'badge-pending',
      assigned:  'badge-accepted',
      in_progress: 'badge-accepted',
      completed: 'badge-complete',
      cancelled: 'badge-rejected',
    };
    return map[status] || 'badge-default';
  },

  renderBadge(status, label) {
    const cls = this.getBadgeClass(status);
    const text = label || status?.replace('_', ' ') || '—';
    return `<span class="badge ${cls}">${text}</span>`;
  },

  // ── AVATAR ──────────────────────────────────────────────

  // Returns initials avatar HTML or an <img> if profile_photo is set
  renderAvatar(profile, size = 40) {
    const initials = (profile?.full_name || '?')
      .split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();

    if (profile?.profile_photo) {
      return `<img src="${profile.profile_photo}" alt="${initials}"
        style="width:${size}px;height:${size}px;border-radius:50%;object-fit:cover;" />`;
    }

    return `<div style="
      width:${size}px;height:${size}px;border-radius:50%;
      background:var(--accent-light);color:var(--accent);
      display:flex;align-items:center;justify-content:center;
      font-size:${Math.round(size * 0.35)}px;font-weight:500;
      flex-shrink:0;">${initials}</div>`;
  },

  // ── TOAST NOTIFICATIONS ─────────────────────────────────

  toast(message, type = 'success', duration = 3500) {
    const existing = document.getElementById('app-toast');
    if (existing) existing.remove();

    const colors = {
      success: { bg: 'var(--green-light)',  color: '#166534', border: 'rgba(34,197,94,0.2)'  },
      error:   { bg: 'var(--red-light)',    color: '#991b1b', border: 'rgba(239,68,68,0.2)'  },
      info:    { bg: 'var(--blue-light)',   color: '#1e40af', border: 'rgba(59,130,246,0.2)' },
      warning: { bg: 'var(--amber-light)',  color: '#92400e', border: 'rgba(245,158,11,0.25)'},
    };
    const c = colors[type] || colors.info;

    const toast = document.createElement('div');
    toast.id = 'app-toast';
    toast.textContent = message;
    Object.assign(toast.style, {
      position:     'fixed',
      bottom:       '24px',
      right:        '24px',
      zIndex:       '9999',
      padding:      '12px 18px',
      borderRadius: 'var(--radius-lg)',
      background:   c.bg,
      color:        c.color,
      border:       `1px solid ${c.border}`,
      fontSize:     '0.875rem',
      fontFamily:   'var(--font-body)',
      fontWeight:   '500',
      boxShadow:    'var(--shadow-md)',
      animation:    'slideUp 0.2s ease',
      maxWidth:     '320px',
    });

    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), duration);
  },

  // ── URL HELPERS ─────────────────────────────────────────

  getParam(key) {
    return new URLSearchParams(window.location.search).get(key);
  },

  setParam(key, value) {
    const params = new URLSearchParams(window.location.search);
    if (value) { params.set(key, value); } else { params.delete(key); }
    const newUrl = `${window.location.pathname}?${params.toString()}`;
    window.history.replaceState({}, '', newUrl);
  },

  // ── MOBILE SIDEBAR ──────────────────────────────────────

  _mobileSidebarOpen: false,

  openMobileSidebar() {
    const sidebar = document.querySelector('.sidebar');
    const overlay = document.querySelector('.sidebar-overlay');
    if (!sidebar) return;
    sidebar.classList.add('open');
    if (overlay) overlay.classList.add('open');
    this._mobileSidebarOpen = true;
    document.body.style.overflow = 'hidden';
  },

  closeMobileSidebar() {
    const sidebar = document.querySelector('.sidebar');
    const overlay = document.querySelector('.sidebar-overlay');
    if (!sidebar) return;
    sidebar.classList.remove('open');
    if (overlay) overlay.classList.remove('open');
    this._mobileSidebarOpen = false;
    document.body.style.overflow = '';
  },

  toggleMobileSidebar() {
    this._mobileSidebarOpen ? this.closeMobileSidebar() : this.openMobileSidebar();
  },

  // Inject mobile header + overlay into portal pages that have a sidebar
  _initMobileNav() {
    if (!document.querySelector('.sidebar')) return;

    // Overlay
    const overlay = document.createElement('div');
    overlay.className = 'sidebar-overlay';
    overlay.addEventListener('click', () => APP.closeMobileSidebar());
    document.body.appendChild(overlay);

    // Mobile header bar
    const header = document.createElement('div');
    header.className = 'mobile-portal-header';
    header.innerHTML = `
      <strong>Assemble<span>AtEase</span></strong>
      <button class="mobile-toggle-btn" aria-label="Open navigation" onclick="APP.toggleMobileSidebar()">
        <span></span><span></span><span></span>
      </button>`;
    document.body.prepend(header);
  },
};

window.APP = APP;

// ── Footer year — runs on every page ──────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const yearEl = document.getElementById('year');
  if (yearEl) yearEl.textContent = new Date().getFullYear();

  // Inject mobile nav for portal/dashboard pages
  APP._initMobileNav();
});

// ── PWA install helper — Easer dashboard routes only ──────────────────────────
// Shows an "Install app" affordance on every Easer route so a Pro can add the
// dashboard to their home screen. On iPhone, installing is REQUIRED for push to
// reach the lock screen at all.
//
// Platform reality (why this branches):
//   • Android / Chrome / Edge fire `beforeinstallprompt` → one tap installs natively.
//   • iOS Safari has NO install API (Apple restriction) → we can only show the
//     Share → Add to Home Screen steps. There is no way to auto-install on iPhone.
(function initPWAInstall() {
  if (typeof window === 'undefined' || !window.location) return;
  if (location.pathname.indexOf('/assembler') !== 0) return; // Easer routes only

  // Ensure the service worker is registered on whatever Easer route the Pro lands
  // on (incl. onboarding pages that don't register it themselves). Android needs a
  // SW in scope before it will offer install; this is idempotent with index.html.
  if ('serviceWorker' in navigator) {
    try {
      navigator.serviceWorker.getRegistration('/assembler/').then(function (reg) {
        if (!reg) navigator.serviceWorker.register('/sw.js', { scope: '/assembler/' }).catch(function () {});
      }).catch(function () {});
    } catch (e) {}
  }

  var isStandalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
    || window.navigator.standalone === true;
  if (isStandalone) return; // already installed — nothing to offer

  var ua = navigator.userAgent || '';
  var isIOS = /iphone|ipad|ipod/i.test(ua)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var deferredPrompt = null;
  var pill = null;

  function dismissed() {
    try { return sessionStorage.getItem('aae-install-dismissed') === '1'; } catch (e) { return false; }
  }

  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();      // stop Chrome's mini-infobar; we drive our own button
    deferredPrompt = e;
    showPill();
  });

  window.addEventListener('appinstalled', function () {
    try { sessionStorage.setItem('aae-installed', '1'); } catch (e) {}
    removePill();
  });

  function ready() {
    if (dismissed()) return;
    if (isIOS) { showPill(); return; }                       // iOS never fires the event
    setTimeout(function () { if (!pill) showPill(); }, 3000); // Android/desktop fallback
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready);
  else ready();

  function place() {
    if (!pill) return;
    // Sit above the notifications banner on the home screen if it's present.
    pill.style.bottom = document.getElementById('push-banner')
      ? 'calc(150px + env(safe-area-inset-bottom))'
      : 'calc(82px + env(safe-area-inset-bottom))';
  }

  function showPill() {
    if (pill || dismissed()) return;
    pill = document.createElement('div');
    pill.id = 'aae-install-pill';
    pill.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);z-index:9998;display:flex;align-items:center;gap:10px;background:#0d1117;color:#fff;border:1px solid rgba(255,255,255,0.12);border-radius:999px;padding:10px 14px;box-shadow:0 8px 28px rgba(0,0,0,0.4);font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Arial,sans-serif';
    pill.innerHTML =
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#00BFFF" stroke-width="2" style="flex-shrink:0"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>'
      + '<button id="aae-install-go" style="background:none;border:none;color:#fff;font-size:0.86rem;font-weight:700;cursor:pointer;padding:0">Install app</button>'
      + '<button id="aae-install-x" aria-label="Dismiss" style="background:none;border:none;color:rgba(255,255,255,0.45);font-size:1.15rem;line-height:1;cursor:pointer;padding:0 2px">&times;</button>';
    document.body.appendChild(pill);
    place(); setTimeout(place, 1700); // re-check once the push banner has had time to appear
    document.getElementById('aae-install-go').addEventListener('click', onInstallClick);
    document.getElementById('aae-install-x').addEventListener('click', function () {
      try { sessionStorage.setItem('aae-install-dismissed', '1'); } catch (e) {}
      removePill();
    });
  }

  function removePill() { if (pill && pill.parentNode) pill.parentNode.removeChild(pill); pill = null; }

  function onInstallClick() {
    if (deferredPrompt) {
      deferredPrompt.prompt();                               // native, one-tap (Android/desktop)
      deferredPrompt.userChoice.then(function (choice) {
        if (choice && choice.outcome === 'accepted') removePill();
        deferredPrompt = null;
      });
    } else if (isIOS) {
      showSheet('ios');                                      // Apple has no install API — guide
    } else {
      showSheet('generic');                                  // browser without the event — guide
    }
  }

  function showSheet(kind) {
    var existing = document.getElementById('aae-install-sheet');
    if (existing) existing.remove();
    var overlay = document.createElement('div');
    overlay.id = 'aae-install-sheet';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,0.55);display:flex;align-items:flex-end;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Arial,sans-serif';
    var shareIcon = '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="#00BFFF" stroke-width="2" style="vertical-align:middle"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>';
    var plusIcon  = '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="#00BFFF" stroke-width="2" style="vertical-align:middle"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>';
    var steps = kind === 'ios'
      ? '<li style="margin-bottom:10px">Tap the <strong>Share</strong> button ' + shareIcon + ' in Safari\'s toolbar.</li>'
        + '<li style="margin-bottom:10px">Scroll down and tap <strong>Add to Home Screen</strong> ' + plusIcon + '.</li>'
        + '<li>Tap <strong>Add</strong>, then open <strong>AE Easer</strong> from your home screen.</li>'
      : '<li style="margin-bottom:10px">Open your browser menu (<strong>&#8942;</strong> or <strong>&#8230;</strong>).</li>'
        + '<li style="margin-bottom:10px">Choose <strong>Install app</strong> or <strong>Add to Home screen</strong>.</li>'
        + '<li>Confirm, then launch it from your home screen.</li>';
    var iosNote = kind === 'ios'
      ? '<p style="margin:12px 0 0;font-size:0.76rem;color:#9aa4b2;line-height:1.5">On iPhone this must be done in <strong>Safari</strong> — installing is what lets job alerts reach your lock screen.</p>'
      : '';
    overlay.innerHTML =
      '<div style="background:#11161d;color:#fff;width:100%;max-width:480px;border-radius:18px 18px 0 0;padding:22px 20px calc(22px + env(safe-area-inset-bottom));box-shadow:0 -8px 40px rgba(0,0,0,0.5)">'
      + '<div style="width:40px;height:4px;border-radius:999px;background:rgba(255,255,255,0.18);margin:0 auto 16px"></div>'
      + '<div style="font-size:1.1rem;font-weight:800;margin-bottom:4px">Add AssembleAtEase to your home screen</div>'
      + '<div style="font-size:0.82rem;color:#9aa4b2;margin-bottom:16px">Instant job alerts and one-tap access — like a real app.</div>'
      + '<ol style="margin:0;padding-left:18px;font-size:0.9rem;line-height:1.5;color:#e5e7eb">' + steps + '</ol>'
      + iosNote
      + '<button id="aae-sheet-close" style="margin-top:18px;width:100%;background:#00BFFF;color:#fff;border:none;border-radius:12px;padding:12px;font-size:0.92rem;font-weight:700;cursor:pointer">Got it</button>'
      + '</div>';
    document.body.appendChild(overlay);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) overlay.remove(); });
    document.getElementById('aae-sheet-close').addEventListener('click', function () { overlay.remove(); });
  }
})();
