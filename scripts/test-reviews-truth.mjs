#!/usr/bin/env node
// Reviews left on test bookings are listed but never counted (2026-10-15: the App
// Review test job's 5-star rating showed as "1 review, 5.0" on the owner dashboard).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadReviews, summarizeReviews } from '../api/_reviews-truth.js';

const reviewsRows = [
  { id: 'r1', booking_id: 'b-test', rating: 5, approved: true, body: '' },
  { id: 'r2', booking_id: 'b-real', rating: 4, approved: true, body: 'Good' },
  { id: 'r3', booking_id: 'b-real2', rating: 2, approved: false, body: 'Late' },
];
const bookings = [{ id: 'b-test', is_test_booking: true }, { id: 'b-real', is_test_booking: false }, { id: 'b-real2', is_test_booking: null }];
const sb = {
  from(table) {
    const q = { _approved: false, select() { return q; }, order() { return q; }, eq(col, v) { if (col === 'approved') q._approved = v; return q; },
      in(_c, ids) { return Promise.resolve({ data: bookings.filter(b => ids.includes(b.id)), error: null }); },
      then(resolve) { const data = table === 'reviews' ? reviewsRows.filter(r => !q._approved || r.approved === true) : []; return Promise.resolve({ data, error: null }).then(resolve); } };
    return q;
  },
};

const all = await loadReviews(sb);
assert.equal(all.length, 3, 'every review is still listed');
assert.equal(all.find(r => r.id === 'r1').is_test, true);
const sum = summarizeReviews(all);
assert.deepEqual(sum, { total: 2, average: 3, fiveStar: 0, hidden: 1, testExcluded: 1 });
assert.deepEqual(summarizeReviews(await loadReviews(sb, { approvedOnly: true })), { total: 1, average: 4, fiveStar: 0, hidden: 0, testExcluded: 1 });
assert.equal(summarizeReviews([]).average, null, 'no reviews means no average, not zero');

const read = f => readFileSync(f, 'utf8');
assert.match(read('api/owner/reviews.js'), /summary: summarizeReviews\(reviews\)/, 'the owner panel gets its counts from the server');
assert.match(read('api/owner/financial-dashboard.js'), /summarizeReviews\(await loadReviews\(sb, \{ approvedOnly: true \}\)\)/);
assert.match(read('api/owner/monitor.js'), /\.filter\(r => r\.is_test !== true\)/, 'the monitor leaves test reviews out');
const owner = read('owner/index.html');
assert.match(owner, /reviewSummary = data\.summary/, 'the panel renders the server counts');
assert.doesNotMatch(owner, /allReviews\.reduce\(/, 'the panel never computes its own average');
assert.match(owner, /No comment left\./, 'an empty comment is said, not printed as empty quotes');
console.log('PASS reviews truth: test-booking reviews listed but never counted, one summary for dashboard, monitor and finance.');
