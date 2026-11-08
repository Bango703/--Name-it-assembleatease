#!/usr/bin/env node
// A custom quote is not a job until the customer approves it.
//
// 2026-10-28: Tyler Finn asked for a Smart Home quote for "today 2-4 PM" in
// Overton (outside the automatic-dispatch area). The owner was emailed that a
// $353.98 "paid-intent booking" had sat unassigned 56 minutes and that
// "automatic dispatch gave up", and twice that a job today had no Pro. None of
// it was true: no card, no hold, no offer, and dispatch never ran. $353.98 was
// the preliminary cart estimate; the owner's quote was $650. The quote was also
// still approvable after its requested time had passed, which would have
// confirmed a past appointment and sent it to Easers.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isOpenCustomQuote, quoteSlotStillOpen, normalizeQuoteSlot } from '../api/booking/_quote-state.js';
import { isStranded, strandedReason } from '../api/_stranded-bookings-core.js';
import { classifyOpsIssue } from '../api/cron/ops-alert.js';
import { buildApprovalPage } from '../api/owner/quote-approve.js';

const read = rel => readFile(new URL(`../${rel}`, import.meta.url), 'utf8').then(s => s.replace(/\r\n/g, '\n'));

// 2026-10-28 08:50 CDT, when the stranded alert fired.
const NOW = Date.parse('2026-10-28T13:50:00Z');
const tyler = {
  ref: 'AAE-SM4SLTAPFA', status: 'pending', payment_status: 'not_required', payment_method_type: 'card',
  total_price: 35398, needs_manual_dispatch: true, dispatch_status: null, assembler_id: null,
  date: '2026-10-28', time: '2:00 PM – 4:00 PM', created_at: '2026-10-28T12:54:13Z',
};
const quoteSent = { ...tyler, payment_status: 'quote_pending_approval', quote_amount_cents: 65000 };

// ── What a quote is ─────────────────────────────────────────────────────────
{
  for (const b of [tyler, quoteSent, { ...tyler, payment_status: 'quote_authorization_pending' }, { ...tyler, payment_status: 'card_saved' }]) {
    assert.equal(isOpenCustomQuote(b), true, `${b.payment_status} is an open quote`);
  }
  assert.equal(isOpenCustomQuote({ ...tyler, payment_status: 'pending' }), false, 'a priced booking waiting on its card is not a quote');
  assert.equal(isOpenCustomQuote({ ...quoteSent, status: 'confirmed', payment_status: 'authorized' }), false, 'an approved quote is a job');
  assert.equal(isOpenCustomQuote({ ...tyler, status: 'confirmed', payment_status: 'card_saved' }), false, 'a scheduled saved-card booking is a job');
  assert.equal(isOpenCustomQuote({ status: 'pending', payment_status: 'not_required', payment_method_type: null }), false, 'a no-charge booking is not a quote');
  console.log('PASS open quotes: unpriced, sent and mid-approval; priced and confirmed bookings are not quotes');
}

// ── The stranded alert leaves quotes alone; fixed-price bookings unchanged ──
{
  assert.equal(isStranded(tyler, { now: NOW }), false, 'Tyler was not a stranded paid booking');
  assert.equal(isStranded(quoteSent, { now: NOW }), false, 'a sent quote waits on the customer');
  assert.equal(isStranded({ ...tyler, payment_status: 'pending', needs_manual_dispatch: false }, { now: NOW }), true,
    'a fixed-price booking whose card never completed is still caught');
  assert.equal(isStranded({ ...tyler, payment_status: 'failed' }, { now: NOW }), true);
  assert.match(strandedReason({ needs_manual_dispatch: true }), /outside the automatic dispatch area/,
    'a booking outside the dispatch area was never given up on by dispatch');
  assert.doesNotMatch(strandedReason({ needs_manual_dispatch: true }), /gave up/);
  assert.match(strandedReason({ needs_manual_dispatch: true, dispatch_status: 'manual_required' }), /gave up/,
    'dispatch that really ran and stopped still says so');
  console.log('PASS stranded alert: no quotes; unpaid fixed-price bookings still caught; "gave up" only when dispatch ran');
}

// ── ops-alert says what a quote actually needs ──────────────────────────────
{
  const at8 = Date.parse('2026-10-28T13:00:00Z'); // 8:00 AM CDT, the first false alert
  assert.equal(classifyOpsIssue(tyler, { now: at8 }), null, 'six minutes old: nothing yet, and never "no Pro assigned"');
  const later = classifyOpsIssue(tyler, { now: Date.parse('2026-10-28T14:00:00Z') });
  assert.equal(later.sev, 'HIGH');
  assert.equal(later.label, 'Quote request waiting for your price — customer asked for 2026-10-28 2:00 PM – 4:00 PM');
  assert.equal(classifyOpsIssue(quoteSent, { now: Date.parse('2026-10-28T17:00:00Z') }), null,
    'a sent quote whose time is still open is the customer\'s move');
  const passed = classifyOpsIssue(quoteSent, { now: Date.parse('2026-10-28T19:30:00Z') });
  assert.match(passed.label, /requested time .* has passed — resend it with a new date/);
  // Fixed-price bookings keep their alerts.
  const today = classifyOpsIssue({ ...tyler, payment_status: 'pending', needs_manual_dispatch: false }, { now: at8 });
  assert.match(today.label, /^Today at 2:00 PM – 4:00 PM — no Pro assigned/);
  assert.equal(classifyOpsIssue({ status: 'confirmed', needs_manual_dispatch: true, dispatch_status: 'manual_required', date: '2026-11-02' }, { now: at8 }).label,
    'Needs manual assignment (auto-dispatch gave up)');
  assert.equal(classifyOpsIssue({ status: 'confirmed', needs_manual_dispatch: true, dispatch_status: null, date: '2026-11-02' }, { now: at8 }).label,
    'Needs manual assignment (outside the automatic dispatch area)');
  console.log('PASS ops-alert: quotes get their own reminders; fixed-price alerts unchanged');
}

