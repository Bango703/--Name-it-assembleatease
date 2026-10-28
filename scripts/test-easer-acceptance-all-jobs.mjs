#!/usr/bin/env node
// Owner, 2026-10-28: an Easer's numbers must count every job, whether it came
// by dispatch or the owner assigned it. Phil (Houston) had 3 completed jobs, all
// owner-assigned, and an Acceptance Rate of "—" because only dispatch offers
// were counted; Active Jobs Today read a nightly counter, not his open work.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  tallyAcceptance, acceptanceRateFor, isNonOfferAcceptLog, loadAcceptanceTallies,
  ACCEPTANCE_MIN_DECISIONS,
} from '../api/_easer-acceptance.js';
import { loadOpenWork, workActivityFor } from '../api/_easer-work-activity.js';

const read = rel => readFile(new URL(`../${rel}`, import.meta.url), 'utf8').then(s => s.replace(/\r\n/g, '\n'));

// ── Every decision counts once, whatever path it came by ─────────────────────
{
  const tallies = tallyAcceptance({
    offers: [
      { easer_id: 'phil', offer_status: 'accepted' },
      { easer_id: 'phil', offer_status: 'declined' },
      { easer_id: 'luis', offer_status: 'expired' },
    ],
    acceptLogs: [
      { actor_id: 'phil', metadata: { decision: 'owner_assignment' } },
      { actor_id: 'phil', metadata: { tier: 'starter' } },               // before tagging: owner assignment
      { actor_id: 'phil', metadata: { decision: 'dispatch_offer', attempt: 1 } }, // already in dispatch_offers
      { actor_id: 'phil', metadata: { attempt: 2, score: 80 } },          // untagged offer accept
      { actor_id: 'luis', metadata: { decision: 'dispatch_token' } },
    ],
    declineLogs: [{ actor_id: 'phil' }],
  });
  assert.deepEqual(tallies.get('phil'), { accepted: 3, declined: 2, expired: 0, total: 5 },
    'offers, owner assignments and their declines all count; offer accepts are not counted twice');
  assert.deepEqual(tallies.get('luis'), { accepted: 1, declined: 0, expired: 1, total: 2 });
  assert.equal(acceptanceRateFor(tallies.get('phil')), 60);
  assert.equal(acceptanceRateFor(tallies.get('luis')), null, `fewer than ${ACCEPTANCE_MIN_DECISIONS} decisions is not yet a rate`);
  assert.equal(acceptanceRateFor(undefined), null);
  assert.equal(isNonOfferAcceptLog({ metadata: null }), true);
  console.log('PASS every offered job counts once: dispatch offers, owner assignments, declines');
}

// ── Both sources are read, across pages ─────────────────────────────────────
{
  const offers = Array.from({ length: 1001 }, () => ({ easer_id: 'phil', offer_status: 'accepted' }));
  const sources = {
    dispatch_offers: offers,
    easer_accepted: [{ actor_id: 'phil', metadata: { decision: 'owner_assignment' } }],
    assignment_declined: [{ actor_id: 'phil' }],
  };
  const fake = {
    from(table) {
      let key = table;
      const q = {
        select() { return q; }, gte() { return q; }, in() { return q; }, not() { return q; }, order() { return q; },
        eq(col, value) { if (col === 'event_type') key = value; return q; },
        range(from, to) { return Promise.resolve({ data: sources[key].slice(from, to + 1), error: null }); },
      };
      return q;
    },
  };
  const { tallies, error } = await loadAcceptanceTallies(fake, '2026-09-28T00:00:00.000Z');
  assert.equal(error, null);
  assert.deepEqual(tallies.get('phil'), { accepted: 1002, declined: 1, expired: 0, total: 1003 }, 'more than one page of offers is read');
  console.log('PASS dispatch offers and owner-assignment decisions are both loaded, past the 1000-row page');
}

