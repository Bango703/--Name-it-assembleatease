#!/usr/bin/env node

/**
 * The only guard in this repo that catches a DATA condition rather than code.
 *
 * Every other check is static: it reads source and fails a build. None of them
 * can see a row that quietly stopped agreeing with Stripe. Two did:
 *
 *   AAE-MPBUPWVA   DB said captured $153.00  ·  Stripe said $0.00 received
 *   AAE-LYTX3WIQW3 DB said refund $0.00      ·  Stripe said $32.94 refunded
 *
 * Found by hand — months and hours late. Both were plainly visible to anyone who
 * asked Stripe. So now something asks, daily.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const src = await fs.readFile(new URL('../api/cron/stripe-reconciliation.js', import.meta.url), 'utf8');

// ── It checks the four ways money can disagree ──────────────────────────────
{
  assert.ok(/CRON_SECRET/.test(src), 'the cron must authenticate');
  for (const kind of [
    'captured_but_stripe_received_nothing',  // AAE-MPBUPWVA
    'captured_amount_mismatch',
    'refund_mismatch',                       // AAE-LYTX3WIQW3
    'authorization_still_held',
  ]) {
    assert.ok(src.includes(kind), `${kind} must be detected`);
  }
  assert.ok(/amount_received/.test(src) && /amount_refunded/.test(src),
    'it must read Stripe\'s own figures, not our mirror of them');
  console.log('PASS all four money disagreements are detected');
}

// ── It NEVER writes ─────────────────────────────────────────────────────────
{
  // A cron silently rewriting money because it believed an API is far worse than
  // a disagreement someone can see. Stripe is truth; a human decides the repair.
  assert.ok(!/\.update\(/.test(src), 'reconciliation must never update a booking');
  assert.ok(!/\.insert\(/.test(src), 'reconciliation must never insert');
  assert.ok(!/\.upsert\(/.test(src), 'reconciliation must never upsert');
  assert.ok(!/stripe\.refunds\.create|stripe\.paymentIntents\.(capture|cancel)/.test(src),
    'reconciliation must never move money in Stripe either');
  assert.ok(/Nothing was changed/.test(src),
    'the alert must say plainly that nothing was repaired automatically');
  console.log('PASS reconciliation only reports — it can never write or move money');
}

// ── Zero tolerance, and the owner is told ───────────────────────────────────
{
  assert.ok(/TOLERANCE_CENTS = 0/.test(src),
    'money either matches or it does not — a tolerance band hides real drift');
  assert.ok(/recipientType: 'owner'/.test(src), 'a disagreement must reach the owner');
  assert.ok(/disableDedupe: true/.test(src),
    'a daily reconciliation must never be collapsed into an earlier one');
  console.log('PASS mismatches are exact, and always reach the owner');
}

// ── Scheduled, or it never runs ─────────────────────────────────────────────
{
  const vercel = JSON.parse(await fs.readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
  const job = (vercel.crons || []).find(c => c.path === '/api/cron/stripe-reconciliation');
  assert.ok(job, 'an unscheduled reconciler never runs — which is how both bugs survived');
  console.log(`PASS reconciliation is scheduled (${job.schedule})`);
}

console.log('\nStripe reconciliation tests passed.');
