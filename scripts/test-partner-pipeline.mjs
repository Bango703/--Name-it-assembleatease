#!/usr/bin/env node
// Partner pipeline, 2026-10-01. Owner: move the partner tracker into the
// owner dashboard. This holds it to the platform's rules:
//   - one owner for stages, kinds and the follow-up rule (api/_partners.js),
//     and the migration checks the same values
//   - bookings per partner are counted from the booking record, through the
//     same attribution path a real booking takes, and unknown is never zero
//   - the panel renders server-decided lists; it never decides "due" itself
//   - an import never overwrites a partner the owner already worked

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  PARTNER_STAGES, PARTNER_KINDS, PARTNER_SOURCES, applyPartnerUpdate, summarizePartners, countPartnerBookings,
  partnerBookingLink, weekStartIso, validateNewPartner, newRefCode, REF_CODE, seedRow,
} from '../api/_partners.js';
import { cleanAcquisitionAttribution } from '../api/_attribution.js';
import { createPartnersHandler } from '../api/owner/partners.js';
import { PARTNER_SEED_LEADS } from '../api/owner/_partner-leads-seed.js';

const read = (f) => readFileSync(f, 'utf8');

// ── 1. One set of values: module and migration agree ────────────────────────
const migration = read('api/migrations/104_partner_leads.sql');
const checkValues = (col) => {
  const m = migration.match(new RegExp(`CHECK \\(${col} IN \\(([^)]*)\\)\\)`));
  assert.ok(m, `migration 104 checks ${col}`);
  return [...m[1].matchAll(/'([a-z_]+)'/g)].map(x => x[1]).sort();
};
assert.deepEqual(checkValues('stage'), PARTNER_STAGES.map(s => s.id).sort(), 'stage values match api/_partners.js');
assert.deepEqual(checkValues('kind'), PARTNER_KINDS.map(k => k.id).sort(), 'kind values match api/_partners.js');
assert.deepEqual(checkValues('source'), [...PARTNER_SOURCES].sort());
assert.match(migration, /ENABLE ROW LEVEL SECURITY/, 'server-only table');
assert.match(migration, /NOTIFY pgrst, 'reload schema'/);
assert.doesNotMatch(migration, /ALTER TABLE public\.bookings/i, 'no booking column is touched');

// ── 2. Follow-up rule ────────────────────────────────────────────────────────
const now = new Date('2026-10-01T15:00:00Z'); // Thursday, Central
const fresh = { stage: 'to_contact', follow_up_on: null, first_contacted_on: null, history: [] };
{
  const { patch } = applyPartnerUpdate(fresh, { stage: 'contacted' }, now);
  assert.equal(patch.stage, 'contacted');
  assert.equal(patch.first_contacted_on, '2026-10-01');
  assert.equal(patch.last_contacted_on, '2026-10-01');
  assert.equal(patch.follow_up_on, '2026-10-06', 'first contact schedules a follow-up 5 days out');
  assert.equal(patch.history.at(-1).to, 'contacted');
}
{
  const { patch } = applyPartnerUpdate({ ...fresh, follow_up_on: '2026-10-03' }, { stage: 'contacted' }, now);
  assert.equal(patch.follow_up_on, undefined, 'an existing follow-up is kept');
}
{
  const { patch } = applyPartnerUpdate({ ...fresh, stage: 'interested', follow_up_on: '2026-10-03' }, { stage: 'partner' }, now);
  assert.equal(patch.follow_up_on, null, 'Partner closes the follow-up');
}
{
  const { patch } = applyPartnerUpdate({ ...fresh, stage: 'contacted', first_contacted_on: '2026-09-20' }, { loggedContact: true }, now);
  assert.equal(patch.last_contacted_on, '2026-10-01');
  assert.equal(patch.first_contacted_on, undefined, 'first contact date never moves');
  assert.equal(patch.follow_up_on, '2026-10-06');
}
assert.ok(applyPartnerUpdate(fresh, { stage: 'won' }, now).error);
assert.ok(applyPartnerUpdate(fresh, { followUpOn: '2026-02-31' }, now).error, 'an impossible date is refused');
assert.ok(applyPartnerUpdate(fresh, {}, now).error);
assert.equal(applyPartnerUpdate(fresh, { notes: '  Left 10 cards  ' }, now).patch.notes, 'Left 10 cards');
{
  const long = { ...fresh, history: Array.from({ length: 60 }, (_, i) => ({ at: 'x', event: 'contact', i })) };
  assert.equal(applyPartnerUpdate(long, { loggedContact: true }, now).patch.history.length, 50, 'history is bounded');
}

