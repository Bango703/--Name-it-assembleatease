import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describeDispatchPaymentBlock } from '../api/_source-of-truth.js';

const read = rel => readFile(new URL(`../${rel}`, import.meta.url), 'utf8');
const savedCard = { total_price: 42651, payment_status: 'card_saved', stripe_payment_method_id: 'pm_1' };

// ── The pro the owner chose can accept the job they were given ─────────────
// PR #163 let the owner ASSIGN an advance booking carrying a confirmed saved
// card, but acceptance still demanded the scheduled hold. The pro was assigned,
// told the job was "on hold" when they tried to accept, and stale-booking would
// have unassigned them 24 hours later. Staffing without acceptance is not
// staffing.
assert.equal(describeDispatchPaymentBlock(savedCard, { allowSavedCard: true }), null,
  'the assigned pro must be able to accept a confirmed saved-card job');

// An open dispatch offer still waits for the hold — auto-dispatch never offers
// a card_saved booking, and this keeps it that way if one ever leaked through.
const offerBlock = describeDispatchPaymentBlock(savedCard);
assert.ok(offerBlock, 'a dispatch offer must still require the hold');
assert.equal(offerBlock.code, 'CARD_SAVED_AWAITING_AUTHORIZATION');

// Genuinely unpaid work is still refused on BOTH paths.
for (const status of ['pending', 'failed', 'not_required']) {
  const b = { ...savedCard, payment_status: status };
  assert.ok(describeDispatchPaymentBlock(b, { allowSavedCard: true }),
    `${status} must never be acceptable, even for the assigned pro`);
}

// ── The accept route asks the right question ───────────────────────────────
const acceptSrc = await read('api/booking/accept-dispatch.js');
assert.match(acceptSrc, /describeDispatchPaymentBlock\(booking, \{ allowSavedCard: isAssignment \}\)/,
  'the saved-card allowance must be scoped to the assignment path, never to open offers');
assert.doesNotMatch(acceptSrc, /!ownerEaserLiveManual && !isBookingPaymentReadyForDispatch\(booking\)/,
  'the accept gate must report which payment problem it hit');
// Ordering: isAssignment must be defined before it is used. This exact mistake
// was caught by lint while writing this change.
assert.ok(acceptSrc.indexOf('const isAssignment') < acceptSrc.indexOf('allowSavedCard: isAssignment'),
  'isAssignment must be declared before the payment check reads it');

// ── The browser must not invent a cause the server did not give ────────────
const ui = await read('assembler/my-assignments.html');
assert.doesNotMatch(ui, /r\.status === 409 \? 'This job was just accepted by another Easer\.'/,
  'a 409 is not proof another Easer took the job — show the server reason (Article 16)');
assert.match(ui, /const msg = d\.error \|\| 'Could not accept/,
  'the accept failure must surface the server message');

// ── Accepting a job resolves the manual-assignment flag ────────────────────
// AAE-DVSNHXE4OO sat on the owner board reading "Needs manual assignment" with
// an Easer already on it. expire-offers had flagged it manual, then the Easer
// accepted a still-live offer — and the accept route, alone among the write
// paths, never cleared the flag. Every other path (assign, dispatch, drop-job,
// release-assignment, reschedule, cancel, _dispatch-safety) clears it.
assert.match(acceptSrc, /needs_manual_dispatch: false/,
  'accepting a job must clear needs_manual_dispatch — an accepted job is not awaiting assignment');

// ── The owner board must not label an assigned job as unassigned ───────────
// Article 16: the flag alone is not proof. ops-alert already pairs it with
// assembler_id; both owner render sites now ask the same question.
const ownerUi = await read('owner/index.html');
for (const [pattern, where] of [
  [/b\.needs_manual_dispatch && !b\.assembler_id/, 'the booking card badge'],
  [/booking\.needs_manual_dispatch && !booking\.assembler_id/, 'the dispatch-log control bar'],
]) {
  assert.match(ownerUi, pattern,
    `${where} must check assembler_id before claiming a job needs manual assignment`);
}

console.log('owner-assigned acceptance tests: PASS');
