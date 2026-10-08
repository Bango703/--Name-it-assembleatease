(function() {
  'use strict';
  var generation = 0;
  function el(id) { return document.getElementById(id); }
  function esc(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, function(c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function money(value) { return value == null || !Number.isFinite(Number(value)) ? 'Unknown' : '$' + (Number(value) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function headers() { return typeof window._ownerHeaders === 'function' ? window._ownerHeaders() : {}; }
  function clear() { generation++; el('acquisition-report').innerHTML = ''; el('acquisition-status').textContent = 'Report has not loaded.'; el('acquisition-refresh').disabled = false; }
  function records(group) {
    return '<details><summary>View ' + Number(group.bookings || 0) + ' booking records</summary><ul style="padding-left:1rem;max-height:220px;overflow:auto">'
      + (group.rows || []).map(function(row) { return '<li style="margin:0.6rem 0;overflow-wrap:anywhere"><button type="button" class="btn" data-demand-booking="' + esc(row.bookingId) + '">' + esc(row.ref) + '</button> ' + esc(row.city) + ' · ' + esc(row.createdDate || 'Date unknown') + ' · ' + esc(row.status) + '<br>' + esc(row.channel) + ' · Recorded retained payments: ' + money(row.recordedPaymentsCents) + '<br><span style="color:var(--muted)">' + esc(row.financeBasis) + '</span></li>'; }).join('') + '</ul></details>';
  }
  function table(title, groups, city) {
    return '<h3 style="font-size:0.92rem;margin:1rem 0 0.5rem">' + esc(title) + '</h3><div tabindex="0" role="region" aria-label="' + esc(title) + '" style="overflow:auto;max-width:100%"><table style="min-width:700px;width:100%;border-collapse:collapse;font-size:0.78rem"><thead><tr>'
      + [city ? 'Service city' : 'Recorded channel', 'Bookings', 'Completed', 'Cancelled / lost', 'Open', city ? 'Organic search bookings / completed' : 'Known contacts', city ? 'Organic search retained payments' : 'Retained payments'].map(function(label) { return '<th scope="col" style="text-align:left;padding:0.5rem;border-bottom:1px solid var(--border)">' + esc(label) + '</th>'; }).join('')
      + '</tr></thead><tbody>' + groups.map(function(group) {
        return '<tr><th scope="row" style="text-align:left;padding:0.5rem;min-width:170px">' + esc(group.label) + records(group) + '</th>'
          + [group.bookings, group.completed, group.cancelled, group.open, city ? Number(group.organicBookings || 0) + ' / ' + Number(group.organicCompleted || 0) : Number(group.uniqueContacts || 0) + (group.missingContact ? ' (+' + group.missingContact + ' without contact)' : ''), city ? money(group.organicRecordedPaymentsCents) : money(group.recordedPaymentsCents)].map(function(value) { return '<td style="padding:0.5rem;border-bottom:1px solid var(--border);vertical-align:top">' + esc(value) + '</td>'; }).join('') + '</tr>';
      }).join('') + '</tbody></table></div>';
  }
  function render(data) {
    var summary = data.summary;
    var range = data.range;
    var stamp = new Date(data.generatedAt).toLocaleString('en-US', { timeZone: 'America/Chicago', timeZoneName: 'short' });
    el('acquisition-status').textContent = (data.partial ? 'Partial report. ' : '') + (range.from ? range.from + ' through ' + range.to : 'All available creation dates') + ' · America/Chicago · Snapshot ' + stamp;
    var html = '<p style="font-size:0.82rem;line-height:1.7"><strong>' + Number(summary.bookings) + ' recorded bookings · ' + Number(summary.completed) + ' completed · ' + Number(summary.incompleteAttribution) + ' with incomplete source evidence.</strong><br>Completed-job retained payments: ' + money(summary.recordedPaymentsCents) + ' · Recorded platform gross before overhead/reserves: ' + money(summary.platformGrossCents) + '<br>Explicit test records excluded: ' + Number(data.excludedTests) + '.</p>';
    if (data.warnings.length) html += '<p style="color:var(--red);font-size:0.8rem;line-height:1.5">' + data.warnings.map(esc).join(' ') + '</p>';
    html += data.channels.length ? table('Outcomes by original channel', data.channels, false) + table('Outcomes by requested service city', data.markets, true) : '<p>No booking records in this creation-date period.</p>';
    html += '<ul style="font-size:0.76rem;color:var(--muted);line-height:1.5">' + data.notes.map(function(note) { return '<li>' + esc(note) + '</li>'; }).join('') + '</ul>';
    el('acquisition-report').innerHTML = html;
  }
  async function load() {
    var auth = headers();
    if (!auth.Authorization || auth.Authorization === 'Bearer ') { clear(); return; }
    var request = ++generation;
    var period = el('acquisition-period').value;
    el('acquisition-refresh').disabled = true;
    el('acquisition-status').textContent = 'Loading acquisition outcomes...';
    // Clear the old cohort so a new date selection never labels stale figures.
    el('acquisition-report').innerHTML = '';
    var failureMessage = 'The acquisition report could not be loaded. Try again.';
    try {
      var response = await fetch('/api/owner/acquisition?period=' + encodeURIComponent(period), { headers: auth, cache: 'no-store' });
      if (response.status === 401 || response.status === 403) failureMessage = 'Your owner session has expired. Sign in again to load the report.';
      else if (response.status === 400) failureMessage = 'Choose a 28-day, 90-day or all-time report.';
      else if (response.status === 503) failureMessage = 'Booking records are temporarily unavailable. Try again.';
      var data = await response.json();
      if (request !== generation) return;
      if (headers().Authorization !== auth.Authorization) { clear(); return; }
      if (!response.ok || data.error) throw new Error('Report unavailable');
      render(data);
    } catch (error) {
      if (request === generation) {
        if (headers().Authorization !== auth.Authorization) clear();
        else el('acquisition-status').textContent = failureMessage + ' Missing counts are not zero.';
      }
    } finally {
      if (request === generation) el('acquisition-refresh').disabled = false;
    }
  }
  function internalStatus() {
    var field = el('acquisition-internal'), status = el('acquisition-internal-status');
    try {
      field.checked = localStorage.getItem('aae-analytics-internal') === '1';
      field.disabled = false;
      status.textContent = (field.checked ? 'This browser is excluded from website analytics.' : 'This browser follows the normal website analytics consent setting.') + ' Applies on the next public-page load. Booking/payment records and test flags remain unchanged.';
    } catch { field.disabled = true; status.textContent = 'Browser storage is unavailable. No analytics exclusion was changed.'; }
  }
  el('acquisition-refresh').addEventListener('click', load);
  el('acquisition-period').addEventListener('change', load);
  el('logout-btn').addEventListener('click', clear);
  el('acquisition-internal').addEventListener('change', function() {
    try {
      if (this.checked) localStorage.setItem('aae-analytics-internal', '1');
      else localStorage.removeItem('aae-analytics-internal');
    } catch { internalStatus(); el('acquisition-internal-status').textContent = 'Could not save the browser setting. No analytics exclusion was changed.'; return; }
    internalStatus();
  });
  window.addEventListener('storage', internalStatus);
  internalStatus();
  window.OwnerAcquisition = { load: load, clear: clear };
})();
