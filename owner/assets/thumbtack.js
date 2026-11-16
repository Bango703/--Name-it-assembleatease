// Owner Thumbtack: leads from Thumbtack and the AAE job each one became. Lead
// activity comes from Thumbtack (api/webhooks); costs, outcomes and the job link
// are the owner's records (api/owner/thumbtack.js decides every total). The
// list sits beside the lead being tracked, on the owner console frame.
(function() {
  'use strict';
  var generation = 0;
  var state = { data: null, tab: 'all', selected: null };
  // Tabs over the leads the server sent. "Jobs booked" is the server's
  // linkedJobs test (outcome booked and a linked AAE job), so the card and the
  // tab list the same rows.
  var TABS = [
    { key: 'all', label: 'All' },
    { key: 'open', label: 'Open' },
    { key: 'booked', label: 'Booked' },
    { key: 'lost', label: 'Not converted' },
  ];
  var OUTCOME = { open: ['warn', 'Open'], booked: ['ok', 'Booked'], not_converted: ['info', 'Not converted'] };
  function el(id) { return document.getElementById(id); }
  function esc(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, function(c) { return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]; }); }
  function money(cents) { return Number.isSafeInteger(cents) ? '$' + (cents / 100).toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 }) : 'Unknown'; }
  function dollars(cents) { return Number.isSafeInteger(cents) ? (cents / 100).toFixed(2) : ''; }
  function auth() { return typeof window._ownerHeaders === 'function' ? window._ownerHeaders() : {}; }
  function status(message, error) { el('thumbtack-status').textContent = message; el('thumbtack-status').style.color = error ? 'var(--c-bad)' : ''; }
  function inTab(lead, key) {
    if (key === 'open') return (lead.owner_outcome || 'open') === 'open';
    if (key === 'booked') return !!lead.booking && lead.owner_outcome === 'booked';
    if (key === 'lost') return lead.owner_outcome === 'not_converted';
    return true;
  }
  function outcomePill(lead) {
    var o = OUTCOME[lead.owner_outcome] || OUTCOME.open;
    return '<span class="c-pill c-pill--' + o[0] + '">' + o[1] + '</span>';
  }
  function when(iso) { return iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''; }
  function fact(name, value) { return '<div><dt>' + esc(name) + '</dt><dd>' + esc(value) + '</dd></div>'; }

  function renderFrame(data) {
    var F = window.OwnerFrame; if (!F) return;
    var s = data.summary || {}; var leads = data.leads || [];
    var counts = {};
    TABS.forEach(function(t) { counts[t.key] = leads.filter(function(l) { return inTab(l, t.key); }).length; });
    var net = s.netAfterLeadCostCents;
    el('thumbtack-summary').innerHTML = F.kpiRow([
      { key: 'all', tone: 'brand', icon: 'users', value: counts.all, label: 'Leads', sub: 'From Thumbtack', active: state.tab === 'all' },
      { key: 'open', tone: counts.open ? 'warn' : 'ok', icon: 'clock', value: counts.open, label: 'Open', sub: 'No outcome recorded', active: state.tab === 'open' },
      { key: 'booked', tone: 'ok', icon: 'calendar', value: counts.booked, label: 'Jobs booked', sub: 'Linked AAE booking', active: state.tab === 'booked' },
      { key: 'cost', tone: 'info', icon: 'tag', value: money(s.netLeadCostCents), label: 'Lead cost', sub: 'Less refunds, credits', open: false },
      { key: 'return', tone: 'info', icon: 'money', value: money(s.platformGrossCents), label: 'Job return', sub: 'Platform gross', open: false },
      { key: 'net', tone: Number.isSafeInteger(net) && net < 0 ? 'bad' : 'ok', icon: 'chart', value: money(net), label: 'Net', sub: 'Return less lead cost', open: false },
    ]);
    el('thumbtack-tabs').innerHTML = F.tabs(TABS.map(function(t) { return { key: t.key, label: t.label, count: counts[t.key] }; }), state.tab, 'data-tt-tab');
  }
  function renderList(data) {
    var all = data.leads || [];
    var leads = all.filter(function(l) { return inTab(l, state.tab); });
    if (!leads.some(function(l) { return l.negotiation_id === state.selected; })) state.selected = leads.length ? leads[0].negotiation_id : null;
    el('thumbtack-leads').innerHTML = leads.length ? leads.map(function(lead) {
      var loc = [lead.city, lead.state].filter(Boolean).join(', ');
      return '<button type="button" class="v2-item" data-tt-lead="' + esc(lead.negotiation_id) + '" aria-pressed="' + (lead.negotiation_id === state.selected) + '">'
        + '<span><span class="v2-item-title">' + esc(lead.service || 'Thumbtack lead') + '</span><span class="v2-item-sub">' + esc([loc, when(lead.lead_created_at)].filter(Boolean).join(' · ')) + '</span></span>'
        + '<span class="v2-item-side">' + esc(money(lead.lead_price_cents)) + outcomePill(lead) + '</span></button>';
    }).join('') : '<div class="v2-empty">' + (all.length ? 'No leads in this tab.' : 'No Thumbtack leads received yet. Once the webhook is connected, new leads and customer messages will appear here.') + '</div>';
  }
  function renderDetail(data) {
    var box = el('thumbtack-detail');
    var lead = (data.leads || []).find(function(l) { return l.negotiation_id === state.selected; });
    if (!lead) { box.innerHTML = '<div class="v2-empty">Choose a lead to track its cost and outcome.</div>'; return; }
    var loc = [lead.city, lead.state].filter(Boolean).join(', ');
    var verified = Number.isSafeInteger(lead.refunded_cents) && Number.isSafeInteger(lead.credited_cents);
    var bookingOptions = '<option value="">Not linked to an AAE job</option>' + (data.bookings || []).map(function(b) { return '<option value="' + esc(b.id) + '" ' + (lead.booking_id === b.id ? 'selected' : '') + '>' + esc(b.ref + ' · ' + (b.service || 'Service') + ' · ' + (b.status || '')) + '</option>'; }).join('');
    box.innerHTML = '<article data-lead="' + esc(lead.negotiation_id) + '">'
      + '<h3>' + esc(lead.service || 'Thumbtack lead') + '</h3>'
      + '<div class="v2-item-sub">' + esc([loc, 'Lead ' + lead.negotiation_id].filter(Boolean).join(' · ')) + '</div>'
      + '<dl class="v2-facts">'
      + fact('Received', when(lead.lead_created_at) || 'Unknown')
      + fact('Initial status', lead.lead_status || 'Unknown')
      + fact('Lead cost', money(lead.lead_price_cents))
      + fact('Linked job', lead.booking ? lead.booking.ref + ' · ' + lead.booking.status : 'Not linked yet')
      + fact('Platform gross return', money(lead.platformGrossCents))
      + fact('Refunds and credits', verified ? 'Verified' : 'Need verification')
      + '</dl>'
      + (lead.latest_message_preview ? '<div class="v2-section"><h4>Latest message</h4><p class="v2-item-text">' + esc(lead.latest_message_preview) + '</p></div>' : '')
      + '<div class="v2-section"><h4>Tracking</h4><div class="v2-form-grid">'
      + '<label class="v2-field">Outcome<select data-outcome><option value="open" ' + (lead.owner_outcome === 'open' ? 'selected' : '') + '>Open / waiting</option><option value="booked" ' + (lead.owner_outcome === 'booked' ? 'selected' : '') + '>Booked</option><option value="not_converted" ' + (lead.owner_outcome === 'not_converted' ? 'selected' : '') + '>Not converted</option></select></label>'
      + '<label class="v2-field">Lead cost ($)<input data-lead-cost type="number" step="0.01" min="0" max="1000000" value="' + esc(dollars(lead.lead_price_cents)) + '"></label>'
      + '<label class="v2-field">Refund ($)<input data-refund type="number" step="0.01" min="0" max="1000000" value="' + esc(dollars(lead.refunded_cents)) + '"></label>'
      + '<label class="v2-field">Courtesy credit ($)<input data-credit type="number" step="0.01" min="0" max="1000000" value="' + esc(dollars(lead.credited_cents)) + '"></label>'
      + '</div><div class="v2-form-grid" style="margin-top:12px"><label class="v2-field">Linked AAE booking<select data-booking>' + bookingOptions + '</select></label></div>'
      + '<div class="v2-actions" style="margin-top:12px"><button type="button" data-save class="btn btn-teal c-sm">Save lead tracking</button></div></div>'
      + '<p class="v2-item-sub" style="margin-top:14px">Thumbtack does not send refund or credit events through the lead webhook. Verify those in Thumbtack and record them here. Linking a booking affects reporting only; it does not modify that booking or payment.</p>'
      + '</article>';
  }
  function render(data) {
    state.data = data;
    var warn = el('thumbtack-warnings');
    var warnings = data.warnings || [];
    warn.hidden = !warnings.length;
    warn.innerHTML = warnings.map(esc).join('<br>');
    renderFrame(data); renderList(data); renderDetail(data);
  }
  async function load() {
    var request = ++generation;
    status('Loading Thumbtack activity…');
    try {
      var response = await fetch('/api/owner/thumbtack', { headers: auth(), cache: 'no-store' });
      var data = await response.json();
      if (request !== generation) return;
      if (!response.ok) throw new Error(response.status === 401 ? 'Owner session expired. Sign in again.' : 'Thumbtack area could not be loaded.');
      render(data);
      status('Updated ' + new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
    } catch (error) { if (request === generation) status(error.message || 'Thumbtack area could not be loaded.', true); }
  }
  el('thumbtack-refresh').addEventListener('click', load);
  el('thumbtack-view').addEventListener('change', function(event) {
    var card = event.target.closest('[data-lead]');
    if (!card) return;
    if (event.target.matches('[data-outcome]') && event.target.value !== 'booked') card.querySelector('[data-booking]').value = '';
    if (event.target.matches('[data-booking]') && event.target.value) card.querySelector('[data-outcome]').value = 'booked';
  });
  el('thumbtack-view').addEventListener('click', async function(event) {
    var pick = event.target.closest('[data-tt-tab], #thumbtack-summary button[data-kpi]');
    if (pick && state.data) { state.tab = pick.getAttribute('data-tt-tab') || pick.getAttribute('data-kpi'); state.selected = null; render(state.data); return; }
    var row = event.target.closest('[data-tt-lead]');
    if (row && state.data) { state.selected = row.getAttribute('data-tt-lead'); renderList(state.data); renderDetail(state.data); return; }
    var button = event.target.closest('[data-save]');
    if (!button) return;
    var card = button.closest('[data-lead]');
    function toCents(selector) {
      var value = card.querySelector(selector).value;
      if (value === '') return null;
      var n = Number(value);
      return Number.isFinite(n) && n >= 0 && n <= 1000000 ? Math.round(n * 100) : NaN;
    }
    var leadPriceCents = toCents('[data-lead-cost]'), refundedCents = toCents('[data-refund]'), creditedCents = toCents('[data-credit]');
    if (Number.isNaN(leadPriceCents) || Number.isNaN(refundedCents) || Number.isNaN(creditedCents)) { status('Enter valid amounts between $0 and $1,000,000.', true); return; }
    button.disabled = true;
    try {
      var update = { negotiationId: card.dataset.lead, bookingId: card.querySelector('[data-booking]').value || null, ownerOutcome: card.querySelector('[data-outcome]').value };
      if (leadPriceCents !== null) update.leadPriceCents = leadPriceCents;
      if (refundedCents !== null) update.refundedCents = refundedCents;
      if (creditedCents !== null) update.creditedCents = creditedCents;
      var response = await fetch('/api/owner/thumbtack', { method: 'POST', headers: Object.assign({ 'Content-Type':'application/json' }, auth()), body: JSON.stringify(update) });
      var data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not save lead tracking.');
      render(data); status('Thumbtack lead tracking saved.');
      if (typeof window._ownerToast === 'function') window._ownerToast('Thumbtack lead updated', 'success');
    } catch (error) { status(error.message || 'Could not save lead tracking.', true); button.disabled = false; }
  });
  function clear() { generation++; state.data = null; state.selected = null; el('thumbtack-leads').innerHTML = ''; el('thumbtack-summary').innerHTML = ''; el('thumbtack-tabs').innerHTML = ''; el('thumbtack-detail').innerHTML = ''; }
  el('logout-btn').addEventListener('click', function() { clear(); status('Sign in to view Thumbtack activity.'); });
  window.OwnerThumbtack = { load: load, clear: clear };
})();
