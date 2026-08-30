#!/usr/bin/env node

/**
 * A customer who saves a card and never reaches the queue must be pushed to the
 * owner, not left for someone to notice.
 *
 * WHAT WENT WRONG
 * Checkout saves the card BEFORE creating the booking. When the second call
 * fails — validation, dropped connection, closed tab — the card is on file at
 * Stripe and no booking exists, so the customer is invisible to everyone.
 *
 * Detection already worked: /api/owner/quote-orphans found them correctly and
 * the dashboard listed them. Both are PULL. Two real customers sat for 34 and
 * 44 days with valid cards and zero emails ever sent to them, because nothing
 * told the owner they were there.
 *
 * These guards lock the three properties that failure depended on: one shared
 * detection rule, an alert that pushes, and a cron that can never spend money.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const read = p => fs.readFile(new URL('../' + p, import.meta.url), 'utf8');
const core = await read('api/_quote-orphans-core.js');
const cron = await read('api/cron/quote-orphan-alert.js');
const ownerApi = await read('api/owner/quote-orphans.js');
const vercel = JSON.parse(await read('vercel.json'));

// ── One detection rule, two callers ────────────────────────────────────────
// A dashboard showing two while an email says three is worse than either alone.
{
  assert.ok(/from '\.\.\/_quote-orphans-core\.js'/.test(ownerApi),
    'the owner panel must read the shared detector, not its own copy');
  assert.ok(/from '\.\.\/_quote-orphans-core\.js'/.test(cron),
    'the alert cron must read the same detector the dashboard does');
  // Neither caller may re-implement the "is there a booking for this card" test.
  for (const [name, src] of [['owner API', ownerApi], ['cron', cron]]) {
    assert.ok(!/setupIntents\.list/.test(src),
      `${name} must not list SetupIntents itself — that is the detector's job`);
    assert.ok(!/payment_status.*card_saved/.test(src),
      `${name} must not re-implement the orphan test`);
  }
  console.log('PASS detection lives in one module and both views read it');
}

// ── The alert pushes, and keeps its meaning ────────────────────────────────
{
  assert.ok(/sendEmail\(/.test(cron), 'the cron must actually send — a silent detector is what failed');
  assert.ok(/ownerEmail\(\)/.test(cron), 'the alert goes to the owner');
  assert.ok(/REMINDER_DAYS/.test(cron),
    'outstanding orphans must resurface, or one ignored email loses them again');
  // A daily repeat of the same names gets filtered, recreating the original bug.
  assert.ok(/alertedIds|already[Aa]lerted/.test(cron),
    'an orphan already reported must not be re-alerted every single day');
  console.log('PASS new orphans alert immediately, outstanding ones resurface, no daily nagging');
}

// ── A failed send must not mark the customer handled ───────────────────────
{
  const sendIdx = cron.indexOf('await sendEmail(');
  const recordIdx = cron.indexOf('event_type: ALERTED_EVENT');
  assert.ok(sendIdx > 0 && recordIdx > sendIdx,
    'the alert must be recorded AFTER the email succeeds, or a failed send is silently marked done');
  console.log('PASS a failed email is retried tomorrow, not recorded as delivered');
}

// ── It can never spend money ───────────────────────────────────────────────
// A saved card is not permission to bill for work nobody has scoped.
{
  for (const [name, src] of [['detector', core], ['cron', cron]]) {
    assert.ok(!/paymentIntents\.(create|capture|confirm)/.test(src),
      `${name} must never create or capture a payment`);
    assert.ok(!/charges\.create|transfers\.create|refunds\.create/.test(src),
      `${name} must never move money`);
    assert.ok(!/setupIntents\.(update|cancel)|customers\.(update|del)/.test(src),
      `${name} must not mutate Stripe objects it is only reading`);
  }
  assert.ok(!/from\('bookings'\)[\s\S]{0,120}\.(update|insert|delete)\(/.test(core),
    'the detector must never write to bookings');
  console.log('PASS neither the detector nor the alert can charge, move, or mutate money');
}

// ── It is actually scheduled, and actually protected ───────────────────────
// An unscheduled cron is a file, not a safety net.
{
  const job = (vercel.crons || []).find(c => c.path === '/api/cron/quote-orphan-alert');
  assert.ok(job, 'the alert must be scheduled in vercel.json or it never runs');
  assert.ok(/^\S+ \S+ \S+ \S+ \S+$/.test(job.schedule), 'schedule must be a valid five-field cron');
  assert.ok(/CRON_SECRET/.test(cron) && /return res\.status\(401\)/.test(cron),
    'the cron must reject unauthenticated calls');
  console.log('PASS the alert is scheduled and rejects unauthenticated calls');
}

// ── Both card-save reasons are covered ─────────────────────────────────────
// A lost scheduled-appointment customer is the same harm as a lost quote.
{
  assert.ok(/quote_booking/.test(core) && /future_booking/.test(core),
    'both card-save purposes must be watched — the failure window is identical');
  console.log('PASS quote and scheduled-appointment card saves are both watched');
}

// ── The email says what the owner needs to act ─────────────────────────────
{
  const { buildAlertEmail } = await import('../api/cron/quote-orphan-alert.js');
  const outstanding = [
    { setupIntentId: 'si_1', email: 'a@example.com', name: 'Real Person', source: 'quote_booking', sourceLabel: 'custom quote', cardOnFile: true, savedAt: '2026-07-16T00:00:00Z', ageDays: 44 },
  ];
  const html = buildAlertEmail({ outstanding, fresh: outstanding });
  assert.ok(html.includes('Real Person') && html.includes('a@example.com'),
    'the owner must get the name and a way to reach them');
  assert.ok(/44 days/.test(html), 'how long they have waited is the whole story');
  assert.ok(/mailto:/.test(html), 'acting on it must be one click, not a lookup');
  assert.ok(/[Nn]othing has been charged/.test(html),
    'the owner must be told plainly that no money moved, so nobody assumes it did');

  // Article 16: never assert what has not been verified. We do NOT know what
  // this customer wanted — the booking that held the items was never created —
  // so the email must not imply the job is scoped or a price is known.
  assert.ok(!/\$\d/.test(html),
    'the email must not show a price: the booking never existed, so nothing was scoped');

  // Escaping: names come from Stripe and land in HTML.
  const nasty = [{ ...outstanding[0], name: '<script>x</script>', email: 'b@example.com' }];
  assert.ok(!buildAlertEmail({ outstanding: nasty, fresh: nasty }).includes('<script>x'),
    'customer-supplied names must be escaped before they reach the owner inbox');
  console.log('PASS the alert carries name, contact, and wait time, escaped, with no invented price');
}

console.log('\nQuote orphan alert tests passed.');
