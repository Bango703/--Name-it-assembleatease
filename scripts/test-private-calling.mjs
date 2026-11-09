#!/usr/bin/env node
// Private customer–Easer lines (owner, 2026-11-08). Every call path, driven
// through the real event handler with Telnyx and the database simulated.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { privateLineConfig, isPoolNumber, lineNumberFor, privateLineOpen, openLinesForCaller, encodeState, decodeState, NO_LINE_MESSAGE, NO_ANSWER_MESSAGE } from '../api/_private-line.js';
import { handlePrivateLineEvent } from '../api/webhooks/telnyx-private-line.js';
import privateCall from '../api/booking/private-call.js';
import { privateTextConfig } from '../api/_private-line.js';
import { handlePrivateTextEvent } from '../api/webhooks/telnyx-private-text.js';
import { summarizeCall, CALL_SUMMARY_MODEL } from '../api/_call-summary.js';
import recordingsCron, { deleteRecording, RECORDING_RETENTION_DAYS } from '../api/cron/private-call-recordings.js';
import { redactAssignmentCustomerData } from '../api/booking/my-assignments.js';

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');
const POOL_A = '+15125550101';
const POOL_B = '+15125550102';
const BUSINESS = '+19792325139';
const CUSTOMER = '+15125550200';
const EASER = '+15125550300';
const LEAD = '+15125550400';
const env = { TELNYX_API_KEY: 'k', TELNYX_PRIVATE_LINE_APP_ID: 'app', TELNYX_PRIVATE_LINE_NUMBERS: `${POOL_A},${POOL_B}`, TELNYX_FROM_NUMBER: BUSINESS, PRIVATE_CALLING_ENABLED: 'true' };
const cfg = privateLineConfig(env);
const recordingCfg = privateLineConfig({ ...env, PRIVATE_CALL_RECORDING_ENABLED: 'true' });
// Tuesday Nov 10, 10 AM Austin = 16:00Z; 20 hours before is inside the 24-hour window.
const NOW = Date.parse('2026-11-09T20:00:00Z');

function booking(id, changes = {}) {
  return { id, ref: 'AAE-' + id.toUpperCase(), service: 'TV Mounting', status: 'confirmed', date: '2026-11-10', time: '10:00 AM - 12:00 PM', customer_phone: CUSTOMER, customer_name: 'Bianca G', assembler_id: 'easer-1', assembler_name: 'Phil H', assembler_accepted_at: '2026-11-08T12:00:00Z', completed_at: null, return_visit_required: false, ...changes };
}

function db(rows) {
  return {
    from(table) {
      let list = (rows[table] || []).slice();
      const q = {
        select() { return q; },
        eq(c, v) { list = list.filter((r) => r[c] === v); return q; },
        in(c, vs) { list = list.filter((r) => vs.includes(r[c])); return q; },
        not(c) { list = list.filter((r) => r[c] != null); return q; },
        order() { return q; },
        limit(n) { list = list.slice(0, n); return q; },
        maybeSingle: async () => ({ data: list[0] || null, error: null }),
        then(resolve, reject) { return Promise.resolve({ data: list, error: null }).then(resolve, reject); },
      };
      return q;
    },
  };
}
const profiles = [{ id: 'easer-1', role: 'assembler', phone: EASER }, { id: 'lead-1', role: 'assembler', phone: LEAD }];

function harness(rows, { config = cfg } = {}) {
  const commands = [];
  const logs = [];
  const pushes = [];
  const ctx = {
    cfg: config, sb: db({ profiles, booking_crew: [], ...rows }), now: NOW,
    command: async (_cfg, callId, action, body) => { commands.push({ callId, action, body, state: decodeState(body?.client_state) }); return { ok: true }; },
    rateLimit: async () => true,
    notifyEaser: async (id, payload) => { pushes.push({ id, payload }); return { ok: true }; },
    log: async (_sb, entry) => { logs.push(entry); return { ok: true }; },
  };
  const send = (type, payload) => handlePrivateLineEvent({ data: { event_type: type, payload } }, ctx);
  return { commands, logs, pushes, send, ctx };
}
const last = (h) => h.commands[h.commands.length - 1];

