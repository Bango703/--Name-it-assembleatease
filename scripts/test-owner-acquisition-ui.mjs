import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync('owner/assets/acquisition.js', 'utf8');
function harness() {
  const nodes = new Map();
  for (const id of ['acquisition-report', 'acquisition-status', 'acquisition-refresh', 'acquisition-period', 'acquisition-internal', 'acquisition-internal-status', 'logout-btn']) {
    nodes.set(id, { innerHTML: '', textContent: '', value: '28', disabled: false, checked: false, events: {}, addEventListener(name, handler) { this.events[name] = handler; } });
  }
  const state = { token: 'owner-one', requests: [], values: new Map(), readBlocked: false, writeBlocked: false, windowEvents: {} };
  const context = vm.createContext({
    document: { getElementById: id => nodes.get(id) },
    _ownerHeaders: () => ({ Authorization: state.token ? 'Bearer ' + state.token : '' }),
    localStorage: {
      getItem(key) { if (state.readBlocked) throw new Error('storage unavailable'); return state.values.get(key) ?? null; },
      setItem(key, value) { if (state.writeBlocked) throw new Error('storage unavailable'); state.values.set(key, value); },
      removeItem(key) { if (state.writeBlocked) throw new Error('storage unavailable'); state.values.delete(key); },
    },
    fetch(url, options) { return new Promise((resolve, reject) => state.requests.push({ url, options, resolve, reject })); },
    addEventListener(name, fn) { state.windowEvents[name] = fn; },
  });
  context.window = context;
  vm.runInContext(source, context);
  const report = (label = 'Organic search') => ({
    generatedAt: '2026-10-07T17:00:00Z', range: { from: '2026-09-09', to: '2026-10-06' },
    summary: { bookings: 1, completed: 1, incompleteAttribution: 0, recordedPaymentsCents: null, platformGrossCents: 2000 },
    excludedTests: 0, warnings: ['Recorded payment evidence unavailable.'], notes: ['Bookings are distinct from website sessions.'],
    channels: [{ label, bookings: 1, completed: 1, cancelled: 0, open: 0, uniqueContacts: 1, recordedPaymentsCents: null,
      rows: [{ bookingId: 'id" onclick="bad', ref: '<img onerror=bad>', city: 'Austin', status: 'completed', channel: 'organic_search', recordedPaymentsCents: null, financeBasis: 'Unknown' }] }],
    markets: [],
  });
  return { state, node: id => nodes.get(id), app: context.OwnerAcquisition, report,
    resolve(index, body = report(), ok = true, status = 200) { state.requests[index].resolve({ ok, status, json: async () => body }); } };
}

const h = harness();
assert.match(h.node('acquisition-internal-status').textContent, /normal website analytics consent/);
assert.equal(h.state.values.size, 0, 'opening the owner dashboard must never silently opt out');
h.state.token = '';
await h.app.load();
assert.equal(h.state.requests.length, 0, 'missing auth must not fetch private reports');
h.state.token = 'owner-one';
const first = h.app.load();
assert.equal(h.node('acquisition-refresh').disabled, true);
assert.equal(h.state.requests[0].options.cache, 'no-store');
h.resolve(0); await first;
assert.match(h.node('acquisition-status').textContent, /2026-09-09 through 2026-10-06/);
assert.match(h.node('acquisition-report').innerHTML, /Unknown/);
assert.match(h.node('acquisition-report').innerHTML, /&lt;img onerror=bad&gt;/);
assert.doesNotMatch(h.node('acquisition-report').innerHTML, /<img|data-demand-booking="id" onclick/);

// A newer selected period wins even when the older response arrives afterward.
const earlier = h.app.load();
h.node('acquisition-period').value = '90';
const newer = h.app.load();
assert.equal(h.node('acquisition-report').innerHTML, '');
assert.match(h.state.requests[2].url, /period=90$/);
h.resolve(2, h.report('New period')); await newer;
h.resolve(1, h.report('Old period')); await earlier;
assert.match(h.node('acquisition-report').innerHTML, /New period/);
assert.doesNotMatch(h.node('acquisition-report').innerHTML, /Old period/);

const pending = h.app.load();
h.node('logout-btn').events.click();
h.resolve(3); await pending;
assert.equal(h.node('acquisition-report').innerHTML, '');
assert.equal(h.node('acquisition-refresh').disabled, false);

const failed = h.app.load();
h.state.requests[4].reject(new Error('Network unavailable')); await failed;
assert.match(h.node('acquisition-status').textContent, /could not be loaded.*Missing counts are not zero/);
assert.doesNotMatch(h.node('acquisition-status').textContent, /Network unavailable/);
assert.equal(h.node('acquisition-report').innerHTML, '');

const stale = h.app.load();
h.state.token = 'owner-two';
h.state.requests[5].reject(new Error('Old session detail')); await stale;
assert.doesNotMatch(h.node('acquisition-status').textContent, /Old session detail/);
assert.equal(h.node('acquisition-status').textContent, 'Report has not loaded.');

const parserFailure = h.app.load();
h.state.requests[6].resolve({ ok: true, status: 200, json: async () => { throw new Error('Unexpected token < at position 0'); } });
await parserFailure;
assert.match(h.node('acquisition-status').textContent, /could not be loaded/);
assert.doesNotMatch(h.node('acquisition-status').textContent, /Unexpected token/);
const expired = h.app.load();
h.resolve(7, { error: 'private internal error' }, false, 401); await expired;
assert.match(h.node('acquisition-status').textContent, /session has expired.*Sign in again/);
assert.doesNotMatch(h.node('acquisition-status').textContent, /private internal error/);
const unavailable = h.app.load();
h.resolve(8, { error: 'database unavailable details' }, false, 503); await unavailable;
assert.match(h.node('acquisition-status').textContent, /temporarily unavailable.*Missing counts are not zero/);

// The explicit internal-browser control faithfully reflects persisted state.
const field = h.node('acquisition-internal');
field.checked = true; field.events.change.call(field);
assert.equal(h.state.values.get('aae-analytics-internal'), '1');
assert.match(h.node('acquisition-internal-status').textContent, /excluded/);
h.state.writeBlocked = true;
field.checked = false; field.events.change.call(field);
assert.equal(field.checked, true, 'failed write must restore the persisted checkbox state');
assert.match(h.node('acquisition-internal-status').textContent, /Could not save/);
h.state.readBlocked = true; h.state.windowEvents.storage();
assert.equal(field.disabled, true);
h.state.readBlocked = false; h.state.writeBlocked = false; h.state.windowEvents.storage();
assert.equal(field.disabled, false, 'recovered storage allows a deliberate setting change');
field.checked = false; field.events.change.call(field);
assert.equal(h.state.values.has('aae-analytics-internal'), false);
assert.equal(h.state.requests.length, 9, 'browser exclusion never writes booking or payment data');

console.log('Owner acquisition UI: dates, unknown money, escaping, request lifecycle, auth changes and explicit storage control PASS');
