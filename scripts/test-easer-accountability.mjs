#!/usr/bin/env node
// The Easer accountability rules the owner set on 2026-10-28:
//   - lets offers expire / stays online but ignores everything → set offline
//   - late arrival, workmanship, property damage → owner-confirmed strikes
//   - accepts jobs they cannot do → the owner keeps them off that service
//   - zero-tolerance suspensions record why
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EASER_RELIABILITY_POLICY as P } from '../api/_source-of-truth.js';
import {
  CONFIRMED_ISSUES, recordConfirmedIssue, loadEaserStrikes, excuseEaserCancellation,
  recordUnansweredOffers, unansweredStreak, setOfflineIfUnanswered,
} from '../api/_easer-reliability.js';
import {
  easerTakesBooking, loadWorkPreferences, normalizeBlockedServices,
} from '../api/_easer-work-preferences.js';
import { NOTIFICATION_COPY } from '../api/assembler/notifications.js';

const read = rel => readFile(new URL(`../${rel}`, import.meta.url), 'utf8').then(s => s.replace(/\r\n/g, '\n'));

// A small in-memory Supabase: enough of the query builder for these modules.
function fakeDb(tables = {}, { failColumns = [] } = {}) {
  let seq = 0;
  const db = { tables };
  db.from = (name) => {
    const rows = (tables[name] ||= []);
    const filters = [];
    let op = 'select';
    let payload = null;
    let columns = '*';
    let limitN = Infinity;
    const q = {
      select(cols) { if (op === 'select') columns = cols || '*'; else columns = cols || columns; return q; },
      insert(row) { op = 'insert'; payload = row; return q; },
      update(row) { op = 'update'; payload = row; return q; },
      eq(c, v) { filters.push(r => r[c] === v); return q; },
      in(c, vs) { filters.push(r => vs.includes(r[c])); return q; },
      gte(c, v) { filters.push(r => String(r[c]) >= String(v)); return q; },
      is(c, v) { filters.push(r => (r[c] ?? null) === v); return q; },
      contains(c, obj) { filters.push(r => Object.entries(obj).every(([k, v]) => r[c]?.[k] === v)); return q; },
      or(expr) {
        const parts = expr.split(',').map(p => p.split('.')[0]);
        filters.push(r => parts.some(c => r[c] != null));
        return q;
      },
      order() { return q; },
      limit(n) { limitN = n; return q; },
      single() { return q.then(res => ({ data: Array.isArray(res.data) ? res.data[0] : res.data, error: res.error })); },
      maybeSingle() { return q.single(); },
      then(resolve, reject) {
        const missing = failColumns.find(col => String(columns).includes(col) || (payload && col in payload));
        if (missing) return Promise.resolve({ data: null, error: { message: `column profiles.${missing} does not exist` } }).then(resolve, reject);
        let out;
        if (op === 'insert') {
          const row = { id: `row-${++seq}`, created_at: new Date(Date.now() + seq).toISOString(), ...payload };
          rows.push(row);
          out = [row];
        } else if (op === 'update') {
          out = rows.filter(r => filters.every(f => f(r)));
          out.forEach(r => Object.assign(r, payload));
        } else {
          out = rows.filter(r => filters.every(f => f(r))).slice(0, limitN);
        }
        return Promise.resolve({ data: out, error: null }).then(resolve, reject);
      },
    };
    return q;
  };
  return db;
}

const NOW = Date.parse('2026-10-28T20:00:00Z');
const ago = min => new Date(NOW - min * 60000).toISOString();

