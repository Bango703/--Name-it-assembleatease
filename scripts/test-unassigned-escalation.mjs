#!/usr/bin/env node

/**
 * A customer must never pay for our failure to staff their job, and must never
 * find out about it by watching the clock run down.
 *
 * WHAT HAPPENED (AAE-LYTX3WIQW3)
 * Booked the night before for a 12:00–2:00 PM window. Assigned three times,
 * accepted by nobody. Still unstaffed when it was flagged manual_required. At
 * 18:36 UTC — twenty-three minutes before her window closed — the CUSTOMER
 * cancelled it herself and was charged $32.94.
 *
 * The owner was alerted four times. The customer was told nothing.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { computeCancellationFee } from '../api/_source-of-truth.js';

// ── THE INVARIANT: no accepted Easer, no fee ────────────────────────────────
{
  // Her exact situation: inside the imminent window, nobody ever accepted.
  const hers = computeCancellationFee({
    serviceSubtotalCents: 21952, hoursUntilAppointment: 0.4, status: 'confirmed',
  });
  assert.equal(hers.feeCents, 0, 'a customer must never be charged when no Easer accepted');
  assert.equal(hers.tier, 'free');
  assert.equal(hers.waivedReason, 'no_easer_accepted', 'the waiver must state its reason');

  // Assignment is NOT commitment. That booking carried an assembler_id at points
  // and still nobody was coming — so the test is acceptance, not assignment.
  assert.equal(
    computeCancellationFee({ serviceSubtotalCents: 20000, hoursUntilAppointment: 0.1, status: 'confirmed', easerAccepted: false }).feeCents,
    0, 'an assignment nobody accepted must not create a fee');

  // Fail-safe: a caller that forgets the flag must not charge.
  assert.equal(
    computeCancellationFee({ serviceSubtotalCents: 20000, status: 'en_route' }).feeCents,
    0, 'omitting easerAccepted must fail toward NOT charging');
  console.log('PASS no accepted Easer means no cancellation fee, and omission fails safe');
}

// ── Legitimate fees are untouched ───────────────────────────────────────────
{
  const A = { serviceSubtotalCents: 20000, easerAccepted: true };
  assert.equal(computeCancellationFee({ ...A, hoursUntilAppointment: 0.4 }).feeCents, 3000, 'imminent');
  assert.equal(computeCancellationFee({ ...A, status: 'en_route' }).feeCents, 3000, 'pro already travelling');
  assert.equal(computeCancellationFee({ ...A, hoursUntilAppointment: 8 }).feeCents, 2000, 'late tier');
  assert.equal(computeCancellationFee({ ...A, hoursUntilAppointment: 30 }).feeCents, 0, 'free window');
  assert.equal(computeCancellationFee({ ...A, isNoShow: true }).feeCents, 3000, 'customer no-show');
  console.log('PASS every legitimate cancellation fee still applies exactly as before');
}

// ── Every cancel path supplies the fact ─────────────────────────────────────
{
  for (const f of ['cancel.js', 'customer-cancel.js', 'guest-cancel.js']) {
    const src = await fs.readFile(new URL(`../api/booking/${f}`, import.meta.url), 'utf8');
    assert.ok(/easerAccepted: Boolean\(booking\.assembler_id && booking\.assembler_accepted_at\)/.test(src),
      `${f} must pass easerAccepted, or it silently waives every fee`);
  }
  console.log('PASS all three cancellation paths supply the acceptance fact');
}

// ── The customer is told before their window ────────────────────────────────
{
  const src = await fs.readFile(new URL('../api/cron/unassigned-escalation.js', import.meta.url), 'utf8');
  assert.ok(/CRON_SECRET/.test(src), 'the cron must authenticate');
  assert.ok(/\.is\('assembler_accepted_at', null\)/.test(src),
    'it must scan on ACCEPTANCE — assignment is not commitment');
  assert.ok(/recipientType: 'customer'/.test(src),
    'the CUSTOMER must be notified; owner alerts already existed and were not enough');
  assert.ok(/neither costs you anything/i.test(src), 'the customer must be told it is free');
  assert.ok(/no cancellation fee/i.test(src), 'the free cancellation must be stated explicitly');

  // It must never cancel on the customer's behalf.
  assert.ok(!/status: 'cancelled'/.test(src) && !/cancelled_at:/.test(src),
    'the cron must never cancel a booking itself — the customer may still want the work');

  // Two overlapping runs must not email the customer twice.
  assert.ok(/\.is\('unassigned_customer_notified_at', null\)/.test(src),
    'the customer notice must be claimed compare-and-set');
  console.log('PASS the customer is told before their window, free of charge, and never cancelled on');
}

// ── Scheduled, or none of it runs ───────────────────────────────────────────
{
  const vercel = JSON.parse(await fs.readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
  const job = (vercel.crons || []).find(c => c.path === '/api/cron/unassigned-escalation');
  assert.ok(job, 'an unscheduled cron never runs');
  assert.equal(job.schedule, '*/15 * * * *');
  console.log('PASS the escalation is scheduled every 15 minutes');
}

console.log('\nUnassigned escalation tests passed.');
