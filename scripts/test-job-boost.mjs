#!/usr/bin/env node
// Job boost (owner, 2026-11-21, AAE-WEIDRMMJRZ): the owner can add pay to a job
// BEFORE anyone accepts it, the offer shows it, it stays with the job, and it is
// capped where the platform would start losing money on that job. The customer's
// price never changes. Runs the real bonus endpoint with its imports replaced by
// local fakes (no database, no email, no network).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import {
  EASER_BONUS_POLICY, computeBookingSplitFromSnapshot, easerBonusCents, easerPayoutDueCents, maxEaserBonusCents,
} from '../api/_source-of-truth.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
let passed = 0;
async function check(name, fn) { await fn(); passed += 1; console.log(`  ok  ${name}`); }

// The real job: $383.21 charged, $29.21 tax, Easer split $247.80, no Easer yet.
const houston = { id: 'b1', ref: 'AAE-WEIDRMMJRZ', service: 'Outdoor & Playsets', status: 'confirmed', total_price: 38321, tax_amount: 2921, payout_status: 'pending', easer_bonus_cents: 0, assembler_id: null };

await check('the cap is what the platform keeps after tax, the Stripe fee and the Easer split', () => {
  // 38321 - 2921 tax - (round(38321*0.029)+30 = 1141) Stripe - 24780 split = 9479
  assert.equal(maxEaserBonusCents(houston), 9479);
  assert.equal(maxEaserBonusCents({ ...houston, stripe_fee: 1200 }), 9420, 'a recorded Stripe fee wins over the estimate');
  assert.equal(maxEaserBonusCents({ ...houston, easer_reimbursement_cents: 2000 }), 7479, 'a reimbursement uses up margin too');
  assert.equal(maxEaserBonusCents({ ...houston, total_price: 0, tax_amount: 0 }), 0, 'an unpriced job carries no bonus');
  assert.ok(maxEaserBonusCents({ ...houston, assembler_due: 36000 }) >= 0, 'never negative');
  assert.equal(EASER_BONUS_POLICY.minPlatformNetCents, 0);
  assert.deepEqual([...EASER_BONUS_POLICY.statuses], ['confirmed', 'en_route', 'arrived', 'in_progress', 'completed']);
});
await check('the bonus is paid with the job and void on a cancellation', () => {
  assert.equal(easerBonusCents({ easer_bonus_cents: 4000 }), 4000);
  assert.equal(easerBonusCents({ easer_bonus_cents: -5 }), 0);
  assert.equal(easerPayoutDueCents({ status: 'completed', assembler_due: 24780, easer_bonus_cents: 4000 }), 28780);
  assert.equal(easerPayoutDueCents({ status: 'cancelled', cancellation_easer_due_cents: 0, easer_bonus_cents: 4000 }), 0);
});

// ── The real endpoint ───────────────────────────────────────────────────────
async function loadHandler(deps) {
  const source = read('api/owner/easer-bonus.js')
    .replace(/^import[\s\S]*?;\n/gm, '')
    .replace('export default async function handler', 'async function handler');
  return vm.runInNewContext(`${source}\nhandler`, { ...deps, console: { error() {} } }, { filename: 'easer-bonus.js' });
}
async function call(booking, body) {
  const updates = [];
  const emails = [];
  const audits = [];
  const sb = {
    from(table) {
      if (table === 'profiles') {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { email: 'phil@example.com', full_name: 'Phil Hawkins' }, error: null }) }) }) };
      }
      assert.equal(table, 'bookings');
      const q = {
        select() { return q; }, eq() { return q; }, not() { return q; },
        maybeSingle: async () => ({ data: booking ? { ...booking } : null, error: null }),
        update(values) { updates.push(values); return { eq: () => ({ not: async () => ({ error: null }) }) }; },
      };
      return q;
    },
  };
  const handler = await loadHandler({
    getSupabase: () => sb,
    verifyOwner: () => true,
    sendEmail: async (args) => { emails.push(args); return { ok: true }; },
    ownerEmail: () => 'owner@example.com',
    esc: (v) => String(v ?? ''),
    logActivity: async () => {},
    writeFinancialAudit: async (_sb, args) => { audits.push(args); },
    EASER_BONUS_POLICY, computeBookingSplitFromSnapshot, maxEaserBonusCents,
  });
  const res = { statusCode: 0, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  await handler({ method: 'POST', headers: {}, body }, res);
  return { res, updates, emails, audits };
}