// ── Online but not answering → offline ──────────────────────────────────────
{
  assert.equal(P.unansweredOffersOffline, 3);
  const sb = fakeDb({
    profiles: [{ id: 'e1', full_name: 'Sam Easer', email: 's@x.test', is_available: true }],
    dispatch_offers: [{ easer_id: 'e1', created_at: ago(600), accepted_at: ago(590), declined_at: null }],
    activity_logs: [],
  });
  // Two jobs unanswered, one offer renewed and expired again: two, not three.
  await recordUnansweredOffers(sb, [{ id: 'o1', booking_id: 'b1', easer_id: 'e1' }, { id: 'o2', booking_id: 'b2', easer_id: 'e1' }], { nowMs: NOW });
  await recordUnansweredOffers(sb, [{ id: 'o1', booking_id: 'b1', easer_id: 'e1' }], { nowMs: NOW });
  assert.equal(sb.tables.activity_logs.filter(r => r.event_type === 'offer_unanswered').length, 2, 'a renewed offer counts once');
  assert.equal(await unansweredStreak(sb, 'e1', { nowMs: NOW }), 2);
  assert.equal((await setOfflineIfUnanswered(sb, 'e1', { nowMs: NOW })).offline, false, 'two is not enough');

  await recordUnansweredOffers(sb, [{ id: 'o3', booking_id: 'b3', easer_id: 'e1' }], { nowMs: NOW });
  const off = await setOfflineIfUnanswered(sb, 'e1', { nowMs: NOW });
  assert.equal(off.offline, true, 'three different jobs in a row: offline');
  assert.equal(sb.tables.profiles[0].is_available, false);
  assert.ok(sb.tables.activity_logs.some(r => r.event_type === 'easer_auto_offline' && r.actor_id === 'e1'));
  assert.equal(await unansweredStreak(sb, 'e1', { nowMs: NOW }), 0, 'going offline starts a new count');

  // Back online: an answer resets the streak too.
  sb.tables.profiles[0].is_available = true;
  await recordUnansweredOffers(sb, [{ id: 'o4', booking_id: 'b4', easer_id: 'e1' }, { id: 'o5', booking_id: 'b5', easer_id: 'e1' }], { nowMs: NOW });
  sb.tables.activity_logs.push({ id: 'acc', event_type: 'easer_accepted', actor_id: 'e1', created_at: new Date(Date.now() + 10000).toISOString() });
  await recordUnansweredOffers(sb, [{ id: 'o6', booking_id: 'b6', easer_id: 'e1' }], { nowMs: NOW });
  const last = sb.tables.activity_logs.filter(r => r.event_type === 'offer_unanswered').pop();
  last.created_at = new Date(Date.now() + 20000).toISOString();
  assert.equal(await unansweredStreak(sb, 'e1', { nowMs: NOW }), 1, 'an accept in between resets the count');
  assert.equal((await setOfflineIfUnanswered(sb, 'e1', { nowMs: NOW })).offline, false);
  console.log('PASS unanswered offers: three different jobs in a row sets the Easer offline; renewals count once; an answer resets');
}

// ── Owner-confirmed problems count as strikes, excusable ────────────────────
{
  assert.deepEqual(Object.fromEntries(Object.entries(CONFIRMED_ISSUES).map(([k, v]) => [k, v.strikes])),
    { late_arrival: 1, quality: 1, damage: 2 });
  assert.equal(CONFIRMED_ISSUES.damage.pausesNow, true, 'confirmed damage pauses new jobs at once');
  assert.equal(CONFIRMED_ISSUES.quality.statuses.includes('confirmed'), false, 'workmanship is judged on work done');
  const sb = fakeDb({ activity_logs: [] });
  const booking = { id: 'b9', ref: 'AAE-TEST9' };
  sb.tables.activity_logs.push({ id: 'c1', event_type: 'easer_cancelled', booking_id: 'b8', created_at: ago(60), metadata: { easerId: 'e2', kind: 'late', strikes: 1 } });
  const late = await recordConfirmedIssue(sb, { booking, easerId: 'e2', easerName: 'Pat', kind: 'late_arrival', note: '45 min late' });
  assert.equal(late.ok, true);
  const again = await recordConfirmedIssue(sb, { booking, easerId: 'e2', easerName: 'Pat', kind: 'late_arrival' });
  assert.equal(again.alreadyRecorded, true, 'one per job and kind');
  await recordConfirmedIssue(sb, { booking, easerId: 'e2', easerName: 'Pat', kind: 'quality' });
  let strikes = (await loadEaserStrikes(sb, ['e2'], { nowMs: Date.now() + 60000 })).get('e2');
  assert.equal(strikes.strikes, 3, 'cancellation + late arrival + workmanship = 3, the pause limit');
  assert.ok(strikes.events.some(e => e.kind === 'late_arrival' && e.reason === '45 min late'));
  const excused = await excuseEaserCancellation(sb, { logId: late.logId, note: 'traffic accident' });
  assert.equal(excused.ok, true, 'a confirmed issue can be excused like a cancellation');
  strikes = (await loadEaserStrikes(sb, ['e2'], { nowMs: Date.now() + 60000 })).get('e2');
  assert.equal(strikes.strikes, 2);
  assert.equal((await recordConfirmedIssue(sb, { booking, easerId: 'e2', easerName: 'Pat', kind: 'theft' })).ok, false);
  console.log('PASS confirmed late arrival, workmanship and damage: strikes counted with cancellations, once per job, excusable');
}

