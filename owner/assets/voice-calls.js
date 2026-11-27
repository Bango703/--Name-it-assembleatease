(function() {
  'use strict';
  var state = { calls: [], selected: null, cursor: null, loading: false, detail: null, badgeStarted: false, tab: 'all' };
  // Cards and tabs over the calls loaded on this page. A count is the number of
  // rows its tab lists; older activity adds to every count when it loads.
  var TABS = [
    { key: 'all', label: 'All' },
    { key: 'unreviewed', label: 'Unreviewed' },
    { key: 'missed', label: 'Not answered' },
    { key: 'request', label: 'With a request' },
  ];
  var NOT_ANSWERED = ['no-answer', 'busy', 'canceled', 'failed'];
  function inTab(call, key) {
    if (key === 'unreviewed') return call.reviewState === 'unreviewed';
    if (key === 'missed') return NOT_ANSWERED.indexOf(call.status) !== -1;
    if (key === 'request') return call.requestState === 'saved';
    return true;
  }
  var labels = { initiated: 'Call started', ringing: 'Ringing observed', 'in-progress': 'Answered; end not received',
    completed: 'Call ended', ended: 'Call ended', busy: 'Busy', 'no-answer': 'Not answered', canceled: 'Canceled', failed: 'Call failed',
    conflicting: 'Conflicting outcomes; check provider', incomplete: 'Partial history; check provider' };
  var noticeLabels = { unavailable: 'Email status unavailable', not_applicable: 'No linked request notification',
    not_logged: 'No owner email attempt logged', needs_attention: 'Owner email needs attention', delivered: 'Owner email delivery recorded',
    delivery_unconfirmed: 'Email attempted; delivery not confirmed' };
  function el(id) { return document.getElementById(id); }
  function esc(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, function(c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  // One date style on this screen (list and detail), and phone numbers as the rest of the dashboard shows them.
  function time(value) { return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Not available'; }
  function phone(value) { var d = String(value || '').replace(/\D/g, ''); if (d.length === 11 && d.charAt(0) === '1') d = d.slice(1); return d.length === 10 ? d.slice(0, 3) + '-' + d.slice(3, 6) + '-' + d.slice(6) : (value || ''); }
  function cap(value) { var t = String(value || ''); return t ? t.charAt(0).toUpperCase() + t.slice(1) : t; }
  function shortTime(value) { return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Not available'; }
  function label(call) { return labels[call.status] || 'Outcome not known'; }
  async function request(suffix, options) {
    var response = await fetch('/api/owner/voice-calls' + suffix, Object.assign({ cache: 'no-store',
      headers: typeof window._ownerHeaders === 'function' ? window._ownerHeaders() : {} }, options || {}));
    var data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Phone call history is unavailable.');
    return data;
  }
  function updateBadge(data) {
    var badge = el('nav-voice-calls'); if (!badge) return;
    var unknown = !data || !data.enabled || !data.reviewStateAvailable;
    badge.textContent = unknown ? '!' : String(data.unreviewed) + (data.nextCursor ? '+' : '');
    badge.title = unknown ? 'Call capture or review status needs attention' : 'Unreviewed calls in the latest page of the 30-day inbox; open for older activity';
    badge.style.display = unknown || data.unreviewed || data.nextCursor ? '' : 'none';
  }
  async function loadBadge() {
    try { updateBadge(await request('')); } catch { updateBadge(null); }
    if (!state.badgeStarted) {
      state.badgeStarted = true;
      window.setInterval(function() {
        var headers = typeof window._ownerHeaders === 'function' ? window._ownerHeaders() : {};
        if (document.hidden || !Object.keys(headers).some(function(k) { return k.toLowerCase() === 'authorization'; })) return;
        // Do not steal selection or replace a paginated list while the owner reads it.
        loadBadge();
      }, 60000);
    }
  }
  function renderFrame() {
    var F = window.OwnerFrame; if (!F) return;
    var counts = {};
    TABS.forEach(function(t) { counts[t.key] = state.calls.filter(function(c) { return inTab(c, t.key); }).length; });
    el('voice-calls-kpis').innerHTML = F.kpiRow([
      { key: 'all', tone: 'brand', icon: 'phone', value: counts.all, label: 'Calls', sub: state.cursor ? 'Loaded so far, last 30 days' : 'Last 30 days', active: state.tab === 'all' },
      { key: 'unreviewed', tone: counts.unreviewed ? 'warn' : 'ok', icon: 'eye', value: counts.unreviewed, label: 'Unreviewed', sub: 'Not marked reviewed', active: state.tab === 'unreviewed' },
      { key: 'missed', tone: counts.missed ? 'bad' : 'info', icon: 'stop', value: counts.missed, label: 'Not answered', sub: 'Busy, missed or failed', active: state.tab === 'missed' },
      { key: 'request', tone: 'ok', icon: 'link', value: counts.request, label: 'With a request', sub: 'A Case is linked', active: state.tab === 'request' },
    ]);
    el('voice-calls-tabs').innerHTML = F.tabs(TABS.map(function(t) { return { key: t.key, label: t.label, count: counts[t.key] }; }), state.tab, 'data-voice-tab');
  }
  function reviewPill(call) {
    return call.reviewState === 'reviewed' ? '<span class="c-pill c-pill--ok">Reviewed</span>'
      : call.reviewState === 'unavailable' ? '<span class="c-pill c-pill--info">Review status unavailable</span>'
      : '<span class="c-pill c-pill--warn">Unreviewed</span>';
  }
  function renderList() {
    renderFrame();
    var rows = state.calls.filter(function(c) { return inTab(c, state.tab); });
    el('voice-calls-list').innerHTML = rows.length ? rows.map(function(call) {
      var party = call.direction === 'outbound' ? call.to : call.from;
      return '<button type="button" class="v2-item voice-call-row" aria-pressed="' + (call.reference === state.selected) + '" data-voice-call="' + esc(call.reference) + '">' +
        '<span><span class="v2-item-title">' + esc(party ? phone(party) : 'Number unavailable') + '</span><span class="v2-item-sub">' + esc(label(call)) + ' &middot; ' + esc(cap(call.direction)) + '</span></span>' +
        '<span class="v2-item-side">' + esc(shortTime(call.firstObservedAt)) + reviewPill(call) + '</span></button>';
    }).join('') : state.calls.length
      ? '<div class="voice-call-empty">No calls in this tab.</div>'
      : '<div class="voice-call-empty">No call events found in this 30-day view. Check capture and route coverage above before concluding that no one called.</div>';
    el('voice-calls-more').hidden = !state.cursor;
  }
  function fact(name, value) { return '<div><dt>' + esc(name) + '</dt><dd>' + esc(value) + '</dd></div>'; }
  function renderDetail(call) {
    var requestText = call.requestState === 'saved' ? 'Confirmed request linked below. See the Case for the caller-provided details and permitted follow-up.'
      : call.requestState === 'unavailable' ? 'Request lookup unavailable. Do not assume the caller has no Case.'
      : 'No confirmed request found at this check. A request can arrive later. This does not prove why the caller ended the call.';
    var html = '<h2>' + esc(label(call)) + '</h2><p class="voice-muted">Caller ID is unverified. A call record is not a booking or permission to contact someone.</p>';
    html += '<dl class="voice-call-facts v2-facts">' + fact('From', call.from ? phone(call.from) : 'Unavailable') + fact('To', call.to ? phone(call.to) : 'Unavailable') +
      fact('Direction', cap(call.direction)) + fact('First event observed', time(call.firstObservedAt)) +
      fact('Latest event observed', time(call.lastObservedAt)) + fact('Provider-reported call duration', call.durationSeconds == null ? 'Not supplied' : call.durationSeconds + ' seconds') + '</dl>';
    if (!call.terminalObserved) html += '<p class="voice-calls-note">No end event has been received. This is the last observed state, not proof that the call is still active.</p>';
    if (!call.complete) html += '<p class="voice-calls-error">This call exceeds the event display limit. Review the provider history; marking it reviewed is disabled.</p>';
    html += '<button type="button" class="btn btn-teal c-sm" data-voice-review' + (!call.complete || call.reviewed ? ' disabled' : '') + '>' + (call.reviewed ? 'Reviewed' : 'Mark activity reviewed') + '</button>';
    html += '<p class="voice-muted">Reviewing only clears the call-history indicator. It sends nothing and does not close a Case. New call events require another review.</p>';
    html += '<section class="voice-call-section"><h3>Request and owner notification</h3><p>' + esc(requestText) + '</p><p>' + esc(noticeLabels[call.notificationState] || 'Email status unavailable') + '</p>';
    (call.cases || []).forEach(function(item) {
      html += '<div class="voice-call-case"><strong>' + esc(item.ref) + '</strong><p>' + esc(item.subject) + '<br>' + esc(item.status) + ' &middot; ' + esc(item.severity) + '</p><button type="button" class="btn c-sm" data-voice-case="' + esc(item.id) + '">Open this Case</button></div>';
    });
    html += '</section><section class="voice-call-section"><h3>Call timeline</h3><ol class="voice-call-timeline">';
    call.events.forEach(function(event) {
      html += '<li>' + esc(event.status === 'in-progress' ? 'Call answered' : labels[event.status] || event.status) + '<span>Occurred: ' + esc(time(event.occurredAt)) + '</span><span>Received: ' + esc(time(event.receivedAt)) + ' &middot; ' + esc(event.source === 'texml' ? 'TeXML' : 'Voice API') + '</span></li>';
    });
    html += '</ol></section><section class="voice-call-section"><h3>Call reference</h3><p class="voice-muted" style="overflow-wrap:anywhere">' + esc(call.reference) + '</p>';
    if (call.parentReference) html += '<p>This is a separate leg of a parent call.</p><button type="button" class="btn c-sm" data-voice-call="' + esc(call.parentReference) + '">View parent call</button>';
    html += '</section>';
    el('voice-calls-detail').innerHTML = html;
  }
  async function select(reference, focusDetail) {
    state.selected = reference; state.detail = null; renderList();
    el('voice-calls-detail').innerHTML = '<p>Loading call details...</p>';
    try {
      var data = await request('?reference=' + encodeURIComponent(reference));
      if (state.selected !== reference) return;
      state.detail = data.call; renderDetail(data.call);
      if (focusDetail && window.matchMedia && window.matchMedia('(max-width: 900px)').matches) el('voice-calls-detail').scrollIntoView({ block: 'start', behavior: 'smooth' });
    } catch (error) {
      if (state.selected === reference) el('voice-calls-detail').innerHTML = '<div class="voice-calls-error">' + esc(error.message) + '</div>';
    }
  }
  async function load(more) {
    if (state.loading) return;
    state.loading = true;
    var refreshBtn = el('voice-calls-refresh');
    if (refreshBtn) refreshBtn.disabled = true;
    el('voice-calls-more').disabled = true;
    try {
      var data = await request(more && state.cursor ? '?cursor=' + encodeURIComponent(state.cursor) : '');
      var merged = new Map((more ? state.calls : []).map(function(c) { return [c.reference, c]; }));
      data.calls.forEach(function(c) { merged.set(c.reference, c); });
      state.calls = Array.from(merged.values()); state.cursor = data.nextCursor;
      el('voice-calls-notice').textContent = data.warning + ' ' + data.scope;
      el('voice-calls-updated').textContent = 'Checked ' + new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      if (!more) updateBadge(data);
      renderList();
      if (state.selected) await select(state.selected);
      else if (state.calls.length) await select(state.calls[0].reference);
    } catch (error) {
      el('voice-calls-notice').textContent = error.message + ' Previously displayed information may be stale.';
      updateBadge(null);
    } finally {
      state.loading = false; if (refreshBtn) refreshBtn.disabled = false; el('voice-calls-more').disabled = false;
    }
  }
  document.addEventListener('click', async function(event) {
    var tabPick = event.target.closest('[data-voice-tab]') || event.target.closest('#voice-calls-kpis [data-kpi]');
    if (tabPick) { state.tab = tabPick.getAttribute('data-voice-tab') || tabPick.getAttribute('data-kpi'); renderList(); return; }
    var callButton = event.target.closest('[data-voice-call]');
    if (callButton) { select(callButton.dataset.voiceCall, true); return; }
    if (event.target.closest('#voice-calls-refresh')) { load(false); return; }
    if (event.target.closest('#voice-calls-more')) { load(true); return; }
    var caseButton = event.target.closest('[data-voice-case]');
    if (caseButton) {
      if (window.OwnerCases && typeof window.OwnerCases.open === 'function') window.OwnerCases.open(caseButton.dataset.voiceCase);
      var nav = document.querySelector('[data-view="cases"]'); if (nav) nav.click();
      return;
    }
    var reviewButton = event.target.closest('[data-voice-review]');
    if (reviewButton && state.detail) {
      var reference = state.detail.reference;
      reviewButton.disabled = true;
      try {
        await request('', { method: 'POST', headers: Object.assign({}, window._ownerHeaders(), { 'Content-Type': 'application/json' }),
          body: JSON.stringify({ action: 'review', reference: reference, revision: state.detail.revision }) });
        if (state.selected === reference) await select(reference);
        var item = state.calls.find(function(c) { return c.reference === reference; });
        if (item && state.detail?.reference === reference) { item.reviewState = state.detail.reviewState; renderList(); }
        loadBadge();
      } catch (error) {
        el('voice-calls-notice').textContent = error.message;
        reviewButton.disabled = false;
      }
    }
  });
  window.OwnerVoiceCalls = { load: function() { return load(false); }, refresh: function() { return load(false); }, loadBadge: loadBadge };
})();
