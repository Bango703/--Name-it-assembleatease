// Owner Partners panel: referral partners for the move-in channel.
// Stages, partner types, follow-up dates and booking counts come from
// /api/owner/partners (api/_partners.js owns the rules). This file renders them.
(function() {
  'use strict';
  var SIGN = 'Travis\nAssembleAtEase\n(979) 232-5139\nassembleatease.com';
  var TEMPLATES = {
    A: function(p) { return { subject: 'A move-in perk for your new tenants (costs you nothing)', body:
      'Hi ' + p.name + ' team,\n\nI run AssembleAtEase, a local furniture assembly, TV mounting, and home-setup service. Move-in week is stressful. New tenants have furniture and a TV to deal with and rarely the tools or time.\n\n' +
      "I'd like to be your simple hand-off for that. Upfront flat pricing, reviewed local pros, and the customer's card isn't charged until the job is finished right. No cost or contract for your office. I can leave a few cards at your leasing desk, or you can drop this link in your move-in packet:\n\n" + p.bookingLink +
      '\n\nCould I stop by this week and leave a few cards?\n\n' + SIGN }; },
    B: function(p) { return { subject: 'A closing gift your clients will actually use', body:
      'Hi ' + p.name + ' team,\n\nCongrats on your recent closings. I run AssembleAtEase, local furniture assembly and home setup. New homeowners always have things to build and mount and no time to do it.\n\n' +
      "A lot of agents hand our card to buyers at closing as a welcome-home gesture. Upfront flat price, reviewed pros, and the card isn't charged until it's done right. It makes you look thoughtful and costs nothing. Here is a link you can share with your buyers:\n\n" + p.bookingLink +
      '\n\nWant me to drop off a small stack of cards for your closing folders?\n\n' + SIGN }; },
    C: function(p) { return { subject: 'The hand-off after your trucks leave', body:
      'Hi ' + p.name + " team,\n\nYour crews move it in. We put it together. AssembleAtEase does furniture assembly, TV mounting, and setup, so your customers aren't staring at a pile of boxes after you leave. We never touch the moving side; we're the next step.\n\n" +
      'Here is a link your crews can share with customers:\n\n' + p.bookingLink +
      '\n\nHappy to send referrals your way too. Can I leave cards with your dispatcher?\n\n' + SIGN }; },
    D: function(p) { return { subject: 'For customers who ask who can put it together', body:
      'Hi ' + p.name + " team,\n\nI run AssembleAtEase, a local furniture assembly and home-setup service. Customers often ask at checkout who can build what they just bought. We'd like to be your answer.\n\n" +
      "Upfront flat pricing, reviewed local pros, and the customer's card isn't charged until the job is finished right. Nothing for your store to manage or pay. I'd leave a small stack of cards at your register, or you could include this link with delivery:\n\n" + p.bookingLink +
      '\n\nCould I stop by this week?\n\n' + SIGN }; },
  };
  function script(p) {
    return "Hi, I run AssembleAtEase, a local assembly and setup service. When your customers move in or buy furniture, they usually have furniture, a TV, maybe a treadmill, and no tools and no time. We handle all of it, upfront flat price, and their card isn't charged until the job's done right. I'd love to be the person you point them to. It makes you look good and costs you nothing. Can I leave a few cards at your desk?\n\nTheir booking link:\n" + p.bookingLink;
  }

  var state = { data: null, loading: false, selected: null, stage: 'all', kind: 'all', city: 'all', q: '', focus: null, pitch: 'email', limit: 80, badgeStarted: false, error: null };
  function el(id) { return document.getElementById(id); }
  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function(c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function headers(json) { var h = typeof window._ownerHeaders === 'function' ? window._ownerHeaders() : {}; return json ? Object.assign({}, h, { 'Content-Type': 'application/json' }) : h; }
  async function request(options) {
    var response = await fetch('/api/owner/partners', Object.assign({ cache: 'no-store', headers: headers(options && options.method === 'POST') }, options || {}));
    var data = {};
    try { data = await response.json(); } catch (e) { data = {}; }
    if (!response.ok) { var err = new Error(data.error || 'The partner list is unavailable. Refresh to try again.'); err.status = response.status; throw err; }
    return data;
  }
  function post(body) { return request({ method: 'POST', body: JSON.stringify(body) }); }
  function fmtDate(iso) { if (!iso) return ''; var d = new Date(iso + 'T12:00:00'); return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); }
  function stageLabel(id) { var s = (state.data && state.data.stages || []).find(function(x) { return x.id === id; }); return s ? s.label : id; }
  function kindOf(id) { return (state.data && state.data.kinds || []).find(function(x) { return x.id === id; }) || { label: id, template: 'A' }; }
  function partners() { return (state.data && state.data.partners) || []; }
  function summary() { return (state.data && state.data.summary) || { contactedThisWeek: [], followUpDue: [], weeklyTarget: 10 }; }
  function inSet(list, id) { return list.indexOf(id) !== -1; }

  function updateBadge() {
    var badge = el('nav-partners'); if (!badge) return;
    if (!state.data || state.data.tableMissing) { badge.style.display = state.error ? '' : 'none'; badge.textContent = '!'; badge.title = 'Partner list unavailable'; return; }
    var due = summary().followUpDue.length;
    badge.textContent = String(due); badge.title = due + ' partner follow-ups due';
    badge.style.display = due ? '' : 'none';
  }
  async function loadBadge() {
    try { state.data = await request(); state.error = null; } catch (e) { state.error = e.message; }
    updateBadge();
    if (!state.badgeStarted) {
      state.badgeStarted = true;
      window.setInterval(function() {
        if (document.hidden) return;
        var h = headers();
        if (!Object.keys(h).some(function(k) { return k.toLowerCase() === 'authorization' || k.toLowerCase() === 'x-owner-password'; })) return;
        if (el('partners-view') && el('partners-view').style.display !== 'none') return;
        loadBadge();
      }, 300000);
    }
  }

  // Everything except the stage filter; the stage chips count within this set.
  function baseList() {
    var q = state.q.trim().toLowerCase(); var s = summary();
    return partners().filter(function(p) {
      if (state.focus === 'due' && !inSet(s.followUpDue, p.id)) return false;
      if (state.focus === 'week' && !inSet(s.contactedThisWeek, p.id)) return false;
      if (state.kind !== 'all' && p.kind !== state.kind) return false;
      if (state.city !== 'all' && p.city !== state.city) return false;
      if (q && (p.name + ' ' + (p.address || '') + ' ' + (p.notes || '')).toLowerCase().indexOf(q) === -1) return false;
      return true;
    });
  }
  function visibleList() {
    var due = summary().followUpDue;
    return baseList().filter(function(p) { return state.stage === 'all' || p.stage === state.stage; }).sort(function(a, b) {
      var da = inSet(due, a.id), db = inSet(due, b.id);
      if (da !== db) return da ? -1 : 1;
      if (da && db && a.followUpOn !== b.followUpOn) return a.followUpOn < b.followUpOn ? -1 : 1;
      return (a.rank || 99999) - (b.rank || 99999);
    });
  }

  function renderHeader() {
    var s = summary(); var n = s.contactedThisWeek.length;
    el('partners-week').innerHTML = '<span class="partners-week-num">' + n + ' / ' + esc(s.weeklyTarget) + '</span><span class="partners-week-bar"><i style="width:' + Math.min(100, Math.round(n / (s.weeklyTarget || 10) * 100)) + '%"></i></span>';
    el('partners-week').setAttribute('aria-pressed', String(state.focus === 'week'));
    el('partners-due').textContent = s.followUpDue.length + (s.followUpDue.length === 1 ? ' follow-up due' : ' follow-ups due');
    el('partners-due').setAttribute('aria-pressed', String(state.focus === 'due'));
    el('partners-due').disabled = !s.followUpDue.length && state.focus !== 'due';
  }
  function renderFilters() {
    var data = state.data;
    var kinds = el('partners-kind');
    if (!kinds.options.length && data.kinds) kinds.innerHTML = '<option value="all">All types</option>' + data.kinds.map(function(k) { return '<option value="' + esc(k.id) + '">' + esc(k.label) + '</option>'; }).join('');
    kinds.value = state.kind;
    var cities = Array.from(new Set(partners().map(function(p) { return p.city; }).filter(Boolean))).sort(function(a, b) { return a === 'Austin' ? -1 : b === 'Austin' ? 1 : a.localeCompare(b); });
    if (cities.indexOf(state.city) === -1) state.city = 'all';
    el('partners-city').innerHTML = '<option value="all">All cities</option>' + cities.map(function(c) { return '<option value="' + esc(c) + '">' + esc(c) + '</option>'; }).join('');
    el('partners-city').value = state.city;
    var addKind = el('partners-add-kind');
    if (!addKind.options.length && data.kinds) addKind.innerHTML = data.kinds.map(function(k) { return '<option value="' + esc(k.id) + '">' + esc(k.label) + '</option>'; }).join('');
    var base = baseList();
    var chips = [{ id: 'all', label: 'All', count: base.length }].concat((data.stages || []).map(function(s) { return { id: s.id, label: s.label, count: base.filter(function(p) { return p.stage === s.id; }).length }; }));
    el('partners-stages').innerHTML = chips.map(function(c) {
      return '<button type="button" class="partners-chip" data-partner-stage-filter="' + esc(c.id) + '" aria-pressed="' + (state.stage === c.id) + '">' +
        (c.id !== 'all' ? '<span class="partners-dot" data-stage="' + esc(c.id) + '"></span>' : '') + esc(c.label) + ' <span class="partners-chip-count">' + c.count + '</span></button>';
    }).join('');
  }
  function renderList() {
    var list = visibleList(); var due = summary().followUpDue;
    el('partners-count').textContent = list.length + (list.length === 1 ? ' partner' : ' partners') + (state.focus === 'due' ? ' with a follow-up due' : state.focus === 'week' ? ' contacted this week' : '');
    if (!list.length) {
      el('partners-list').innerHTML = '<div class="partners-empty">' + (partners().length ? 'No partners match these filters. Clear the search or choose another stage.' : 'No partners yet. Add one with the form above.') + '</div>';
      return;
    }
    el('partners-list').innerHTML = list.slice(0, state.limit).map(function(p) {
      var isDue = inSet(due, p.id);
      var right = isDue ? '<span class="partners-due">Follow up ' + esc(fmtDate(p.followUpOn)) + '</span>' : p.followUpOn ? '<span>Follow up ' + esc(fmtDate(p.followUpOn)) + '</span>' : '';
      var booked = p.bookings ? '<span class="partners-booked">' + p.bookings + (p.bookings === 1 ? ' booking' : ' bookings') + '</span>' : '';
      return '<button type="button" class="partners-row" data-partner-id="' + esc(p.id) + '" aria-pressed="' + (state.selected === p.id) + '">' +
        '<span class="partners-stripe" data-stage="' + esc(p.stage) + '"></span>' +
        '<span class="partners-row-main"><strong>' + esc(p.name) + '</strong><span class="partners-meta">' + esc(kindOf(p.kind).label) + (p.city ? ' &middot; ' + esc(p.city) : '') + (p.rating ? ' &middot; ' + esc(p.rating.toFixed(1)) + ' (' + esc(p.reviewCount || 0) + ' reviews)' : '') + '</span></span>' +
        '<span class="partners-row-side">' + right + booked + '<span>' + esc(stageLabel(p.stage)) + '</span></span></button>';
    }).join('') + (list.length > state.limit ? '<button type="button" class="partners-button partners-more" data-partner-more>Show ' + Math.min(100, list.length - state.limit) + ' more of ' + (list.length - state.limit) + '</button>' : '');
  }
  function fact(name, html) { return '<div><dt>' + esc(name) + '</dt><dd>' + html + '</dd></div>'; }
  function copyButton(text, what) { return ' <button type="button" class="partners-copy" data-partner-copy="' + esc(text) + '" data-partner-copy-what="' + esc(what) + '">Copy</button>'; }
  function renderDetail() {
    var box = el('partners-detail');
    var p = partners().find(function(x) { return x.id === state.selected; });
    if (!p) { box.innerHTML = '<p class="partners-muted">Choose a partner to see their contact details, booking link and pitch.</p>'; return; }
    var kind = kindOf(p.kind); var tpl = TEMPLATES[kind.template] || TEMPLATES.A;
    var pitchText = state.pitch === 'email' ? (function(t) { return 'Subject: ' + t.subject + '\n\n' + t.body; })(tpl(p)) : script(p);
    var bookingsText = p.bookings === null ? 'Booking counts are unavailable right now. Refresh to try again.'
      : p.bookings ? p.bookings + (p.bookings === 1 ? ' booking' : ' bookings') + ', ' + p.completedJobs + ' completed' + (p.bookingRefs.length ? ' (' + p.bookingRefs.map(esc).join(', ') + ')' : '') : 'No bookings through this link yet';
    var html = '<div class="partners-detail-head"><div><div class="partners-eyebrow">' + esc(kind.label) + (p.rank ? ' &middot; Rank ' + esc(p.rank) : '') + (p.source === 'manual' ? ' &middot; Added by you' : '') + '</div><h3>' + esc(p.name) + '</h3></div></div>';
    html += '<dl class="partners-facts">';
    if (p.phone) html += fact('Phone', '<a href="tel:' + esc(p.phone.replace(/[^\d+]/g, '')) + '">' + esc(p.phone) + '</a>' + copyButton(p.phone, 'Phone'));
    if (p.email) html += fact('Email', esc(p.email) + copyButton(p.email, 'Email'));
    if (p.website) html += fact('Website', '<a href="' + esc(p.website) + '" target="_blank" rel="noopener">' + esc(p.website.replace(/^https?:\/\/(www\.)?/, '').replace(/[?#].*$/, '').replace(/\/$/, '')) + '</a>');
    if (p.address) html += fact('Address', esc(p.address));
    if (p.rating) html += fact('Google', esc(p.rating.toFixed(1)) + ' stars, ' + esc(p.reviewCount || 0) + ' reviews');
    if (p.mapsUrl) html += fact('Map', '<a href="' + esc(p.mapsUrl) + '" target="_blank" rel="noopener">Open in Google Maps</a>');
    if (p.social.length) html += fact('Social', p.social.map(function(u) { return '<a href="' + esc(u) + '" target="_blank" rel="noopener">' + (u.indexOf('facebook') !== -1 ? 'Facebook' : u.indexOf('instagram') !== -1 ? 'Instagram' : u.indexOf('linkedin') !== -1 ? 'LinkedIn' : 'Profile') + '</a>'; }).join(' '));
    html += '</dl>';
    html += '<section class="partners-section"><h4>Their booking link</h4><p class="partners-link">' + esc(p.bookingLink) + copyButton(p.bookingLink, 'Booking link') + '</p><p class="partners-muted">Bookings made through this link are counted here automatically. ' + esc(bookingsText) + '.</p></section>';
    html += '<section class="partners-section"><h4>Stage</h4><div class="partners-stagebtns">' + (state.data.stages || []).map(function(s) {
      return '<button type="button" data-partner-set-stage="' + esc(s.id) + '" aria-pressed="' + (p.stage === s.id) + '"><span class="partners-dot" data-stage="' + esc(s.id) + '"></span>' + esc(s.label) + '</button>';
    }).join('') + '</div>';
    html += '<div class="partners-row2"><label class="partners-field">Follow up on<input type="date" id="partners-followup" value="' + esc(p.followUpOn || '') + '"></label>' +
      '<button type="button" class="partners-button" data-partner-log-contact>Log a contact today</button></div>' +
      '<p class="partners-muted">Contacted ' + (p.lastContactedOn ? 'last on ' + esc(fmtDate(p.lastContactedOn)) : 'not yet') + '. Logging a contact sets the next follow-up 5 days out.</p></section>';
    html += '<section class="partners-section"><h4>Notes</h4><textarea id="partners-notes" rows="4" maxlength="4000" placeholder="Who you spoke to, what they said, cards left">' + esc(p.notes || '') + '</textarea>' +
      '<div class="partners-row2"><button type="button" class="partners-button partners-primary" data-partner-save-notes>Save notes</button><span id="partners-save-status" class="partners-muted" role="status"></span></div></section>';
    html += '<section class="partners-section"><div class="partners-row2 partners-between"><div class="partners-tabs"><button type="button" data-partner-pitch="email" aria-pressed="' + (state.pitch === 'email') + '">Email (template ' + esc(kind.template) + ')</button><button type="button" data-partner-pitch="script" aria-pressed="' + (state.pitch === 'script') + '">Walk-in or call</button></div>' +
      '<button type="button" class="partners-button partners-primary" data-partner-copy="' + esc(pitchText) + '" data-partner-copy-what="' + (state.pitch === 'email' ? 'Email' : 'Script') + '">Copy</button></div><pre class="partners-pitch">' + esc(pitchText) + '</pre></section>';
    if (p.history.length) {
      html += '<section class="partners-section"><h4>History</h4><ol class="partners-history">' + p.history.slice().reverse().map(function(h) {
        var when = new Date(h.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
        var what = h.event === 'stage' ? 'Moved from ' + stageLabel(h.from) + ' to ' + stageLabel(h.to) : h.event === 'contact' ? 'Contact logged' : h.event === 'added' ? 'Added' : h.event;
        return '<li>' + esc(what) + '<span>' + esc(when) + '</span></li>';
      }).join('') + '</ol></section>';
    }
    box.innerHTML = html;
  }
  function renderSetup() {
    var data = state.data; var box = el('partners-setup');
    if (data.tableMissing) { box.hidden = false; box.innerHTML = '<strong>Partners are not set up yet.</strong> ' + esc(data.message); return; }
    if (data.seedAvailable && !data.seedImported) {
      box.hidden = false;
      box.innerHTML = '<strong>' + esc(data.seedAvailable) + ' ranked partners from the Google Maps search are ready.</strong> Apartments, property managers, movers, realtors and furniture stores in Austin and the surrounding cities. <button type="button" class="partners-button partners-primary" data-partner-import>Load the partner list</button>';
      return;
    }
    if (!data.bookingCountsAvailable) { box.hidden = false; box.textContent = 'Booking counts could not be read. Partner details are current; refresh to load the counts.'; return; }
    box.hidden = true;
  }
  function render() {
    if (!state.data) return;
    renderSetup();
    var ready = !state.data.tableMissing;
    el('partners-body').hidden = !ready;
    updateBadge();
    if (!ready) return;
    renderHeader(); renderFilters(); renderList(); renderDetail();
  }
  async function load() {
    if (state.loading) return;
    state.loading = true; el('partners-refresh').disabled = true;
    try {
      state.data = await request(); state.error = null;
      el('partners-notice').hidden = true;
      if (!state.selected && state.data.partners && state.data.partners.length && window.matchMedia && !window.matchMedia('(max-width: 900px)').matches) state.selected = visibleList()[0] && visibleList()[0].id;
      render();
    } catch (error) {
      state.error = error.message;
      el('partners-notice').hidden = false; el('partners-notice').textContent = error.message + (state.data ? ' Showing the last list loaded.' : '');
      updateBadge();
    } finally { state.loading = false; el('partners-refresh').disabled = false; }
  }
  function replacePartner(updated) {
    var list = partners(); var i = list.findIndex(function(p) { return p.id === updated.id; });
    var prev = i >= 0 ? list[i] : null;
    // Booking counts are not part of a save response; keep the ones already loaded.
    if (prev) { updated.bookings = prev.bookings; updated.completedJobs = prev.completedJobs; updated.bookingRefs = prev.bookingRefs; list[i] = updated; }
    else list.unshift(updated);
  }
  async function save(body, statusText) {
    var status = el('partners-save-status');
    try {
      var data = await post(Object.assign({ action: 'update', id: state.selected }, body));
      replacePartner(data.partner);
      // The summary lists (due, contacted this week) are decided by the server; reload them.
      var fresh = await request(); state.data = fresh;
      render();
      if (statusText && el('partners-save-status')) el('partners-save-status').textContent = statusText;
    } catch (error) {
      if (status) status.textContent = error.message; else { el('partners-notice').hidden = false; el('partners-notice').textContent = error.message; }
    }
  }
  function toast(text) {
    var n = el('partners-toast'); if (!n) return;
    n.textContent = text; n.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(function() { n.hidden = true; }, 1800);
  }
  async function copy(text, what) {
    try { await navigator.clipboard.writeText(text); toast(what + ' copied'); }
    catch (e) {
      var ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); toast(what + ' copied'); } catch (_) { toast('Select the text and copy it'); }
      ta.remove();
    }
  }

  document.addEventListener('click', async function(event) {
    if (!event.target.closest('#partners-view')) return;
    var t;
    if ((t = event.target.closest('[data-partner-id]'))) {
      state.selected = t.dataset.partnerId; renderList(); renderDetail();
      if (window.matchMedia && window.matchMedia('(max-width: 900px)').matches) el('partners-detail').scrollIntoView({ block: 'start', behavior: 'smooth' });
      return;
    }
    if ((t = event.target.closest('[data-partner-stage-filter]'))) { state.stage = t.dataset.partnerStageFilter; state.limit = 80; renderFilters(); renderList(); return; }
    if (event.target.closest('#partners-refresh')) { load(); return; }
    if (event.target.closest('#partners-due')) { state.focus = state.focus === 'due' ? null : 'due'; state.stage = 'all'; render(); return; }
    if (event.target.closest('#partners-week')) { state.focus = state.focus === 'week' ? null : 'week'; state.stage = 'all'; render(); return; }
    if (event.target.closest('[data-partner-more]')) { state.limit += 100; renderList(); return; }
    if ((t = event.target.closest('[data-partner-copy]'))) { copy(t.dataset.partnerCopy, t.dataset.partnerCopyWhat || 'Text'); return; }
    if ((t = event.target.closest('[data-partner-pitch]'))) { state.pitch = t.dataset.partnerPitch; renderDetail(); return; }
    if ((t = event.target.closest('[data-partner-set-stage]'))) { t.disabled = true; await save({ stage: t.dataset.partnerSetStage }, 'Saved'); return; }
    if ((t = event.target.closest('[data-partner-log-contact]'))) { t.disabled = true; await save({ loggedContact: true }, 'Contact logged'); return; }
    if ((t = event.target.closest('[data-partner-save-notes]'))) {
      t.disabled = true; el('partners-save-status').textContent = 'Saving...';
      await save({ notes: el('partners-notes').value }, 'Notes saved');
      return;
    }
    if ((t = event.target.closest('[data-partner-import]'))) {
      t.disabled = true; t.textContent = 'Loading partners...';
      try {
        var result = await post({ action: 'import_seed' });
        await load();
        toast(result.inserted + ' partners loaded');
      } catch (error) { el('partners-setup').textContent = error.message; }
    }
  });
  document.addEventListener('change', function(event) {
    if (!event.target.closest('#partners-view')) return;
    if (event.target.id === 'partners-kind') { state.kind = event.target.value; state.limit = 80; renderFilters(); renderList(); }
    else if (event.target.id === 'partners-city') { state.city = event.target.value; state.limit = 80; renderFilters(); renderList(); }
    else if (event.target.id === 'partners-followup') { save({ followUpOn: event.target.value || null }, 'Follow-up saved'); }
  });
  var searchTimer;
  document.addEventListener('input', function(event) {
    if (event.target.id !== 'partners-search') return;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function() { state.q = event.target.value; state.limit = 80; renderFilters(); renderList(); }, 150);
  });
  document.addEventListener('submit', async function(event) {
    if (event.target.id !== 'partners-add-form') return;
    event.preventDefault();
    var status = el('partners-add-status'); var button = event.target.querySelector('button[type=submit]');
    button.disabled = true; status.textContent = 'Adding...';
    try {
      var data = await post({ action: 'create', name: el('partners-add-name').value, kind: el('partners-add-kind').value,
        city: el('partners-add-city').value, phone: el('partners-add-phone').value, email: el('partners-add-email').value, website: el('partners-add-website').value });
      event.target.reset(); el('partners-add-city').value = 'Austin';
      state.selected = data.partner.id; state.stage = 'all'; state.focus = null;
      await load();
      status.textContent = data.partner.name + ' added.';
    } catch (error) { status.textContent = error.message; }
    finally { button.disabled = false; }
  });

  window.OwnerPartners = { load: load, refresh: load, loadBadge: loadBadge };
})();
