#!/usr/bin/env node
// Policy acknowledgment (owner, 2026-09-30): Easers must be told about the
// cancellation policy by email and in the app, and there must be a record
// that each one read it. The existing announcement engine only knew "done
// when a profile field changes"; an acknowledgment is done when the Easer
// taps "I understand". This holds that flow shut.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TARGET_RULES, getEaserRequiredActions, acknowledgeAnnouncement } from '../api/_announcements.js';

const ANN = { id: 'ann-1', key: 'reliability_policy_2026_09', type: 'required_action', title: 'Cancellation policy for accepted jobs', body: 'Line one.\n\nLine two.', action_label: 'Open the app to confirm', action_url: '/assembler/my-assignments', target_rule: 'policy_acknowledgment', status: 'active', starts_at: '2026-01-01T00:00:00Z', ends_at: null };

function fakeDb({ profiles = [], deliveries = [], announcements = [ANN] } = {}) {
  const db = { profiles, deliveries, announcements };
  db.from = (table) => {
    const q = { filters: [], notNull: [], update: null, insert: null };
    const rowsFor = () => {
      let rows = table === 'profiles' ? profiles : table === 'easer_announcement_deliveries' ? deliveries : announcements;
      for (const [c, v] of q.filters) rows = rows.filter((r) => r[c] === v);
      for (const c of q.notNull) rows = rows.filter((r) => r[c] != null);
      return rows;
    };
    const api = {
      select() { return api; },
      eq(c, v) { q.filters.push([c, v]); return api; },
      not(c, op, v) { if (op === 'is' && v === null) q.notNull.push(c); return api; },
      lte() { return api; }, or() { return api; },
      update(v) { q.update = v; return api; },
      insert(v) { q.insert = v; return api; },
      maybeSingle() { return Promise.resolve({ data: rowsFor()[0] || null, error: null }); },
      single() {
        if (q.insert) { const row = { id: 'd' + (deliveries.length + 1), ...q.insert }; deliveries.push(row); return Promise.resolve({ data: row, error: null }); }
        if (q.update) { const row = rowsFor()[0]; Object.assign(row, q.update); return Promise.resolve({ data: row, error: null }); }
        return Promise.resolve({ data: rowsFor()[0] || null, error: null });
      },
      then(resolve, reject) { return Promise.resolve({ data: rowsFor(), error: null }).then(resolve, reject); },
    };
    return api;
  };
  return db;
}

const rule = TARGET_RULES.policy_acknowledgment;
assert.ok(rule && rule.ackRequired === true, 'the acknowledgment rule exists and is marked as needing a tap');

const profiles = [
  { id: 'e1', role: 'assembler', status: 'active', application_status: 'approved', email: 'a@x.com' },
  { id: 'e2', role: 'assembler', status: 'active', application_status: 'approved', email: 'b@x.com' },
  { id: 'e3', role: 'assembler', status: 'suspended', application_status: 'approved', email: 'c@x.com' },
];

// Targets: active approved Easers who have not acknowledged
{
  const db = fakeDb({ profiles, deliveries: [{ id: 'd1', announcement_id: 'ann-1', easer_id: 'e1', dismissed_at: '2026-09-30T15:00:00Z' }] });
  const { data } = await rule.query(db, ANN);
  assert.deepEqual(data.map((p) => p.id), ['e2'], 'acknowledged and inactive Easers are not reminded');
}

// In-app: shown until acknowledged, with an I-understand marker
{
  const db = fakeDb({ profiles });
  const actions = await getEaserRequiredActions(db, profiles[1]);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].ackRequired, true);
  assert.equal(actions[0].key, 'reliability_policy_2026_09');
}

// Acknowledge: dated record, idempotent, hides the notice
{
  const db = fakeDb({ profiles });
  const first = await acknowledgeAnnouncement(db, { easerId: 'e2', key: 'reliability_policy_2026_09', nowIso: '2026-09-30T16:00:00Z' });
  assert.equal(first.ok, true);
  assert.equal(db.deliveries[0].dismissed_at, '2026-09-30T16:00:00Z', 'the tap is stored with its time');
  assert.equal(db.deliveries[0].completed_at, '2026-09-30T16:00:00Z', 'reminders stop');
  const again = await acknowledgeAnnouncement(db, { easerId: 'e2', key: 'reliability_policy_2026_09' });
  assert.equal(again.alreadyAcknowledged, true);
  assert.equal(db.deliveries.length, 1, 'no duplicate record');
  assert.equal((await getEaserRequiredActions(db, profiles[1])).length, 0, 'the notice is gone after the tap');
}

// Only acknowledgment notices accept a tap
{
  const payout = { ...ANN, id: 'ann-2', key: 'payout_setup', target_rule: 'payout_setup_incomplete' };
  const db = fakeDb({ profiles, announcements: [payout] });
  assert.equal((await acknowledgeAnnouncement(db, { easerId: 'e2', key: 'payout_setup' })).status, 404, 'a payout-setup notice cannot be dismissed by tapping');
}

// Wiring
const read = (f) => readFileSync(f, 'utf8');
assert.match(read('api/cron/easer-announcements.js'), /rule\.query\(sb, a\)/, 'the reminder job gives the rule its announcement');
assert.match(read('api/owner/announcement-adoption.js'), /rule\.query\(sb, a\)/, 'the owner adoption view counts who confirmed');
assert.match(read('api/cron/easer-announcements.js'), /white-space:pre-line/, 'the email keeps the policy list line breaks');
const page = read('assembler/my-assignments.html');
assert.match(page, /a\.ackRequired[\s\S]*id="required-action-ack"[\s\S]*>I understand</);
assert.match(page, /\/api\/assembler\/acknowledge-announcement/);
const migration = read('api/migrations/102_easer_cancellation_policy_announcement.sql');
assert.match(migration, /'policy_acknowledgment'/);
assert.match(migration, /ON CONFLICT \(key\) DO NOTHING/, 'safe to run twice');
assert.match(migration, /\n  false,\n/, 'the notice never blocks job offers');

console.log('PASS policy acknowledgment: reminds only Easers who have not confirmed, records the tap with its time, stops reminders, never blocks offers.');
