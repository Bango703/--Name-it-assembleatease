#!/usr/bin/env node
// Owner audit of the Easer app, 2026-10-12:
//   "on easer messages theres no clear line between messaging assembleatease
//    and customer, messages is leaking between both"
//   "when easer click directions it doesnt actually go to the address"
//   "inbox ... theres no control it just keep going down"
//   "account updates need to be specific for each update ... when i click some
//    update it doesnt say anything, or show anything"
//   "when easer gets help on job it doesnt go to case, instead messages on
//    booking in owner"
//   "on dark mode the blue line around booking dont show"
// Each one is held here. The message and inbox handlers run for real against an
// in-memory database; no network, no live data.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { easerMessageThread } from '../api/booking/_message-routing.js';
import { messageDirectionLabel } from '../api/_owner-inbox.js';
import { operationCaseOwnerStatusLabel } from '../api/_operation-cases.js';
import {
  NOTIFICATION_COPY,
  noticeFor,
  canonicalNoticeType,
  requiredActionKey,
} from '../api/assembler/notifications.js';

const read = (f) => readFileSync(f, 'utf8').replace(/^﻿/, '');

// ── In-memory database, with the PostgREST filters these handlers use ────────
function orTerms(expr) {
  const terms = [];
  let depth = 0, cur = '';
  for (const ch of expr) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) { terms.push(cur); cur = ''; } else cur += ch;
  }
  if (cur) terms.push(cur);
  return terms;
}
function orPredicate(expr) {
  const one = (term) => {
    const and = term.match(/^and\((.*)\)$/);
    if (and) { const parts = orTerms(and[1]).map(one); return r => parts.every(p => p(r)); }
    const [col, op, ...rest] = term.split('.');
    const val = rest.join('.');
    assert.equal(op, 'eq', `unsupported filter ${term}`);
    return r => String(r[col] ?? '') === val;
  };
  const parts = orTerms(expr).map(one);
  return r => parts.some(p => p(r));
}
function memoryDb(seed) {
  const rows = structuredClone(seed);
  return {
    rows,
    from(table) {
      rows[table] ||= [];
      let op = 'select', payload = null, limit = Infinity, order = null;
      const preds = [];
      const run = () => {
        let matches = rows[table].filter(r => preds.every(p => p(r)));
        if (op === 'update') { matches.forEach(r => Object.assign(r, payload)); return { data: matches, error: null }; }
        if (order) matches = [...matches].sort((a, b) => (a[order.col] < b[order.col] ? -1 : 1) * (order.asc ? 1 : -1));
        return { data: matches.slice(0, limit), error: null };
      };
      const q = {
        select() { return q; },
        eq(f, v) { preds.push(r => r[f] === v); return q; },
        in(f, vs) { preds.push(r => vs.includes(r[f])); return q; },
        is(f, v) { preds.push(r => (r[f] ?? null) === v); return q; },
        lt(f, v) { preds.push(r => String(r[f]) < String(v)); return q; },
        like(f, pattern) { const prefix = pattern.replace(/%$/, ''); preds.push(r => String(r[f] ?? '').startsWith(prefix)); return q; },
        or(expr) { preds.push(orPredicate(expr)); return q; },
        order(col, opts = {}) { order = { col, asc: opts.ascending !== false }; return q; },
        limit(n) { limit = n; return q; },
        update(p) { op = 'update'; payload = p; return q; },
        async maybeSingle() { const r = run(); return { data: r.data[0] || null, error: null }; },
        then(resolve, reject) { return Promise.resolve(run()).then(resolve, reject); },
      };
      return q;
    },
  };
}
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
async function loadHandler(path, deps) {
  const source = read(path)
    .replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"];\r?\n/gm, '')
    .replace(/export default async function/, 'async function')
    .replace(/export const /g, 'const ')
    .replace(/export function /g, 'function ')
    .replace(/export async function /g, 'async function ');
  return new AsyncFunction(...Object.keys(deps), `${source}\nreturn { handler };`)(...Object.values(deps));
}
async function call(handler, { method = 'GET', body = {}, query = {} } = {}) {
  const res = { statusCode: 0, body: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  await handler({ method, body, query, headers: { authorization: 'Bearer t', 'x-forwarded-for': '1.1.1.1' } }, res);
  return res;
}

// ── 1. Two conversations, and nothing the customer told AssembleAtEase ───────
{
  assert.equal(easerMessageThread({ sender: 'customer', recipient_type: 'assembler' }), 'customer');
  assert.equal(easerMessageThread({ sender: 'assembler', recipient_type: 'customer' }), 'customer');
  assert.equal(easerMessageThread({ sender: 'assembler', recipient_type: 'owner' }), 'team');
  assert.equal(easerMessageThread({ sender: 'owner', recipient_type: 'assembler' }), 'team');

  const LEAD = 'easer-lead', HELPER = 'easer-helper', OLD = 'easer-before';
  const at = (n) => `2026-10-12T1${n}:00:00Z`;
  const db = memoryDb({
    bookings: [{ id: 'b1', assembler_id: LEAD, assembler_accepted_at: at(0) }],
    booking_crew: [{ id: 'c1', booking_id: 'b1', easer_id: HELPER, role: 'helper', removed_at: null }],
    messages: [
      { id: 'm1', booking_id: 'b1', sender: 'customer', recipient_type: 'owner', recipient_user_id: null, sender_user_id: null, body: 'Before anyone accepted: is this pro any good?', created_at: at(1) },
      { id: 'm2', booking_id: 'b1', sender: 'owner', recipient_type: 'customer', recipient_user_id: null, sender_user_id: null, body: 'Owner reply to the customer', created_at: at(2) },
      { id: 'm3', booking_id: 'b1', sender: 'customer', recipient_type: 'assembler', recipient_user_id: OLD, sender_user_id: null, body: 'To the previous pro', created_at: at(3) },
      { id: 'm4', booking_id: 'b1', sender: 'customer', recipient_type: 'assembler', recipient_user_id: LEAD, sender_user_id: null, body: 'Gate code 1234', created_at: at(4) },
      { id: 'm5', booking_id: 'b1', sender: 'assembler', recipient_type: 'customer', recipient_user_id: null, sender_user_id: LEAD, body: 'On my way', created_at: at(5) },
      { id: 'm6', booking_id: 'b1', sender: 'assembler', recipient_type: 'owner', recipient_user_id: null, sender_user_id: LEAD, body: '[Job issue] Missing parts', created_at: at(6) },
      { id: 'm7', booking_id: 'b1', sender: 'owner', recipient_type: 'assembler', recipient_user_id: LEAD, sender_user_id: null, body: 'Owner to the lead', created_at: at(7) },
    ],
    operations_cases: [{ id: 'case-uuid-1', booking_id: 'b1', case_ref: 'CASE-2026-0001', status: 'open', subject: 'Easer reported a job issue', source_ref: 'easer-support-message:m6' }],
  });
  let me = LEAD, owner = false;
  const { handler } = await loadHandler('api/booking/message.js', {
    getSupabase: () => db,
    rateLimit: async () => true,
    verifyOwner: () => owner,
    requireAssignedWorkEaser: async () => ({ ok: true, user: { id: me } }),
    respondWithEaserAccessError: (res) => res.status(403).json({ error: 'denied' }),
    easerMessageThread,
    messageDirectionLabel,
    operationCaseOwnerStatusLabel,
  });

  const lead = await call(handler, { query: { bookingId: 'b1' } });
  assert.equal(lead.statusCode, 200, JSON.stringify(lead.body));
  const leadIds = lead.body.messages.map(m => m.id);
  assert.deepEqual(leadIds, ['m4', 'm5', 'm6', 'm7'], 'the Easer sees their own conversations only');
  assert.ok(!leadIds.includes('m1'), "what the customer wrote to AssembleAtEase never reaches the Easer");
  assert.ok(!leadIds.includes('m3'), "a previous pro's conversation never reaches the new one");
  assert.deepEqual(lead.body.messages.map(m => m.thread), ['customer', 'customer', 'team', 'team'], 'the server says which conversation each is in');

  me = HELPER;
  const helper = await call(handler, { query: { bookingId: 'b1' } });
  assert.deepEqual(helper.body.messages.map(m => m.id), ['m4', 'm5'], "a helper sees the lead's customer conversation, not the lead's notes to AssembleAtEase");

  owner = true;
  const ownerView = await call(handler, { query: { bookingId: 'b1' } });
  assert.equal(ownerView.body.messages.length, 7, 'the owner sees every message');
  const helpRow = ownerView.body.messages.find(m => m.id === 'm6');
  assert.deepEqual(helpRow.case, { id: 'case-uuid-1', ref: 'CASE-2026-0001', statusLabel: 'Open', subject: 'Easer reported a job issue' }, 'a help request names its case on the booking');
  assert.equal(ownerView.body.messages.find(m => m.id === 'm5').case, null);
}

// The app and the web show one conversation at a time, from the server's thread.
{
  const views = read('mobile/ios/App/App/EaserViews.swift');
  const models = read('mobile/ios/App/App/EaserModels.swift');
  const web = read('assembler/my-assignments.html');
  const owner = read('owner/index.html');
  assert.match(models, /thread = MessageThread\(rawValue: c\.string\("thread"\) \?\? ""\)/, 'the app reads the thread the server sends');
  assert.match(views, /private var shown: \[JobMessage\] \{ messages\.filter \{ \$0\.thread == thread \} \}/, 'the app shows one conversation');
  assert.match(views, /try await store\.send\(text, about: job, toCustomer: thread == \.customer\)/, 'a message goes to the conversation on screen');
  assert.match(views, /MessagesView\(job: job, thread: \.customer\)[\s\S]{0,400}MessagesView\(job: job, thread: \.team\)/, 'two doors from the job');
  assert.doesNotMatch(views, /Picker\("Send to"/, 'no recipient switch under one mixed list');
  assert.match(web, /var msgs = _threadMessages\.filter\(function\(m\) \{ return m\.thread === which; \}\);/, 'the web shows one conversation');
  assert.match(web, /class="asgn-thread-tab" role="tab" data-thread="customer"/);
  assert.doesNotMatch(web, /href="sms:/, 'customer messages stay on the platform, where the reply lands');
  assert.match(owner, /data-message-case="' \+ esc\(m\.case\.id\) \+ '"/, 'the owner opens the case from the message');
}

// ── 2. Directions open the maps app at the address ───────────────────────────
{
  const views = read('mobile/ios/App/App/EaserViews.swift');
  assert.doesNotMatch(views, /http:\/\/maps\.apple\.com/, 'a web link opens inside the app, not in Maps');
  assert.match(views, /case \.apple: link = "maps:\/\/\?daddr=\\\(destination\)&dirflg=d"/);
  assert.match(views, /case \.google: link = "https:\/\/www\.google\.com\/maps\/dir\/\?api=1&destination=/);
  assert.match(views, /if let url = URL\(string: link\) \{ UIApplication\.shared\.open\(url\) \}/, 'opened by the system, past the in-app browser');
  assert.match(views, /allowed\.remove\(charactersIn: "&\+=\?#"\)/, 'an address with # or & is still one destination');
  const web = read('assembler/my-assignments.html');
  assert.doesNotMatch(web, /google\.com\/maps\/search/, 'directions, not a search');
  assert.match(web, /'https:\/\/maps\.apple\.com\/\?daddr=' : 'https:\/\/www\.google\.com\/maps\/dir\/\?api=1/);
}

// ── 3. Every inbox item says what happened and goes to its own place ─────────
{
  // Every notification the API sends to an Easer, found by reading the code.
  const root = 'api';
  const files = [];
  (function walk(d) {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) { if (!/migrations/.test(p)) walk(p); } else if (p.endsWith('.js')) files.push(p);
    }
  })(root);
  const sentTypes = new Set();
  for (const f of files) {
    const lines = read(f).split('\n');
    lines.forEach((l, i) => {
      if (!/recipientType:\s*'easer'/.test(l)) return;
      for (let j = Math.max(0, i - 12); j < Math.min(lines.length, i + 12); j++) {
        const m = lines[j].match(/notificationType:\s*'([a-z_]+)'/);
        if (m) sentTypes.add(m[1]);
      }
    });
  }
  // Rows written for the owner or the customer next to an Easer row, and the
  // pre-account waitlist (no Easer account to show an inbox to).
  const notEaserInbox = new Set([
    'identity_failed_owner', 'identity_verified_owner', 'easer_account_closure', 'easer_account_closure_cancelled',
    'easer_waitlist', 'easer_waitlist_confirmation', 'easer_waitlist_owner_added', 'waitlist_invite', 'easer_phone_verification',
  ]);
  assert.ok(sentTypes.size > 40, `found ${sentTypes.size} Easer notification types`);
  const missing = [...sentTypes].filter(t => !notEaserInbox.has(t) && !NOTIFICATION_COPY[canonicalNoticeType(t)] && !requiredActionKey(t));
  assert.deepEqual(missing, [], 'every notification an Easer can get has its own wording and destination');

  const ACTIONS = new Set(['job', 'job_customer_messages', 'job_team_messages', 'payouts', 'account', 'personal_info', 'today', 'none']);
  for (const [type, item] of Object.entries(NOTIFICATION_COPY)) {
    assert.ok(ACTIONS.has(item.action), `${type} goes somewhere the app knows`);
    assert.ok(['jobs', 'money', 'account'].includes(item.category), `${type} has an inbox group`);
    assert.equal(item.action === 'none', item.actionLabel === null, `${type}: a button exactly when there is somewhere to go`);
    assert.doesNotMatch(item.detail, /Tap to view|A new update is available|has been updated\.$/, `${type} says what happened`);
  }
  assert.equal(noticeFor('evidence_requested'), noticeFor('evidence_request'), 'one event on two channels is one item');
  assert.equal(noticeFor('easer_required_action_payout_setup', new Map([['payout_setup', { title: 'Set up payouts', body: 'Connect your bank to get paid.', action_label: 'Set up payouts' }]])).detail, 'Connect your bank to get paid.', 'a required action shows its own words');

  const db = memoryDb({
    profiles: [{ id: 'e1', role: 'assembler' }],
    notification_log: [
      ...Array.from({ length: 45 }, (_, i) => ({ id: `n${i}`, recipient_user_id: 'e1', recipient_type: 'easer', status: 'sent', booking_id: `b${i}`, notification_type: 'dispatch_offer', sent_at: new Date(Date.UTC(2026, 9, 12, 0, 59 - i)).toISOString(), recipient_read_at: null })),
      { id: 'code', recipient_user_id: 'e1', recipient_type: 'easer', status: 'sent', booking_id: null, notification_type: 'easer_phone_verification', sent_at: '2026-10-12T02:00:00.000Z', recipient_read_at: null },
    ],
  });
  const { handler } = await loadHandler('api/assembler/notifications.js', {
    getSupabase: () => db,
    authenticateBearerUser: async () => ({ ok: true, user: { id: 'e1' } }),
    respondWithEaserAccessError: (res) => res.status(401).json({ error: 'denied' }),
  });
  const first = await call(handler, {});
  assert.equal(first.statusCode, 200, JSON.stringify(first.body));
  assert.equal(first.body.notifications.length, 30, 'one page at a time');
  assert.ok(!first.body.notifications.some(n => n.id === 'code'), 'a sign-in code is not an inbox item');
  assert.equal(first.body.notifications[0].actionLabel, 'Review offer');
  assert.equal(first.body.notifications[0].category, 'jobs');
  assert.ok(first.body.nextBefore, 'there is an older page');
  const older = await call(handler, { query: { before: first.body.nextBefore } });
  assert.equal(older.body.notifications.length, 15);
  assert.equal(older.body.nextBefore, null, 'the oldest page says so');
  assert.equal(new Set([...first.body.notifications, ...older.body.notifications].map(n => n.id)).size, 45, 'no item twice, none skipped');

  const views = read('mobile/ios/App/App/EaserViews.swift');
  const store = read('mobile/ios/App/App/EaserStore.swift');
  assert.match(views, /Section\("New"\)[\s\S]{0,200}Earlier/, 'new items are apart from read ones');
  assert.match(views, /Text\("Jobs"\)\.tag\("jobs"\)[\s\S]{0,120}Text\("Money"\)\.tag\("money"\)[\s\S]{0,120}Text\("Account"\)\.tag\("account"\)/, 'the inbox can be narrowed');
  assert.match(views, /Text\("Show older"\)/, 'older items load on request, not all at once');
  assert.match(store, /"\/api\/assembler\/notifications\?before=" \+ EaserAPI\.query\(before\)/);
  for (const action of ['"job"', '"job_customer_messages", "job_team_messages"', '"payouts"', '"personal_info"', '"account"', '"today"']) {
    assert.ok(views.includes(`case ${action}:`), `the detail screen opens ${action}`);
  }
  assert.match(store, /try await api\.call\("POST", "\/api\/assembler\/notifications", body: \["ids": ids\]\)\s*let saved = Set\(ids\)/, 'shown as read only after the server saved it');
}

// ── 4. Dark mode: a card never disappears into the page ──────────────────────
{
  const views = read('mobile/ios/App/App/EaserViews.swift');
  const support = read('mobile/ios/Shared/AppFoundation.swift');
  assert.match(support, /static let card = Color\(uiColor: \.secondarySystemGroupedBackground\)/);
  assert.doesNotMatch(views, /\.background\(Color\(uiColor: \.systemBackground\), in: RoundedRectangle/, 'black on black in dark mode');
  assert.match(views, /\.stroke\(emphasis \? Brand\.sky : Color\(uiColor: \.separator\), lineWidth: emphasis \? 2 : 1\)/, 'every job card has an edge');
}

console.log('PASS Easer threads and inbox: two separate conversations, help requests linked to their case, directions in the maps app, a specific inbox with pages and details, cards visible in dark mode.');
