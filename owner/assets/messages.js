// Owner Messages inbox. Conversations, labels and the "waiting for you" list come
// from /api/owner/messages (api/_owner-inbox.js); this file renders them and opens
// the booking thread to reply. SMS rows open the same inbox with an SMS thread and
// reply through /api/owner/sms-messages.
(function() {
  'use strict';
  var state = { data: null, loading: false, onlyReply: false, badgeStarted: false, selectedSmsId: null, smsLoading: false, sendingSms: false };
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
  async function requestSms(id) {
    var r = await fetch('/api/owner/sms-messages?conversationId=' + encodeURIComponent(id), { headers: headers(), cache: 'no-store' });
    var d = {};
    try { d = await r.json(); } catch (e) { d = {}; }
    if (!r.ok) throw new Error(d.error || 'The SMS conversation could not be loaded.');
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
  function needsReply(c, data) {
    return data.needsReply.indexOf(c.kind === 'sms' ? 'sms:' + c.conversationId : c.bookingId) !== -1;
  }
  function render() {
    var data = state.data; if (!data) return;
    var list = data.conversations.filter(function(c) { return !state.onlyReply || needsReply(c, data); });
    var btn = el('inbox-filter-reply');
    btn.setAttribute('aria-pressed', String(state.onlyReply));
    btn.textContent = 'Waiting for you (' + data.needsReply.length + ')';
    var notes = [];
    if (data.smsAvailable === false) {
      notes.push('SMS conversations could not be loaded. '
        + (data.smsError ? 'Reason: ' + data.smsError : 'Apply the SMS inbox migration and refresh.'));
    }
    el('inbox-notice').hidden = !notes.length; el('inbox-notice').textContent = notes.join(' ');
    if (!list.length) {
      el('inbox-list').innerHTML = '<div class="inbox-empty">' + (state.onlyReply ? 'Nothing is waiting for your reply.' : 'No SMS messages yet. Texts to the business number will appear here.') + '</div>';
      return;
    }
    el('inbox-list').innerHTML = list.map(function(c) {
      var who = [esc(c.customerName || c.phone || 'Customer'), c.easerName ? 'Easer: ' + esc(c.easerName) : null].filter(Boolean).join(' &middot; ');
      var tags = '';
      if (c.needsReply) tags += '<span class="inbox-tag inbox-tag-reply">Waiting for you</span>';
      if (c.unreadForOwner) tags += '<span class="inbox-tag inbox-tag-unread">' + c.unreadForOwner + ' unread</span>';
      return '<button type="button" class="inbox-row' + (c.needsReply ? ' inbox-row-reply' : '') + '" data-inbox-sms="' + esc(c.conversationId) + '">' +
        '<span class="inbox-row-top"><strong>' + esc(c.ref || c.phone || 'SMS conversation') + '</strong><span class="inbox-who">' + who + '</span><span class="inbox-when">' + esc(when(c.lastMessage.at)) + '</span></span>' +
        '<span class="inbox-direction">' + esc(c.lastMessage.direction) + '</span>' +
        '<span class="inbox-body">' + esc(c.lastMessage.body) + '</span>' +
        '<span class="inbox-row-bottom">' + tags + '<span class="inbox-count">SMS conversation</span><span class="inbox-open">Open conversation</span></span>' +
        '</button>';
    }).join('');
  }
  function smsStatusLabel(message) {
    if (message.status === 'suppressed') return 'Not sent — text consent is not recorded';
    if (message.status === 'failed') return 'Failed';
    if (message.status === 'delivered') return 'Delivered';
    return 'Sent';
  }
  function renderSmsThread(data) {
    var title = el('sms-thread-title');
    var meta = el('sms-thread-meta');
    var body = el('sms-thread-body');
    var input = el('sms-reply-input');
    var send = el('sms-reply-send');
    title.textContent = data.conversation.customer_name || data.conversation.profiles?.full_name || data.conversation.phone;
    var booking = data.conversation.bookings;
    var profile = data.conversation.profiles;
    meta.textContent = [
      data.conversation.phone,
      booking ? 'Booking ' + booking.ref : null,
      profile && !booking ? 'Easer: ' + (profile.full_name || profile.email) : null,
    ].filter(Boolean).join(' • ');
    body.innerHTML = (data.messages || []).map(function(message) {
      var outbound = message.direction === 'outbound';
      var label = outbound ? 'You to SMS' : 'SMS to You';
      return '<div class="msg ' + (outbound ? 'owner' : 'customer') + '">' +
        '<div>' + esc(message.body) + '</div>' +
        '<div class="msg-time">' + label + ' • ' + esc(when(message.occurred_at)) + (outbound ? ' • ' + esc(smsStatusLabel(message)) : '') + '</div>' +
        '</div>';
    }).join('') || '<div class="inbox-empty">No SMS messages in this conversation.</div>';
    input.disabled = false;
    send.disabled = false;
    input.placeholder = data.replyEligibility && !data.replyEligibility.consentRecorded
      ? 'Text consent is not recorded for this number yet'
      : 'Reply by text...';
    body.scrollTop = body.scrollHeight;
  }
  async function openSms(id) {
    if (!id || state.smsLoading) return;
    state.smsLoading = true;
    state.selectedSmsId = id;
    var panel = el('sms-panel');
    panel.hidden = false;
    el('sms-thread-body').innerHTML = '<div class="inbox-empty">Loading SMS conversation...</div>';
    el('sms-thread-title').textContent = 'SMS conversation';
    el('sms-thread-meta').textContent = '';
    try {
      renderSmsThread(await requestSms(id));
      await loadBadge();
    } catch (error) {
      el('sms-thread-body').innerHTML = '<div class="inbox-empty">' + esc(error.message) + '</div>';
      el('sms-reply-input').disabled = true;
      el('sms-reply-send').disabled = true;
    } finally { state.smsLoading = false; }
  }
  async function sendSmsReply() {
    var input = el('sms-reply-input');
    var body = input.value.trim();
    if (!body || !state.selectedSmsId || state.sendingSms) return;
    if (!window.confirm('Send this SMS reply to this phone number?')) return;
    state.sendingSms = true;
    el('sms-reply-send').disabled = true;
    input.disabled = true;
    try {
      var r = await fetch('/api/owner/sms-messages', {
        method: 'POST', headers: headers(), body: JSON.stringify({ conversationId: state.selectedSmsId, body: body }),
      });
      var data = {};
      try { data = await r.json(); } catch (e) { data = {}; }
      if (!r.ok || data.error) throw new Error(data.error || 'The SMS reply was not sent.');
      input.value = '';
      await openSms(state.selectedSmsId);
      if (typeof window.toast === 'function') window.toast('SMS reply sent', 'success');
    } catch (error) {
      if (typeof window.toast === 'function') window.toast(error.message, 'error');
      input.disabled = false;
    } finally {
      state.sendingSms = false;
      el('sms-reply-send').disabled = false;
      if (!input.disabled) input.focus();
    }
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
    var row = event.target.closest('[data-inbox-sms]');
    if (row) { await openSms(row.dataset.inboxSms); return; }
    if (event.target.closest('#sms-reply-send')) { await sendSmsReply(); return; }
    if (event.target.closest('#inbox-refresh')) { load(); return; }
    if (event.target.closest('#inbox-filter-reply')) { state.onlyReply = !state.onlyReply; render(); }
  });
  window.OwnerInbox = { load: load, refresh: load, loadBadge: loadBadge };
})();
