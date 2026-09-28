import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const owner = await readFile(new URL('../owner/index.html', import.meta.url), 'utf8');
const css = await readFile(new URL('../owner/assets/owner.css', import.meta.url), 'utf8');
function sourceFunction(name) {
  const match = new RegExp(`^  (?:async )?function ${name}\\(`, 'm').exec(owner);
  assert.ok(match, `actual ${name} renderer/helper exists`);
  const end = owner.indexOf('\n  }', match.index);
  assert.ok(end > match.index, `${name} has a complete body`);
  return owner.slice(match.index, end + '\n  }'.length);
}
const functions = [
  'manualPayoutPreferenceLabel', 'easerTierBadge', 'formatUsPhone', 'hasValidUsPhone', 'loadPayoutLedger',
].map(sourceFunction).join('\n');
const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);
const money = value => '$' + (Number(value || 0) / 100).toFixed(2);
const cells = row => [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map(match => match[1]);
const rows = html => [...html.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/g)].map(match => match[0]);
const preferenceCell = html => rows(html)[0].match(/<td\b[^>]*>[\s\S]*?<\/td>/g)[1];
const baseEaser = {
  assembler_id: 'easer-1', assembler_name: 'Ann', assembler_tier: 'starter',
  email: 'ann@example.test', phone: '7375550100', payout_method_preference: 'ach',
  jobs: 3, total_owed: 12345, total_paid: 2345, total_payable: 5000,
  total_connect_pending: 3000, total_on_hold: 2000, last_earning_date: '2026-09-28',
  account_closure_status: null, unpaid_jobs: [],
};
const baseTotals = {
  jobs: 7, cancellation_earnings: 1, total_pending: 33333,
  total_payable: 11111, total_connect_pending: 12222, total_on_hold: 10000, total_paid: 9999,
};

async function render(easers, options = {}) {
  const response = { easers, totals: { ...baseTotals }, ...(options.response || {}) };
  const snapshot = structuredClone(response);
  const elements = new Map(['an-payout-body', 'an-payout-totals', 'nav-payouts'].map(id => [id, {
    innerHTML: 'stale content', textContent: '', title: '', style: {},
  }]));
  const calls = { fetch: [], reserve: 0, actions: [] };
  const context = vm.createContext({
    esc, fmt$: money, formatDate: value => 'Date ' + value,
    headers: () => ({ Authorization: 'local-test-only' }),
    document: { getElementById: id => elements.get(id) || null },
    selectedId: 'selected-booking', allBookings: [{ id: 'selected-booking' }],
    payoutTruthAvailable: false, payoutJobsByBookingId: new Map([['stale', {}]]),
    reserveParts: { payouts: -1 },
    renderReserveRollup() { calls.reserve += 1; },
    renderActions(booking) { calls.actions.push(booking.id); },
    async fetch(url, request = {}) {
      calls.fetch.push({ url, request });
      assert.equal(url, '/api/owner/payouts');
      assert.equal(request.method || 'GET', 'GET', 'rendering must never submit a payout mutation');
      assert.equal(request.body, undefined, 'rendering is a read only request');
      if (options.networkError) throw new Error('Mock network unavailable');
      return {
        ok: options.ok !== false,
        async json() {
          if (options.invalidJson) throw new Error('Mock invalid JSON');
          return response;
        },
      };
    },
  });
  vm.runInContext(functions, context, { filename: 'owner/index.html:payout-ledger' });
  await context.loadPayoutLedger();
  assert.deepEqual(response, snapshot, 'presentation must not change returned records or money');
  assert.equal(calls.fetch.length, 1, 'rendering only reads the payout ledger');
  assert.equal(calls.reserve, 1);
  assert.deepEqual(calls.actions, ['selected-booking'], 'existing selected-booking refresh is preserved');
  return {
    context, calls, elements, html: elements.get('an-payout-body').innerHTML,
    totalsHtml: elements.get('an-payout-totals').innerHTML,
  };
}

