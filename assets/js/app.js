// ============================================
//  ASSEMBLEATEASE — app.js
//  Auth helpers, nav builder, UI utilities
// ============================================

const EASER_BOOTSTRAP_PROFILE_FIELDS = [
  'id',
  'role',
  'full_name',
  'phone',
  'city',
  'state',
  'zip',
  'profile_photo',
  'rating',
  'review_count',
  'created_at',
  'tier',
  'status',
  'application_status',
  'is_available',
  'identity_verified',
  'stripe_verification_id',
  'account_closure_status',
  'contractor_agreement_signed_at',
].join(',');

const APP = {

  _privateSessionUserId: null,
  _privateSessionSubscription: null,
  _privateSessionAbortController: null,

  // ── AUTH ────────────────────────────────────────────────

  // Get the current session and profile. Returns null if not logged in.
  async getAuth() {
    const attempt = async () => {
      try {
        const { data: { session }, error } = await supabaseClient.auth.getSession();
        if (error || !session) return null;

        const { data: profile, error: profileError } = await supabaseClient
          .from('profiles')
          .select(EASER_BOOTSTRAP_PROFILE_FIELDS)
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

  // Remove authenticated Easer data that must never survive an account switch
  // in the same browser tab. Keep unrelated preferences such as cookie consent.
  clearPrivateSessionData() {
    try {
      const keys = [];
      for (let i = 0; i < sessionStorage.length; i += 1) {
        const key = sessionStorage.key(i);
        if (key === 'easer_dashboard_cache_v1' || key?.startsWith('easer_dashboard_cache_v1:')) {
          keys.push(key);
        }
      }
      keys.forEach((key) => sessionStorage.removeItem(key));
    } catch {}
  },

  async bindPrivateSession(expectedUserId) {
    const userId = String(expectedUserId || '').trim();
    if (!userId) return false;

    if (this._privateSessionSubscription) {
      this._privateSessionSubscription.unsubscribe();
      this._privateSessionSubscription = null;
    }
    this._privateSessionUserId = userId;
    this.clearPrivateSessionData();
    if (this._privateSessionAbortController) this._privateSessionAbortController.abort();
    this._privateSessionAbortController = new AbortController();

    const invalidate = (session) => {
      if (this._privateSessionUserId !== userId) return;
      if (session?.user?.id === userId) return;

      this._privateSessionUserId = null;
  if (this._privateSessionAbortController) this._privateSessionAbortController.abort();
  this._privateSessionAbortController = null;
      this.clearPrivateSessionData();
      if (document.body) document.body.style.visibility = 'hidden';
      try { window.stop(); } catch {}

      const returnTo = window.location.pathname + window.location.search + window.location.hash;
      const destination = session?.user
        ? returnTo
        : '/auth/login?return=' + encodeURIComponent(returnTo);
      window.location.replace(destination);
    };

    const { data } = supabaseClient.auth.onAuthStateChange(function(_event, session) {
      invalidate(session);
    });
    this._privateSessionSubscription = data?.subscription || null;

    try {
      const { data: sessionData, error } = await supabaseClient.auth.getSession();
      if (error || sessionData?.session?.user?.id !== userId) {
        invalidate(sessionData?.session || null);
        return false;
      }
    } catch {
      invalidate(null);
      return false;
    }

    return this._privateSessionUserId === userId;
  },

  isPrivateSessionCurrent(expectedUserId) {
    return this._privateSessionUserId === String(expectedUserId || '').trim();
  },

  privateFetch(expectedUserId, input, init = {}) {
    if (!this.isPrivateSessionCurrent(expectedUserId) || !this._privateSessionAbortController) {
      return Promise.reject(new DOMException('Private session changed', 'AbortError'));
    }
    return fetch(input, {
      ...init,
      signal: this._privateSessionAbortController.signal,
    });
  },

  revealPrivatePage() {
    if (!document.body) return;
    document.body.style.visibility = 'visible';
    document.body.classList.remove('easer-booting');
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
      this.clearPrivateSessionData();
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
  // Presentational address formatter — mirrors the server-side formatAddress()
  // in api/_email.js so a street address reads the same clean, capitalized way
  // on-screen as it does in emails: "3301 e pecan st" -> "3301 E PECAN ST".
  // Not a validator; keep the raw value for map/geocode queries.
  formatAddress(raw) {
    if (!raw) return '';
    return String(raw)
      .split(',')
      .map((part) => part.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join(', ')
      .toUpperCase();
  },

  // Easer-facing presentation helpers. Keep stored values unchanged; these
  // only translate internal labels and normalize postal casing for display.
  formatServiceLabel(service) {
    const raw = String(service || '').trim();
    const key = raw.toLowerCase().replace(/\s+/g, '');
    if (key === 'trampoline/disassembly/moving/reassembly') {
      return 'Trampoline Move & Reassembly';
    }
    return raw || 'Service';
  },

  formatPostalAddress(raw) {
    if (!raw) return '';
    const suffixes = {
      st: 'St', street: 'St', rd: 'Rd', road: 'Rd', ave: 'Ave', avenue: 'Ave',
      blvd: 'Blvd', boulevard: 'Blvd', dr: 'Dr', drive: 'Dr', ln: 'Ln', lane: 'Ln',
      ct: 'Ct', court: 'Ct', cir: 'Cir', circle: 'Cir', pkwy: 'Pkwy', parkway: 'Pkwy',
      hwy: 'Hwy', highway: 'Hwy', way: 'Way', pl: 'Pl', place: 'Pl',
      unit: 'Unit', apt: 'Apt', apartment: 'Apt', suite: 'Suite', ste: 'Ste',
    };
    const uppercase = new Set(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw', 'tx', 'us', 'usa']);
    return String(raw).split(',').map((part) => part.trim().split(/\s+/).map((word) => {
      const lower = word.toLowerCase();
      if (!lower) return '';
      if (/^#?\d/.test(word)) return word.toUpperCase();
      if (uppercase.has(lower)) return lower.toUpperCase();
      if (suffixes[lower]) return suffixes[lower];
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    }).join(' ')).filter(Boolean).join(', ');
  },

  showAlert(id, message, type = 'error') {
    const el = document.getElementById(id);
    if (!el) return;
    el.className = `alert alert-${type}`;
    el.setAttribute('role', type === 'error' ? 'alert' : 'status');
    el.setAttribute('aria-live', type === 'error' ? 'assertive' : 'polite');
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
    input?.setAttribute('aria-invalid', 'true');
    input?.setAttribute('aria-describedby', `${inputId}-error`);
    if (errEl) { errEl.textContent = message; errEl.classList.add('visible'); }
  },

  clearFieldErrors(formId) {
    const scope = formId ? document.getElementById(formId) : document;
    scope?.querySelectorAll('.form-control').forEach(el => {
      el.classList.remove('error');
      el.removeAttribute('aria-invalid');
      if (el.getAttribute('aria-describedby') === `${el.id}-error`) el.removeAttribute('aria-describedby');
    });
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
    return new Intl.NumberFormat('en-US', {
      style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2,
    }).format(Number(amount) || 0);
  },

  // ── RENDER HELPERS ──────────────────────────────────────

  renderError(message) {
    return `<div class="error-state"><strong>Error:</strong> ${message}</div>`;
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

// True only inside the installed AssembleAtEase app (App Store / Google Play), where
// Capacitor provides native push. The website never has window.Capacitor, so
// every branch guarded by this is a no-op on the web.
window.AAE_isNativeApp = function () {
  try { return !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform()); }
  catch (_) { return false; }
};

// Auth and Easer pages share this loader. It never adds a script on the website.
if (window.AAE_isNativeApp() && !window.__aaeNativeBridgeReady && !document.querySelector('script[src*="/native-app.js"]')) {
  const nativeBridge = document.createElement('script');
  nativeBridge.src = '/assets/js/native-app.js?v=20261008c';
  document.head.appendChild(nativeBridge);
}

// ── Footer year — runs on every page ──────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const yearEl = document.getElementById('year');
  if (yearEl) yearEl.textContent = new Date().getFullYear();

  // Inject mobile nav for portal/dashboard pages
  APP._initMobileNav();
});

// ── Easer service worker ───────────────────────────────────────────────────
// Registered on every Easer route so web job notifications keep working on
// Android and desktop. The "Install app / Add to home screen" prompt that used
// to sit here was removed (owner, 2026-11-12): Easers get the Easer app from the
// App Store, offered by Apple's banner (scripts/app-banner-sync.mjs).
(function initEaserServiceWorker() {
  if (typeof window === 'undefined' || !window.location) return;
  if (location.pathname.indexOf('/assembler') !== 0) return; // Easer routes only
  // The store app has native push: no service worker there.
  if (window.AAE_isNativeApp && window.AAE_isNativeApp()) return;
  if (!('serviceWorker' in navigator)) return;
  try {
    navigator.serviceWorker.getRegistration('/assembler/').then(function (reg) {
      if (reg) reg.update().catch(function () {});
      else navigator.serviceWorker.register('/sw.js', { scope: '/assembler/' }).catch(function () {});
    }).catch(function () {});
  } catch (e) {}
})();
