(function () {
  var API_URL = '/api/promo';
  var STYLE_ID = 'aae-site-promo-style';
  var INLINE_ID = 'aae-inline-promo-bar';

  function esc(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = [
      '.offer-bar{background:#f7fcff;border-bottom:1px solid rgba(0,191,255,0.18)}',
      '.offer-bar[hidden]{display:none !important}',
      '.offer-bar-inner{max-width:1120px;margin:0 auto;padding:0.8rem 1.25rem;display:flex;align-items:center;justify-content:center;text-align:center;gap:0.7rem;flex-wrap:wrap}',
      '.offer-bar-copy{display:flex;align-items:center;gap:0.7rem;flex-wrap:wrap;color:#0f172a;font-size:0.92rem;line-height:1.5}',
      '.offer-pill{display:inline-flex;align-items:center;padding:0.22rem 0.55rem;border-radius:999px;background:#e0f7ff;color:#0369a1;font-size:0.68rem;font-weight:800;letter-spacing:0.08em;text-transform:uppercase}',
      '.offer-bar strong{font-weight:800;color:#0f172a}',
      '.offer-bar-code{color:#475569;font-size:0.86rem}',
      '.offer-bar-cta{display:inline-flex;align-items:center;justify-content:center;min-height:42px;padding:0 1rem;border-radius:999px;background:#00BFFF;color:#fff;text-decoration:none;font-size:0.84rem;font-weight:800;white-space:nowrap}',
      '.offer-bar-cta:hover{background:#0099CC}',
      '.site-promo-inline{background:#f7fcff;border-top:1px solid rgba(0,191,255,0.12);border-bottom:1px solid rgba(0,191,255,0.12)}',
      '.site-promo-inline .offer-bar-inner{padding:0.72rem 1.25rem}',
      '@media (max-width: 768px) {',
      '  .offer-bar-inner{padding:0.7rem 1rem}',
      '  .offer-bar-copy{flex-direction:column;align-items:center;gap:0.2rem;font-size:0.85rem;text-align:center}',
      '  .offer-pill{font-size:0.6rem}',
      '  .offer-bar-code{font-size:0.8rem}',
      '}',
    ].join('');
    document.head.appendChild(style);
  }

  function toRelativeUrl(url) {
    return url.pathname + (url.search || '') + (url.hash || '');
  }

  function rewriteBookingLinks(promoCode) {
    document.querySelectorAll('a[href]').forEach(function (link) {
      var href = link.getAttribute('href');
      if (!href) return;
      try {
        var url = new URL(href, window.location.origin);
        if (url.origin !== window.location.origin || url.pathname !== '/book') return;
        if (promoCode) url.searchParams.set('promo', promoCode);
        else url.searchParams.delete('promo');
        link.setAttribute('href', toRelativeUrl(url));
      } catch (_err) {
        // Ignore malformed links.
      }
    });
  }

  function promoMarkup(promo) {
    return ''
      + '<div class="offer-bar-inner">'
      +   '<div class="offer-bar-copy">'
      +     '<span class="offer-pill">' + esc(promo.title || 'Special Offer') + '</span>'
      +     '<strong>' + esc(promo.label || 'Promo discount') + '</strong>'
      +     '<span class="offer-bar-code">Use code: ' + esc(promo.code) + '</span>'
      +   '</div>'
      + '</div>';
  }

  function renderHomeBar(promo) {
    var container = document.getElementById('new-customer-offer');
    if (!container) return false;
    container.hidden = !promo;
    container.innerHTML = promo ? promoMarkup(promo) : '';
    return true;
  }

  function renderInlineBar(promo) {
    var existing = document.getElementById(INLINE_ID);
    if (!promo) {
      if (existing) existing.remove();
      return;
    }

    if (!existing) {
      var nav = document.querySelector('.nav');
      if (!nav || !nav.parentNode) return;
      existing = document.createElement('div');
      existing.id = INLINE_ID;
      existing.className = 'site-promo-inline';
      nav.insertAdjacentElement('afterend', existing);
    }

    existing.innerHTML = promoMarkup(promo);
  }

  // ---- SEO snippet sync (homepage only) -------------------------------------
  // When the owner turns the promo ON, lead the homepage title + description
  // with the offer so Google's snippet shows it. When the promo is OFF, the
  // original (clean) meta is restored. Source of truth is the owner panel label,
  // so this auto-syncs with the on/off toggle — no stale "30% off" promises.
  var ORIGINAL_SEO = null;

  function isHomepage() {
    var p = (window.location.pathname || '/').replace(/\/index\.html$/i, '/');
    return p === '/' || p === '';
  }

  function metaEl(selector) {
    return document.head ? document.head.querySelector(selector) : null;
  }

  function setMetaContent(selector, value) {
    var el = metaEl(selector);
    if (el && value != null) el.setAttribute('content', value);
  }

  function captureSeo() {
    if (ORIGINAL_SEO) return;
    var desc = metaEl('meta[name="description"]');
    var ogDesc = metaEl('meta[property="og:description"]');
    var ogTitle = metaEl('meta[property="og:title"]');
    var twTitle = metaEl('meta[name="twitter:title"]');
    var twDesc = metaEl('meta[name="twitter:description"]');
    ORIGINAL_SEO = {
      title: document.title,
      desc: desc ? desc.getAttribute('content') : null,
      ogDesc: ogDesc ? ogDesc.getAttribute('content') : null,
      ogTitle: ogTitle ? ogTitle.getAttribute('content') : null,
      twTitle: twTitle ? twTitle.getAttribute('content') : null,
      twDesc: twDesc ? twDesc.getAttribute('content') : null,
    };
  }

  function updateSeo(promo) {
    if (!isHomepage()) return;
    captureSeo();
    var hook = promo && promo.label ? String(promo.label).trim() : '';
    if (hook) {
      var title = hook + ' | AssembleAtEase Home Setup & Assembly';
      var desc = hook + '. Furniture assembly, TV mounting & smart home setup with upfront pricing, reviewed pros, and secure checkout.';
      document.title = title;
      setMetaContent('meta[name="description"]', desc);
      setMetaContent('meta[property="og:description"]', desc);
      setMetaContent('meta[property="og:title"]', title);
      setMetaContent('meta[name="twitter:title"]', title);
      setMetaContent('meta[name="twitter:description"]', desc);
    } else if (ORIGINAL_SEO) {
      document.title = ORIGINAL_SEO.title;
      setMetaContent('meta[name="description"]', ORIGINAL_SEO.desc);
      setMetaContent('meta[property="og:description"]', ORIGINAL_SEO.ogDesc);
      setMetaContent('meta[property="og:title"]', ORIGINAL_SEO.ogTitle);
      setMetaContent('meta[name="twitter:title"]', ORIGINAL_SEO.twTitle);
      setMetaContent('meta[name="twitter:description"]', ORIGINAL_SEO.twDesc);
    }
  }

  function applyPromo(promo) {
    window.AAE_ACTIVE_PROMO = promo || null;
    ensureStyles();
    rewriteBookingLinks(promo && promo.code ? promo.code : '');
    if (!renderHomeBar(promo)) renderInlineBar(promo);
    updateSeo(promo);
  }

  function loadPromo() {
    fetch(API_URL, { cache: 'no-store' })
      .then(function (resp) { return resp.ok ? resp.json() : null; })
      .then(function (data) {
        var promo = data && data.promo && data.promo.enabled ? data.promo : null;
        applyPromo(promo);
      })
      .catch(function () {
        applyPromo(null);
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadPromo, { once: true });
  } else {
    loadPromo();
  }
})();