// ── Open work is read from bookings, return visits on their own date ────────
{
  const rows = [
    { assembler_id: 'phil', date: '2026-10-25', assembler_accepted_at: 'x', return_visit_required: true, return_visit_date: '2026-10-28' },
    { assembler_id: 'phil', date: '2026-10-30', assembler_accepted_at: null, return_visit_required: false, return_visit_date: null },
    { assembler_id: 'luis', date: '2026-10-28', assembler_accepted_at: 'x', return_visit_required: false, return_visit_date: null },
  ];
  const fake = { from() { const q = { select() { return q; }, in() { return q; }, not() { return Promise.resolve({ data: rows, error: null }); } }; return q; } };
  const work = await loadOpenWork(fake, '2026-10-28');
  assert.deepEqual(work.get('phil'), { openJobs: 2, awaitingAcceptance: 1, jobsToday: 1 },
    'a job assigned days ago with a return visit today is open and today');
  assert.deepEqual(work.get('luis'), { openJobs: 1, awaitingAcceptance: 0, jobsToday: 1 });
  const none = workActivityFor('nobody', work, new Map());
  assert.equal(none.openJobs, 0);
  assert.deepEqual({ ...none.acceptance, rate: none.acceptance.rate }, { accepted: 0, declined: 0, expired: 0, total: 0, rate: null, windowDays: 30, minDecisions: 3 });
  const unknown = workActivityFor('phil', null, null);
  assert.equal(unknown.openJobs, null, 'unreadable bookings are unknown, never a confident 0');
  assert.equal(unknown.acceptance, null);
  assert.equal(unknown.acceptanceAllTime, null);
  // Phil on 2026-10-28: one decision in the last 30 days, four overall.
  const phil = workActivityFor('phil', work,
    new Map([['phil', { accepted: 1, declined: 0, expired: 0, total: 1 }]]),
    new Map([['phil', { accepted: 4, declined: 0, expired: 0, total: 4 }]]));
  assert.equal(phil.acceptance.rate, null, 'one recent decision is not yet a 30-day rate');
  assert.deepEqual(phil.acceptanceAllTime, { accepted: 4, declined: 0, expired: 0, total: 4 }, 'the whole record is shown beside it');
  const failing = { from() { const q = { select() { return q; }, in() { return q; }, not() { return Promise.resolve({ data: null, error: { message: 'down' } }); } }; return q; } };
  const origError = console.error; console.error = () => {};
  assert.equal(await loadOpenWork(failing, '2026-10-28'), null);
  console.error = origError;
  console.log('PASS open jobs and jobs today come from bookings; a return visit counts on its own date');
}

// ── The writers record who decided ──────────────────────────────────────────
{
  const decline = await read('api/booking/decline-dispatch.js');
  const block = decline.slice(decline.indexOf("eventType: 'assignment_declined'"), decline.indexOf("eventType: 'assignment_declined'") + 700);
  assert.match(block, /actorType: 'easer',\s*\n\s*actorId: user\.id,/, 'an owner-assigned decline is saved with the Easer as actor');
  assert.doesNotMatch(block, /\bactor: 'easer'/, 'logActivity has no `actor` field');
  const accept = await read('api/booking/accept-dispatch.js');
  assert.match(accept, /decision: 'dispatch_offer',/);
  assert.match(accept, /decision: isAssignment \? 'owner_assignment' : 'dispatch_token',/);
  console.log('PASS accepts are tagged by path; owner-assigned declines name the Easer');
}

// ── The nightly rate and the dashboard read the same count ──────────────────
{
  const cron = await read('api/cron/tier-check.js');
  assert.match(cron, /loadAcceptanceTallies\(sb, acceptanceWindowStart\(nowMs\)\)/);
  assert.match(cron, /\.from\('profiles'\)\.select\('id, acceptance_rate'\)\.eq\('role', 'assembler'\)/,
    'every Easer is written, so a rate from an older window is cleared');
  assert.doesNotMatch(cron, /rates\[o\.easer_id\]/, 'the dispatch-only tally is gone');
  const list = await read('api/assembler/list.js');
  assert.match(list, /workActivity: workActivityFor\(profile\.id, workByEaser, acceptance\.tallies, acceptanceAllTime\.tallies\)/);
  assert.match(list, /loadAcceptanceTallies\(sb, new Date\(0\)\.toISOString\(\)\)/, 'the all-time count reads from the beginning');
  const owner = await read('owner/index.html');
  assert.match(owner, /<strong>Open jobs:<\/strong>/);
  assert.match(owner, /<strong>Jobs today:<\/strong>/);
  assert.match(owner, /<strong>Acceptance \(' \+ \(acc \? acc\.windowDays : 30\) \+ ' days\):<\/strong>/);
  assert.match(owner, /<strong>Acceptance \(all time\):<\/strong>/);
  assert.doesNotMatch(owner, /Active Jobs Today/, 'the nightly counter is no longer shown as current work');
  console.log('PASS the tier job and the owner dashboard count the same decisions');
}

console.log('\nEaser acceptance and work activity tests passed.');
