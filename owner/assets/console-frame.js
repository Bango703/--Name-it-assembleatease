// Owner console frame (owner, 2026-11-16: "make sure every area follows the
// same update"). The parts every owner screen draws: number cards, tabs with
// counts. One builder, so the screens cannot drift apart; each screen decides
// what its numbers are, always the length of a list the server sent, and what
// a card opens. Styles: owner/assets/console.css ("every screen").
(function () {
  'use strict';
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  var ICONS = {
    alert: '<path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>',
    clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
    check: '<circle cx="12" cy="12" r="10"/><path d="m8 12 3 3 5-6"/>',
    trend: '<polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/>',
    user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
    phone: '<path d="M5 3h4l2 5-3 2a14 14 0 0 0 6 6l2-3 5 2v4a2 2 0 0 1-2 2C10 21 3 14 3 5a2 2 0 0 1 2-2Z"/>',
    star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
    money: '<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
    gift: '<rect x="3" y="8" width="18" height="13" rx="2"/><path d="M3 12h18"/><path d="M12 8v13"/><path d="M12 8c-1.5-3-5-3.5-5-1s3.5 1 5 1c1.5 0 5 1.5 5-1s-3.5-2-5 1z"/>',
    mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 6-10 7L2 6"/>',
    chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    photo: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="10" r="1.5"/><path d="m21 15-5-5L5 19"/>',
    chart: '<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>',
    pause: '<circle cx="12" cy="12" r="10"/><line x1="10" y1="15" x2="10" y2="9"/><line x1="14" y1="15" x2="14" y2="9"/>',
    stop: '<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>',
    send: '<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>',
    eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
    eyeOff: '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/>',
    tag: '<path d="M20.59 13.41 13.42 20.58a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/>',
    spark: '<path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/>',
  };
  function icon(name, size) {
    var s = size || 18;
    return '<svg viewBox="0 0 24 24" width="' + s + '" height="' + s + '" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">' + (ICONS[name] || ICONS.chart) + '</svg>';
  }
  // A number card. c: { key, tone, icon, value, label, sub, id, active, open }.
  // A card opens its list unless open === false (a money total or an average,
  // which is a figure about a list rather than a list).
  function kpi(c) {
    var opens = c.open !== false;
    var tag = opens ? 'button' : 'div';
    return '<' + tag + (opens ? ' type="button" aria-pressed="' + (c.active ? 'true' : 'false') + '"' : '')
      + ' class="kpi' + (opens ? '' : ' is-static') + (c.active ? ' is-active' : '') + '" data-kpi="' + esc(c.key) + '">'
      + '<span class="kpi-icon kpi-' + esc(c.tone || 'brand') + '">' + icon(c.icon) + '</span>'
      + '<span class="kpi-body"><span class="kpi-value"' + (c.id ? ' id="' + esc(c.id) + '"' : '') + '>' + esc(c.value) + '</span>'
      + '<span class="kpi-label">' + esc(c.label) + '</span>'
      + (c.sub ? '<span class="kpi-sub">' + esc(c.sub) + '</span>' : '') + '</span></' + tag + '>';
  }
  function kpiRow(cards) {
    return '<div class="kpi-row v2-kpis">' + cards.map(kpi).join('') + '</div>';
  }
  // Tabs with counts. items: [{ key, label, count }]; attr is the data
  // attribute each screen listens for (for example 'data-today-tab').
  function tabs(items, active, attr) {
    return '<div class="tabs bk-tabs" role="tablist">' + items.map(function (t) {
      var on = t.key === active;
      return '<button type="button" role="tab" class="tab' + (on ? ' active' : '') + '" aria-selected="' + on + '" ' + attr + '="' + esc(t.key) + '">'
        + esc(t.label) + (t.count == null ? '' : ' <span class="tab-count">' + esc(t.count) + '</span>') + '</button>';
    }).join('') + '</div>';
  }
  // Bring a section into view and mark it, so a card that points at a panel
  // further down shows where it went.
  function reveal(node) {
    if (!node || !node.scrollIntoView) return;
    node.scrollIntoView({ block: 'start', behavior: 'smooth' });
    node.classList.remove('v2-flash');
    void node.offsetWidth;
    node.classList.add('v2-flash');
  }
  window.OwnerFrame = { esc: esc, icon: icon, kpi: kpi, kpiRow: kpiRow, tabs: tabs, reveal: reveal };
})();