await check('a bonus can be set on a confirmed job nobody has accepted, and no Easer is emailed', async () => {
  const { res, updates, emails, audits } = await call(houston, { bookingId: 'b1', amountCents: 4000, reason: 'Hard-to-fill playset job' });
  assert.equal(res.statusCode, 200);
  assert.equal(updates[0].easer_bonus_cents, 4000);
  assert.equal(res.body.baseDueCents, 24780, 'the split the job pays, before anyone is assigned');
  assert.equal(res.body.totalDueCents, 28780);
  assert.equal(res.body.stage, 'before_acceptance');
  assert.equal(res.body.platformNetAfterCents, 5479);
  assert.equal(res.body.hasEaser, false);
  assert.equal(emails.length, 0, 'nobody to email yet; the offer carries it');
  assert.equal(audits[0].metadata.fundedBy, 'platform_margin');
  assert.equal(audits[0].metadata.stage, 'before_acceptance');
});
await check('more than the job can carry is refused with the real limit', async () => {
  const { res, updates } = await call(houston, { bookingId: 'b1', amountCents: 9500, reason: 'too much' });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'BONUS_ABOVE_MARGIN');
  assert.equal(res.body.maxBonusCents, 9479);
  assert.match(res.body.error, /\$94\.79/);
  assert.equal(updates.length, 0);
});
await check('an assigned Easer is told; a paid payout, an unpaid booking or a cancelled job are refused', async () => {
  let r = await call({ ...houston, assembler_id: 'e1', assembler_name: 'Phil Hawkins', assembler_due: 24780 }, { bookingId: 'b1', amountCents: 3000, reason: 'Thanks for taking it' });
  assert.equal(r.res.statusCode, 200);
  assert.equal(r.emails.length, 1);
  assert.equal(r.emails[0].meta.notificationType, 'easer_bonus_added');
  r = await call({ ...houston, status: 'completed', assembler_id: 'e1', payout_status: 'paid' }, { bookingId: 'b1', amountCents: 3000, reason: 'late' });
  assert.equal(r.res.body.code, 'PAYOUT_ALREADY_SENT');
  for (const status of ['pending', 'cancelled', 'declined', 'refunded']) {
    r = await call({ ...houston, status }, { bookingId: 'b1', amountCents: 3000, reason: 'nope' });
    assert.equal(r.res.body.code, 'NOT_ELIGIBLE', status);
  }
  r = await call({ ...houston, status: 'completed', assembler_id: null }, { bookingId: 'b1', amountCents: 3000, reason: 'nobody' });
  assert.equal(r.res.body.code, 'NO_EASER');
  r = await call(houston, { bookingId: 'b1', amountCents: 3000, reason: '' });
  assert.equal(r.res.body.code, 'BONUS_REASON_REQUIRED');
});

// ── Every place an Easer sees pay shows it ──────────────────────────────────
await check('offers (push, text, email), the Easer app and the assignment email include the bonus', () => {
  const dispatch = read('api/booking/_dispatch-internal.js');
  assert.match(dispatch, /\}\)\.assemblerDueCents \+ easerBonusCents\(booking\)/, 'push and text');
  assert.match(dispatch, /' \(includes a \$' \+ \(bonusCents \/ 100\)\.toFixed\(2\) \+ ' bonus\)'/, 'offer email');
  const mine = read('api/booking/my-assignments.js');
  assert.match(mine, /const estimateDue = split\.assemblerDueCents \+ sdBonus \+ jobBonus;/);
  assert.match(mine, /if \(jobBonus > 0\) b\._bonus_cents = jobBonus;/);
  assert.match(read('api/booking/assign.js'), /feeSnapshot\.estimatedDueCents \+ easerBonusCents\(booking\)/);
  assert.match(read('assembler/my-assignments.html'), /'Includes a ' \+ formatMoneyCents\(b\._bonus_cents\) \+ ' bonus'/);
  assert.match(read('assembler/index.html'), /pay \+= ' incl\. ' \+ fmtPay\(b\._bonus_cents\) \+ ' bonus'/);
});
await check('the owner can set it on any confirmed job, and the customer price is untouched', () => {
  const owner = read('owner/index.html');
  assert.match(owner, /field\('Bonus Pay', \['confirmed','en_route','arrived','in_progress','completed'\]\.indexOf\(b\.status\) === -1/);
  assert.match(owner, /It shows on the offer to whoever takes the job\./);
  const api = read('api/owner/easer-bonus.js');
  assert.doesNotMatch(api, /total_price:\s/, 'the bonus never writes the customer price');
  assert.doesNotMatch(api, /assembler_due:\s/, 'the split stays a pure function of what the customer paid');
});

console.log(`job boost: ${passed} checks passed`);
