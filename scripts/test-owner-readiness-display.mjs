// Execute the actual owner presentation and loader with isolated DOM/network fakes.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const dashboard = await readFile(new URL('../owner/index.html', import.meta.url), 'utf8');
function fn(name) {
  const match = new RegExp(`  (?:async )?function ${name}\\(`).exec(dashboard);
  assert.ok(match, `${name} exists`);
  const end = dashboard.indexOf('\n  }', match.index);
  assert.ok(end > match.index, `${name} has a top-level closing brace`);
  return dashboard.slice(match.index, end + '\n  }'.length);
}
const names = ['esc', 'readinessChip', 'easerOfferPresentation', 'renderOnboardingReadinessPanel', 'loadEaserOnboardingReadiness'];
const serial = dashboard.match(/  var easerReadinessRequest = 0;/)?.[0];
assert.ok(serial, 'The loader request sequence is initialized');
const panelId = 'asm-onboarding-readiness-panel';
const chipId = 'asm-dispatch-chip';
const element = () => ({ innerHTML: '', textContent: '', style: {} });

function readiness(overrides = {}) {
  return {
    requirementsVerified: true, requirementsReady: true, requirementsMissingItems: [],
    offerStatus: 'offline', available: false,
    applicationSubmitted: true, contractorAgreementAccepted: true, agreementCurrent: true,
    agreementVersion: 'fixture-agreement', codeOfConductAccepted: true, applicationFeeSatisfied: true,
    phoneAvailable: true, jobTextsEnabled: true, tierEligible: true, identityVerified: true, ownerApproved: true,
    // The old dispatch verdict deliberately disagrees with complete setup while offline.
    isReady: false, finalStatus: 'ACTION REQUIRED', missingItems: ['Online and available'],
    connectRequired: false, payoutSetupComplete: true, taxReadinessStatus: 'W-9 Requested', w9Status: 'requested',
    ...overrides,
  };
}
const payload = overrides => ({ readiness: readiness(overrides) });