// Configuration and the window.
{
  assert.equal(privateLineConfig({ ...env, PRIVATE_CALLING_ENABLED: '' }).enabled, false, 'off unless switched on');
  assert.equal(privateLineConfig({ ...env, TELNYX_PRIVATE_LINE_NUMBERS: '' }).enabled, false, 'off without a pool');
  assert.equal(isPoolNumber(cfg, POOL_A), true);
  assert.equal(isPoolNumber(cfg, BUSINESS), false, 'the business number is never a private line');
  assert.equal(isPoolNumber(privateLineConfig({ ...env, TELNYX_PRIVATE_LINE_NUMBERS: `${POOL_A},${BUSINESS}` }), BUSINESS), false, 'even if someone lists it in the pool');
  assert.equal(lineNumberFor(cfg, 'b1'), lineNumberFor(cfg, 'b1'), 'a booking always shows the same number');
  assert.equal(privateLineOpen(booking('b1'), NOW), true, '20 hours before: open');
  assert.equal(privateLineOpen(booking('b1'), Date.parse('2026-11-08T20:00:00Z')), false, '44 hours before: closed');
  assert.equal(privateLineOpen(booking('b1', { status: 'en_route', date: '2026-11-12' }), NOW), true, 'on the way: open at once');
  assert.equal(privateLineOpen(booking('b1', { status: 'cancelled' }), NOW), false);
  assert.equal(privateLineOpen(booking('b1', { assembler_accepted_at: null }), NOW), false, 'not before the Easer accepts');
  assert.equal(privateLineOpen(booking('b1', { status: 'completed', completed_at: '2026-11-09T10:00:00Z' }), NOW), true, 'completed 10 hours ago: still open');
  assert.equal(privateLineOpen(booking('b1', { status: 'completed', completed_at: '2026-11-08T10:00:00Z' }), NOW), false, 'completed 34 hours ago: closed');
}
console.log('PASS window: off until switched on, pool only, opens with contact release, closes 24 hours after completion or on cancel');

// A customer calls: she reaches the Easer, who must press 1.
{
  const h = harness({ bookings: [booking('b1')] });
  assert.equal((await h.send('call.initiated', { call_control_id: 'in-1', direction: 'incoming', from: CUSTOMER, to: POOL_A })).routed, 'greeting');
  assert.equal(last(h).action, 'answer');
  await h.send('call.answered', { call_control_id: 'in-1', client_state: last(h).body.client_state });
  assert.equal(last(h).action, 'speak');
  assert.equal(last(h).body.payload, 'Connecting your AssembleAtEase call.', 'no recording sentence while recording is off');
  await h.send('call.speak.ended', { call_control_id: 'in-1', client_state: last(h).body.client_state });
  const dial = last(h);
  assert.equal(dial.action, 'dial');
  assert.equal(dial.body.to, EASER, 'rings the assigned Easer');
  assert.equal(dial.body.from, POOL_A, 'shows the private line, never anyone\'s real number');
  assert.equal(dial.body.bridge_on_answer, false, 'not joined until they press 1');
  assert.equal(dial.body.link_to, 'in-1');
  await h.send('call.answered', { call_control_id: 'out-1', client_state: dial.body.client_state });
  assert.equal(last(h).action, 'gather_using_speak');
  assert.equal(last(h).body.payload, 'This is a call from your AssembleAtEase customer. Press 1 to connect.');
  assert.equal(last(h).body.valid_digits, '1');
  await h.send('call.gather.ended', { call_control_id: 'out-1', digits: '1', client_state: last(h).body.client_state });
  assert.equal(last(h).action, 'bridge');
  assert.equal(last(h).body.call_control_id, 'in-1');
  assert.ok(!h.commands.some((c) => c.action === 'record_start'), 'nothing recorded while recording is off');
  assert.equal(h.logs[0].eventType, 'private_call_connected');
  const bridgedState = last(h).body.client_state;
  await h.send('call.hangup', { call_control_id: 'out-1', client_state: bridgedState });
  assert.deepEqual([last(h).callId, last(h).action], ['in-1', 'hangup'], 'one side hangs up, the other is ended');
}
console.log('PASS customer to Easer: greeting, the Easer is rung from the private line, presses 1, then connected');

