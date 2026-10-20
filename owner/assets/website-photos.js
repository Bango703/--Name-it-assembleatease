// Owner Website Photos: the collection of completion photos the owner has
// approved for the website, and what is posted where. Which photos may be used
// at all (Terms version, opt-outs) is decided by /api/owner/website-photos and
// api/_website-photos.js; this file renders the server's answer and sends the
// owner's choices to /api/owner/website-photo.
(function () {
  'use strict';

  var state = { data: null, tab: 'available', loading: false };
  var USE_REASON = {
    earlier_terms: 'Booked before website photos were allowed',
    opted_out: 'Customer opted out of website photos',
  };

  function el(id) { return document.getElementById(id); }
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function headers(json) {
    var h = typeof window._ownerHeaders === 'function' ? window._ownerHeaders() : {};
    return json ? Object.assign({}, h, { 'Content-Type': 'application/json' }) : h;
  }
  function toast(text, kind) {
    if (typeof window._ownerToast === 'function') window._ownerToast(text, kind || 'success');
  }

  // ── The one set of buttons, used in the library and in a booking record ──
  // photo: { id, state: 'available' | 'collected' | 'on_website', websiteService }
  // ctx:   { services, use: { allowed, reason }, bookingId }
  function actionsHtml(photo, ctx) {
    var use = (ctx && ctx.use) || { allowed: true };
    var services = (ctx && ctx.services) || {};
    var id = esc(photo.id);
    var bookingId = esc((ctx && ctx.bookingId) || '');
    function button(label, action, primary, title) {
      return '<button type="button" class="btn' + (primary ? ' btn-teal' : '') + ' wp-btn"' + (title ? ' title="' + esc(title) + '"' : '') + ' '
        + 'data-wp-action="' + action + '" data-wp-id="' + id + '" data-wp-booking="' + bookingId + '">' + esc(label) + '</button>';
    }
    var out = '<div class="wp-actions">';
    if (photo.state === 'on_website') {
      out += '<div class="wp-state wp-state--live">On website &middot; ' + esc(services[photo.websiteService] || photo.websiteService || '') + '</div>'
        + button('Take off website', 'unpublish') + button('Remove', 'uncollect', false, 'Remove from the collection');
    } else if (photo.state === 'collected') {
      out += '<div class="wp-state wp-state--saved">In collection</div>'
        + button('Post to website', 'publish', true) + button('Remove', 'uncollect', false, 'Remove from the collection');
    } else if (!use.allowed) {
      out += '<div class="wp-state wp-state--off">' + esc(USE_REASON[use.reason] || 'Not available for the website') + '</div>';
    } else {
      out += button('Save to collection', 'collect', true);
    }
    return out + '</div>';
  }

  async function post(body) {
    var r = await fetch('/api/owner/website-photo', { method: 'POST', headers: headers(true), body: JSON.stringify(body) });
    var d = {};
    try { d = await r.json(); } catch (e) { d = {}; }
    if (!r.ok) throw new Error(d.error || 'The website photo could not be updated, and the server did not say why.');
    return d;
  }

  function lookup(evidenceId) {
    var photos = (state.data && state.data.photos) || [];
    for (var i = 0; i < photos.length; i++) if (photos[i].id === evidenceId) return photos[i];
    return null;
  }

  // ctx for prompts: services, checklist and the booking's suggested service.
  async function act(action, evidenceId, bookingId, ctx) {
    ctx = ctx || {};
    var services = ctx.services || (state.data && state.data.services) || {};
    var checklist = ctx.checklist || (state.data && state.data.checklist) || [];
    var body = { evidenceId: evidenceId, action: action };
    if (action === 'collect') {
      if (!confirm('Save this photo to the website collection?\nConfirm it shows:\n- ' + checklist.join('\n- '))) return;
      body.checklistConfirmed = true;
    }
    if (action === 'publish') {
      var keys = Object.keys(services);
      var found = lookup(evidenceId);
      var suggested = (ctx.suggestedServices || (found && found.suggestedServices) || [])[0] || keys[0];
      var menu = keys.map(function (k, i) { return (i + 1) + '. ' + services[k]; }).join('\n');
      var pick = prompt('Which service page is this photo for?\n' + menu, String(keys.indexOf(suggested) + 1));
      if (pick === null) return;
      var service = keys[Number(pick) - 1];
      if (!service) { toast('Choose a number from the list', 'error'); return; }
      var alt = prompt('Describe the photo in a few words. Visitors and search engines see this.', '');
      if (alt === null) return;
      if (alt.trim().length < 10) { toast('Describe the photo in at least a few words', 'error'); return; }
      body.service = service;
      body.alt = alt.trim();
    }
    if (action === 'uncollect' && !confirm('Remove this photo from the collection? If it is on the website, it comes down too.')) return;
    try {
      await post(body);
      toast({
        collect: 'Saved to the collection', uncollect: 'Removed from the collection',
        publish: 'Posted to the website', unpublish: 'Taken off the website',
      }[action] || 'Updated');
    } catch (err) {
      toast(err.message, 'error');
      return;
    }
    if (bookingId && typeof window.loadEvidence === 'function') await window.loadEvidence(bookingId, true);
    if (el('website-photos-view') && el('website-photos-view').style.display !== 'none') await load();
  }

  async function optOut(bookingId) {
    if (!confirm('Record that this customer does not want photos from their bookings used? Any of their photos in the collection or on the website are removed.')) return;
    try {
      var d = await post({ bookingId: bookingId, action: 'opt_out' });
      toast('Opt-out recorded' + (d.photosRemoved ? '; ' + d.photosRemoved + ' photo(s) removed' : ''));
    } catch (err) {
      toast(err.message, 'error');
      return;
    }
    if (typeof window.loadEvidence === 'function') await window.loadEvidence(bookingId, true);
  }

  // Clicks on any website-photo button, anywhere in the dashboard. Capture
  // phase, so a button inside a photo card does not also open the photo.
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-wp-action]');
    if (!b) return;
    e.preventDefault();
    e.stopPropagation();
    var bookingId = b.getAttribute('data-wp-booking') || null;
    var ctx = bookingId && window._evidenceWebsiteCtx ? window._evidenceWebsiteCtx(bookingId) : null;
    if (b.getAttribute('data-wp-action') === 'opt_out') optOut(bookingId);
    else act(b.getAttribute('data-wp-action'), b.getAttribute('data-wp-id'), bookingId, ctx);
  }, true);

  // "2026-11-02" -> "Nov 2, 2026" (a calendar date: no time zone shift).
  function niceDate(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
    if (!m) return '';
    return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m[2]) - 1] + ' ' + Number(m[3]) + ', ' + m[1];
  }

  // ── The library view ─────────────────────────────────────────────────────
  var TABS = [
    { key: 'available', label: 'Job photos' },
    { key: 'collected', label: 'Collection' },
    { key: 'on_website', label: 'On website' },
  ];
  var EMPTY = {
    available: 'New completion photos appear here once a job booked under the current Terms is finished.',
    collected: 'Photos you save from Job photos wait here until you post them.',
    on_website: 'Nothing is posted yet. Post a photo from the Collection.',
  };

  function render() {
    var view = el('website-photos-view');
    if (!view) return;
    var d = state.data;
    if (!d) { view.innerHTML = '<div class="wp-note">Loading photos…</div>'; return; }
    var counts = d.counts || {};
    var countFor = { available: counts.available || 0, collected: counts.collected || 0, on_website: counts.onWebsite || 0 };
    var tabs = '<div class="tabs wp-tabs">' + TABS.map(function (t) {
      return '<button type="button" class="tab' + (state.tab === t.key ? ' active' : '') + '" data-wp-tab="' + t.key + '">'
        + esc(t.label) + '<span class="tab-count">' + countFor[t.key] + '</span></button>';
    }).join('') + '</div>';
    var photos = (d.photos || []).filter(function (p) { return p.state === state.tab; });
    var grid = photos.length
      ? '<div class="wp-grid">' + photos.map(function (p) {
        return '<figure class="wp-card">'
          + (p.previewUrl ? '<img src="' + esc(p.previewUrl) + '" alt="' + esc(p.websiteAlt || ('Completion photo for ' + p.bookingRef)) + '" loading="lazy"/>' : '<div class="wp-noimg">Preview unavailable</div>')
          + '<figcaption><div class="wp-meta"><strong>' + esc(p.bookingRef) + '</strong> &middot; ' + esc(p.service || '') + '</div>'
          + '<div class="wp-sub">' + esc([p.city, niceDate(p.date)].filter(Boolean).join(' · ')) + '</div>'
          + (p.websiteAlt ? '<div class="wp-sub">&ldquo;' + esc(p.websiteAlt) + '&rdquo;</div>' : '')
          + actionsHtml(p, { services: d.services, use: { allowed: true } })
          + '</figcaption></figure>';
      }).join('') + '</div>'
      : '<div class="empty-state"><div class="empty-state-title">Nothing here yet</div><div class="empty-state-desc">' + esc(EMPTY[state.tab]) + '</div></div>';
    view.innerHTML = '<div class="wp-note">Photos of finished work from bookings under the current Terms. Save the ones you like to the collection, then post them to a service page when you are ready.</div>'
      + tabs + grid;
  }

  async function load() {
    if (state.loading) return;
    state.loading = true;
    if (!state.data) render();
    try {
      var r = await fetch('/api/owner/website-photos', { cache: 'no-store', headers: headers(false) });
      var d = {};
      try { d = await r.json(); } catch (e) { d = {}; }
      if (!r.ok) throw new Error(d.error || 'Photos could not be loaded.');
      state.data = d;
      render();
    } catch (err) {
      var view = el('website-photos-view');
      if (view) view.innerHTML = '<div class="wp-note wp-note--error">' + esc(err.message) + '</div>';
    } finally {
      state.loading = false;
    }
  }

  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-wp-tab]');
    if (!t) return;
    state.tab = t.getAttribute('data-wp-tab');
    render();
  });

  window.OwnerWebsitePhotos = { load: load, refresh: load, actionsHtml: actionsHtml };
})();
