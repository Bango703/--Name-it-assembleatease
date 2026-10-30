#!/usr/bin/env node
// Owner, 2026-10-29: Luis Munoz had every job requirement done but was offline,
// so he was missing from the assign list, and the owner could not text him from
// the dashboard because Messages only replied to threads an Easer had started.
// Two tools: ask an offline Easer to go online for a job, and text an Easer.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  onlyOfflineBlocks, bookingTakesAskedEaser, describeJobForEaser, buildGoOnlineSms,
  pendingGoOnlineAnswers, GO_ONLINE_ANSWER_WINDOW_HOURS,
} from '../api/_easer-go-online.js';
import { NOTIFICATION_COPY } from '../api/assembler/notifications.js';

const read = rel => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

// ── Who can be asked ────────────────────────────────────────────────────────
{
  assert.equal(onlyOfflineBlocks({ isReady: false, missingItems: ['Online and available'] }), true, 'offline is the only blocker');
  assert.equal(onlyOfflineBlocks({ isReady: false, missingItems: ['Online and available', 'Job texts enabled'] }), false, 'going online would not be enough');
  assert.equal(onlyOfflineBlocks({ isReady: false, missingItems: ['Identity verified'] }), false);
  assert.equal(onlyOfflineBlocks({ isReady: true, missingItems: [] }), false, 'an online Easer is already assignable');
  assert.equal(onlyOfflineBlocks(null), false);
  console.log('PASS only Easers blocked by nothing but being offline are offered');
}

// ── Which jobs can take an asked Easer ──────────────────────────────────────
{
  const todayIso = '2026-10-29';
  const web = { status: 'confirmed', source: 'online', date: '2026-10-30' };
  assert.equal(bookingTakesAskedEaser(web, { todayIso }), true);
  assert.equal(bookingTakesAskedEaser({ ...web, date: '2026-10-28' }, { todayIso }), false, 'a past job');
  assert.equal(bookingTakesAskedEaser({ ...web, status: 'pending' }, { todayIso }), false, 'not confirmed');
  assert.equal(bookingTakesAskedEaser({ ...web, is_test_booking: true }, { todayIso }), false, 'test booking');
  const thumbtack = { status: 'confirmed', source: 'owner_manual', date: '2026-10-30', payment_method: 'thumbtack', external_platform: 'thumbtack', payment_status: 'offline_recorded', external_agreement_verified_at: '2026-10-29T20:00:00Z' };
  assert.equal(bookingTakesAskedEaser(thumbtack, { todayIso }), true, 'a verified Thumbtack job takes any Easer');
  assert.equal(bookingTakesAskedEaser({ ...thumbtack, external_agreement_verified_at: null }, { todayIso }), false, 'unverified Thumbtack job');
  assert.equal(bookingTakesAskedEaser({ ...thumbtack, payment_method: 'cash', external_platform: null }, { todayIso }), false, 'an offline owner job is the owner-Easer\'s');
  console.log('PASS confirmed future jobs only; owner offline jobs stay with the owner-Easer');
}

// ── What the Easer is told ──────────────────────────────────────────────────
{
  const job = describeJobForEaser({ service: 'Furniture Assembly', service_city: 'Houston', date: '2026-10-30', time: '8:00 AM – 10:00 AM', customer_name: 'Ni Dixon', address: '123 Main St' });
  const sms = buildGoOnlineSms(job);
  assert.equal(sms, 'AssembleAtEase: Furniture Assembly job in Houston, Fri, Oct 30 8 AM-10 AM. Go Online in the Easer app to get it.');
  assert.doesNotMatch(sms, /Ni Dixon|Main St|https?:/, 'no customer details and no link');
  assert.equal(job.day, 'Friday, October 30, 2026');
  console.log('PASS the text names the service, city, day and time, never the customer');
}

// ── Telling the owner once when an asked Easer comes online ─────────────────
{
  const nowMs = Date.parse('2026-10-29T22:00:00Z');
  const hoursAgo = h => new Date(nowMs - h * 3600000).toISOString();
  const requests = [
    { id: 'r1', booking_id: 'b1', actor_id: 'luis', created_at: hoursAgo(1) },
    { id: 'r2', booking_id: 'b2', actor_id: 'luis', created_at: hoursAgo(2) },
    { id: 'r3', booking_id: 'b3', actor_id: 'carlos', created_at: hoursAgo(1) },
    { id: 'r4', booking_id: 'b4', actor_id: 'santiago', created_at: hoursAgo(GO_ONLINE_ANSWER_WINDOW_HOURS + 1) },
  ];
  const due = pendingGoOnlineAnswers(requests, new Set(['r2']), new Set(['luis', 'santiago']), { nowMs });
  assert.deepEqual(due.map(r => r.id), ['r1'], 'online, not yet reported, inside the window');
  console.log('PASS the owner is told once per request, only while it is recent');
}

