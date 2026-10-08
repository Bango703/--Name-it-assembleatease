#!/usr/bin/env node
// Easer last-minute cancellations (owner, 2026-09-30): "they are not taking
// this platform serious. last minute cancellation knowing a job to be
// completed today." A cancellation after the 15-minute grace window cost the
// Easer nothing and landed on the owner as a support case.
//
// Now: late (<24h) = 1 strike, same-day = 2, 90-day window, pause at 3,
// dispatch ranks strikes down, the Easer sees the cost before confirming, the
// owner can excuse. This holds each rule shut.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EASER_RELIABILITY_POLICY as P, classifyEaserCancellation } from '../api/_source-of-truth.js';
import { loadEaserStrikes, recordEaserCancellation, pauseEaserIfOverLimit, excuseEaserCancellation } from '../api/_easer-reliability.js';

const H = 3600000;
// 2026-09-30 10:00 Central
const now = Date.parse('2026-09-30T10:00:00-05:00');
const accepted2dAgo = now - 48 * H;

// ── Classification ───────────────────────────────────────────────────────────
assert.equal(classifyEaserCancellation({ acceptedAtMs: now - 5 * 60000, nowMs: now, appointmentMs: now + 3 * H, appointmentDate: '2026-09-30' }).kind, 'grace', 'a mis-tap inside 15 minutes is free, even same day');
assert.equal(classifyEaserCancellation({ acceptedAtMs: accepted2dAgo, nowMs: now, appointmentMs: now + 6 * H, appointmentDate: '2026-09-30' }).kind, 'same_day');
assert.equal(classifyEaserCancellation({ acceptedAtMs: accepted2dAgo, nowMs: now, appointmentMs: now + 6 * H, appointmentDate: '2026-09-30' }).strikes, P.sameDayStrikes);
const tomorrowMorning = classifyEaserCancellation({ acceptedAtMs: accepted2dAgo, nowMs: now, appointmentMs: now + 23 * H, appointmentDate: '2026-10-01' });
assert.equal(tomorrowMorning.kind, 'late');
assert.equal(tomorrowMorning.strikes, P.lateStrikes);
assert.equal(classifyEaserCancellation({ acceptedAtMs: accepted2dAgo, nowMs: now, appointmentMs: now + 30 * H, appointmentDate: '2026-10-01' }).kind, 'advance');
assert.equal(classifyEaserCancellation({ acceptedAtMs: accepted2dAgo, nowMs: now, appointmentMs: now + 30 * H, appointmentDate: '2026-10-01' }).strikes, 0);
assert.equal(classifyEaserCancellation({ acceptedAtMs: accepted2dAgo, nowMs: now, appointmentMs: null, appointmentDate: '2026-10-03' }).kind, 'late', 'an unreadable time is not treated as advance notice');
assert.equal(classifyEaserCancellation({ acceptedAtMs: accepted2dAgo, nowMs: now, appointmentMs: now - H, appointmentDate: '2026-09-29' }).kind, 'same_day', 'after the start is at least same-day');
// Central-time day boundary: 11:30 PM Central on the 29th is still the 29th
const lateNight = Date.parse('2026-09-29T23:30:00-05:00');
assert.equal(classifyEaserCancellation({ acceptedAtMs: lateNight - 48 * H, nowMs: lateNight, appointmentMs: lateNight + 10 * H, appointmentDate: '2026-09-30' }).kind, 'late', 'tomorrow in Central time is not same-day');

