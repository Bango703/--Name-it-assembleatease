#!/usr/bin/env node
// Owner dashboard audit (owner, 2026-11-27: "i need a full audit on dashboard.
// layout, duplicates and everything ... see if dashbaord looks professional").
// Locks the fixes from that audit:
//   - one Refresh per screen (the header one reloads the screen you are on),
//     and it keeps its icon after a refresh;
//   - the Financial Report (PDF) button only on Financials;
//   - one "Create Booking" button with a plus icon (it opens a form here);
//   - Marketing never calls the social queue healthy with no channel connected;
//   - Phone Calls shows one date style and phone numbers like the rest;
//   - pop-up titles use the console type, not the old serif.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const page = read('owner/index.html');

for (const id of ['voice-calls-refresh', 'inbox-refresh', 'partners-refresh', 'giftcards-refresh', 'site-chat-refresh-btn', 'mk-social-refresh']) {
  assert.doesNotMatch(page, new RegExp(`id="${id}"`), `${id}: one Refresh per screen, the header one`);
}
const handler = page.slice(page.indexOf("document.getElementById('refresh-btn').addEventListener"), page.indexOf("if (ownerSessionToken) showDashboard();"));
for (const view of ['voice-calls', 'messages', 'partners', 'giftcards', 'marketing', 'intelligence']) {
  assert.match(handler, new RegExp(`currentView === '${view}'`), `the header Refresh reloads ${view}`);
}
assert.match(handler, /var label = btn\.innerHTML;[\s\S]*btn\.innerHTML = label;/, 'the header Refresh keeps its icon');
for (const file of ['owner/assets/voice-calls.js', 'owner/assets/messages.js', 'owner/assets/partners.js']) {
  assert.doesNotMatch(read(file), /el\('(voice-calls|inbox|partners)-refresh'\)\.disabled/, `${file}: no crash when the in-screen Refresh is gone`);
}

const syncStart = page.indexOf('function syncPrimaryOwnerAction(view) {');
const sync = page.slice(syncStart, page.indexOf('\n  }\n', syncStart));
assert.match(sync, /report\.style\.display = view === 'analytics' \? '' : 'none';/, 'the Financial Report button is on Financials only');
assert.doesNotMatch(page, /Add Customer \+ Booking/, 'one name for the one create form');
assert.doesNotMatch(page, /id="new-booking-btn"[^>]*><svg[^>]*><path d="M14 3h7v7"/, 'no "opens a new page" icon on a button that opens a form');
assert.match(page, /id="new-booking-btn" type="button"><svg[^>]*><path d="M12 5v14"\/><path d="M5 12h14"\/><\/svg> Create Booking/);
assert.match(page, /placeholder="Search bookings"/, 'the search placeholder fits its box');

const social = page.slice(page.indexOf("var note = document.getElementById('mk-social-note');"), page.indexOf('Queue coverage is healthy.'));
assert.match(social, /else if \(!channels\.length\) \{\n\s+note\.textContent = 'No social channels are connected yet\.';/, 'no "healthy" with nothing connected');

const calls = read('owner/assets/voice-calls.js');
assert.match(calls, /function time\(value\) \{[^}]*year: 'numeric'/, 'one date style in Phone Calls');
assert.match(calls, /fact\('From', call\.from \? phone\(call\.from\)/, 'phone numbers formatted in the call detail');
assert.match(calls, /esc\(party \? phone\(party\) : 'Number unavailable'\)/, 'phone numbers formatted in the call list');

assert.match(read('owner/assets/console.css'), /\.modal h3 \{ font-family: inherit; font-weight: 700; \}/, 'pop-up titles use the console type');

console.log('PASS owner dashboard polish: one Refresh, report on Financials, one create button, honest social note, call formats, console type in pop-ups');

// ── Market Demand layout (owner, 2026-11-27: "marketdemand is just messy") ──
{
  const view = page.slice(page.indexOf('<div id="market-demand-view"'), page.indexOf('<!-- ─── WAITLIST VIEW ─── -->'));
  const coverage = view.slice(view.indexOf('md-coverage-card'), view.indexOf('<div class="md-row2">'));
  assert.ok(coverage.includes('id="md-coverage"') && coverage.includes('id="md-top-markets"'), 'one coverage card: the summary sits over the area cards');
  assert.equal((view.match(/<h3>Market Coverage/g) || []).length, 1, 'coverage is not shown twice');
  const acq = view.slice(view.indexOf('class="fin-card md-acq"'), view.indexOf('id="dispatch-health-card"'));
  assert.doesNotMatch(acq, /acquisition-internal/, 'the browser setting is not inside the report');
  assert.match(view, /<div class="md-browser-setting">[\s\S]*id="acquisition-internal"/, 'the browser setting sits at the foot of the page');
  assert.ok(view.indexOf('md-coverage-card') < view.indexOf('md-row2') && view.indexOf('md-row2') < view.indexOf('dispatch-health-card')
    && view.indexOf('dispatch-health-card') < view.indexOf('md-requests-table') && view.indexOf('md-requests-table') < view.indexOf('id="md-reconciliation"'),
  'order: coverage, trend and acquisition, Houston, activity, records');
  const css = read('owner/assets/console.css');
  assert.doesNotMatch(css, /\.md-row3|\.md-acq \{ grid-column/, 'no rule pushes acquisition off the trend row');
  assert.match(css, /\.md-kpi \.kpi-value \{ overflow: visible; text-overflow: clip; \}/, 'a money figure is never cut off');
  assert.match(page, /if \(!rows\.length\) return '<span class="md-count-zero">'/, 'a zero count is plain text, not an empty drop-down');
  const dh = page.slice(page.indexOf('function dhList('), page.indexOf('function renderMarketDemand('));
  assert.match(dh, /<details class="dh-checks"><summary>All recruitment checks/, 'the rule list is folded');
  assert.match(dh, /None in this window: /, 'empty lists fold into one line');
  assert.match(dh, /formatDate\(r\.date\)/, 'readable dates');
  assert.doesNotMatch(page.slice(page.indexOf('async function loadDispatchHealth()'), page.indexOf('function dhPct(')), /'Last ' \+ d\.windowDays \+ ' days, ZIPs '/, 'never prints "undefined"');
  assert.doesNotMatch(read('api/owner/_dispatch-health.js'), /\(s\)/, 'plain plurals in the recruitment checks');
}
console.log('PASS Market Demand: one coverage card, trend beside acquisition, Houston card tidy, records and setting at the foot');