// ── Server: refusals before anything is sent, recorded only after ───────────
{
  const src = read('api/_easer-go-online.js');
  const fn = src.slice(src.indexOf('export async function requestEaserGoOnline'), src.indexOf('export function pendingGoOnlineAnswers'));
  const firstSend = fn.indexOf('await sendSms(');
  for (const code of ['BOOKING_NOT_ASSIGNABLE', 'ALREADY_ASSIGNED', 'OWNER_EASER', 'DEMO_EASER', 'EASER_ALREADY_ONLINE', 'EASER_NOT_READY', 'ALREADY_ASKED']) {
    const at = fn.indexOf(`'${code}'`);
    assert.ok(at > 0 && at < firstSend, `${code} is checked before anything is sent`);
  }
  assert.match(fn, /\.eq\('event_type', 'easer_go_online_requested'\)\n\s+\.eq\('booking_id', bookingId\)\n\s+\.eq\('actor_id', easerId\)/, 'once per Easer per job');
  assert.match(fn, /if \(!channels\.text && !channels\.email\) \{\n\s+return fail\(502, 'GO_ONLINE_NOT_SENT'/, 'nothing recorded when nothing went out');
  assert.ok(fn.indexOf("eventType: 'easer_go_online_requested'") > fn.indexOf("'GO_ONLINE_NOT_SENT'"), 'the request is logged after the send');
  assert.match(fn, /sms_consent_at: rawProfile\.sms_consent_at, sms_opted_out_at: rawProfile\.sms_opted_out_at/, 'texts respect job-text consent and STOP');
  assert.ok(NOTIFICATION_COPY.easer_go_online_request, 'the app notice has copy');
  assert.ok(NOTIFICATION_COPY.owner_sms_easer, 'an owner text has copy');

  const update = read('api/assembler/update.js');
  assert.match(update, /if \(action === 'go_online_request'\) \{[\s\S]{0,400}requestEaserGoOnline\(sb, \{ easerId: assemblerId, bookingId \}\)/);

  const cron = read('api/cron/expire-offers.js');
  assert.match(cron, /results\.askedOnline = \(await notifyOwnerOfOnlineEasers\(sb\)\)\.told;/, 'the cron tells the owner');
  assert.match(src, /if \(!sent\?\.ok\) continue; \/\/ told next run instead/, 'a failed owner email is retried, not marked done');

  const list = read('api/booking/assemblers.js');
  assert.match(list, /if \(onlyOfflineBlocks\(readiness\) && normalized\.is_owner !== true && !demoIds\.has\(normalized\.id\)\) \{/);
  assert.match(list, /return res\.status\(200\)\.json\(\{ assemblers, ownerEaser, offlineReady \}\);/);
  console.log('PASS server: refusals first, once per job, logged only after sending, owner told by cron');
}

// ── Text an Easer: consent checked, thread opened in Messages ───────────────
{
  const src = read('api/owner/sms-messages.js');
  assert.match(src, /if \(req\.method === 'POST' && req\.body\?\.easerId && !req\.body\?\.conversationId\) return startEaserConversation\(req, res\);/);
  const fn = src.slice(src.indexOf('async function startEaserConversation'), src.indexOf('export default async function handler'));
  assert.match(fn, /\.select\('id, full_name, email, phone, role, status, sms_consent_at, sms_opted_out_at'\)/);
  assert.ok(fn.indexOf('smsEligibility(recipient)') < fn.indexOf('await sendSms('), 'consent is checked before sending');
  assert.match(fn, /code: 'SMS_EASER_BLOCKED'/);
  assert.match(fn, /recordSmsConversationMessage\(sb, \{[\s\S]{0,120}direction: 'outbound',\n\s+sender: 'owner',/, 'the text is saved as a Messages thread');
  console.log('PASS owner text: consent first, STOP respected, saved to Messages');
}

// ── Dashboard ───────────────────────────────────────────────────────────────
{
  const dash = read('owner/index.html');
  assert.match(dash, /<div id="assign-offline" style="display:none;margin-top:0\.6rem"><\/div>/);
  assert.match(dash, /renderOfflineAsk\(null\); \/\/ cleared here; only the unassigned branch fills it/, 'a previous booking\'s list never lingers');
  assert.match(dash, /if \(!ownerEaserOnly && b\.status === 'confirmed' && b\.is_test_booking !== true/);
  assert.match(dash, /action: 'go_online_request', bookingId: bookingId/);
  assert.match(dash, /phoneWithCall\(a\.phone, 'easer', a\.id\) \+ textEaserControl\(a\)/, 'Text sits next to Call');
  assert.match(dash, /if \(a\.sms_opted_out_at\) return ' <span[^']*'?[^;]*Replied STOP: cannot be texted/);
  assert.match(dash, /fetch\('\/api\/owner\/sms-messages', \{ method: 'POST', headers: headers\(\), body: JSON\.stringify\(\{ easerId: id, body: body \}\) \}\)/);
  console.log('PASS dashboard: offline list on unassigned jobs, Text button on the Easer card');
}

console.log('\nEaser go-online and owner text tests passed.');
