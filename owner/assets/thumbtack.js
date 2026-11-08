(function() {
  'use strict';
  var generation = 0;
  function el(id) { return document.getElementById(id); }
  function esc(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, function(c) { return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]; }); }
  function money(cents) { return Number.isSafeInteger(cents) ? '$' + (cents / 100).toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 }) : 'Unknown'; }
  function dollars(cents) { return Number.isSafeInteger(cents) ? (cents / 100).toFixed(2) : ''; }
  function auth() { return typeof window._ownerHeaders === 'function' ? window._ownerHeaders() : {}; }
  function status(message, error) { el('thumbtack-status').textContent = message; el('thumbtack-status').style.color = error ? '#b91c1c' : 'var(--muted)'; }
  function render(data) {
    var s = data.summary || {};
    var stats = [['Leads', s.leads || 0], ['Lead cost recorded', money(s.leadCostCents)], ['Refunds', money(s.refundsCents)], ['Courtesy credits', money(s.creditsCents)], ['Net lead cost', money(s.netLeadCostCents)], ['Jobs booked', s.linkedJobs || 0], ['Completed job return', money(s.platformGrossCents)], ['Net after lead cost', money(s.netAfterLeadCostCents)]];
    el('thumbtack-summary').innerHTML = stats.map(function(x) { return '<div style="flex:1 1 135px;min-width:0;padding:0.7rem 0.85rem;border:1px solid var(--border);border-radius:8px;background:var(--elevated)"><div style="font-size:1.12rem;font-weight:800;color:var(--text)">' + esc(x[1]) + '</div><div style="font-size:0.74rem;color:var(--muted);margin-top:0.15rem">' + esc(x[0]) + '</div></div>'; }).join('');
    var html = '';
    if ((data.warnings || []).length) html += '<div style="padding:0.65rem 0.8rem;margin-bottom:0.7rem;border:1px solid var(--border-md);border-radius:8px;background:var(--elevated);color:var(--text);font-size:0.78rem;line-height:1.5">' + data.warnings.map(esc).join('<br>') + '</div>';
    if (!data.leads?.length) html += '<p style="color:var(--muted);font-size:0.84rem">No Thumbtack leads received yet. Once the webhook is connected, new leads and customer messages will appear here.</p>';
    html += (data.leads || []).map(function(lead) {
      var loc = [lead.city, lead.state].filter(Boolean).join(', ');
      var bookingOptions = '<option value="">Not linked to an AAE job</option>' + (data.bookings || []).map(function(b) { return '<option value="' + esc(b.id) + '" ' + (lead.booking_id === b.id ? 'selected' : '') + '>' + esc(b.ref + ' · ' + (b.service || 'Service') + ' · ' + (b.status || '')) + '</option>'; }).join('');
      return '<article data-lead="' + esc(lead.negotiation_id) + '" style="border:1px solid var(--border);border-radius:10px;padding:0.85rem;margin:0.6rem 0;background:var(--surface)">'
        + '<div style="display:flex;justify-content:space-between;gap:0.7rem;flex-wrap:wrap"><div><strong>' + esc(lead.service || 'Thumbtack lead') + '</strong>' + (loc ? '<span style="color:var(--muted)"> · ' + esc(loc) + '</span>' : '') + '<div style="font-size:0.74rem;color:var(--muted);margin-top:0.2rem">Lead ' + esc(lead.negotiation_id) + ' · ' + 'Initial status: ' + esc(lead.lead_status || 'Unknown') + (lead.lead_created_at ? ' · ' + esc(new Date(lead.lead_created_at).toLocaleString()) : '') + '</div></div><div style="font-weight:700">' + esc(money(lead.lead_price_cents)) + ' lead cost</div></div>'
        + (lead.latest_message_preview ? '<p style="margin:0.6rem 0;font-size:0.82rem;line-height:1.45">Latest message: ' + esc(lead.latest_message_preview) + '</p>' : '')
        + '<div style="display:flex;gap:0.65rem;flex-wrap:wrap;align-items:end;margin-top:0.7rem"><label style="font-size:0.75rem">Outcome<select data-outcome style="display:block;width:140px;padding:0.48rem;border:1px solid var(--border);border-radius:6px;background:white"><option value="open" ' + (lead.owner_outcome === 'open' ? 'selected' : '') + '>Open / waiting</option><option value="booked" ' + (lead.owner_outcome === 'booked' ? 'selected' : '') + '>Booked</option><option value="not_converted" ' + (lead.owner_outcome === 'not_converted' ? 'selected' : '') + '>Not converted</option></select></label>'
        + '<label style="font-size:0.75rem">Lead cost ($)<input data-lead-cost type="number" step="0.01" min="0" max="1000000" value="' + esc(dollars(lead.lead_price_cents)) + '" style="display:block;width:110px;padding:0.45rem;border:1px solid var(--border);border-radius:6px"></label>'
        + '<label style="font-size:0.75rem">Refund ($)<input data-refund type="number" step="0.01" min="0" max="1000000" value="' + esc(dollars(lead.refunded_cents)) + '" style="display:block;width:100px;padding:0.45rem;border:1px solid var(--border);border-radius:6px"></label>'
        + '<label style="font-size:0.75rem">Courtesy credit ($)<input data-credit type="number" step="0.01" min="0" max="1000000" value="' + esc(dollars(lead.credited_cents)) + '" style="display:block;width:110px;padding:0.45rem;border:1px solid var(--border);border-radius:6px"></label>'
        + '<label style="font-size:0.75rem;flex:1 1 220px">Linked AAE booking<select data-booking style="display:block;width:100%;padding:0.48rem;border:1px solid var(--border);border-radius:6px;background:white">' + bookingOptions + '</select></label>'
        + '<button type="button" data-save class="btn">Save lead tracking</button></div>'
        + '<div style="font-size:0.76rem;color:var(--muted);margin-top:0.55rem">' + (lead.booking ? 'Linked job: ' + esc(lead.booking.ref) + ' · ' + esc(lead.booking.status) + ' · platform gross return ' + esc(money(lead.platformGrossCents)) : 'No AAE job linked yet.') + ((Number.isSafeInteger(lead.refunded_cents) && Number.isSafeInteger(lead.credited_cents)) ? ' · Refunds and credits verified.' : ' · Refund and credit amounts need verification.') + '</div></article>';
    }).join('');
    el('thumbtack-leads').innerHTML = html;
  }
  async function load() {
    var request = ++generation;
    status('Loading Thumbtack activity…');
    el('thumbtack-leads').innerHTML = '';
    try {
      var response = await fetch('/api/owner/thumbtack', { headers: auth(), cache: 'no-store' });
      var data = await response.json();
      if (request !== generation) return;
      if (!response.ok) throw new Error(response.status === 401 ? 'Owner session expired. Sign in again.' : 'Thumbtack area could not be loaded.');
      render(data);
      status('Thumbtack leads and linked AAE job results. Lead cost refunds/credits must be verified in Thumbtack and entered here.');
    } catch (error) { if (request === generation) status(error.message || 'Thumbtack area could not be loaded.', true); }
  }
  el('thumbtack-refresh').addEventListener('click', load);
  el('thumbtack-leads').addEventListener('change', function(event) {
    var card = event.target.closest('[data-lead]');
    if (!card) return;
    if (event.target.matches('[data-outcome]') && event.target.value !== 'booked') card.querySelector('[data-booking]').value = '';
    if (event.target.matches('[data-booking]') && event.target.value) card.querySelector('[data-outcome]').value = 'booked';
  });
  el('thumbtack-leads').addEventListener('click', async function(event) {
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
  el('logout-btn').addEventListener('click', function() { generation++; el('thumbtack-leads').innerHTML = ''; status('Sign in to view Thumbtack activity.'); });
  window.OwnerThumbtack = { load: load, clear: function() { generation++; el('thumbtack-leads').innerHTML = ''; } };
})();
