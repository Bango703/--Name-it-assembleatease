// AI suggestions in the owner dashboard (owner, 2026-11-26). One card for the
// booking thread, the text thread and the case. Everything shown comes from
// /api/owner/ai-assist (api/_ai-assist.js decides what a suggestion says and
// whether it could ever send on its own). This file never sends a message:
// "Use this reply" hands the text to the screen's own reply box, and the
// owner's own Send button does the sending.
(function() {
  'use strict';

  var SCOPES = {
    booking: { param: 'bookingId', title: 'Suggested reply', use: 'Use this reply', foot: 'Written by AI from this booking. Nothing is sent until you press Send.' },
    sms: { param: 'smsConversationId', title: 'Suggested text', use: 'Use this reply', foot: 'Written by AI from this conversation. Nothing is sent until you press Send SMS.' },
    case: { param: 'caseId', title: 'AI summary', use: 'Use this update', foot: 'Written by AI from this case. Nothing is sent until you press Send Update.' },
  };
  var WHO = { customer: 'Customer', assembler: 'Easer', easer: 'Easer' };
  var mounts = new WeakMap();

  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function(c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function headers() {
    var h = typeof window._ownerHeaders === 'function' ? window._ownerHeaders() : {};
    h['Content-Type'] = 'application/json';
    return h;
  }
  async function call(method, query, body) {
    var r = await fetch('/api/owner/ai-assist' + (query || ''), { method: method, headers: headers(), cache: 'no-store', body: body ? JSON.stringify(body) : undefined });
    var d = {};
    try { d = await r.json(); } catch (e) { d = {}; }
    if (!r.ok) throw new Error(d.error || 'The AI suggestion could not be loaded.');
    return d;
  }

  function chips(draft, scope) {
    var out = [];
    if (scope === 'case') {
      if (draft.categoryLabel) out.push('<span class="ai-chip' + (draft.category === 'urgent' || draft.category === 'high' ? ' ai-chip-owner' : '') + '">' + esc(draft.categoryLabel) + '</span>');
    } else if (draft.routine) {
      out.push('<span class="ai-chip ai-chip-routine">Routine</span>');
    } else if (draft.categoryLabel) {
      out.push('<span class="ai-chip ai-chip-owner">Needs you: ' + esc(draft.categoryLabel) + '</span>');
    }
    if (draft.urgent) out.push('<span class="ai-chip ai-chip-urgent">Urgent</span>');
    return out.join('');
  }

  function routineLine(draft, scope, autoReply) {
    if (scope !== 'booking') return '';
    if (draft.routine) {
      return '<p class="ai-note">' + (autoReply ? 'Routine: this sends on its own unless you reply first.' : 'Routine: this would send on its own once automatic replies are on.') + '</p>';
    }
    return draft.reviewNote ? '<p class="ai-note">Waits for you: ' + esc(draft.reviewNote) + '</p>' : '';
  }

  function cardHtml(draft, scope, state) {
    var cfg = SCOPES[scope];
    if (draft.status === 'pending') {
      return '<div class="ai-card"><div class="ai-status">Writing a suggestion...</div></div>';
    }
    if (draft.status === 'failed') {
      return '<div class="ai-card"><div class="ai-card-head"><span class="ai-card-title">' + esc(cfg.title) + '</span></div>' +
        '<p class="ai-note">No suggestion this time: ' + esc(draft.error) + '</p>' +
        '<div class="ai-actions"><button type="button" class="btn" data-ai-redo="' + esc(draft.id) + '" data-ai-audience="' + esc(draft.audience || '') + '">Try again</button></div></div>';
    }
    var title = scope === 'case' ? cfg.title : cfg.title + (WHO[draft.audience] ? ' to ' + WHO[draft.audience] : '');
    var draftBlock = draft.draft
      ? (scope === 'case' ? '<p class="ai-next"><strong>Suggested update to ' + esc(WHO[draft.audience] || 'them') + ':</strong></p>' : '') +
        '<div class="ai-draft">' + esc(draft.draft) + '</div>'
      : '';
    var useBtn = draft.draft ? '<button type="button" class="btn btn-teal" data-ai-use="' + esc(draft.id) + '">' + esc(cfg.use) + '</button>' : '';
    return '<div class="ai-card' + (draft.urgent ? ' ai-urgent' : '') + '">' +
      '<div class="ai-card-head"><span class="ai-card-title">' + esc(title) + '</span>' + chips(draft, scope) + '</div>' +
      (draft.summary ? '<p class="ai-summary">' + esc(draft.summary) + '</p>' : '') +
      (draft.nextStep ? '<p class="ai-next"><strong>Next step:</strong> ' + esc(draft.nextStep) + '</p>' : '') +
      draftBlock +
      routineLine(draft, scope, state.autoReply) +
      (scope === 'case' && draft.reviewNote ? '<p class="ai-note">Check before sending: ' + esc(draft.reviewNote) + '</p>' : '') +
      '<div class="ai-actions">' + useBtn +
        '<button type="button" class="btn" data-ai-redo="' + esc(draft.id) + '" data-ai-audience="' + esc(draft.audience || '') + '">New suggestion</button>' +
        '<button type="button" class="btn" data-ai-dismiss="' + esc(draft.id) + '">Dismiss</button>' +
      '</div>' +
      '<p class="ai-foot">' + esc(cfg.foot) + '</p>' +
    '</div>';
  }

  function render(container) {
    var m = mounts.get(container);
    if (!m) return;
    var s = m.state;
    if (s.note) { container.hidden = false; container.innerHTML = '<div class="ai-status">' + esc(s.note) + '</div>'; return; }
    var cards = (s.drafts || []).map(function(d) { return cardHtml(d, m.scope, s); });
    if (s.writing) cards.push('<div class="ai-card"><div class="ai-status">Writing a suggestion...</div></div>');
    container.hidden = cards.length === 0;
    container.innerHTML = cards.join('');
  }

  async function refresh(container, autoDraft) {
    var m = mounts.get(container);
    if (!m) return;
    var token = m.token;
    var cfg = SCOPES[m.scope];
    try {
      var d = await call('GET', '?' + cfg.param + '=' + encodeURIComponent(m.id));
      if (m.token !== token) return;
      m.state = { drafts: d.drafts || [], autoReply: d.autoReply === true, note: d.setupNeeded ? d.reason : null };
      render(container);
      var missing = (d.waiting || []).filter(function(w) { return w.hasSuggestion === false || m.scope === 'case'; });
      if (autoDraft && d.enabled && !d.setupNeeded && missing.length && !(d.drafts || []).length) {
        await write(container, missing[missing.length - 1].audience || null, false);
      } else if ((d.drafts || []).some(function(x) { return x.status === 'pending'; }) && m.polls < 6) {
        m.polls += 1;
        setTimeout(function() { if (m.token === token) refresh(container, false); }, 5000);
      }
    } catch (error) {
      if (m.token !== token) return;
      m.state = { drafts: [], note: error.message };
      render(container);
    }
  }

  async function write(container, audience, redo) {
    var m = mounts.get(container);
    if (!m) return;
    var token = m.token;
    var body = { action: 'draft', redo: redo === true };
    body[SCOPES[m.scope].param] = m.id;
    if (audience) body.audience = audience;
    m.state.writing = true;
    if (redo) m.state.drafts = (m.state.drafts || []).filter(function(d) { return d.audience !== audience; });
    render(container);
    try {
      await call('POST', '', body);
    } catch (error) {
      if (m.token === token && typeof window.toast === 'function') window.toast(error.message, 'error');
    }
    if (m.token !== token) return;
    m.state.writing = false;
    await refresh(container, false);
  }

  function mount(container, opts) {
    if (!container || !opts || !SCOPES[opts.scope] || !opts.id) { if (container) { container.hidden = true; container.innerHTML = ''; } return; }
    var previous = mounts.get(container);
    var m = { scope: opts.scope, id: opts.id, onUse: opts.onUse, token: (previous ? previous.token : 0) + 1, polls: 0, state: { drafts: [] } };
    mounts.set(container, m);
    container.classList.add('ai-assist');
    container.hidden = true;
    container.innerHTML = '';
    if (!container.dataset.aiBound) {
      container.dataset.aiBound = '1';
      container.addEventListener('click', async function(event) {
        var cur = mounts.get(container);
        if (!cur) return;
        var use = event.target.closest('[data-ai-use]');
        var redo = event.target.closest('[data-ai-redo]');
        var dismiss = event.target.closest('[data-ai-dismiss]');
        if (use) {
          var draft = (cur.state.drafts || []).find(function(d) { return d.id === use.getAttribute('data-ai-use'); });
          if (draft && typeof cur.onUse === 'function') cur.onUse(draft);
          return;
        }
        if (redo) { await write(container, redo.getAttribute('data-ai-audience') || null, true); return; }
        if (dismiss) {
          try {
            await call('POST', '', { action: 'dismiss', draftId: dismiss.getAttribute('data-ai-dismiss') });
          } catch (error) {
            if (typeof window.toast === 'function') window.toast(error.message, 'error');
          }
          await refresh(container, false);
        }
      });
    }
    refresh(container, true);
  }

  window.OwnerAiAssist = { mount: mount };
})();
