// Applicants who stop at identity verification get followed up, and nothing
// ever marks them verified except Stripe (owner, 2026-11-20).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  IDENTITY_FOLLOWUP_DAYS,
  buildIdentityFollowupEmail,
  buildIdentityFollowupSms,
  identityActivityAnchorMs,
  identityFollowupStage,
  isAwaitingIdentity,
  nextIdentityFollowup,
} from '../api/_identity-followup.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
let passed = 0;
const check = (name, fn) => { fn(); passed += 1; console.log(`  ok  ${name}`); };
const DAY = 86400000;
const base = { role: 'assembler', application_status: 'applied', contractor_agreement_signed_at: '2026-11-18T21:31:37Z', identity_verified: false };

check('open applicant with a signed agreement and no verified ID is awaiting identity', () => {
  assert.equal(isAwaitingIdentity(base), true);
  assert.equal(isAwaitingIdentity({ ...base, application_status: 'waitlist' }), true);
});
check('verified, rejected, closed or unsigned profiles are left alone', () => {
  assert.equal(isAwaitingIdentity({ ...base, identity_verified: true }), false);
  assert.equal(isAwaitingIdentity({ ...base, application_status: 'rejected' }), false);
  assert.equal(isAwaitingIdentity({ ...base, application_status: 'approved' }), false);
  assert.equal(isAwaitingIdentity({ ...base, account_closure_status: 'closed' }), false);
  assert.equal(isAwaitingIdentity({ ...base, contractor_agreement_signed_at: null }), false);
});
check('stage comes from Stripe: none, quit, processing, verified, unreadable', () => {
  assert.equal(identityFollowupStage(base, null), 'not_started');
  const withSession = { ...base, stripe_identity_session_id: 'vs_123' };
  assert.equal(identityFollowupStage(withSession, { status: 'requires_input', last_error: { code: 'abandoned' } }), 'started_not_finished');
  assert.equal(identityFollowupStage(withSession, { status: 'canceled' }), 'started_not_finished');
  assert.equal(identityFollowupStage(withSession, { status: 'processing' }), 'in_review');
  assert.equal(identityFollowupStage(withSession, { status: 'verified' }), 'verified_unrecorded');
  assert.equal(identityFollowupStage(withSession, null, { sessionLookupFailed: true }), 'unknown');
});
check('reminders fall on days 1, 3 and 7 after the last ID activity, then stop', () => {
  assert.deepEqual([...IDENTITY_FOLLOWUP_DAYS], [1, 3, 7]);
  const anchor = Date.parse('2026-11-18T21:33:00Z');
  assert.equal(nextIdentityFollowup({ anchorMs: anchor, sentCount: 0, nowMs: anchor + 0.5 * DAY }), null);
  assert.deepEqual(nextIdentityFollowup({ anchorMs: anchor, sentCount: 0, nowMs: anchor + 1 * DAY }), { number: 1, isLast: false });
  assert.equal(nextIdentityFollowup({ anchorMs: anchor, sentCount: 1, nowMs: anchor + 2 * DAY }), null);
  assert.deepEqual(nextIdentityFollowup({ anchorMs: anchor, sentCount: 1, nowMs: anchor + 3 * DAY }), { number: 2, isLast: false });
  assert.deepEqual(nextIdentityFollowup({ anchorMs: anchor, sentCount: 2, nowMs: anchor + 8 * DAY }), { number: 3, isLast: true });
  assert.equal(nextIdentityFollowup({ anchorMs: anchor, sentCount: 3, nowMs: anchor + 30 * DAY }), null);
});
check('an applicant who stalled weeks ago gets the reminders spaced 2 then 4 days apart, never on consecutive days', () => {
  const anchor = Date.parse('2026-10-01T12:00:00Z');
  const now = Date.parse('2026-11-22T15:17:00Z');
  assert.deepEqual(nextIdentityFollowup({ anchorMs: anchor, sentCount: 0, nowMs: now }), { number: 1, isLast: false });
  assert.equal(nextIdentityFollowup({ anchorMs: anchor, sentCount: 1, lastSentMs: now, nowMs: now + 1 * DAY }), null, 'not the next day');
  assert.deepEqual(nextIdentityFollowup({ anchorMs: anchor, sentCount: 1, lastSentMs: now, nowMs: now + 2 * DAY }), { number: 2, isLast: false });
  assert.equal(nextIdentityFollowup({ anchorMs: anchor, sentCount: 2, lastSentMs: now + 2 * DAY, nowMs: now + 5 * DAY }), null, 'not three days later');
  assert.deepEqual(nextIdentityFollowup({ anchorMs: anchor, sentCount: 2, lastSentMs: now + 2 * DAY, nowMs: now + 6 * DAY }), { number: 3, isLast: true });
});
check('the anchor moves forward when the applicant opens a new ID session', () => {
  const session = { created: Date.parse('2026-11-20T10:00:00Z') / 1000 };
  assert.equal(identityActivityAnchorMs(base, session), Date.parse('2026-11-20T10:00:00Z'));
  assert.equal(identityActivityAnchorMs(base, null), Date.parse(base.contractor_agreement_signed_at));
});
check('applicant copy names no processor, session or system term (seat 15)', () => {
  const esc = (s) => String(s);
  for (const stage of ['not_started', 'started_not_finished']) {
    const { subject, html } = buildIdentityFollowupEmail({ fullName: 'Pat Doe', stage, url: 'https://www.assembleatease.com/assembler/verify-identity?token=t', esc });
    const sms = buildIdentityFollowupSms({ stage, url: 'https://x.test/v' });
    for (const text of [subject, html, sms]) {
      assert.doesNotMatch(text, /stripe|session|webhook|requires_input|abandoned|pending|status/i, text);
    }
    assert.match(html, /The AssembleAtEase Team/);
    assert.doesNotMatch(html, /Travis/);
    assert.ok(sms.length <= 160, `sms is ${sms.length} characters`);
  }
});
check('the cron is scheduled, CRON_SECRET-protected, keyed once per reminder and never writes verification', () => {
  const vercel = JSON.parse(read('vercel.json'));
  assert.ok(vercel.crons.some(c => c.path === '/api/cron/identity-followup'), 'cron registered in vercel.json');
  const src = read('api/cron/identity-followup.js');
  assert.match(src, /process\.env\.CRON_SECRET/);
  assert.match(src, /notificationKey/);
  assert.doesNotMatch(src, /identity_verified:\s*true/);
  assert.doesNotMatch(src, /id_verification_status:\s*'verified'/);
});

console.log(`identity follow-up: ${passed} checks passed`);
