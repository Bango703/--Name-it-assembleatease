#!/usr/bin/env node
// Inactive Easers (owner, 2026-10-29): Thomas J Williams-Gibson never signed the
// updated agreement, was not online and never accepted a job. The owner sends a
// notice that states those reasons; the account can be closed only after the
// 14 days contractor agreement 12.4 requires, unless the Easer answers by
// signing the agreement or accepting a job.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  INACTIVITY_NOTICE_DAYS, inactivityReasons, inactivityNoticeState, loadJobHistory, buildInactivityNoticeHtml,
} from '../api/_easer-inactivity.js';
import { CONTRACTOR_AGREEMENT_VERSION } from '../api/_assembler-onboarding.js';

const read = rel => readFile(new URL(`../${rel}`, import.meta.url), 'utf8').then(s => s.replace(/\r\n/g, '\n'));
const NOW = Date.parse('2026-10-29T16:00:00Z');
const days = n => new Date(NOW + n * 86400000).toISOString();

const thomas = { contractor_agreement_signed_at: '2026-08-28T15:00:00Z', contractor_agreement_version: '2026-08-28', is_available: false };
const current = { contractor_agreement_signed_at: '2026-10-20T15:00:00Z', contractor_agreement_version: CONTRACTOR_AGREEMENT_VERSION, is_available: true };

// ── Who is inactive, and why ────────────────────────────────────────────────
{
  assert.equal(INACTIVITY_NOTICE_DAYS, 14, 'agreement 12.4: fourteen days');
  const reasons = inactivityReasons(thomas, { acceptedJobs: 0 }, { nowMs: NOW });
  assert.deepEqual(reasons.map(r => r.key), ['agreement', 'no_jobs', 'offline'], 'Thomas: all three, in plain words');
  assert.match(reasons[0].text, new RegExp(`version ${CONTRACTOR_AGREEMENT_VERSION}`));
  assert.deepEqual(inactivityReasons(current, { acceptedJobs: 3, lastAcceptedAt: days(-5) }, { nowMs: NOW }), [], 'an active Easer gets nothing');
  assert.deepEqual(inactivityReasons({ ...current, is_available: false }, { acceptedJobs: 3, lastAcceptedAt: days(-5) }, { nowMs: NOW }), [],
    'being offline alone is a choice, not inactivity');
  assert.deepEqual(inactivityReasons(current, { acceptedJobs: 2, lastAcceptedAt: days(-45) }, { nowMs: NOW }).map(r => r.key), ['no_recent_jobs']);
  console.log('PASS reasons: unsigned agreement, no jobs, no recent jobs, offline; offline alone never counts');
}

// ── The notice: open, ended, answered ───────────────────────────────────────
{
  assert.equal(inactivityNoticeState(null, thomas, {}), null);
  const notice = { sentAt: days(-3), deadline: days(11) };
  assert.equal(inactivityNoticeState(notice, thomas, { acceptedJobs: 0 }, { nowMs: NOW }).status, 'open');
  assert.equal(inactivityNoticeState({ sentAt: days(-15), deadline: days(-1) }, thomas, { acceptedJobs: 0 }, { nowMs: NOW }).status, 'ended',
    'after 14 days with no answer, the account may be closed');
  const signed = inactivityNoticeState(notice, { ...thomas, contractor_agreement_signed_at: days(-1), contractor_agreement_version: CONTRACTOR_AGREEMENT_VERSION }, { acceptedJobs: 0 }, { nowMs: NOW });
  assert.equal(signed.status, 'responded', 'signing the current agreement answers the notice');
  const took = inactivityNoticeState({ sentAt: days(-15), deadline: days(-1) }, thomas, { acceptedJobs: 1, lastAcceptedAt: days(-2) }, { nowMs: NOW });
  assert.equal(took.status, 'responded', 'accepting a job answers it, even after the date');
  assert.equal(inactivityNoticeState(notice, thomas, { acceptedJobs: 1, lastAcceptedAt: days(-30) }, { nowMs: NOW }).status, 'open',
    'a job accepted before the notice is not an answer');
  console.log('PASS notice: open for 14 days, then ended; signing or accepting a job answers it');
}

// ── Job history counts every accept, and fails closed ───────────────────────
{
  const rows = {
    activity_logs: [{ booking_id: 'b1', actor_id: 'e1', created_at: days(-40) }, { booking_id: 'b2', actor_id: 'e1', created_at: days(-10) }],
    bookings: [{ id: 'b2', assembler_id: 'e1', assembler_accepted_at: days(-10) }, { id: 'b3', assembler_id: 'e1', assembler_accepted_at: days(-2) }],
  };
  const fake = (fail = false) => ({ from(t) { const q = { select() { return q; }, eq() { return q; }, in() { return q; }, not() { return q; },
    then(res) { return Promise.resolve(fail ? { data: null, error: { message: 'down' } } : { data: rows[t], error: null }).then(res); } }; return q; } });
  const history = (await loadJobHistory(fake(), ['e1', 'e2']));
  assert.deepEqual(history.get('e1'), { acceptedJobs: 3, lastAcceptedAt: days(-2) }, 'dispatch and owner-assigned accepts both count, each job once');
  assert.deepEqual(history.get('e2'), { acceptedJobs: 0, lastAcceptedAt: null });
  await assert.rejects(loadJobHistory(fake(true), ['e1']), /could not be read/, 'a failed read never looks like "no jobs"');
  console.log('PASS job history: every accept counted once; a failed read throws');
}

// ── The email says why, when, and how to stay ───────────────────────────────
{
  const html = buildInactivityNoticeHtml({ reasons: inactivityReasons(thomas, { acceptedJobs: 0 }, { nowMs: NOW }), deadline: days(14), note: 'Call us <anytime>' });
  assert.match(html, /You have not accepted any jobs/);
  assert.match(html, /section 12\.4/);
  assert.match(html, /your Easer account will be closed\./);
  assert.match(html, /November 12, 2026/, 'the closing date in Central time');
  assert.match(html, /sign the updated contractor agreement, go online, or accept a job/);
  assert.match(html, /Call us &lt;anytime&gt;/, 'the owner note is escaped');
  console.log('PASS notice email: reasons, the 12.4 date, how to keep the account');
}

// ── Wiring ──────────────────────────────────────────────────────────────────
{
  const update = await read('api/assembler/update.js');
  assert.match(update, /if \(action === 'inactivity_notice'\)/);
  assert.ok(update.indexOf("if (!sent?.ok || sent?.suppressed)") < update.indexOf("eventType: 'easer_inactivity_notice'"),
    'the notice is recorded only after the email went out');
  assert.match(update, /code: 'INACTIVITY_NOTICE_OPEN'/, 'no second notice while one is open');
  assert.match(update, /code: 'EASER_NOT_INACTIVE'/);
  const list = await read('api/assembler/list.js');
  assert.match(list, /inactivity: inactivityFor\(profile\),/);
  const dash = await read('owner/index.html');
  assert.match(dash, /action: 'inactivity_notice', note: note/);
  assert.match(dash, /n && n\.status === 'ended'[\s\S]{0,400}deactivateFromDetail/, 'Close account is offered when the notice ends');
  assert.match(dash, /inactivityTag\(a\) \+ '<\/td>'/, 'the roster shows who is inactive');
  console.log('PASS wiring: owner action, roster, Easer detail');
}

console.log('\nEaser inactivity tests passed.');
