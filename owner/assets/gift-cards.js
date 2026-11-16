// Owner Gift Cards panel: what was sold, what is still owed in service, and
// any card whose email did not go out. Numbers come from /api/owner/gift-cards
// (api/_gift-cards.js owns the rules; balances come from the database ledger).
(function () {
  'use strict';
  var state = { data: null, loading: false, error: null, confirmVoid: null, tab: 'all' };
  // Tabs over the cards the server sent. "Not sent" and "Priority" are the same
  // tests the server's summary counts (api/_gift-cards.js summarizeForOwner), so
  // a card's number is the number of rows its tab lists.
  var TABS = [
    { key: 'all', label: 'All' },
    { key: 'active', label: 'Active' },
    { key: 'unsent', label: 'Email not sent' },
    { key: 'priority', label: 'Priority' },
    { key: 'void', label: 'Void' },
  ];
  function inTab(c, key) {
    if (key === 'active') return c.status === 'active';
    if (key === 'unsent') return c.status === 'active' && !c.deliveredAt;
    if (key === 'priority') return c.status === 'active' && !!c.priorityUntil && new Date(c.priorityUntil) > new Date();
    if (key === 'void') return c.status === 'void';
    return true;
  }
  function el(id) { return document.getElementById(id); }
  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function money(cents) { return '$' + (Number(cents || 0) / 100).toFixed(2); }
  function day(iso) { return iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : ''; }
  function headers(json) { var h = typeof window._ownerHeaders === 'function' ? window._ownerHeaders() : {}; return json ? Object.assign({}, h, { 'Content-Type': 'application/json' }) : h; }
  async function request(options) {
    var response = await fetch('/api/owner/gift-cards', Object.assign({ cache: 'no-store', headers: headers(options && options.method === 'POST') }, options || {}));
    var data = {};
    try { data = await response.json(); } catch (e) { data = {}; }
    if (!response.ok) throw new Error(data.error || 'Gift cards are unavailable. Refresh to try again.');
    return data;
  }
  function note(text, isError) {
    var n = el('giftcards-notice');
    if (!n) return;
    n.textContent = text || '';
    n.hidden = !text;
    n.className = 'giftcards-note' + (isError ? ' giftcards-note-error' : '');
  }

  function tile(label, value, hint) {
    return '<div class="giftcards-tile"><div class="giftcards-tile-label">' + esc(label) + '</div><div class="giftcards-tile-value">' + esc(value) + '</div>' + (hint ? '<div class="giftcards-tile-hint">' + esc(hint) + '</div>' : '') + '</div>';
  }

  function render() {
    var body = el('giftcards-body');
    if (!body) return;
    var d = state.data;
    if (!d) { body.innerHTML = state.error ? '' : '<p class="giftcards-muted">Loading gift cards</p>'; return; }
    var status = d.enabled ? 'On sale' : (d.configured ? 'Not on sale: checkout cannot take codes yet' : 'Not on sale: GIFT_CARD_CODE_SECRET or Stripe is not set');
    el('giftcards-status').textContent = status;
    if (d.tableMissing) { body.innerHTML = '<p class="giftcards-note">' + esc(d.message) + '</p>'; return; }
    var s = d.summary;
    var counts = {};
    TABS.forEach(function (t) { counts[t.key] = d.cards.filter(function (c) { return inTab(c, t.key); }).length; });
    var F = window.OwnerFrame;
    if (F) {
      el('giftcards-kpis').innerHTML = F.kpiRow([
        { key: 'all', tone: 'brand', icon: 'gift', value: money(s.soldCents), label: 'Sold', sub: s.soldCount + ' sold: ' + s.giftCardCount + ' gift cards, ' + s.moveInPassCount + ' passes', active: state.tab === 'all' },
        { key: 'owed', tone: 'warn', icon: 'money', value: money(s.outstandingPaidCents), label: 'Still owed in service', sub: 'Paid credit not used yet', open: false },
        { key: 'bonus', tone: 'info', icon: 'tag', value: money(s.outstandingBonusCents), label: 'Bonus credit live', sub: 'Promotional, expires', open: false },
        { key: 'used', tone: 'ok', icon: 'check', value: money(s.redeemedCents), label: 'Used on bookings', sub: 'Redeemed so far', open: false },
        { key: 'unsent', tone: s.undelivered ? 'bad' : 'ok', icon: 'mail', value: s.undelivered, label: 'Emails not sent', sub: s.undelivered ? 'Resend from the list' : 'All delivered', active: state.tab === 'unsent', open: s.undelivered > 0 },
        { key: 'priority', tone: 'brand', icon: 'clock', value: s.activePriority, label: 'Priority active', sub: 'Move-In Passes inside 30 days', active: state.tab === 'priority', open: s.activePriority > 0 },
      ]);
      el('giftcards-tabs').innerHTML = F.tabs(TABS.map(function (t) { return { key: t.key, label: t.label, count: counts[t.key] }; }), state.tab, 'data-gc-tab');
    }
    var html = '';
    if (!d.cards.length) {
      body.innerHTML = '<div class="v2-empty">No gift cards or Move-In Passes sold yet.</div>';
      return;
    }
    var rows = d.cards.filter(function (c) { return inTab(c, state.tab); });
    html += '<div class="v2-scroll"><table class="giftcards-table c-table"><colgroup><col style="width:9%"><col style="width:15%"><col style="width:7%"><col style="width:12%"><col style="width:15%"><col style="width:15%"><col style="width:11%"><col style="width:16%"></colgroup><thead><tr><th>Bought</th><th>Card</th><th>Paid</th><th>Left</th><th>To</th><th>From</th><th>Email</th><th></th></tr></thead><tbody>';
    if (!rows.length) html += '<tr><td colspan="8" class="v2-empty">No cards in this tab.</td></tr>';
    rows.forEach(function (c) {
      var left = c.status === 'void' ? 'Void' : money(c.balancePaidCents + c.balanceBonusCents) + (c.balanceBonusCents ? ' (' + money(c.balanceBonusCents) + ' bonus, ends ' + day(c.bonusExpiresAt) + ')' : '');
      var mail = c.deliveredAt ? 'Sent ' + day(c.deliveredAt) : (c.deliveryError ? 'Failed: ' + c.deliveryError : 'Not sent yet');
      var actions = c.status === 'active'
        ? '<button type="button" class="btn c-sm" data-resend="' + esc(c.id) + '">Resend code</button>' +
          (state.confirmVoid === c.id
            ? ' <button type="button" class="btn btn-red c-sm" data-void-confirm="' + esc(c.id) + '">Confirm void</button> <button type="button" class="btn c-sm" data-void-cancel="1">Keep</button>'
            : ' <button type="button" class="btn c-sm" data-void="' + esc(c.id) + '">Void</button>')
        : '';
      html += '<tr' + (c.status === 'void' ? ' class="giftcards-void"' : '') + '>' +
        '<td>' + esc(day(c.createdAt)) + '</td>' +
        '<td>' + esc(c.name) + '<div class="giftcards-muted">ending ' + esc(c.last4) + (c.priorityUntil && new Date(c.priorityUntil) > new Date() ? ', priority to ' + esc(day(c.priorityUntil)) : '') + '</div></td>' +
        '<td>' + esc(money(c.paidCents)) + '</td>' +
        '<td>' + esc(left) + '</td>' +
        '<td>' + esc(c.recipientName || '') + '<div class="giftcards-muted">' + esc(c.recipientEmail) + '</div></td>' +
        '<td>' + esc(c.purchaserName || '') + '<div class="giftcards-muted">' + esc(c.purchaserEmail) + '</div></td>' +
        '<td class="' + (c.deliveredAt ? '' : 'giftcards-warn') + '">' + esc(mail) + '</td>' +
        '<td class="giftcards-actions">' + actions + '</td></tr>';
    });
    html += '</tbody></table></div>';
    html += '<div class="v2-foot">' + returnCreditForm()
      + (state.confirmVoid ? '<span class="giftcards-muted">Voiding stops any remaining credit on the card from being used. Use it for a refunded or disputed purchase.</span>' : '') + '</div>';
    body.innerHTML = html;
  }

  function returnCreditForm() {
    return '<form class="giftcards-return" id="giftcards-return-form"><label class="giftcards-muted" for="giftcards-return-ref">Return gift card credit from a refunded booking</label>' +
      '<span class="giftcards-return-row"><input id="giftcards-return-ref" placeholder="AAE-ABC123XYZ0" maxlength="24" autocomplete="off"> ' +
      '<button type="submit" class="btn c-sm">Return credit</button></span></form>';
  }

  function updateBadge() {
    var badge = el('nav-giftcards');
    if (!badge) return;
    var n = state.data && state.data.summary ? state.data.summary.undelivered : 0;
    badge.textContent = String(n);
    badge.title = n + ' gift card emails not sent';
    badge.style.display = n ? '' : 'none';
  }

  async function load() {
    if (state.loading) return;
    state.loading = true;
    note('');
    try { state.data = await request(); state.error = null; } catch (e) { state.error = e.message; note(e.message, true); }
    state.loading = false;
    render();
    updateBadge();
  }

  async function act(body, doneText) {
    note('');
    try {
      var result = await request({ method: 'POST', body: JSON.stringify(body) });
      note(result.message || doneText);
      state.confirmVoid = null;
      await load();
      note(result.message || doneText);
    } catch (e) { note(e.message, true); }
  }

  document.addEventListener('click', function (event) {
    var t = event.target;
    if (!t || !t.closest || !t.closest('#giftcards-view')) return;
    var pick = t.closest('[data-gc-tab], #giftcards-kpis button[data-kpi]');
    if (pick) { state.tab = pick.getAttribute('data-gc-tab') || pick.getAttribute('data-kpi'); render(); return; }
    if (t.dataset.resend) { t.disabled = true; act({ action: 'resend', id: t.dataset.resend }, 'Sent.'); }
    else if (t.dataset.void) { state.confirmVoid = t.dataset.void; render(); }
    else if (t.dataset.voidCancel) { state.confirmVoid = null; render(); }
    else if (t.dataset.voidConfirm) { t.disabled = true; act({ action: 'void', id: t.dataset.voidConfirm, confirm: true, note: 'from dashboard' }, 'Card voided.'); }
    else if (t.id === 'giftcards-refresh') load();
  });

  document.addEventListener('submit', function (event) {
    if (!event.target || event.target.id !== 'giftcards-return-form') return;
    event.preventDefault();
    var input = el('giftcards-return-ref');
    var ref = input ? input.value.trim() : '';
    if (!ref) { note('Enter a booking reference.', true); return; }
    act({ action: 'return_booking_credit', bookingRef: ref }, 'Credit returned.');
  });

  window.OwnerGiftCards = { load: load, refresh: load };
})();