// ── 3. Server-decided lists ─────────────────────────────────────────────────
assert.equal(weekStartIso(now), '2026-09-28', 'week starts Monday, Central time');
assert.equal(weekStartIso(new Date('2026-10-05T04:00:00Z')), '2026-09-28', 'Sunday night in Central is still the old week');
{
  const rows = [
    { id: 'a', stage: 'contacted', follow_up_on: '2026-10-01', last_contacted_on: '2026-09-28' },
    { id: 'b', stage: 'partner', follow_up_on: '2026-09-01', last_contacted_on: '2026-09-27' },
    { id: 'c', stage: 'interested', follow_up_on: '2026-10-02', last_contacted_on: null },
  ];
  const s = summarizePartners(rows, now);
  assert.deepEqual(s.followUpDue, ['a'], 'due includes today, excludes future and closed partners');
  assert.deepEqual(s.contactedThisWeek, ['a']);
  assert.equal(s.weeklyTarget, 10);
}

// ── 4. Bookings per partner, through the real attribution path ──────────────
const partner = { kind: 'apartment', ref_code: 'k7m2qx' };
const link = new URL(partnerBookingLink(partner));
assert.equal(link.pathname, '/book');
assert.equal(link.searchParams.get('bundle'), 'move-in-ready');
assert.equal(link.searchParams.get('utm_source'), 'partner');
assert.equal(link.searchParams.get('utm_campaign'), 'k7m2qx');
assert.equal(new URL(partnerBookingLink({ kind: 'furniture', ref_code: 'k7m2qx' })).searchParams.get('bundle'), null, 'stores open plain booking');
const attribution = cleanAcquisitionAttribution({
  utmSource: link.searchParams.get('utm_source'), utmMedium: link.searchParams.get('utm_medium'),
  utmCampaign: link.searchParams.get('utm_campaign'), landingPath: '/book',
});
{
  const counts = countPartnerBookings([
    { ref: 'AAE-1', status: 'completed', booking_attribution: attribution },
    { ref: 'AAE-2', status: 'confirmed', booking_attribution: { ...attribution, utmCampaign: 'K7M2QX' } },
    { ref: 'AAE-3', status: 'completed', is_test_booking: true, booking_attribution: attribution },
    { ref: 'AAE-4', status: 'completed', booking_attribution: { ...attribution, utmSource: 'google' } },
  ]);
  assert.deepEqual(counts.get('k7m2qx'), { bookings: 2, completed: 1, refs: ['AAE-1', 'AAE-2'] }, 'test bookings and other channels are not counted');
}

// ── 5. Input checks ──────────────────────────────────────────────────────────
assert.ok(validateNewPartner({ kind: 'mover' }).error);
assert.ok(validateNewPartner({ name: 'X', kind: 'bank' }).error);
assert.ok(validateNewPartner({ name: 'X', kind: 'mover', website: 'javascript:alert(1)' }).error, 'only http(s) links are stored');
assert.ok(validateNewPartner({ name: 'X', kind: 'mover', email: "'first.last@x.com" }).error, 'a malformed address is refused');
assert.equal(validateNewPartner({ name: ' Einstein Moving ', kind: 'mover', email: 'Ops@Example.com' }).value.email, 'ops@example.com');
for (let i = 0; i < 200; i++) assert.match(newRefCode(), REF_CODE);

