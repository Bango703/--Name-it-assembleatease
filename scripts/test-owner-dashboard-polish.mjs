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