// Recording on: both people hear it before connecting; the caller leg records.
{
  const h = harness({ bookings: [booking('b1')] }, { config: recordingCfg });
  await h.send('call.initiated', { call_control_id: 'in-1', direction: 'incoming', from: CUSTOMER, to: POOL_A });
  await h.send('call.answered', { call_control_id: 'in-1', client_state: last(h).body.client_state });
  assert.match(last(h).body.payload, /This call is recorded and transcribed for quality and assurance\./, 'the caller hears it');
  await h.send('call.speak.ended', { call_control_id: 'in-1', client_state: last(h).body.client_state });
  await h.send('call.answered', { call_control_id: 'out-1', client_state: last(h).body.client_state });
  assert.match(last(h).body.payload, /This call is recorded and transcribed for quality and assurance\. Press 1 to connect\./, 'the person rung hears it before connecting');
  await h.send('call.gather.ended', { call_control_id: 'out-1', digits: '1', client_state: last(h).body.client_state });
  const record = h.commands.find((c) => c.action === 'record_start');
  assert.ok(record && record.callId === 'in-1' && record.body.channels === 'dual', 'recorded, one person per channel');
  const bridgeIndex = h.commands.findIndex((c) => c.action === 'bridge');
  assert.ok(h.commands.indexOf(record) > bridgeIndex, 'recording starts only after both heard the notice and connected');
}
console.log('PASS recording: announced to both before connecting; recording starts after');

// No answer, or not pressing 1: the caller is told, the Easer is pushed.
{
  const h = harness({ bookings: [booking('b1')] });
  await h.send('call.initiated', { call_control_id: 'in-1', direction: 'incoming', from: CUSTOMER, to: POOL_A });
  await h.send('call.answered', { call_control_id: 'in-1', client_state: last(h).body.client_state });
  await h.send('call.speak.ended', { call_control_id: 'in-1', client_state: last(h).body.client_state });
  const calleeState = last(h).body.client_state;
  await h.send('call.hangup', { call_control_id: 'out-1', client_state: calleeState });
  const told = h.commands.find((c) => c.action === 'speak' && c.callId === 'in-1' && c.body.payload === NO_ANSWER_MESSAGE);
  assert.ok(told, 'the customer hears that the pro will call back');
  assert.equal(h.pushes[0].id, 'easer-1');
  assert.match(h.pushes[0].payload.title, /Missed call/);
  assert.equal(h.logs.find((l) => l.eventType === 'private_call_missed').bookingId, 'b1');
  await h.send('call.speak.ended', { call_control_id: 'in-1', client_state: told.body.client_state });
  assert.deepEqual([last(h).callId, last(h).action], ['in-1', 'hangup']);
}
console.log('PASS no answer: never joined to voicemail; the caller is told and the Easer gets a missed-call notice');

// Crews reach the lead; an Easer reaches the customer.
{
  const h = harness({ bookings: [booking('b1')], booking_crew: [{ booking_id: 'b1', easer_id: 'lead-1', role: 'lead' }] });
  await h.send('call.initiated', { call_control_id: 'in-1', direction: 'incoming', from: CUSTOMER, to: POOL_B });
  await h.send('call.answered', { call_control_id: 'in-1', client_state: last(h).body.client_state });
  await h.send('call.speak.ended', { call_control_id: 'in-1', client_state: last(h).body.client_state });
  assert.equal(last(h).body.to, LEAD, 'two Easers: the lead is rung');
  const lines = await openLinesForCaller(h.ctx.sb, LEAD, NOW);
  assert.equal(lines[0].destination, CUSTOMER, 'the lead Easer reaches the customer');
  assert.equal((await openLinesForCaller(h.ctx.sb, EASER, NOW)).length, 0, 'the helper does not get the customer');
}
console.log('PASS crews: a customer reaches the lead Easer; the lead reaches the customer, the helper does not');