const preferenceCases = [
  ['ach', 'ACH / bank transfer', true], ['zelle', 'Zelle', true],
  ['paypal', 'PayPal', true], ['check', 'Check', true],
  [null, 'Not provided', false], ['', 'Not provided', false],
  [undefined, 'Unknown', false], ['wire', 'Unknown', false],
  ['__proto__', 'Unknown', false], ['constructor', 'Unknown', false], ['toString', 'Unknown', false],
  ['<img src=x onerror=alert(1)>', 'Unknown', false],
];
for (const [value, label, known] of preferenceCases) {
  const profile = { ...baseEaser, payout_method_preference: value };
  if (value === undefined) delete profile.payout_method_preference;
  const result = await render([profile]);
  assert.equal(result.context.manualPayoutPreferenceLabel(value), label);
  const cell = preferenceCell(result.html);
  assert.match(cell, new RegExp(`>${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}<`));
  assert.ok(cell.includes(known ? 'var(--text)' : 'var(--muted)'), 'manual preference is neutral metadata');
  assert.doesNotMatch(cell, /var\(--red\)|#[ef][0-9a-f]{5}|Not selected|Not ready|Action required/i);
  assert.doesNotMatch(result.html, /<img\b|\[object Object\]|function (?:Object|toString)/);
}

const ledgerRows = [
  {
    ...baseEaser,
    unpaid_jobs: [{ id: 'manual-1', ref: 'AAE-MANUAL', payout_mode: 'manual', disposition: 'pending' }],
  },
  {
    ...baseEaser, assembler_id: 'easer-2', assembler_name: 'Alexandria Maria Longlastname',
    assembler_tier: 'professional', payout_method_preference: null,
    jobs: 4, total_owed: 98765, total_paid: 56789, total_payable: 0,
    total_connect_pending: 41976, total_on_hold: 0,
    unpaid_jobs: [
      { id: 'connect-transfer', ref: 'AAE-TRANSFER', payout_mode: 'stripe_connect', disposition: 'transferred' },
      { id: 'connect-pending', ref: 'AAE-AUTOMATIC', payout_mode: 'stripe_connect', disposition: 'pending' },
    ],
  },
  {
    ...baseEaser, assembler_id: 'easer-3', assembler_name: 'Jo & Sam <img src=x onerror=alert(1)>',
    assembler_tier: 'elite', payout_method_preference: 'zelle', account_closure_status: 'reviewing',
    email: 'quoted"address@example.test', jobs: 8,
    total_owed: 30101, total_paid: 10101, total_payable: 10000, total_connect_pending: 5000, total_on_hold: 5000,
    unpaid_jobs: [
      { id: 'mixed-hold"', ref: 'AAE-<HOLD>', payout_mode: 'manual', disposition: 'on_hold', hold_reasons: ['Review <script>unsafe</script> evidence'] },
      { id: 'mixed-auto', ref: 'AAE-MIX-AUTO', payout_mode: 'stripe_connect', disposition: 'pending' },
      { id: 'mixed-manual', ref: 'AAE-MIX-MANUAL', payout_mode: 'manual', disposition: 'pending' },
      { id: 'mixed-extra', ref: 'AAE-EXTRA', payout_mode: 'manual', disposition: 'pending' },
    ],
  },
  { ...baseEaser, assembler_id: 'easer-4', assembler_name: 'No tier yet', assembler_tier: null, phone: null, email: null },
];
const rendered = await render(ledgerRows);
assert.equal(rendered.context.payoutTruthAvailable, true);
assert.equal(rendered.context.reserveParts.payouts, baseTotals.total_pending);
assert.equal(rendered.context.payoutJobsByBookingId.size, 7, 'hidden fourth job is still retained in canonical payout lookup');
const renderedRows = rows(rendered.html);
assert.equal(renderedRows.length, ledgerRows.length);
for (let index = 0; index < ledgerRows.length; index += 1) {
  const record = ledgerRows[index];
  const columns = cells(renderedRows[index]);
  assert.equal(columns.length, 10, 'identity repair must retain existing table semantics');
  assert.match(columns[0], /class="payout-easer"/);
  assert.match(columns[0], /class="payout-easer-identity"/);
  assert.match(columns[0], /class="payout-easer-name"/);
  assert.match(columns[0], /class="payout-easer-tier"/);
  assert.match(columns[0], /^<div class="payout-easer">/);
  let depth = 0;
  let topLevelDivs = 0;
  for (const tag of columns[0].matchAll(/<\/?div\b[^>]*>/g)) {
    if (tag[0].startsWith('</')) depth -= 1;
    else {
      if (depth === 0) topLevelDivs += 1;
      depth += 1;
    }
    assert.ok(depth >= 0, 'identity cell has balanced wrappers');
  }
  assert.equal(depth, 0);
  assert.equal(topLevelDivs, 1, 'contact and closure must share the identity wrapper on mobile');
  assert.ok(columns[0].includes(esc(record.assembler_name)));
  assert.equal(columns[2], String(record.jobs));
  for (const [column, key] of [[3, 'total_owed'], [4, 'total_paid'], [5, 'total_payable'], [6, 'total_connect_pending'], [7, 'total_on_hold']]) {
    assert.equal(columns[column], money(record[key]), `${key} must remain the server amount`);
  }
  assert.equal(columns[8], 'Date ' + record.last_earning_date);
  if (record.assembler_tier) assert.ok(columns[0].includes(record.assembler_tier));
}
assert.match(renderedRows[0], /data-payout-booking-id="manual-1"[^>]*data-payout-intent="record"/);
assert.match(renderedRows[1], /Processing bank payout/);
assert.match(renderedRows[1], /Pending automatic transfer/);
assert.doesNotMatch(renderedRows[1], /data-payout-booking-id=|data-payout-intent=/, 'Connect transfers remain informational, never manual payout buttons');
assert.match(renderedRows[2], /data-payout-booking-id="mixed-hold&quot;"[^>]*data-payout-intent="review"/);
assert.match(renderedRows[2], /data-payout-booking-id="mixed-manual"[^>]*data-payout-intent="record"/);
assert.match(renderedRows[2], /Pending automatic transfer/);
assert.match(renderedRows[2], /\+1 more/);
assert.match(renderedRows[2], /Closure: reviewing/);
assert.match(renderedRows[3], /No action/);
assert.match(renderedRows[3], /Email missing/);
assert.match(renderedRows[3], /Valid phone required/);
assert.doesNotMatch(rendered.html, /<script\b|<img\b|<HOLD>/i);
assert.match(rendered.html, /Jo &amp; Sam &lt;img/);
assert.match(rendered.html, /quoted&quot;address@example\.test/);
assert.match(rendered.html, /Review &lt;script&gt;unsafe&lt;\/script&gt; evidence/);
for (const key of ['total_payable', 'total_connect_pending', 'total_on_hold', 'total_paid']) {
  assert.ok(rendered.totalsHtml.includes(money(baseTotals[key])), `totals preserve ${key}`);
}
assert.equal(rendered.elements.get('nav-payouts').textContent, 4);

const empty = await render([]);
assert.match(empty.html, /colspan="10"/);
assert.match(empty.html, /No completed-job or cancellation earnings/);
assert.equal(empty.context.payoutTruthAvailable, true);
assert.equal(empty.elements.get('nav-payouts').style.display, 'none');
for (const failure of [
  { networkError: true }, { ok: false }, { response: { error: 'Mock payout source unavailable' } }, { ok: false, invalidJson: true },
]) {
  const result = await render(ledgerRows, failure);
  assert.equal(result.context.payoutTruthAvailable, false);
  assert.equal(result.context.payoutJobsByBookingId.size, 0);
  assert.match(result.html, /colspan="10"/);
  assert.match(result.html, /Payout data could not be verified/);
  assert.doesNotMatch(result.html, /\$0\.00|data-payout-booking-id=/);
  assert.match(result.totalsHtml, /Payout totals unavailable/);
  assert.equal(result.elements.get('nav-payouts').textContent, '!');
}

// These guards ensure the actual renderer stays wired to the production layout.
// They complement browser geometry checks; source assertions alone do not prove
// that badge positions or wrapping are correct in a browser.
const table = owner.match(/<table\b[^>]*id="an-payout-table"[^>]*>[\s\S]*?<\/table>/)?.[0];
assert.ok(table);
assert.equal([...table.matchAll(/<th\b/g)].length, 10);
assert.match(table, /Manual payout preference/);
assert.doesNotMatch(table, />Preferred Method</);
const ledgerSection = owner.slice(owner.indexOf('<!-- Payout Ledger'), owner.indexOf('</tbody>', owner.indexOf('<!-- Payout Ledger')));
assert.match(ledgerSection, /manual payouts/i);
assert.match(ledgerSection, /Stripe payout setup/i);
assert.match(css, /\.payout-easer-identity\s*\{[^}]*display\s*:\s*grid/);
assert.match(css, /\.payout-easer-identity\s*\{[^}]*grid-template-columns\s*:\s*minmax\(0\s*,\s*1fr\)\s+7\.25rem/);
assert.match(css, /\.payout-easer-name[^}]*overflow-wrap\s*:\s*anywhere/);
assert.match(css, /\.payout-easer-tier\s*\{[^}]*width\s*:\s*7\.25rem/);
assert.match(css, /\.payout-easer-tier\s+\.sb\s*\{[^}]*width\s*:\s*100%[^}]*justify-content\s*:\s*center/);
assert.match(css, /@media\s*\(\s*max-width\s*:\s*800px\s*\)\s*\{[\s\S]*?\.payout-easer-identity\s*\{[^}]*grid-template-columns\s*:\s*(?:1fr|minmax\(0\s*,\s*1fr\))/);

console.log('Owner payout ledger presentation: PASS (actual renderer, neutral preferences, identity slots, server amounts, manual/Connect actions, escaping and source failures)');
