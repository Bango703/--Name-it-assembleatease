#!/usr/bin/env node
// Owner Bookings tabs (owner, 2026-10-18): the list opened on All, which was
// mostly test and cancelled bookings. It now opens on Active, test bookings
// sit only under Test, and each tab's count is the length of the list it opens.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const html = (await readFile(new URL('../owner/index.html', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');

const tabs = [...html.slice(html.indexOf('<div class="tabs" id="tabs">'), html.indexOf('</div>', html.indexOf('<div class="tabs" id="tabs">')))
  .matchAll(/<button class="tab( active)?" data-status="([a-z]+)">/g)].map(m => ({ status: m[2], active: !!m[1] }));
assert.deepEqual(tabs.map(t => t.status), ['active', 'pending', 'confirmed', 'completed', 'cancelled', 'declined', 'all', 'test']);
assert.deepEqual(tabs.filter(t => t.active).map(t => t.status), ['active'], 'Active is the tab that opens first');
assert.match(html, /let currentStatus = 'active';/, 'the list starts on Active');

// Run the real filter against sample bookings.
const start = html.indexOf('  var ACTIVE_BOOKING_TAB_STATUSES');
const end = html.indexOf('  function renderList() {', start);
assert.ok(start > 0 && end > start, 'the tab filter is one block');
const ctx = vm.createContext({
  PIPELINE_STATUSES: ['en_route', 'arrived', 'in_progress'],
  isTestBooking: b => !!b && b.is_test_booking === true,
  allBookings: [
    { id: 1, status: 'pending' },
    { id: 2, status: 'confirmed' },
    { id: 3, status: 'in_progress' },
    { id: 4, status: 'completed' },
    { id: 5, status: 'cancelled' },
    { id: 6, status: 'declined' },
    { id: 7, status: 'confirmed', is_test_booking: true },
    { id: 8, status: 'cancelled', is_test_booking: true },
  ],
});
vm.runInContext(html.slice(start, end) + '\nglobalThis.bookingsForTab = bookingsForTab;', ctx);
const ids = tab => ctx.bookingsForTab(tab).map(b => b.id);
assert.deepEqual(ids('active'), [1, 2, 3], 'Active: waiting, booked or under way; no test, no closed');
assert.deepEqual(ids('confirmed'), [2, 3]);
assert.deepEqual(ids('cancelled'), [5], 'a cancelled test booking stays out of Cancelled');
assert.deepEqual(ids('all'), [1, 2, 3, 4, 5, 6], 'All is every real booking');
assert.deepEqual(ids('test'), [7, 8], 'test bookings only under Test');

// The tab number is the list's length, from the same filter.
assert.match(html, /var c = bookingsForTab\(s\)\.length;/, 'tab counts come from the list filter');
assert.match(html, /var filtered = bookingsForTab\(currentStatus\);/, 'the list uses the same filter');
assert.match(html, /currentStatus = isTestBooking\(booking\) \? 'test' : 'all';/, 'opening a booking by ref shows the tab that holds it');

console.log('PASS owner bookings tabs: opens on Active, test bookings only under Test, counts are list lengths');