// Two open jobs: a menu. Nothing open, or off: the business line.
{
  const h = harness({ bookings: [booking('b1'), booking('b2', { time: '2:00 PM - 4:00 PM' })] });
  assert.equal((await h.send('call.initiated', { call_control_id: 'in-1', direction: 'incoming', from: CUSTOMER, to: POOL_A })).routed, 'menu');
  await h.send('call.answered', { call_control_id: 'in-1', client_state: last(h).body.client_state });
  assert.equal(last(h).action, 'gather_using_speak');
  assert.match(last(h).body.payload, /For your job on Tuesday, November 10 at 10:00 AM, press 1\. For your job on Tuesday, November 10 at 2:00 PM, press 2\./);
  await h.send('call.gather.ended', { call_control_id: 'in-1', digits: '2', client_state: last(h).body.client_state });
  assert.equal(decodeState(last(h).body.client_state).bookingId, 'b2', 'the chosen job is called');

  for (const [rows, config, why] of [[{ bookings: [] }, cfg, 'no open line'], [{ bookings: [booking('b1')] }, privateLineConfig({ ...env, PRIVATE_CALLING_ENABLED: '' }), 'calling off']]) {
    const b = harness(rows, { config });
    assert.equal((await b.send('call.initiated', { call_control_id: 'in-9', direction: 'incoming', from: CUSTOMER, to: POOL_A })).routed, 'business_line', why);
    await b.send('call.answered', { call_control_id: 'in-9', client_state: last(b).body.client_state });
    assert.equal(last(b).body.payload, NO_LINE_MESSAGE);
    await b.send('call.speak.ended', { call_control_id: 'in-9', client_state: last(b).body.client_state });
    assert.deepEqual([last(b).action, last(b).body.to], ['transfer', BUSINESS], `${why}: goes to the business line`);
  }
  const notMine = harness({ bookings: [booking('b1')] });
  assert.equal((await notMine.send('call.initiated', { call_control_id: 'in-x', direction: 'incoming', from: CUSTOMER, to: BUSINESS })).ignored, 'not_a_private_line', 'a call to the business number is never touched here');
  assert.equal(notMine.commands.length, 0);
}
console.log('PASS routing: two jobs get a menu; nothing open or calling off goes to the business line; the business number is never handled here');

// The buttons: Easer and customer start a call; the right person is rung first.
{
  const run = async (req, rows, extra = {}) => {
    const out = { status: 200, body: null, headers: {} };
    const res = { status(c) { out.status = c; return this; }, setHeader(k, v) { out.headers[k] = v; }, json(b) { out.body = b; return this; } };
    const dialed = [];
    await privateCall(req, res, {
      cfg, sb: db({ profiles, booking_crew: [], ...rows }), rateLimit: async () => true, now: NOW,
      easerAccess: async () => ({ ok: true, user: { id: extra.userId || 'easer-1' } }),
      customerAccess: async () => ({ ok: true }),
      command: async (_c, _id, action, body) => { dialed.push({ action, body, state: decodeState(body.client_state) }); return { ok: true }; },
      ...extra.deps,
    });
    return { ...out, dialed };
  };
  const easer = await run({ method: 'POST', headers: { authorization: 'Bearer t' }, body: { bookingId: 'b1' } }, { bookings: [booking('b1')] });
  assert.equal(easer.status, 200);
  assert.equal(easer.dialed[0].body.to, EASER, 'the Easer who pressed Call is rung first');
  assert.equal(easer.dialed[0].body.from, lineNumberFor(cfg, 'b1'));
  assert.deepEqual([easer.dialed[0].state.stage, easer.dialed[0].state.destination], ['initiator', CUSTOMER]);
  const helper = await run({ method: 'POST', headers: { authorization: 'Bearer t' }, body: { bookingId: 'b1' } }, { bookings: [booking('b1')], booking_crew: [{ booking_id: 'b1', easer_id: 'lead-1', role: 'lead' }] });
  assert.equal(helper.status, 404, 'only the lead calls the customer');
  const customer = await run({ method: 'POST', headers: {}, body: { ref: 'AAE-B1', email: 'c@example.test', token: 't' } }, { bookings: [booking('b1')] });
  assert.deepEqual([customer.status, customer.dialed[0].body.to, customer.dialed[0].state.destination], [200, CUSTOMER, EASER]);
  const closed = await run({ method: 'POST', headers: { authorization: 'Bearer t' }, body: { bookingId: 'b1' } }, { bookings: [booking('b1', { date: '2026-11-20' })] });
  assert.equal(closed.status, 409);
  assert.equal(closed.body.code, 'PRIVATE_LINE_CLOSED');
  const off = await run({ method: 'POST', headers: { authorization: 'Bearer t' }, body: { bookingId: 'b1' } }, { bookings: [booking('b1')] }, { deps: { cfg: privateLineConfig({ ...env, PRIVATE_CALLING_ENABLED: '' }) } });
  assert.equal(off.body.code, 'PRIVATE_CALLING_OFF');
  // The pressed-button call then follows the same greeting/press-1 path.
  const h = harness({ bookings: [booking('b1')] });
  await h.send('call.answered', { call_control_id: 'init-1', client_state: easer.dialed[0].body.client_state });
  await h.send('call.speak.ended', { call_control_id: 'init-1', client_state: last(h).body.client_state });
  assert.deepEqual([last(h).action, last(h).body.to, last(h).body.bridge_on_answer], ['dial', CUSTOMER, false]);
}
console.log('PASS buttons: "Call customer" and "Call your pro" ring the presser first; only the lead; closed and off say so');

