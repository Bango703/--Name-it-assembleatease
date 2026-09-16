(function () {
  'use strict';

  var state = { notifications: [], loading: false };

  function relativeTime(value) {
    var created = new Date(value || 0).getTime();
    if (!Number.isFinite(created) || created <= 0) return '';
    var seconds = Math.max(0, Math.floor((Date.now() - created) / 1000));
    if (seconds < 60) return 'Just now';
    var minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + 'm ago';
    var hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + 'h ago';
    var days = Math.floor(hours / 24);
    if (days < 7) return days + 'd ago';
    return new Date(created).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  function setBadge(count) {
    var badge = document.getElementById('eh-bell-badge');
    if (!badge) return;
    var total = Math.max(0, Number(count) || 0);
    badge.textContent = total > 99 ? '99+' : String(total);
    badge.style.display = total ? '' : 'none';
    var button = document.getElementById('eh-bell-btn');
    if (button) button.setAttribute('aria-label', total ? 'Notifications, ' + total + ' unread' : 'Notifications');
  }

  // Every page ships the list with inline "Loading..." styling (centered and
  // padded). Drop it with the placeholder so loaded rows use the list's layout.
  function resetList(list) {
    list.removeAttribute('style');
    list.className = 'easer-notification-list';
    list.textContent = '';
  }

  function render(items) {
    var list = document.getElementById('notif-list');
    if (!list) return;
    resetList(list);

    if (!items.length) {
      var empty = document.createElement('div');
      empty.className = 'easer-notification-empty';
      empty.textContent = 'You are all caught up.';
      list.appendChild(empty);
      return;
    }

    items.forEach(function (item) {
      var link = document.createElement('a');
      link.className = 'easer-notification-item' + (item.read ? '' : ' is-unread');
      link.href = item.href || '/assembler/my-assignments';

      var marker = document.createElement('span');
      marker.className = 'easer-notification-marker';
      marker.setAttribute('aria-hidden', 'true');

      var content = document.createElement('span');
      content.className = 'easer-notification-content';
      var title = document.createElement('strong');
      title.textContent = item.title || 'Account update';
      var detail = document.createElement('span');
      detail.textContent = item.detail || 'A new update is available.';
      var time = document.createElement('time');
      time.dateTime = item.createdAt || '';
      time.textContent = relativeTime(item.createdAt);

      content.appendChild(title);
      content.appendChild(detail);
      content.appendChild(time);
      link.appendChild(marker);
      link.appendChild(content);
      list.appendChild(link);
    });
  }

  async function sessionToken() {
    if (!window.supabaseClient) return '';
    var result = await window.supabaseClient.auth.getSession();
    var session = result && result.data && result.data.session;
    return session && session.access_token ? session.access_token : '';
  }

  async function request(method, body) {
    var token = await sessionToken();
    if (!token) return null;
    var response = await fetch('/api/assembler/notifications', {
      method: method,
      headers: Object.assign(
        { Authorization: 'Bearer ' + token },
        body ? { 'Content-Type': 'application/json' } : {}
      ),
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
    if (!response.ok) throw new Error('Notification request failed');
    return response.json();
  }

  async function load() {
    if (state.loading) return;
    state.loading = true;
    try {
      var result = await request('GET');
      if (!result) return;
      state.notifications = Array.isArray(result.notifications) ? result.notifications : [];
      render(state.notifications);
      setBadge(result.unreadCount);
    } catch (error) {
      var list = document.getElementById('notif-list');
      if (list) {
        resetList(list);
        var retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'easer-notification-retry';
        retry.textContent = 'Notifications unavailable. Tap to retry.';
        retry.addEventListener('click', load);
        list.appendChild(retry);
      }
    } finally {
      state.loading = false;
    }
  }

  // Article 16: the badge clears from the server's answer, never from hope.
  // This used to zero the badge and restyle every item as read BEFORE the
  // write, so a failed request left the Easer looking at "all caught up" while
  // the server still held the notifications unread. The write goes first; only
  // a confirmed write redraws, and it redraws from a fresh load of server truth.
  async function markVisibleRead() {
    var unread = state.notifications.filter(function (item) { return !item.read; });
    if (!unread.length) return;
    try {
      await request('POST', { ids: unread.map(function (item) { return item.id; }) });
    } catch (error) {
      // Leave them showing as unread. Reading a notification must never block
      // the job workflow, and a failed write must never look like a success.
      return;
    }
    await load();
  }

  document.addEventListener('DOMContentLoaded', function () {
    var button = document.getElementById('eh-bell-btn');
    if (!button || !document.getElementById('notif-list')) return;
    load();
    button.addEventListener('click', function () {
      window.setTimeout(function () {
        var panel = document.getElementById('notif-panel');
        if (panel && panel.style.display !== 'none') {
          load().then(markVisibleRead);
        }
      }, 0);
    });
  });
}());