// ── The owner keeps an Easer off a service ──────────────────────────────────
{
  const known = ['Furniture Assembly', 'TV Mounting', 'Smart Home'];
  const tv = { service: 'TV Mounting', date: '2026-11-02', time: '10:00 AM – 12:00 PM' };
  const both = { service: 'Furniture Assembly, TV Mounting', date: '2026-11-02', time: '10:00 AM – 12:00 PM' };
  assert.equal(easerTakesBooking({ owner_blocked_services: ['TV Mounting'] }, tv, known).reason, 'owner_blocked');
  assert.equal(easerTakesBooking({ owner_blocked_services: ['TV Mounting'] }, both, known).ok, false, 'any blocked part keeps the job away');
  assert.equal(easerTakesBooking({ owner_blocked_services: ['TV Mounting'], work_services: ['TV Mounting'] }, tv, known).ok, false,
    'the owner block wins over the Easer\'s own choice');
  assert.equal(easerTakesBooking({ owner_blocked_services: ['TV Mounting'] }, { service: 'Smart Home' }, known).ok, true);
  assert.equal(easerTakesBooking({ owner_blocked_services: [] }, tv, known).ok, true);
  assert.deepEqual(normalizeBlockedServices([], known), { ok: true, value: null }, 'an empty list clears the block');
  assert.equal(normalizeBlockedServices(['Rocket Repair'], known).ok, false);

  const sb = fakeDb({ profiles: [{ id: 'e3', work_services: ['TV Mounting'], weekly_availability: null, owner_blocked_services: ['TV Mounting'] }] });
  const prefs = await loadWorkPreferences(sb, ['e3']);
  assert.deepEqual(prefs.get('e3').owner_blocked_services, ['TV Mounting']);
  assert.deepEqual(prefs.get('e3').work_services, ['TV Mounting']);
  const before124 = fakeDb({ profiles: [{ id: 'e3', work_services: ['TV Mounting'], weekly_availability: null }] }, { failColumns: ['owner_blocked_services'] });
  const prefsBefore = await loadWorkPreferences(before124, ['e3']);
  assert.deepEqual(prefsBefore.get('e3').work_services, ['TV Mounting'], 'without migration 124 the Easer\'s own choices still filter');
  assert.equal(prefsBefore.get('e3').owner_blocked_services, undefined);
  console.log('PASS owner service block: wins over the Easer\'s choice, any blocked part keeps a job away, safe before migration 124');
}

// ── Wiring ──────────────────────────────────────────────────────────────────
{
  const expire = await read('api/cron/expire-offers.js');
  assert.match(expire, /\.select\('id, booking_id, easer_id'\)/);
  assert.ok(expire.indexOf('recordUnansweredOffers(sb, expiredOffers') < expire.indexOf('no affected bookings'),
    'the offline check runs before the early return');
  const owner = await read('api/owner/easer-reliability.js');
  assert.match(owner, /if \(req\.body\?\.action === 'confirm_issue'\) return confirmIssue\(sb, req, res\);/);
  assert.match(owner, /force: issue\.pausesNow,/);
  const update = await read('api/assembler/update.js');
  assert.match(update, /if \(action === 'set_blocked_services'\)/);
  assert.match(update, /eventType: 'easer_suspended',[\s\S]{0,300}metadata: \{ easerId: assemblerId, reason: reasonKey, notes: notes \|\| null \}/,
    'a suspension keeps its reason and note on the record');
  for (const key of ['safety', 'fraud', 'off_platform', 'false_credentials']) assert.match(update, new RegExp(`  ${key}: '`));
  const migration = await read('api/migrations/124_owner_blocked_services.sql');
  assert.match(migration, /ADD COLUMN IF NOT EXISTS owner_blocked_services TEXT\[\]/);
  assert.match(migration, /VALUES \(124, 'owner_blocked_services'\)/);
  const dash = await read('owner/index.html');
  assert.match(dash, /action: 'confirm_issue', bookingId: bookingId, kind: kind, note: note/);
  assert.match(dash, /action: 'set_blocked_services', services: services/);
  assert.match(dash, /suspensionReason: document\.getElementById\('suspension-reason'\)\.value/);
  for (const type of ['easer_auto_offline', 'easer_strike_recorded']) assert.ok(NOTIFICATION_COPY[type], `${type} has inbox copy`);
  console.log('PASS wiring: offer expiry, owner actions, suspension reason, migration 124, dashboard, Easer inbox');
}

console.log('\nEaser accountability tests passed.');