// Wiring.
{
  const hook = read('api/webhooks/telnyx-private-line.js');
  assert.match(hook, /if \(!\(deps\.verify \|\| verifyVoiceSignature\)\(raw, req\.headers \|\| \{\}, publicKey, Date\.now\(\)\)\)/, 'signed Telnyx events only');
  assert.match(read('api/webhooks/telnyx-call-control.js'), /routeInboundBookingCall/, 'the owner call webhook is untouched by this branch');
  assert.ok(encodeState({ stage: 'x' }).length < 600);
}
console.log('PASS wiring: signed events only; the owner call webhook is unchanged');

// Private job texts on the toll-free line.
{
  const TEXT = '+18777484603';
  const tcfg = privateTextConfig({ TELNYX_PRIVATE_TEXT_NUMBER: TEXT, TELNYX_FROM_NUMBER: BUSINESS, PRIVATE_TEXTING_ENABLED: 'true' });
  assert.equal(privateTextConfig({ TELNYX_PRIVATE_TEXT_NUMBER: TEXT, TELNYX_FROM_NUMBER: BUSINESS }).enabled, false, 'off unless switched on');
  assert.equal(privateTextConfig({ TELNYX_PRIVATE_TEXT_NUMBER: BUSINESS, TELNYX_FROM_NUMBER: BUSINESS, PRIVATE_TEXTING_ENABLED: 'true' }).enabled, false, 'never the business number');
  const consented = { sms_consent_at: '2026-11-01T00:00:00Z', sms_opted_out_at: null };
  const textHarness = (rows, config = tcfg) => {
    const sent = [];
    const logs = [];
    const ctx = {
      cfg: config, sb: db({ profiles: profiles.map((p) => ({ ...p, full_name: p.id === 'lead-1' ? 'Lena Lead' : 'Phil Hawkins', ...consented })), booking_crew: [], ...rows }), now: NOW,
      send: async (msg) => { sent.push(msg); return { ok: true }; },
      log: async (_sb, entry) => { logs.push(entry); return { ok: true }; },
    };
    const text = (from, body) => handlePrivateTextEvent({ data: { event_type: 'message.received', payload: { from: { phone_number: from }, to: [{ phone_number: TEXT }], text: body } } }, ctx);
    return { sent, logs, text };
  };
  const b1 = booking('b1', consented);

  const c = textHarness({ bookings: [b1] });
  assert.equal((await c.text(CUSTOMER, 'Is 10 still good?')).action, 'relayed');
  assert.equal(c.sent[0].recipient.phone, EASER, 'the customer reaches her pro');
  assert.equal(c.sent[0].from, TEXT, 'sent from the job-text line, never anyone\'s real number');
  assert.equal(c.sent[0].body, 'AssembleAtEase job AAE-B1, Bianca: Is 10 still good?', 'labelled as coming through AssembleAtEase');
  assert.equal(c.logs[0].eventType, 'private_text_relayed', 'on the owner timeline');

  const e = textHarness({ bookings: [b1] });
  await e.text(EASER, 'On my way, 20 minutes');
  assert.deepEqual([e.sent[0].recipient.phone, e.sent[0].body], [CUSTOMER, 'AssembleAtEase, Phil (your pro): On my way, 20 minutes']);

  const blocked = textHarness({ bookings: [b1] });
  assert.equal((await blocked.text(EASER, 'text me at 281.722.0506')).action, 'blocked', 'the contact guard applies');
  assert.equal(blocked.sent.length, 1, 'only the refusal goes back to the sender');
  assert.equal(blocked.sent[0].recipient.phone, EASER);
  assert.equal(blocked.logs[0].eventType, 'private_text_blocked');
  assert.equal((await textHarness({ bookings: [b1] }).text(CUSTOMER, 'my email is me@example.com')).action, 'blocked', 'both directions');

  const noConsent = textHarness({ bookings: [booking('b1', { sms_consent_at: null })] });
  await noConsent.text(EASER, 'Running late');
  assert.equal(noConsent.sent[0].recipient.sms_consent_at, null, 'the customer\'s real consent goes to the shared sender, which refuses without it');

  const two = textHarness({ bookings: [b1, booking('b2', { ...consented, time: '2:00 PM - 4:00 PM' })] });
  assert.equal((await two.text(CUSTOMER, 'Hello')).action, 'asked_which_job');
  assert.match(two.sent[0].body, /You have 2 active jobs\. Start your text with 1 for 2026-11-10 10:00 AM, 2 for 2026-11-10 2:00 PM\./);
  await two.text(CUSTOMER, '2 bring a ladder please');
  assert.equal(two.sent[1].body, 'AssembleAtEase job AAE-B2, Bianca: bring a ladder please', 'the number picks the job and is dropped');

  const none = textHarness({ bookings: [] });
  assert.equal((await none.text(CUSTOMER, 'hi')).action, 'no_open_job');
  assert.match(none.sent[0].body, /This number is for active AssembleAtEase jobs\. For anything else, call or text 979-232-5139\./);
  const stop = textHarness({ bookings: [b1] });
  assert.equal((await stop.text(CUSTOMER, 'STOP')).action, 'opt_out_noted');
  assert.equal(stop.sent.length, 0, 'STOP is never relayed');
  const help = textHarness({ bookings: [b1] });
  assert.equal((await help.text(CUSTOMER, 'HELP')).action, 'keyword_answered_by_telnyx');
  assert.equal(help.sent.length, 0, 'Telnyx answers HELP; no duplicate from us');
  const off = textHarness({ bookings: [b1] }, privateTextConfig({ TELNYX_PRIVATE_TEXT_NUMBER: TEXT, TELNYX_FROM_NUMBER: BUSINESS }));
  assert.equal((await off.text(CUSTOMER, 'hi')).action, 'not_enabled');
  assert.equal((await handlePrivateTextEvent({ data: { event_type: 'message.received', payload: { from: { phone_number: CUSTOMER }, to: [{ phone_number: BUSINESS }], text: 'hi' } } }, { cfg: tcfg })).ignored, 'not_the_private_text_line', 'texts to the business number are never handled here');
  assert.match(read('api/_sms.js'), /from: String\(from \|\| process\.env\.TELNYX_FROM_NUMBER \|\| ''\)\.trim\(\),/, 'the shared sender only gains a from number; its consent and logging stay');
}
console.log('PASS job texts: both ways from the toll-free line, labelled AssembleAtEase, contact guard both ways, consent enforced, STOP and HELP handled, business texts untouched');

