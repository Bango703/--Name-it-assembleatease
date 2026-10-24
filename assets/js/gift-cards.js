// Gift cards page. Prices, limits and whether anything is on sale come from
// /api/gift-cards/checkout (api/_gift-cards.js owns the rules). This file
// collects the form and renders what the server says.
(function () {
  'use strict';
  var state = { config: null, kind: 'gift_card', amountCents: 5000 };
  function el(id) { return document.getElementById(id); }
  function dollars(cents) { var n = cents / 100; return '$' + (Number.isInteger(n) ? n.toFixed(0) : n.toFixed(2)); }
  function longDate(iso) { return new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }); }
  function showError(text) { var e = el('gc-error'); e.textContent = text || ''; e.hidden = !text; }

  async function api(path, options) {
    var response = await fetch(path, Object.assign({ cache: 'no-store' }, options || {}));
    var data = {};
    try { data = await response.json(); } catch (e) { data = {}; }
    return { ok: response.ok, status: response.status, data: data };
  }
  function post(path, body) {
    return api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }

  function pass() { return (state.config && state.config.moveInPass) || { paidCents: 4900, bonusCents: 1100, bonusDays: 30, priorityDays: 30 }; }

  function renderChips() {
    var chips = el('gc-chips');
    var presets = (state.config && state.config.presetCents) || [2500, 5000, 10000, 15000, 25000];
    chips.innerHTML = '';
    presets.forEach(function (cents) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'gc-chip';
      b.textContent = dollars(cents);
      b.setAttribute('aria-pressed', String(cents === state.amountCents && !el('gc-amount').value));
      b.addEventListener('click', function () { el('gc-amount').value = ''; state.amountCents = cents; render(); });
      chips.appendChild(b);
    });
  }

  function render() {
    var isPass = state.kind === 'move_in_pass';
    el('gc-amounts').hidden = isPass;
    renderChips();
    var p = pass();
    var gifting = el('gc-gift').checked;
    el('gc-recipient').hidden = !gifting;
    var summary = isPass
      ? 'Move-In Pass: ' + dollars(p.paidCents) + ' for ' + dollars(p.paidCents + p.bonusCents) + ' of credit'
      : 'Gift card: ' + (state.amountCents ? dollars(state.amountCents) : 'choose an amount');
    el('gc-summary').textContent = summary;
    el('gc-fine').textContent = isPass
      ? 'The ' + dollars(p.paidCents) + ' you pay never expires. The ' + dollars(p.bonusCents) + ' bonus and priority booking last ' + p.bonusDays + ' days from purchase, and the bonus is used first. Credit is not cash and cannot be withdrawn.'
      : 'Credit never expires. It is not cash and cannot be withdrawn.';
    var open = !!(state.config && state.config.enabled);
    el('gc-closed').hidden = open || !state.config;
    el('gc-submit').disabled = !open;
    el('gc-submit').title = open ? '' : 'Gift cards go on sale soon.';
  }

  function readAmount() {
    var typed = el('gc-amount').value.trim();
    if (!typed) return state.amountCents;
    var n = Number(typed);
    return Number.isFinite(n) ? Math.round(n * 100) : 0;
  }

  async function submit(event) {
    event.preventDefault();
    showError('');
    var isPass = state.kind === 'move_in_pass';
    var cents = isPass ? pass().paidCents : readAmount();
    var min = (state.config && state.config.minCents) || 2500;
    var max = (state.config && state.config.maxCents) || 50000;
    if (!isPass && (!cents || cents % 100 !== 0 || cents < min || cents > max)) {
      showError('Choose a whole-dollar amount from ' + dollars(min) + ' to ' + dollars(max) + '.');
      return;
    }
    var button = el('gc-submit');
    button.disabled = true;
    button.textContent = 'Opening payment';
    var result = await post('/api/gift-cards/checkout', {
      kind: state.kind,
      amountDollars: cents / 100,
      purchaserName: el('gc-purchaser-name').value,
      purchaserEmail: el('gc-purchaser-email').value,
      forSomeoneElse: el('gc-gift').checked,
      recipientName: el('gc-recipient-name').value,
      recipientEmail: el('gc-recipient-email').value,
      message: el('gc-message').value,
    }).catch(function () { return { ok: false, data: {} }; });
    if (result.ok && result.data.url) { window.location.href = result.data.url; return; }
    showError(result.data.error || 'Payment could not be opened. Try again in a moment.');
    button.textContent = 'Continue to payment';
    render();
  }

  async function confirmPurchase(sessionId) {
    var done = el('gc-done');
    done.hidden = false;
    el('gc-done-title').textContent = 'Checking your payment';
    el('gc-done-text').textContent = '';
    var result = await post('/api/gift-cards/confirm', { sessionId: sessionId }).catch(function () { return { ok: false, data: {} }; });
    if (result.ok) {
      el('gc-done-title').textContent = 'Your ' + (result.data.kind === 'move_in_pass' ? 'Move-In Pass' : 'gift card') + ' is on its way';
      el('gc-done-text').textContent = result.data.amount + ' of credit, card ending in ' + result.data.last4 + '. ' +
        (result.data.emailed ? 'The code was emailed to ' + result.data.sentTo + '.' : 'The code will be emailed to ' + result.data.sentTo + ' shortly.');
    } else {
      el('gc-done-title').textContent = 'Thank you';
      el('gc-done-text').textContent = result.data.error || 'If you paid, your card will arrive by email shortly.';
    }
    try { history.replaceState(null, '', '/gift-cards'); } catch (e) { /* keep the URL */ }
  }

  async function checkBalance(event) {
    event.preventDefault();
    var out = el('gc-balance-result');
    out.textContent = 'Checking';
    var result = await post('/api/gift-cards/balance', { code: el('gc-code').value }).catch(function () { return { ok: false, data: {} }; });
    if (!result.ok) { out.textContent = result.data.error || 'Balances are unavailable right now. Try again in a moment.'; return; }
    var c = result.data.card;
    if (!c.active) { out.textContent = 'This card ending in ' + c.last4 + ' can no longer be used. Reply to your card email for help.'; return; }
    var parts = [dollars(c.balanceCents) + ' left on your ' + c.name + ' ending in ' + c.last4 + '.'];
    if (c.bonusCents && c.bonusExpiresAt) parts.push(dollars(c.bonusCents) + ' of it is bonus credit that expires ' + longDate(c.bonusExpiresAt) + '.');
    if (c.priorityUntil) parts.push('Priority booking until ' + longDate(c.priorityUntil) + '.');
    out.textContent = parts.join(' ');
  }

  document.addEventListener('DOMContentLoaded', async function () {
    document.querySelectorAll('input[name="gc-kind"]').forEach(function (radio) {
      radio.addEventListener('change', function () { if (radio.checked) { state.kind = radio.value; render(); } });
    });
    el('gc-gift').addEventListener('change', render);
    el('gc-amount').addEventListener('input', function () { render(); });
    el('gc-form').addEventListener('submit', submit);
    el('gc-balance-form').addEventListener('submit', checkBalance);
    var params = new URLSearchParams(window.location.search);
    if (params.get('pass') === '1') { var r = document.querySelector('input[value="move_in_pass"]'); r.checked = true; state.kind = 'move_in_pass'; }
    render();
    var sessionId = params.get('session_id');
    if (params.get('purchase') === 'success' && sessionId) confirmPurchase(sessionId);
    var config = await api('/api/gift-cards/checkout').catch(function () { return { ok: false, data: {} }; });
    state.config = config.ok ? config.data : { enabled: false };
    render();
  });
})();
