#!/usr/bin/env node
// The owner dashboard opens on Live Operations.
//
// It used to open on Bookings — the record book — so the first thing the owner
// saw was a list of every booking ever taken, and the page that answers "what
// needs me right now" (alerts, bookings needing action, active jobs, today's
// schedule, who is free) only loaded if he clicked it. Rule 8: the dashboard
// must answer "what does Travis do next?" without being asked for it.
//
// Four things have to agree or the page opens in a contradictory state: the
// starting view, the highlighted nav link, which panel is visible, and the
// title in the top bar. They are set in four different places, so they are
// checked together here.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../owner/index.html', import.meta.url), 'utf8');

// ── 1. The starting view ────────────────────────────────────────────────────
assert.match(html, /var currentView = 'liveops';/, 'the dashboard starts on Live Ops');
assert.doesNotMatch(html, /var currentView = 'bookings';/);

// ── 2. Exactly one nav link is highlighted, and it is that view ─────────────
const navLinks = [...html.matchAll(/<a([^>]*?)data-view="([a-z-]+)"/g)]
  .map(match => ({ view: match[2], active: /class="[^"]*\bactive\b/.test(match[1]) }));
const activeLinks = navLinks.filter(link => link.active);
assert.equal(activeLinks.length, 1, `exactly one nav link starts active (found ${activeLinks.length})`);
assert.equal(activeLinks[0].view, 'liveops', 'and it is the Live Ops link');
assert.ok(navLinks.some(link => link.view === 'bookings' && !link.active), 'Bookings does not also start active');

// ── 3. The panel that is visible is the one the nav says ────────────────────
const liveOpsDiv = html.match(/<div id="liveops-view"([^>]*)>/);
const bookingsDiv = html.match(/<div id="bookings-view"([^>]*)>/);
assert.ok(liveOpsDiv && bookingsDiv, 'both views exist');
assert.doesNotMatch(liveOpsDiv[1], /display:\s*none/, 'Live Ops is visible on load');
assert.match(bookingsDiv[1], /display:\s*none/, 'Bookings is hidden until it is chosen');

// ── 4. The top bar names the view the owner is looking at ───────────────────
assert.match(html, /<div class="topbar-title">Live Operations<\/div>/,
  'the title matches the landing view instead of naming a page that is not shown');

// ── 5. The landing view refreshes itself without being clicked ──────────────
// Live Ops polls every 30s, and that polling used to begin only inside the nav
// click handler. Opening on it without starting it would show one snapshot and
// then quietly go stale.
const showDashboard = html.slice(html.indexOf('function showDashboard()'), html.indexOf('function showDashboard()') + 1400);
assert.match(showDashboard, /startLiveOps\(\)/, 'signing in starts the Live Ops refresh');
assert.match(showDashboard, /setTimeout\(function \(\) \{ if \(currentView === 'liveops'\) startLiveOps\(\); \}, 0\);/,
  'deferred by a tick: a saved session calls showDashboard before _liveOpsTimer exists, and starting it earlier would leak the interval');

// ── 6. Opening a booking record still takes you to Bookings ─────────────────
assert.match(html, /window\.openOwnerBookingRecord = async function[\s\S]{0,400}currentView = 'bookings';/,
  'the flows that jump to a booking still switch views');

console.log('Owner landing view tests: PASS');
