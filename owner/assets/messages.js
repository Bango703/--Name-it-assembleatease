// Owner Messages inbox. Conversations, labels and the "waiting for you" list come
// from /api/owner/messages (api/_owner-inbox.js); this file renders them and opens
// the booking thread to reply.
(function() {
  'use strict';
  var state = { data: null, loading: false, onlyReply: false, badgeStarted: false };
  function el(id) { return document.getElementById(id); }
  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function(c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function headers() { return typeof window._ownerHeaders === 'function' ? window._ownerHeaders() : {}; }
  function when(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    var sameDay = d.toDateString() === new Date().toDateString();
    return sameDay ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ', ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  async function request() {
    var r = await fetch('/api/owner/messages', { headers: headers(), cache: 'no-store' });
    var d = {};
    try { d = await r.json(); } catch (e) { d = {}; }
    if (!r.ok) throw new Error(d.error || 'Messages could not be loaded. Refresh to try again.');
    return d;
  }
  function paintBadge() {
    var badge = el('nav-inbox'); if (!badge) return;
    if (!state.data) { badge.style.display = 'none'; return; }
    var n = state.data.needsReply.length;
    badge.textContent = String(n);
    badge.title = n + (n === 1 ? ' conversation is' : ' conversations are') + ' waiting for your reply';
    badge.style.display = n ? '' : 'none';
  }
  function render() {
    var data = state.data; if (!data) return;
    var list = data.conversations.filter(function(c) { return !state.onlyReply || data.needsReply.indexOf(c.bookingId) !== -1; });
    var btn = el('inbox-filter-reply');
    btn.setAttribute('aria-pressed', String(state.onlyReply));
    btn.textContent = 'Waiting for you (' + data.needsReply.length + ')';
    var notes = [];
    if (data.truncated) notes.push('Showing the most recent 1,000 messages.');
    if (!data.bookingDetailsAvailable) notes.push('Booking names could not be loaded; refs may be missing. Refresh to try again.');
    el('inbox-notice').hidden = !notes.length; el('inbox-notice').textContent = notes.join(' ');
    if (!list.length) {
      el('inbox-list').innerHTML = '<div class="inbox-empty">' + (state.onlyReply ? 'Nothing is waiting for your reply.' : 'No messages in the last ' + esc(data.windowDays) + ' days.') + '</div>';
      return;
    }
    el('inbox-list').innerHTML = list.map(function(c) {
      var who = [esc(c.customerName || 'Customer'), c.easerName ? 'Easer: ' + esc(c.easerName) : null].filter(Boolean).join(' &middot; ');
      var tags = '';
      if (c.needsReply) tags += '<span class="inbox-tag inbox-tag-reply">Waiting for you</span>';
      else if (c.direct) tags += '<span class="inbox-tag">Between customer and Easer</span>';
      if (c.unreadForOwner) tags += '<span class="inbox-tag inbox-tag-unread">' + c.unreadForOwner + ' unread</span>';
      return '<button type="button" class="inbox-row' + (c.needsReply ? ' inbox-row-reply' : '') + '" data-inbox-booking="' + esc(c.bookingId) + '" data-inbox-thread="' + esc(c.openThread) + '">' +
        '<span class="inbox-row-top"><strong>' + esc(c.ref || 'Booking') + '</strong><span class="inbox-who">' + who + '</span><span class="inbox-when">' + esc(when(c.lastMessage.at)) + '</span></span>' +
        '<span class="inbox-direction">' + esc(c.lastMessage.direction) + '</span>' +
        '<span class="inbox-body">' + esc(c.lastMessage.body) + '</span>' +
        '<span class="inbox-row-bottom">' + tags + '<span class="inbox-count">' + c.messageCount + (c.messageCount === 1 ? ' message' : ' messages') + '</span><span class="inbox-open">Open conversation</span></span>' +
        '</button>';
    }).join('');
  }
  async function load() {
    if (state.loading) return;
    state.loading = true; el('inbox-refresh').disabled = true;
    try { state.data = await request(); render(); }
    catch (error) {
      el('inbox-notice').hidden = false;
      el('inbox-notice').textContent = error.message + (state.data ? ' Showing the last list loaded.' : '');
      if (!state.data) el('inbox-list').innerHTML = '<div class="inbox-empty">Messages could not be loaded.</div>';
    } finally { state.loading = false; el('inbox-refresh').disabled = false; paintBadge(); }
  }
  async function loadBadge() {
    try { state.data = await request(); } catch (e) { /* keep the last known badge */ }
    paintBadge();
    if (!state.badgeStarted) {
      state.badgeStarted = true;
      window.setInterval(function() {
        if (document.hidden) return;
        var h = headers();
        if (!Object.keys(h).some(function(k) { return k.toLowerCase() === 'authorization' || k.toLowerCase() === 'x-owner-password'; })) return;
        loadBadge();
      }, 120000);
    }
  }
  document.addEventListener('click', async function(event) {
    if (!event.target.closest('#messages-view')) return;
    var row = event.target.closest('[data-inbox-booking]');
    if (row) {
      var ok = typeof window.ownerOpenBookingMessages === 'function' && await window.ownerOpenBookingMessages(row.dataset.inboxBooking, row.dataset.inboxThread);
      if (!ok) { el('inbox-notice').hidden = false; el('inbox-notice').textContent = 'That booking could not be opened. Refresh Bookings and try again.'; }
      return;
    }
    if (event.target.closest('#inbox-refresh')) { load(); return; }
    if (event.target.closest('#inbox-filter-reply')) { state.onlyReply = !state.onlyReply; render(); }
  });
  window.OwnerInbox = { load: load, refresh: load, loadBadge: loadBadge };
})();