// ── Fake database ────────────────────────────────────────────────────────────
function fakeDb(rows = [], profiles = {}) {
  const inserted = [];
  const db = {
    rows, profiles, inserted,
    from(table) {
      const q = { table, filters: [], _in: null, _gte: null, _contains: null, _update: null, _insert: null };
      const api = {
        select() { return api; },
        in(col, vals) { q._in = { col, vals }; return api; },
        gte(col, val) { q._gte = { col, val }; return api; },
        order() { return api; },
        eq(col, val) { q.filters.push([col, val]); return api; },
        contains(col, val) { q._contains = val; return api; },
        limit() { return api; },
        maybeSingle() { return api.then((r) => ({ data: (r.data || [])[0] || null, error: r.error })); },
        single() { return api.then((r) => ({ data: Array.isArray(r.data) ? r.data[0] : r.data, error: r.error })); },
        update(vals) { q._update = vals; return api; },
        insert(vals) { q._insert = vals; return api; },
        then(resolve, reject) {
          try {
            if (table === 'activity_logs' && q._insert) {
              const row = { id: 'log-' + (rows.length + 1), created_at: new Date(now).toISOString(), ...q._insert };
              rows.push(row); inserted.push(row);
              return Promise.resolve({ data: [row], error: null }).then(resolve, reject);
            }
            if (table === 'activity_logs') {
              let data = rows.slice();
              if (q._in) data = data.filter((r) => q._in.vals.includes(r[q._in.col]));
              if (q._gte) data = data.filter((r) => r.created_at >= q._gte.val);
              for (const [c, v] of q.filters) data = data.filter((r) => r[c] === v);
              if (q._contains) data = data.filter((r) => Object.entries(q._contains).every(([k, v]) => r.metadata?.[k] === v));
              return Promise.resolve({ data, error: null }).then(resolve, reject);
            }
            if (table === 'profiles' && q._update) {
              const id = q.filters.find(([c]) => c === 'id')?.[1];
              const needStatus = q.filters.find(([c]) => c === 'status')?.[1];
              const p = profiles[id];
              if (p && (!needStatus || p.status === needStatus)) { Object.assign(p, q._update); return Promise.resolve({ data: [{ id }], error: null }).then(resolve, reject); }
              return Promise.resolve({ data: [], error: null }).then(resolve, reject);
            }
            return Promise.resolve({ data: [], error: null }).then(resolve, reject);
          } catch (e) { return Promise.reject(e).then(resolve, reject); }
        },
      };
      return api;
    },
  };
  return db;
}

const iso = (ms) => new Date(ms).toISOString();
{
  const rows = [
    { id: 'a', booking_id: 'b1', event_type: 'easer_cancelled', created_at: iso(now - 10 * 86400000), metadata: { easerId: 'e1', kind: 'same_day', strikes: 2 } },
    { id: 'b', booking_id: 'b2', event_type: 'easer_cancelled', created_at: iso(now - 20 * 86400000), metadata: { easerId: 'e1', kind: 'late', strikes: 1 } },
    { id: 'c', booking_id: 'b3', event_type: 'easer_cancelled', created_at: iso(now - 120 * 86400000), metadata: { easerId: 'e1', kind: 'same_day', strikes: 2 } },
    { id: 'd', booking_id: 'b4', event_type: 'easer_cancelled', created_at: iso(now - 5 * 86400000), metadata: { easerId: 'e2', kind: 'late', strikes: 1 } },
    { id: 'x', booking_id: 'b4', event_type: 'easer_cancellation_excused', created_at: iso(now - 4 * 86400000), metadata: { easerId: 'e2', excusedLogId: 'd' } },
  ];
  const map = await loadEaserStrikes(fakeDb(rows), ['e1', 'e2', 'e3'], { nowMs: now });
  assert.equal(map.get('e1').strikes, 3, 'strikes inside 90 days add up; older ones drop off');
  assert.equal(map.get('e2').strikes, 0, 'an excused cancellation carries no strikes');
  assert.equal(map.get('e2').events[0].excused, true);
  assert.equal(map.get('e3').strikes, 0);
}

// Recording + pause at the limit, never overriding an owner decision
{
  const profiles = { e1: { status: 'active', is_available: true }, e9: { status: 'suspended' } };
  const db = fakeDb([], profiles);
  const rec = await recordEaserCancellation(db, { booking: { id: 'b1', ref: 'AAE-1' }, easerId: 'e1', easerName: 'Pat', classification: { kind: 'same_day', strikes: 2, hoursUntilStart: 5, minutesSinceAccept: 900 } });
  assert.equal(rec.ok, true);
  assert.equal(db.inserted[0].metadata.strikes, 2);
  assert.deepEqual(await pauseEaserIfOverLimit(db, { easerId: 'e1', easerName: 'Pat', strikes: 2 }), { paused: false });
  assert.equal((await pauseEaserIfOverLimit(db, { easerId: 'e1', easerName: 'Pat', strikes: 3 })).paused, true);
  assert.equal(profiles.e1.status, 'suspended');
  assert.equal(profiles.e1.is_available, false);
  assert.equal((await pauseEaserIfOverLimit(db, { easerId: 'e9', easerName: 'Sam', strikes: 5 })).paused, false, 'an already-suspended Easer is left as the owner set it');
}

