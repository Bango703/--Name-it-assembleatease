#!/usr/bin/env node

/**
 * payout.paid must actually find the booking it belongs to.
 *
 * WHAT WAS WRONG
 * getPayoutTransferIds resolved a connected-account payout back to our transfer
 * ids by matching balance transactions of type 'transfer' with a tr_… source.
 * On a DESTINATION account that combination never occurs: money arriving from
 * the platform lands as type 'payment' whose source is a charge (py_…), and only
 * the expanded charge carries source_transfer — the tr_… we store on the booking.
 * On a connected account 'transfer' means funds leaving to somewhere else.
 *
 * So the lookup returned [] for every real payout, payout.paid was ignored with
 * reason 'no_matching_transfers', and NO Easer was ever marked paid. Verified on
 * production: Trapper Riney's $419.30 reached his bank on 2026-09-02
 * (po_1UB1vtC2OdFrNHP6IUwFpwXI, status=paid) while the booking still read
 * stripe_bank_payout_status='pending' and the owner dashboard showed
 * "Processing bank payout" with PAID $0.00.
 *
 * That is a Rule 5 violation — the database disagreeing with Stripe about money
 * that has already moved.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const src = await fs.readFile(new URL('../api/assembler/stripe-webhook.js', import.meta.url), 'utf8');
const fn = src.slice(src.indexOf('export async function getPayoutTransferIds'));
const body = fn.slice(0, fn.indexOf('\n}') + 2);

// ── The expansion the linkage depends on ───────────────────────────────────
{
  assert.ok(/expand:\s*\['data\.source'\]/.test(body),
    "balance transactions must expand data.source — an unexpanded source is a bare string and source_transfer is unreachable");
  console.log('PASS the payout lookup expands data.source');
}

// ── Incoming money is 'payment', not 'transfer' ────────────────────────────
{
  assert.ok(/transaction\.type === 'payment'/.test(body),
    "must match type 'payment' — that is how a platform transfer appears on the destination account");
  assert.ok(/source\?\.source_transfer|source\.source_transfer/.test(body),
    'must read source_transfer to recover the tr_ id stored on the booking');
  console.log("PASS type 'payment' is resolved through source_transfer");
}

// ── The old-only behaviour must not come back ──────────────────────────────
{
  const matchesTransfer = /transaction\.type === 'transfer'/.test(body);
  const matchesPayment = /transaction\.type === 'payment'/.test(body);
  assert.ok(!(matchesTransfer && !matchesPayment),
    "matching only type 'transfer' is the exact bug: it finds nothing on a destination account");
  console.log("PASS matching 'transfer' alone can no longer be the whole rule");
}

// ── The handler still refuses to guess ─────────────────────────────────────
// Marking payouts paid account-wide or by timestamp would mark unrelated
// earnings paid whenever Stripe excludes funds from a payout.
{
  const handler = src.slice(src.indexOf("case 'payout.paid'"), src.indexOf("case 'payout.failed'"));
  assert.ok(/no_matching_transfers/.test(handler),
    'an unresolvable payout must be recorded as ignored with its reason, not guessed at');
  assert.ok(/\.in\('stripe_transfer_id', transferIds\)/.test(handler),
    'only bookings whose transfer is actually in this payout may be marked paid');
  assert.ok(/\.eq\('stripe_destination_account_id', connectedAccount\)/.test(handler),
    'the update must be scoped to the connected account that was paid');
  assert.ok(/\.eq\('payout_status', 'transferred'\)/.test(handler),
    'only a transferred payout can become paid');
  console.log('PASS only bookings genuinely inside the payout are marked paid');
}

// -- The arrival date stops being a guess once Stripe knows -----------------
// We estimate arrival at transfer time by counting business days, because the
// payout does not exist yet. That estimate was wrong by two days on the first
// real payout: the Easer was told Friday 2026-09-04, the money landed Wednesday
// 2026-09-02. payout.created is the moment Stripe publishes the real date.
{
  const start = src.indexOf("case 'payout.created'");
  const end = src.indexOf("case 'payout.paid'");
  assert.ok(start > 0 && end > start, 'payout.created must be handled, or the estimate is never corrected');
  const created = src.slice(start, end);
  assert.ok(/expected_bank_arrival_at: arrivalIso/.test(created),
    "payout.created must replace the estimate with Stripe's real arrival_date");
  assert.ok(!/payout_status:/.test(created),
    'a SCHEDULED payout must never advance payout_status - only paid does that');
  assert.ok(/\.in\('stripe_transfer_id', transferIds\)/.test(created)
    && /\.eq\('stripe_destination_account_id', connectedAccount\)/.test(created),
    'the correction must be scoped exactly like payout.paid');
  console.log('PASS payout.created replaces the estimated arrival date, and advances nothing else');
}

// -- payout.paid records what actually happened -----------------------------
{
  const paid = src.slice(src.indexOf("case 'payout.paid'"), src.indexOf("case 'payout.failed'"));
  assert.ok(/stripe_bank_payout_id: payout\.id/.test(paid),
    'the payout id must be stored, or the booking cannot be traced back to Stripe');
  assert.ok(/paidArrivalIso \|\| nowIso/.test(paid),
    "Stripe's arrival_date must win over our clock: the webhook can land hours after the money did");
  console.log("PASS payout.paid stores the payout id and prefers Stripe's arrival date");
}

console.log('\nConnect payout.paid linkage tests passed.');
