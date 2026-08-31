(function() {
  'use strict';

  var state = {
    cases: [],
    selectedId: null,
    loading: false,
  };

  var TYPE_LABELS = {
    support: 'Support Request',
    damage: 'Damage Report',
    quality: 'Quality Issue',
    payment: 'Payment Issue',
    dispute: 'Payment Dispute',
    safety: 'Safety Report',
    late_arrival: 'Late Arrival',
    no_show: 'No-Show',
    missing_hardware: 'Missing Hardware',
    account: 'Account Support',
  };

  function headers() {
    return typeof window._ownerHeaders === 'function'
      ? window._ownerHeaders()
      : { 'Content-Type': 'application/json' };
  }

  async function request(url, options) {
    var response = await fetch(url, Object.assign({ headers: headers() }, options || {}));
    var data = await response.json().catch(function() { return {}; });
    if (!response.ok || data.error) {
      var error = new Error(data.error || 'Request failed');
      error.setupNeeded = data.setupNeeded === true;
      error.status = response.status;
      throw error;
    }
    return data;
  }

  async function loadBadge() {
    var badge = document.getElementById('nav-cases');
    if (!badge) return;
    try {
      var data = await request('/api/owner/cases?status=active');
      var count = Number(data.summary && data.summary.ownerActionRequired || 0);
      badge.textContent = String(count);
      badge.title = 'Cases requiring owner action';
      badge.style.display = count > 0 ? '' : 'none';
    } catch (error) {
      badge.style.display = 'none';
    }
  }

  async function load() {
    if (state.loading) return;
    state.loading = true;
    var list = document.getElementById('cases-list');
    var detail = document.getElementById('cases-detail');
    if (list) list.innerHTML = '<div class="cases-loading">Loading cases...</div>';
    if (detail && !state.selectedId) detail.innerHTML = '<div class="cases-loading">Loading case details...</div>';

    try {
      var params = new URLSearchParams();
      params.set('status', valueOf('cases-status-filter') || 'active');
      params.set('caseType', valueOf('cases-type-filter') || 'all');
      params.set('severity', valueOf('cases-severity-filter') || 'all');
      var data = await request('/api/owner/cases?' + params.toString());
      state.cases = data.cases || [];
      renderSummary(data.summary || {});
      renderList();
      updateBadge(data.summary || {});

      var selectedStillVisible = state.cases.some(function(item) { return item.id === state.selectedId; });
      if (!selectedStillVisible) state.selectedId = state.cases.length ? state.cases[0].id : null;
      if (state.selectedId) await select(state.selectedId, true);
      else renderEmptyDetail();
    } catch (error) {
      renderLoadError(error);
    } finally {
      state.loading = false;
    }
  }

  async function select(caseId, listAlreadyRendered) {
    state.selectedId = caseId;
    if (!listAlreadyRendered) renderList();
    var detail = document.getElementById('cases-detail');
    if (!detail) return;
    detail.innerHTML = '<div class="cases-loading">Loading case details...</div>';
    try {
      var data = await request('/api/owner/cases?caseId=' + encodeURIComponent(caseId));
      renderDetail(data.case, data.events || []);
    } catch (error) {
      detail.innerHTML = '<div class="cases-error">' + esc(error.message || 'Could not load this case.') + '</div>';
    }
  }

  function renderSummary(summary) {
    setText('cases-stat-active', summary.active || 0);
    setText('cases-stat-new', summary.new || 0);
    setText('cases-stat-priority', summary.highPriority || 0);
    setText('cases-stat-waiting', (summary.waitingCustomer || 0) + (summary.waitingEaser || 0));
  }

  function updateBadge(summary) {
    var badge = document.getElementById('nav-cases');
    if (!badge) return;
    var count = Number(summary.ownerActionRequired || 0);
    badge.textContent = String(count);
    badge.title = 'Cases requiring owner action';
    badge.style.display = count > 0 ? '' : 'none';
  }

  function renderList() {
    var list = document.getElementById('cases-list');
    var count = document.getElementById('cases-list-count');
    if (!list) return;
    if (count) count.textContent = String(state.cases.length);
    if (!state.cases.length) {
      list.innerHTML = '<div class="cases-empty">No cases match these filters.</div>';
      return;
    }
    list.innerHTML = state.cases.map(function(item) {
      var contact = item.customer && (item.customer.name || item.customer.email) || 'No customer linked';
      return '<button type="button" class="cases-list-item' + (item.id === state.selectedId ? ' active' : '') + '" data-case-id="' + attr(item.id) + '">' +
        '<div class="cases-list-top">' +
          '<span class="cases-list-ref">' + esc(item.ref) + '</span>' +
          '<span class="cases-badge status-' + attr(item.status) + '">' + esc(item.statusLabel) + '</span>' +
        '</div>' +
        '<div class="cases-list-subject">' + esc(item.subject) + '</div>' +
        '<div class="cases-list-meta">' + esc(item.typeLabel) + ' &middot; ' + esc(contact) + '<br>' + esc(relativeTime(item.updatedAt)) + '</div>' +
      '</button>';
    }).join('');
  }

  function renderDetail(item, events) {
    var detail = document.getElementById('cases-detail');
    if (!detail) return;
    var customer = item.customer || {};
    var easer = item.easer || {};
    var notification = item.notifications || { attempts: 0, failed: 0, latest: null };
    var actions = item.availableActions || [];
    var actionOptions = actions.map(function(action) {
      return '<option value="' + attr(action.action) + '" data-confirm="' + (action.requiresConfirmation ? 'true' : 'false') + '">' + esc(action.label) + '</option>';
    }).join('');
    var bookingHtml = item.booking
      ? metaItem('Booking', item.booking.ref + ' - ' + (item.booking.service || 'Service'))
      : metaItem('Booking', 'Not linked');
    var contactHtml = customer.email
      ? '<a href="mailto:' + attr(customer.email) + '">' + esc(customer.email) + '</a>'
      : 'Not provided';
    var phoneHtml = customer.phone
      ? '<a href="tel:' + attr(dialablePhone(customer.phone)) + '">' + esc(displayPhone(customer.phone)) + '</a>'
      : 'Not provided';
    var easerHtml = easer.email
      ? esc(easer.name || 'Easer') + '<br><a href="mailto:' + attr(easer.email) + '">' + esc(easer.email) + '</a>'
      : 'Not linked';
    var recipientOptions = '';
    if (customer.email) recipientOptions += '<option value="customer">Customer - ' + esc(customer.email) + '</option>';
    if (easer.email) recipientOptions += '<option value="easer">Easer - ' + esc(easer.email) + '</option>';
    var communicationHtml = recipientOptions
      ? '<div class="cases-detail-section">' +
          '<div class="cases-section-label">Send an update</div>' +
          '<form id="cases-contact-form" class="cases-update-form" data-case-id="' + attr(item.id) + '" data-status="' + attr(item.status) + '">' +
            '<label for="cases-contact-recipient">Recipient</label>' +
            '<select id="cases-contact-recipient" name="recipientType">' + recipientOptions + '</select>' +
            '<label for="cases-contact-message">Message they will receive</label>' +
            '<textarea id="cases-contact-message" maxlength="2000" placeholder="Write only what this person needs to know and what happens next."></textarea>' +
            '<div class="cases-form-actions">' +
              '<div class="cases-form-status" id="cases-contact-status">This sends an email and records the exact message in the case timeline.</div>' +
              '<button type="submit" class="btn btn-teal" id="cases-contact-btn">Send Update</button>' +
            '</div>' +
          '</form>' +
        '</div>'
      : '<div class="cases-detail-section"><div class="cases-section-label">Send an update</div><div class="cases-resolution">Add or link a verified customer or Easer email before sending an update.</div></div>';
    var latestNotification = notification.latest
      ? notification.latest.status.charAt(0).toUpperCase() + notification.latest.status.slice(1)
      : 'No attempt logged';
    var bookingWorkflow = item.booking
      ? '<div class="cases-detail-section">' +
          '<div class="cases-section-label">Linked booking action</div>' +
          '<div class="cases-resolution">' +
            (item.requiresBookingDamageResolution
              ? 'This report has an active booking hold. Review its evidence and complete the documented acknowledgment there; the case will close automatically.'
              : 'Open the linked booking to review its authoritative status, evidence, payment, and timeline.') +
            '<div style="margin-top:0.75rem"><button type="button" class="btn btn-teal" data-open-case-booking="' + attr(item.booking.id) + '" data-booking-tab="' + (item.type === 'damage' ? 'evidence' : '') + '">' +
              (item.requiresBookingDamageResolution ? 'Review Evidence and Close Alert' : 'Open Linked Booking') +
            '</button></div>' +
          '</div>' +
        '</div>'
      : '';

    detail.innerHTML =
      '<div class="cases-detail-title-row">' +
        '<div>' +
          '<div class="cases-list-ref">' + esc(item.ref) + '</div>' +
          '<h3>' + esc(item.subject) + '</h3>' +
        '</div>' +
        '<div class="cases-detail-actions">' +
          '<span class="cases-badge severity-' + attr(item.severity) + '">' + esc(item.severity) + '</span>' +
          '<span class="cases-badge status-' + attr(item.status) + '">' + esc(item.statusLabel) + '</span>' +
        '</div>' +
      '</div>' +
      '<div class="cases-detail-section">' +
        '<div class="cases-section-label">Request</div>' +
        '<div class="cases-description">' + esc(item.description) + '</div>' +
      '</div>' +
      '<div class="cases-detail-section">' +
        '<div class="cases-section-label">Case information</div>' +
        '<div class="cases-meta-grid">' +
          metaItem('Type', item.typeLabel || TYPE_LABELS[item.type] || 'Operational Case') +
          metaItem('Customer-visible status', item.customerStatus && item.customerStatus.label || 'In Progress') +
          metaItemHtml('Customer', esc(customer.name || 'Not provided') + '<br>' + contactHtml) +
          metaItemHtml('Phone', phoneHtml) +
          metaItemHtml('Easer', easerHtml) +
          bookingHtml +
          metaItem('Updated', formatDate(item.updatedAt)) +
          metaItemHtml('Notifications', '<span class="cases-badge' + (notification.failed ? ' notification-failed' : '') + '">' + esc(latestNotification) + '</span><br>' + notification.attempts + ' attempt' + (notification.attempts === 1 ? '' : 's')) +
          metaItem('Source', sourceLabel(item.source)) +
        '</div>' +
      '</div>' +
      bookingWorkflow +
      communicationHtml +
      (item.resolutionSummary ? '<div class="cases-detail-section"><div class="cases-section-label">Resolution</div><div class="cases-resolution">' + esc(item.resolutionSummary) + '</div></div>' : '') +
      '<div class="cases-detail-section">' +
        '<div class="cases-section-label">Update case</div>' +
        '<form id="cases-update-form" class="cases-update-form" data-case-id="' + attr(item.id) + '" data-status="' + attr(item.status) + '">' +
          '<label for="cases-action-select">Action</label>' +
          '<select id="cases-action-select" name="action">' + actionOptions + '</select>' +
          '<label for="cases-action-note">Internal note</label>' +
          '<textarea id="cases-action-note" name="note" maxlength="4000" placeholder="Record what happened, what is needed, or how the case was resolved."></textarea>' +
          '<div id="cases-wait-message-wrap" style="display:none;margin-top:0.75rem">' +
            '<label for="cases-wait-message" id="cases-wait-message-label">Message to recipient</label>' +
            '<textarea id="cases-wait-message" maxlength="2000" placeholder="Explain what is needed and what the recipient should do next."></textarea>' +
            '<div class="cases-form-status" style="margin-top:0.35rem">The status changes only after this email is accepted for delivery.</div>' +
          '</div>' +
          '<label class="cases-confirm" id="cases-confirm-wrap"><input type="checkbox" id="cases-confirm-check"/> <span>I confirm this case status should be changed. This does not send money, issue a refund, change a booking, or release an Easer payout.</span></label>' +
          '<div class="cases-form-actions">' +
            '<div class="cases-form-status" id="cases-form-status">Updates are saved to the internal case timeline.</div>' +
            '<button type="submit" class="btn btn-teal" id="cases-save-btn">Save Update</button>' +
          '</div>' +
        '</form>' +
      '</div>' +
      '<div class="cases-detail-section">' +
        '<div class="cases-section-label">Timeline</div>' +
        '<div class="cases-timeline">' + renderEvents(events) + '</div>' +
      '</div>';

    updateConfirmationVisibility();
  }

  function renderEvents(events) {
    if (!events.length) return '<div class="cases-empty" style="min-height:100px">No timeline events recorded.</div>';
    return events.map(function(event) {
      var title = eventTitle(event);
      var note = event.note ? '<div class="cases-event-note">' + esc(event.note) + '</div>' : '';
      var publicMessage = event.publicMessage ? '<div class="cases-event-public"><strong>Message sent:</strong> ' + esc(event.publicMessage) + '</div>' : '';
      return '<div class="cases-event">' +
        '<div class="cases-event-title">' + esc(title) + '</div>' +
        '<div class="cases-event-meta">' + esc(event.actor && event.actor.name || event.actor && event.actor.type || 'System') + ' &middot; ' + esc(formatDate(event.createdAt)) + '</div>' +
        note +
        publicMessage +
      '</div>';
    }).join('');
  }

  function eventTitle(event) {
    if (event.type === 'created') return 'Case received';
    if (event.type === 'status_changed') return (event.fromStatusLabel || 'Status') + ' to ' + (event.toStatusLabel || 'Updated');
    if (event.type === 'internal_note') return 'Internal note added';
    if (event.type === 'notification_attempted') return 'Notifications attempted';
    if (event.type === 'public_update') return 'Customer or Easer update recorded';
    return 'Case updated';
  }

  function renderEmptyDetail() {
    var detail = document.getElementById('cases-detail');
    if (detail) detail.innerHTML = '<div class="cases-empty">Choose a case to review its request, contact information, notifications, and timeline.</div>';
  }

  function renderLoadError(error) {
    var list = document.getElementById('cases-list');
    var detail = document.getElementById('cases-detail');
    var message = error.setupNeeded
      ? 'Operations Cases is ready in code but migration 053 must be applied before this queue can be used.'
      : (error.message || 'Could not load operations cases.');
    if (list) list.innerHTML = '<div class="cases-error">' + esc(message) + '</div>';
    if (detail) detail.innerHTML = '<div class="cases-error">No case data was changed.</div>';
  }

  function updateConfirmationVisibility() {
    var select = document.getElementById('cases-action-select');
    var wrap = document.getElementById('cases-confirm-wrap');
    var checkbox = document.getElementById('cases-confirm-check');
    var waitMessageWrap = document.getElementById('cases-wait-message-wrap');
    var waitMessageLabel = document.getElementById('cases-wait-message-label');
    var waitMessage = document.getElementById('cases-wait-message');
    if (!select || !wrap || !checkbox) return;
    var selected = select.options[select.selectedIndex];
    var required = selected && selected.dataset.confirm === 'true';
    wrap.classList.toggle('visible', required);
    if (!required) checkbox.checked = false;
    var waitAction = selected && ['wait_customer', 'wait_easer'].includes(selected.value);
    if (waitMessageWrap) waitMessageWrap.style.display = waitAction ? '' : 'none';
    if (waitMessage) waitMessage.required = Boolean(waitAction);
    if (waitMessageLabel && waitAction) {
      waitMessageLabel.textContent = selected.value === 'wait_customer' ? 'Message to customer' : 'Message to Easer';
    }
  }

  async function submitUpdate(form) {
    var button = document.getElementById('cases-save-btn');
    var status = document.getElementById('cases-form-status');
    var select = document.getElementById('cases-action-select');
    var note = document.getElementById('cases-action-note');
    var confirmBox = document.getElementById('cases-confirm-check');
    var publicMessage = document.getElementById('cases-wait-message');
    if (!button || !status || !select || !note) return;
    var selected = select.options[select.selectedIndex];
    var confirmationRequired = selected && selected.dataset.confirm === 'true';
    if (confirmationRequired && !confirmBox.checked) {
      status.textContent = 'Check the confirmation before saving this status change.';
      status.style.color = '#991b1b';
      return;
    }

    button.disabled = true;
    button.textContent = 'Saving...';
    status.textContent = 'Saving the case update...';
    status.style.color = '';
    try {
      await request('/api/owner/case-action', {
        method: 'POST',
        body: JSON.stringify({
          caseId: form.dataset.caseId,
          expectedStatus: form.dataset.status,
          action: select.value,
          note: note.value.trim(),
          publicMessage: publicMessage ? publicMessage.value.trim() : '',
          confirmed: confirmationRequired && confirmBox.checked,
        }),
      });
      status.textContent = 'Case update saved.';
      status.style.color = '#047857';
      await load();
    } catch (error) {
      status.textContent = error.message || 'The case could not be updated.';
      status.style.color = '#991b1b';
    } finally {
      button.disabled = false;
      button.textContent = 'Save Update';
    }
  }

  async function submitContactUpdate(form) {
    var button = document.getElementById('cases-contact-btn');
    var status = document.getElementById('cases-contact-status');
    var recipient = document.getElementById('cases-contact-recipient');
    var message = document.getElementById('cases-contact-message');
    if (!button || !status || !recipient || !message) return;
    if (message.value.trim().length < 5) {
      status.textContent = 'Enter the update this person needs.';
      status.style.color = '#991b1b';
      return;
    }
    button.disabled = true;
    button.textContent = 'Sending...';
    status.textContent = 'Sending and recording the update...';
    status.style.color = '';
    try {
      var result = await request('/api/owner/case-action', {
        method: 'POST',
        body: JSON.stringify({
          caseId: form.dataset.caseId,
          expectedStatus: form.dataset.status,
          action: 'send_update',
          recipientType: recipient.value,
          publicMessage: message.value.trim(),
        }),
      });
      status.textContent = result.notification && result.notification.providerAccepted
        ? 'Update accepted for delivery and recorded.'
        : 'Update recorded.';
      status.style.color = '#047857';
      await load();
    } catch (error) {
      status.textContent = error.message || 'The update could not be sent. The case was not changed.';
      status.style.color = '#991b1b';
    } finally {
      button.disabled = false;
      button.textContent = 'Send Update';
    }
  }

  function metaItem(label, value) {
    return metaItemHtml(label, esc(value == null ? '-' : String(value)));
  }

  function metaItemHtml(label, html) {
    return '<div class="cases-meta-item"><div class="cases-meta-label">' + esc(label) + '</div><div class="cases-meta-value">' + html + '</div></div>';
  }

  function sourceLabel(source) {
    var labels = {
      contact_form: 'Website contact form',
      booking: 'Booking workflow',
      customer_report: 'Customer report',
      easer_report: 'Easer report',
      stripe: 'Stripe event',
      owner: 'Owner entry',
      system: 'System event',
    };
    return labels[source] || 'Operational record';
  }

  function dialablePhone(value) {
    var digits = String(value || '').replace(/\D/g, '');
    if (digits.length === 10) return '+1' + digits;
    if (digits.length === 11 && digits.charAt(0) === '1') return '+' + digits;
    return String(value || '').trim();
  }

  function displayPhone(value) {
    var digits = String(value || '').replace(/\D/g, '');
    if (digits.length === 11 && digits.charAt(0) === '1') digits = digits.slice(1);
    if (digits.length === 10) return '(' + digits.slice(0, 3) + ') ' + digits.slice(3, 6) + '-' + digits.slice(6);
    return String(value || '').trim();
  }

  function formatDate(value) {
    if (!value) return '-';
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) return '-';
    return date.toLocaleString('en-US', {
      timeZone: 'America/Chicago',
      month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit',
    });
  }

  function relativeTime(value) {
    var date = new Date(value);
    var seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
    if (!Number.isFinite(seconds)) return 'Unknown update time';
    if (seconds < 60) return 'Updated just now';
    var minutes = Math.round(seconds / 60);
    if (minutes < 60) return 'Updated ' + minutes + ' min ago';
    var hours = Math.round(minutes / 60);
    if (hours < 24) return 'Updated ' + hours + ' hr ago';
    var days = Math.round(hours / 24);
    return 'Updated ' + days + ' day' + (days === 1 ? '' : 's') + ' ago';
  }

  function valueOf(id) {
    var element = document.getElementById(id);
    return element ? element.value : '';
  }

  function setText(id, value) {
    var element = document.getElementById(id);
    if (element) element.textContent = String(value);
  }

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function attr(value) {
    return esc(value);
  }

  document.addEventListener('click', function(event) {
    var bookingButton = event.target.closest('[data-open-case-booking]');
    if (bookingButton) {
      if (typeof window.openOwnerBookingRecord === 'function') {
        window.openOwnerBookingRecord(bookingButton.dataset.openCaseBooking, bookingButton.dataset.bookingTab || null);
      }
      return;
    }
    var row = event.target.closest('[data-case-id]');
    if (row && row.classList.contains('cases-list-item')) select(row.dataset.caseId);
  });

  document.addEventListener('change', function(event) {
    if (event.target.id === 'cases-action-select') updateConfirmationVisibility();
    if (['cases-status-filter', 'cases-type-filter', 'cases-severity-filter'].includes(event.target.id)) load();
  });

  document.addEventListener('submit', function(event) {
    if (event.target.id === 'cases-update-form') {
      event.preventDefault();
      submitUpdate(event.target);
    } else if (event.target.id === 'cases-contact-form') {
      event.preventDefault();
      submitContactUpdate(event.target);
    }
  });

  window.OwnerCases = {
    load: load,
    loadBadge: loadBadge,
    refresh: load,
    select: select,
  };
})();