// ── 6. Handler ───────────────────────────────────────────────────────────────
function fakeDb(results) {
  const calls = [];
  function builder(table) {
    const call = { table, ops: [] }; calls.push(call);
    const b = {
      select(...a) { call.ops.push(['select', ...a]); return b; },
      insert(rows) { call.ops.push(['insert', rows]); return b; },
      upsert(rows, opts) { call.ops.push(['upsert', rows, opts]); return b; },
      update(patch) { call.ops.push(['update', patch]); return b; },
      eq(...a) { call.ops.push(['eq', ...a]); return b; },
      ilike(...a) { call.ops.push(['ilike', ...a]); return b; },
      order() { return b; }, limit() { return b; },
      maybeSingle() { return Promise.resolve(results.next(call)); },
      then(resolve, reject) { return Promise.resolve(results.next(call)).then(resolve, reject); },
    };
    return b;
  }
  return { calls, from: builder };
}
function res() {
  return { statusCode: 0, body: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}
const row = (over = {}) => ({ id: '11111111-1111-4111-8111-111111111111', ref_code: 'k7m2qx', source: 'google_maps', name: 'Square Cow Movers', kind: 'mover', stage: 'to_contact', social: [], history: [], updated_at: '2026-10-01T10:00:00Z', ...over });
{
  const r = res();
  await createPartnersHandler({ authorize: () => false, supabase: () => { throw new Error('no'); } })({ method: 'GET' }, r);
  assert.equal(r.statusCode, 401, 'owner only');
}
{
  const db = fakeDb({ next: () => ({ data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.partner_leads'" } }) });
  const r = res();
  await createPartnersHandler({ authorize: () => true, supabase: () => db, seed: [] })({ method: 'GET' }, r);
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.tableMissing, true, 'before migration 104 the panel says what to run');
  assert.match(r.body.message, /migration 104/);
}
{
  const db = fakeDb({ next: (call) => call.table === 'partner_leads' ? { data: [row()], error: null } : { data: null, error: { message: 'timeout' } } });
  const r = res();
  await createPartnersHandler({ authorize: () => true, supabase: () => db, seed: [], now: () => now })({ method: 'GET' }, r);
  assert.equal(r.body.bookingCountsAvailable, false);
  assert.equal(r.body.partners[0].bookings, null, 'a failed booking read is unknown, never zero');
}
{
  let n = 0;
  const db = fakeDb({ next: (call) => {
    n++;
    if (call.ops.some(o => o[0] === 'update')) return { data: [], error: null }; // row changed underneath
    return { data: row(), error: null };
  } });
  const r = res();
  await createPartnersHandler({ authorize: () => true, supabase: () => db, now: () => now })({ method: 'POST', body: { action: 'update', id: row().id, stage: 'contacted' } }, r);
  assert.equal(r.statusCode, 409, 'a stale edit is refused, not applied over a newer one');
  const upd = db.calls.find(c => c.ops.some(o => o[0] === 'update'));
  assert.ok(upd.ops.some(o => o[0] === 'eq' && o[1] === 'updated_at'), 'update is pinned to the version read');
}
{
  const db = fakeDb({ next: (call) => ({ data: call.ops.find(o => o[0] === 'upsert')[1].slice(0, 1).map(() => ({ id: 'x' })), error: null }) });
  const r = res();
  const seed = [{ id: 'ChIJa', name: 'A', kind: 'mover', city: 'Austin' }, { id: 'ChIJb', name: 'B', kind: 'realtor', city: 'Austin' }];
  await createPartnersHandler({ authorize: () => true, supabase: () => db, seed })({ method: 'POST', body: { action: 'import_seed' } }, r);
  const up = db.calls[0].ops.find(o => o[0] === 'upsert');
  assert.deepEqual(up[2], { onConflict: 'place_id', ignoreDuplicates: true }, 'import never overwrites a partner already in the list');
  assert.ok(up[1].every(x => REF_CODE.test(x.ref_code) && !('stage' in x) && !('notes' in x)), 'import sets no owner-worked fields');
  assert.deepEqual(r.body, { inserted: 1, alreadyPresent: 1 });
}

// ── 7. Seed list ─────────────────────────────────────────────────────────────
const kindIds = new Set(PARTNER_KINDS.map(k => k.id));
assert.ok(PARTNER_SEED_LEADS.length > 0, 'the Google Maps list ships with the panel');
assert.equal(new Set(PARTNER_SEED_LEADS.map(l => l.id)).size, PARTNER_SEED_LEADS.length, 'no duplicate places');
for (const lead of PARTNER_SEED_LEADS) {
  const r = seedRow(lead, 'abcdef');
  assert.ok(r.name && kindIds.has(r.kind) && r.place_id, `seed lead is importable: ${lead.name}`);
  assert.ok(!lead.address || /,\s*TX 78[67]\d\d/.test(lead.address), `seed lead is in Central Texas: ${lead.name}`);
  if (lead.email) assert.equal(r.email, lead.email.toLowerCase(), `seed email is a real address: ${lead.email}`);
  assert.doesNotMatch(lead.email || '', /first\.?last|@company\.com|bugreport@|dmca|accessibility@/i, 'placeholder and vendor addresses are not partners');
}

// ── 8. Panel renders server verdicts ────────────────────────────────────────
const panel = read('owner/assets/partners.js');
assert.match(panel, /summary\(\)\.followUpDue/, 'due list comes from the server');
assert.match(panel, /summary\(\)\.contactedThisWeek|s\.contactedThisWeek/, 'weekly count comes from the server');
assert.doesNotMatch(panel, /followUpOn\s*<=|new Date\(\)\.toISOString\(\)\.slice\(0, ?10\)/, 'the panel never decides what is due');
assert.doesNotMatch(panel, /addDays|FOLLOW_UP_DAYS/, 'the follow-up rule is not copied into the browser');
assert.match(panel, /p\.bookings === null/, 'unknown booking counts are shown as unknown');
const dash = read('owner/index.html');
assert.match(dash, /<script src="\/owner\/assets\/partners\.js" defer><\/script>/);
assert.match(dash, /data-view="partners"/);
assert.match(dash, /id="partners-view"/);
assert.match(dash, /\$partnersView,/, 'the view is hidden with the others');

console.log(`PASS partner pipeline: one set of stages and kinds, follow-ups decided on the server, bookings counted from the booking record (unknown is never zero), stale edits refused, import never overwrites, ${PARTNER_SEED_LEADS.length} seed partners importable.`);