// ── A quote is approved only for a time that can still be staffed ──────────
{
  assert.equal(normalizeQuoteSlot('2:00 PM - 4:00 PM'), '2:00 PM – 4:00 PM');
  assert.equal(quoteSlotStillOpen(quoteSent, new Date('2026-10-28T13:00:00Z')), true, '8 AM: the 2 PM window is 6h away');
  // The same rule a customer meets booking: the same-day lead time applies only
  // while same-day service is on.
  const sameDay = process.env.SAME_DAY_ENABLED;
  delete process.env.SAME_DAY_ENABLED;
  assert.equal(quoteSlotStillOpen(quoteSent, new Date('2026-10-28T18:00:00Z')), true, '1 PM: the 2 PM window has not started');
  assert.equal(quoteSlotStillOpen(quoteSent, new Date('2026-10-28T19:05:00Z')), false, '2:05 PM: the window has started');
  process.env.SAME_DAY_ENABLED = 'true';
  assert.equal(quoteSlotStillOpen(quoteSent, new Date('2026-10-28T18:00:00Z')), false, '1 PM with same-day on: inside the lead time');
  if (sameDay === undefined) delete process.env.SAME_DAY_ENABLED; else process.env.SAME_DAY_ENABLED = sameDay;
  assert.equal(quoteSlotStillOpen(quoteSent, new Date('2026-10-29T15:00:00Z')), false, 'the next day it has passed');
  assert.equal(quoteSlotStillOpen({ ...quoteSent, date: '2026-10-31' }, new Date('2026-10-29T15:00:00Z')), true);
  assert.equal(quoteSlotStillOpen({ ...quoteSent, time: 'Flexible' }, new Date('2026-10-27T15:00:00Z')), false, 'an unpublished window must be set');

  const approve = await read('api/owner/quote-approve.js');
  assert.match(approve, /const \{ bookingId, finalPriceCents, date, time \} = req\.body \|\| \{\};/);
  assert.match(approve, /if \(!quoteSlotStillOpen\(\{ date: nextDate, time: nextTime \}\)\) \{\n\s+return res\.status\(409\)/, 'a quote is not sent for a past time');
  assert.match(approve, /date: nextDate,\n\s+time: nextTime,/, 'the date sent is the date approved');
  assert.match(approve, /if \(action === 'authorize' && !booking\.stripe_payment_intent_id && !quoteSlotStillOpen\(booking\)\)/, 'approval does not start for a past time');
  assert.match(approve, /booking\.payment_status === 'quote_pending_approval' && !quoteSlotStillOpen\(booking\)/, 'the page says so before asking for a card');
  const page = buildApprovalPage({ booking: { ...quoteSent, customer_name: 'Tyler Finn', service: 'Smart Home', quote_subtotal_cents: 60046, quote_tax_cents: 4954 }, token: 't', publishableKey: 'pk' });
  assert.match(page, /Appointment<\/span><strong>Wednesday, October 28, 2026, 2:00 PM – 4:00 PM<\/strong>/, 'the customer sees the appointment they approve');

  const owner = await read('owner/index.html');
  assert.match(owner, /id="qm-date"/);
  assert.match(owner, /finalPriceCents: Math\.round\(amount \* 100\), date: quoteDate, time: quoteTime/);
  console.log('PASS quotes carry their appointment; a passed time is re-dated by the owner, never approved');
}

// ── The preliminary estimate is never presented as the quote ────────────────
{
  const booking = await read('api/booking.js');
  assert.match(booking, /\$\{quoteRequested \? 'Preliminary estimate \(not the quote\)' : 'Est\. Total'\}/);
  // Dispatch still only takes confirmed, payment-verified bookings; a quote is
  // confirmed only by the customer's approval with the card hold in place.
  const dispatch = await read('api/booking/_dispatch-internal.js');
  assert.match(dispatch, /if \(booking\.status !== BOOKING_STATUS\.CONFIRMED\) return \{ dispatched: 0/);
  const auto = await read('api/cron/auto-dispatch.js');
  assert.match(auto, /\.eq\('status', 'confirmed'\)/);
  const approve = await read('api/owner/quote-approve.js');
  assert.match(approve, /total_price: booking\.quote_amount_cents,[\s\S]{0,200}payment_status: 'authorized',[\s\S]{0,200}status: BOOKING_STATUS\.CONFIRMED,/,
    'approval swaps the quote in as the price before the booking is a job');
  console.log('PASS the preliminary estimate is labeled; dispatch sees a quote only after approval and hold');
}

console.log('\nCustom quote lifecycle tests passed.');