// Excuse: removes strikes once, idempotent, does not reactivate
{
  const rows = [{ id: 'a', booking_id: 'b1', event_type: 'easer_cancelled', created_at: iso(now - 86400000), metadata: { easerId: 'e1', strikes: 2 } }];
  const db = fakeDb(rows, { e1: { status: 'suspended' } });
  assert.equal((await excuseEaserCancellation(db, { logId: 'a' })).ok, true);
  assert.equal((await excuseEaserCancellation(db, { logId: 'a' })).alreadyExcused, true);
  assert.equal(db.profiles.e1.status, 'suspended', 'excusing never reactivates; that is an explicit owner decision');
  assert.equal((await loadEaserStrikes(db, ['e1'], { nowMs: now })).get('e1').strikes, 0);
  assert.equal((await excuseEaserCancellation(db, { logId: 'nope' })).status, 404);
}

// ── Wiring ───────────────────────────────────────────────────────────────────
const read = (f) => readFileSync(f, 'utf8');
const drop = read('api/booking/drop-job.js');
assert.doesNotMatch(drop, /windowClosed: true/, 'the 15-minute limit no longer sends a late cancellation to the owner queue');
assert.match(drop, /classifyEaserCancellation\(\{/);
assert.ok(drop.indexOf("if (preview === true)") < drop.indexOf(".from('bookings').update("), 'preview must return before anything changes');
assert.ok(drop.indexOf('recordEaserCancellation(sb') > drop.indexOf(".from('bookings').update("), 'a strike is recorded only for a cancellation that happened');
assert.match(drop, /pauseEaserIfOverLimit\(sb/);
assert.match(drop, /Your reliability record could not be checked\. The job was not released\./, 'no strike history, no cancellation (it cannot be priced)');

const dispatch = read('api/booking/_dispatch-internal.js');
assert.match(dispatch, /try \{\s*strikesByEaser = await loadEaserStrikes\(/, 'dispatch reads strikes inside a try');
assert.match(dispatch, /dispatch reliability lookup failed \(no penalty applied\)/, 'dispatch fails open');
assert.match(dispatch, /score -= strikes \* strikePenalty/);

const easerPage = read('assembler/my-assignments.html');
assert.doesNotMatch(easerPage, /minsSinceAcceptance <= 15,/, 'self-service cancel is not limited to 15 minutes');
assert.match(easerPage, /preview: true/, 'the Easer sees the cost before confirming');
assert.match(easerPage, /id="reliability-standing"/);
assert.match(easerPage, /The job is today\. Cancelling counts as/);

const ownerPage = read('owner/index.html');
assert.match(ownerPage, /id="asm-reliability-panel"/);
assert.match(ownerPage, /\/api\/owner\/easer-reliability/);

// Confirmed no-show (owner action; an automatic flag alone never counts)
assert.equal(P.noShowStrikes, 3);
const noShow = read('api/owner/confirm-no-show.js');
assert.match(noShow, /verifyOwner\(req\)/, 'only the owner can confirm a no-show');
assert.match(noShow, /booking\.status !== BOOKING_STATUS\.CONFIRMED/, 'an Easer who is on the way or on site is not a no-show');
assert.match(noShow, /if \(startMs > nowMs\) return res\.status\(409\)/, 'cannot be confirmed before the appointment starts');
assert.match(noShow, /contains\('metadata', \{ easerId, kind: 'no_show' \}\)/, 'one no-show per booking and Easer');
assert.match(noShow, /strikes: EASER_RELIABILITY_POLICY\.noShowStrikes/);
assert.doesNotMatch(noShow, /from\('bookings'\)\.update/, 'confirming a no-show does not move the job');
assert.match(ownerPage, /Tap again to record 3 strikes/, 'two taps, so it cannot be recorded by accident');
assert.doesNotMatch(read('api/cron/no-show-check.js'), /recordEaserCancellation/, 'the automatic flag never adds strikes by itself');

console.log('PASS Easer cancellation reliability: grace/advance/late/same-day, 90-day strikes, excuse, pause at limit, fail-open dispatch, cost shown before confirming.');