function harness() {
  const elements = new Map([[panelId, element()], [chipId, element()]]);
  const requests = [];
  const context = vm.createContext({
    document: { getElementById: id => elements.get(id) || null },
    currentAssemblerDetailId: 'easer-A',
    headers: () => ({ Authorization: 'Bearer isolated-owner-fixture' }),
    fetch: (url, options) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject })),
  });
  vm.runInContext([serial, ...names.map(fn)].join('\n'), context);
  function respond(index, data, ok = true) { requests[index].resolve({ ok, json: async () => data }); }
  function mount(id) {
    context.currentAssemblerDetailId = id;
    elements.set(panelId, element());
    elements.set(chipId, element());
  }
  return { context, elements, requests, respond, mount, panel: () => elements.get(panelId), chip: () => elements.get(chipId) };
}
const details = html => [...html.matchAll(/<details\b([^>]*)>([\s\S]*?)<\/details>/g)];
const summary = html => html.slice(0, html.indexOf('<details'));
function displaySnapshot(h) {
  return { html: h.panel().innerHTML, chip: h.chip().textContent, style: { ...h.chip().style } };
}
function assertUnverified(h) {
  assert.equal(h.chip().textContent, 'Unverified');
  assert.equal(h.chip().style.background, 'var(--elevated)');
  assert.match(h.panel().innerHTML, /could not be verified/);
  assert.match(h.panel().innerHTML, /role="status"/);
  assert.match(h.panel().innerHTML, /Retry readiness check/);
  assert.doesNotMatch(h.panel().innerHTML, /#d1fae5|>Complete<|>YES<|>NO<|Missing Job Requirements/);
}

// Offline is a pause in new offers, not an unmet job requirement.
const offline = harness();
offline.context.renderOnboardingReadinessPanel(payload());
assert.equal(offline.chip().textContent, 'Offline');
assert.equal(offline.chip().style.background, 'var(--elevated)');
assert.match(summary(offline.panel().innerHTML), /Job requirements[\s\S]*>Complete</);
assert.match(summary(offline.panel().innerHTML), /Job requirements are complete/);
assert.doesNotMatch(offline.panel().innerHTML, /Action required|ACTION REQUIRED|Missing Job Requirements/);
const offlineDetails = details(offline.panel().innerHTML);
assert.equal(offlineDetails.length, 2);
for (const section of offlineDetails) assert.doesNotMatch(section[1], /\bopen\b/, 'Details start collapsed');
assert.match(offlineDetails[0][2], /Availability<\/div><div[^>]*>Offline \(new offers paused\)<\/div>/);
assert.doesNotMatch(offlineDetails[0][2], />NO<|Stripe Connect|W-9/);
assert.match(offlineDetails[1][2], /Payout and tax setup[\s\S]*Manual external payouts[\s\S]*Not required for launch/);
assert.match(offlineDetails[1][2], /W-9 Requested/);
// The roster and detail use one server-state presentation helper.
assert.match(fn('renderAssemblerTable'), /esc\(easerOfferPresentation\(a\.readiness\)\.label\)/);

const online = harness();
online.context.renderOnboardingReadinessPanel(payload({ available: true, offerStatus: 'ready' }));
assert.equal(online.chip().textContent, 'Ready for offers');
assert.equal(online.chip().style.background, '#d1fae5');
assert.match(summary(online.panel().innerHTML), />Complete</);
assert.match(details(online.panel().innerHTML)[0][2], /Availability<\/div><div[^>]*>Online<\/div>/);

// Real requirements stay actionable, and every external requirement/copy value is escaped.
const missing = harness();
missing.context.renderOnboardingReadinessPanel(payload({
  requirementsReady: false, offerStatus: 'action_required', phoneAvailable: false, jobTextsEnabled: false,
  requirementsMissingItems: ['Valid phone on file', '<img src=x onerror="alert(1)">'],
  agreementVersion: '<script>agreement</script>', jobTexts: { label: '<svg onload="alert(2)">' },
  taxReadinessStatus: '<b>tax</b>', w9Status: '<i>not_requested</i>',
}));
assert.equal(missing.chip().textContent, 'Requirements need attention');
assert.match(summary(missing.panel().innerHTML), />Action required<|Missing Job Requirements/);
assert.match(missing.panel().innerHTML, /Missing Job Requirements[\s\S]*Valid phone on file/);
assert.match(missing.panel().innerHTML, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
assert.match(missing.panel().innerHTML, /&lt;script&gt;agreement&lt;\/script&gt;/);
assert.match(missing.panel().innerHTML, /&lt;svg onload=&quot;alert\(2\)&quot;&gt;/);
assert.match(missing.panel().innerHTML, /&lt;b&gt;tax&lt;\/b&gt;/);
assert.match(missing.panel().innerHTML, /&lt;i&gt;not requested&lt;\/i&gt;/);
assert.doesNotMatch(missing.panel().innerHTML, /<img|<script|<svg|<b>tax|<i>not/);

// Missing/legacy API proof cannot inherit an old green dispatch or setup badge.
for (const data of [null, undefined, {}, { readiness: {} },
  { readiness: { isReady: true, finalStatus: 'READY FOR JOBS', available: true } },
  payload({ requirementsVerified: false, offerStatus: 'ready' }),
  payload({ requirementsVerified: undefined, offerStatus: 'ready' }),
  payload({ offerStatus: 'future_unknown_state' }),
]) {
  const unknown = harness();
  unknown.context.renderOnboardingReadinessPanel(payload({ available: true, offerStatus: 'ready' }));
  unknown.context.renderOnboardingReadinessPanel(data);
  assertUnverified(unknown);
}

// Separate payout/tax trouble must not relabel complete job requirements.
for (const connectVerified of [true, false]) {
  const payout = harness();
  payout.context.renderOnboardingReadinessPanel(payload({
    connectRequired: true, connectVerified, payoutSetupComplete: false, connectStarted: true,
    connectComplete: false, payoutsEnabled: false, requirementsDueCount: 7,
    disabledReason: '<img src=x>', taxReadinessStatus: 'Action required', w9Status: 'not_requested',
    missingItems: ['Online and available', 'Stripe Connect incomplete', 'W-9 required'],
  }));
  assert.equal(payout.chip().textContent, 'Offline');
  assert.match(summary(payout.panel().innerHTML), />Complete</);
  assert.doesNotMatch(summary(payout.panel().innerHTML), /Action required|Missing Job Requirements/);
  const sections = details(payout.panel().innerHTML);
  assert.doesNotMatch(sections[0][2], /Stripe Connect|W-9|Payout Setup/);
  assert.match(sections[1][2], connectVerified ? /Payout and tax setup[^<]*Action required/ : /Payout and tax setup[^<]*Unverified/);
  assert.match(sections[1][2], connectVerified
    ? /Requirements Due Count<\/div><div[^>]*>7<\/div>/
    : /Requirements Due Count<\/div><div[^>]*>Unknown<\/div>/);
  assert.doesNotMatch(sections[1][2], /<img/);
  if (connectVerified) assert.match(sections[1][2], /&lt;img src=x&gt;/);
}

// Real loader: successful read, escaped URL parameter, authenticated read, no mutation.
const loaded = harness();
loaded.context.currentAssemblerDetailId = 'easer/A & B';
loaded.context.renderOnboardingReadinessPanel(payload({ available: true, offerStatus: 'ready' }));
const load = loaded.context.loadEaserOnboardingReadiness('easer/A & B');
assert.equal(loaded.chip().textContent, 'Checking...');
assert.equal(loaded.chip().style.background, 'var(--elevated)');
assert.match(loaded.panel().innerHTML, /Checking job requirements/);
assert.equal(loaded.requests[0].url, '/api/owner/easer-readiness?assemblerId=easer%2FA%20%26%20B');
assert.equal(loaded.requests[0].options.headers.Authorization, 'Bearer isolated-owner-fixture');
assert.equal(loaded.requests[0].options.method, undefined);
assert.equal(loaded.requests[0].options.body, undefined);
loaded.respond(0, payload()); await load;
assert.equal(loaded.chip().textContent, 'Offline');

for (const failure of ['http', 'api', 'network', 'json']) {
  const failed = harness();
  failed.context.renderOnboardingReadinessPanel(payload({ available: true, offerStatus: 'ready' }));
  const pending = failed.context.loadEaserOnboardingReadiness('easer-A');
  if (failure === 'network') failed.requests[0].reject(new Error('Network unavailable'));
  else if (failure === 'json') failed.requests[0].resolve({ ok: true, json: async () => { throw new Error('Bad JSON'); } });
  else failed.respond(0, { error: '<script>private failure detail</script>' }, failure !== 'http');
  await pending;
  assertUnverified(failed);
  assert.doesNotMatch(failed.panel().innerHTML, /private failure detail|<script>/);
}

// A late success or error from A cannot overwrite B's already rendered result.
for (const olderFails of [false, true]) {
  const race = harness();
  const oldPanel = race.panel();
  const old = race.context.loadEaserOnboardingReadiness('easer-A');
  race.mount('easer-B');
  const fresh = race.context.loadEaserOnboardingReadiness('easer-B');
  race.respond(1, payload({ offerStatus: 'ready', available: true })); await fresh;
  const before = displaySnapshot(race);
  if (olderFails) race.requests[0].reject(new Error('Late A failure'));
  else race.respond(0, payload({ requirementsReady: false, offerStatus: 'action_required', requirementsMissingItems: ['Old A blocker'] }));
  await old;
  assert.deepEqual(displaySnapshot(race), before);
  assert.match(oldPanel.innerHTML, /Checking job requirements/, 'Detached panel is not rendered into either');
}

// Two refreshes of the same person and same DOM still require latest-request wins.
for (const olderFails of [false, true]) {
  const race = harness();
  const old = race.context.loadEaserOnboardingReadiness('easer-A');
  const fresh = race.context.loadEaserOnboardingReadiness('easer-A');
  race.respond(1, payload()); await fresh;
  const before = displaySnapshot(race);
  if (olderFails) race.requests[0].reject(new Error('Older refresh failed'));
  else race.respond(0, payload({ offerStatus: 'ready', available: true }));
  await old;
  assert.deepEqual(displaySnapshot(race), before);
}

// Independently prove person identity and container identity, without a newer request.
for (const change of ['different-person', 'closed', 'replaced-container']) {
  for (const olderFails of [false, true]) {
    const race = harness();
    const pending = race.context.loadEaserOnboardingReadiness('easer-A');
    if (change === 'replaced-container') race.mount('easer-A');
    else race.context.currentAssemblerDetailId = change === 'closed' ? null : 'easer-B';
    race.panel().innerHTML = 'Current view must remain';
    race.chip().textContent = 'Current chip';
    const before = displaySnapshot(race);
    if (olderFails) race.requests[0].reject(new Error('Stale request failed'));
    else race.respond(0, payload());
    await pending;
    assert.deepEqual(displaySnapshot(race), before, `${change}: stale ${olderFails ? 'error' : 'success'} is ignored`);
  }
}
const absent = harness();
absent.elements.delete(panelId);
await absent.context.loadEaserOnboardingReadiness('easer-A');
assert.equal(absent.requests.length, 0);
assert.doesNotThrow(() => absent.context.renderOnboardingReadinessPanel(payload()));
const noChip = harness();
noChip.elements.delete(chipId);
assert.doesNotThrow(() => noChip.context.renderOnboardingReadinessPanel(payload()));
assert.match(noChip.panel().innerHTML, />Complete</);

console.log('Owner readiness display: PASS (offline setup, real blockers, escaping, unverified proof, separate payout/tax, read failures, request/person/container races)');