// The buttons reach the server: the Easer gets a private Call instead of the number.
{
  const accepted = { id: 'b1', status: 'confirmed', date: '2026-11-10', time: '10:00 AM - 12:00 PM', customer_name: 'Bianca George', customer_phone: CUSTOMER, assembler_id: 'easer-1', assembler_accepted_at: '2026-11-08T12:00:00Z', address: '1 Main St', details: 'TV' };
  const [off] = redactAssignmentCustomerData([{ ...accepted }], NOW, { privateCallingOn: false });
  assert.equal(off.customer_phone, CUSTOMER, 'calling off: today\'s behaviour, the number after release');
  assert.equal(off._private_call, undefined);
  const [on] = redactAssignmentCustomerData([{ ...accepted }], NOW, { privateCallingOn: true });
  assert.deepEqual([on.customer_phone, on._private_call], [null, true], 'calling on: no number, a private Call');
  const [early] = redactAssignmentCustomerData([{ ...accepted, date: '2026-11-20' }], NOW, { privateCallingOn: true });
  assert.deepEqual([early.customer_phone, early._private_call], [null, undefined], 'before release: neither');

  const page = read('assembler/my-assignments.html');
  assert.match(page, /b\._private_call && b\._crew_role !== 'helper'/, 'the web page shows Call only to the lead');
  assert.match(page, /fetch\('\/api\/booking\/private-call', \{\s*method: 'POST',[\s\S]{0,200}body: JSON\.stringify\(\{ bookingId: privateCallButton\.getAttribute\('data-booking-id'\) \}\)/);
  const models = read('mobile/ios/App/App/EaserModels.swift');
  const views = read('mobile/ios/App/App/EaserViews.swift');
  assert.match(models, /privateCall = c\.bool\("_private_call"\) \?\? false/, 'the Easer app reads the flag');
  assert.match(views, /\} else if job\.privateCall \{/, 'and shows Call customer through the private line');
  assert.match(views, /store\.api\.call\("POST", "\/api\/booking\/private-call", body: \["bookingId": job\.id\]\)/);

  assert.match(read('api/booking/track.js'), /private_call_available: privateLineConfig\(\)\.enabled && privateLineOpen\(booking\),/, 'the booking page is told when calling is open');
  const track = read('track.html');
  assert.match(track, /proCall\.style\.display = b\.private_call_available \? '' : 'none';/, 'Call your pro shows only when the server says so');
  assert.match(track, /body: JSON\.stringify\(\{ ref: currentRef, email: currentEmail, token: currentMutationToken \}\)/);
}
console.log('PASS buttons: Call (Easer web and app) and Call your pro reach the private line; no number is sent while calling is on');

// Recording: transcribed, summarized for the owner, deleted after 90 days.
{
  const h = harness({ bookings: [booking('b1')] }, { config: recordingCfg });
  await h.send('call.initiated', { call_control_id: 'in-1', direction: 'incoming', from: CUSTOMER, to: POOL_A });
  await h.send('call.answered', { call_control_id: 'in-1', client_state: last(h).body.client_state });
  await h.send('call.speak.ended', { call_control_id: 'in-1', client_state: last(h).body.client_state });
  await h.send('call.answered', { call_control_id: 'out-1', client_state: last(h).body.client_state });
  await h.send('call.gather.ended', { call_control_id: 'out-1', digits: '1', client_state: last(h).body.client_state });
  const record = h.commands.find((c) => c.action === 'record_start');
  assert.deepEqual([record.body.transcription, record.body.transcription_engine], [true, 'deepgram/nova-3'], 'transcribed by Telnyx');

  const summaries = [];
  h.ctx.summarize = async (args) => { summaries.push(args); return { ok: true, summary: 'Customer moved the time to 2 PM. No off-platform request.', model: CALL_SUMMARY_MODEL }; };
  await h.send('call.recording.transcription.saved', { call_control_id: 'in-1', recording_id: 'rec-1', transcription_text: 'hello', client_state: record.body.client_state });
  assert.deepEqual(summaries[0], { transcript: 'hello', callerType: 'customer' });
  const logged = h.logs.find((l) => l.eventType === 'private_call_summary');
  assert.match(logged.description, /^Call summary: Customer moved the time to 2 PM\./, 'on the owner timeline');
  h.ctx.summarize = async () => ({ ok: false, reason: 'refused' });
  await h.send('call.recording.transcription.saved', { call_control_id: 'in-1', recording_id: 'rec-2', transcription_text: 'x', client_state: record.body.client_state });
  assert.match(h.logs.find((l) => l.eventType === 'private_call_summary_unavailable').description, /could not be summarized \(refused\)/, 'a missing summary says why');

  // The summary call itself.
  const fakeClient = (reply) => ({ beta: { messages: { create: async (body) => { fakeClient.last = body; return reply; } } } });
  const ok = await summarizeCall({ transcript: 'Pro: running late', callerType: 'easer', client: fakeClient({ stop_reason: 'end_turn', model: CALL_SUMMARY_MODEL, content: [{ type: 'text', text: 'The pro said he was running late. No off-platform request.' }] }) });
  assert.equal(ok.ok, true);
  assert.equal(fakeClient.last.model, 'claude-opus-5-5');
  assert.deepEqual([fakeClient.last.fallbacks, fakeClient.last.betas[0], fakeClient.last.output_config.effort], ['default', 'server-side-fallback-2026-07-01', 'low']);
  assert.equal((await summarizeCall({ transcript: 'x', client: fakeClient({ stop_reason: 'refusal', content: [] }) })).reason, 'refused');
  assert.equal((await summarizeCall({ transcript: '   ', client: fakeClient({}) })).reason, 'empty_transcript');
  assert.equal((await summarizeCall({ transcript: 'x', client: { beta: { messages: { create: async () => { throw new Error('offline'); } } } } })).reason, 'network_error', 'never throws');

  // 90-day deletion.
  assert.equal(RECORDING_RETENTION_DAYS, 90);
  const rows = {
    activity_logs: [
      { id: 'a1', booking_id: 'b1', event_type: 'private_call_recorded', created_at: '2026-07-01T00:00:00Z', metadata: { recordingId: 'old-1' } },
      { id: 'a2', booking_id: 'b1', event_type: 'private_call_recorded', created_at: '2026-07-02T00:00:00Z', metadata: { recordingId: 'old-done' } },
      { id: 'a3', booking_id: 'b1', event_type: 'private_call_recording_deleted', created_at: '2026-10-01T00:00:00Z', metadata: { recordingId: 'old-done' } },
      { id: 'a4', booking_id: 'b2', event_type: 'private_call_recorded', created_at: '2026-11-01T00:00:00Z', metadata: { recordingId: 'recent' } },
    ],
  };
  const cronDb = {
    from(table) {
      let list = (rows[table] || []).slice();
      const q = {
        select() { return q; },
        eq(c, v) { list = list.filter((r) => r[c] === v); return q; },
        lte(c, v) { list = list.filter((r) => r[c] <= v); return q; },
        in(c, vs) { list = c === 'metadata->>recordingId' ? list.filter((r) => vs.includes(r.metadata?.recordingId)) : list.filter((r) => vs.includes(r[c])); return q; },
        order() { return q; }, limit() { return q; },
        insert: async () => ({ error: null }),
        then(resolve, reject) { return Promise.resolve({ data: list, error: null }).then(resolve, reject); },
      };
      return q;
    },
  };
  const removed = [];
  const deletedLogs = [];
  const out = { status: 0, body: null };
  const res = { status(c) { out.status = c; return this; }, json(b) { out.body = b; return this; } };
  process.env.CRON_SECRET = 'cron-test';
  await recordingsCron({ headers: { authorization: 'Bearer cron-test' } }, res, {
    sb: cronDb, now: NOW, remove: async (id) => { removed.push(id); return { ok: true }; }, log: async (_sb, e) => { deletedLogs.push(e); return { ok: true }; },
  });
  assert.deepEqual(removed, ['old-1'], 'only recordings past 90 days, and never one already deleted');
  assert.equal(out.body.deleted, 1);
  assert.match(deletedLogs[0].description, /deleted after 90 days\. The summary stays on this booking\./);
  await recordingsCron({ headers: { authorization: 'Bearer wrong' } }, res, { sb: cronDb });
  assert.equal(out.status, 401, 'cron secret required');
  assert.deepEqual(await deleteRecording('k', 'gone', async () => ({ ok: false, status: 404 })), { ok: true, alreadyGone: true }, 'already gone counts as deleted');
  assert.equal((await deleteRecording('k', 'x', async () => { throw new Error('down'); })).ok, false, 'never throws');
  const vercel = JSON.parse(read('vercel.json'));
  assert.ok(vercel.crons.some((c) => c.path === '/api/cron/private-call-recordings'), 'scheduled daily');
}
console.log('PASS recordings: transcribed, summarized for the owner (never throwing), deleted after 90 days, summary kept');
console.log('\nPrivate calling tests passed.');
