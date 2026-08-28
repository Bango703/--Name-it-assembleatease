#!/usr/bin/env node

/**
 * Arrival verification and the nudge that makes it possible.
 *
 * THE PROBLEM
 * Easers arrive at jobs and never tap "Arrived", so the owner cannot tell whether
 * anyone showed up. Nothing ever asked them to: reminders go to the customer, and
 * no-show-check alerts the OWNER sixty minutes late. The one person who can
 * update the status got an assignment email and then silence.
 *
 * So the nudge is the fix and the location is the evidence — in that order. These
 * tests hold both to the line that matters: it must never punish an honest Easer
 * for a bad GPS fix, and it must never become a location trail.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {
  distanceMetres,
  describeArrival,
  locationConsentOk,
  ARRIVAL_CONFIRMED_M,
  ARRIVAL_NEARBY_M,
} from '../api/_geocode.js';

// ── Distance ────────────────────────────────────────────────────────────────
{
  const lat = 30.42281, lng = -97.58646;   // a real Pflugerville address
  assert.equal(distanceMetres(lat, lng, lat, lng), 0);
  assert.equal(distanceMetres(lat, lng, lat + 0.00072, lng), 80, '~80m north');
  assert.ok(Math.abs(distanceMetres(lat, lng, lat + 0.027, lng) - 3000) < 20, '~3km north');
  // Number(null) is 0, and 0 is a VALID latitude. Without an explicit guard a
  // missing coordinate becomes 0N 0E in the Gulf of Guinea and returns a
  // confident ~3,400km instead of "unknown". This assertion caught exactly that.
  for (const bad of [null, undefined, '']) {
    assert.equal(distanceMetres(bad, lng, lat, lng), null, `${String(bad)} must yield null, never a distance from 0,0`);
  }
  assert.equal(distanceMetres('x', lng, lat, lng), null, 'garbage yields null, never a false match');
  assert.equal(distanceMetres(999, lng, lat, lng), null, 'an impossible latitude is bad data, not a far-away place');
  console.log('PASS distance is accurate, and missing coordinates never read as "here"');
}

// ── The verdict is descriptive, never pass/fail ─────────────────────────────
{
  assert.equal(describeArrival({ distanceM: 18, accuracyM: 12 }).state, 'confirmed');
  assert.equal(describeArrival({ distanceM: 300, accuracyM: 20 }).state, 'nearby');
  assert.equal(describeArrival({ distanceM: 3200, accuracyM: 30 }).state, 'far');

  // No location at all is UNKNOWN, not a failure. An Easer who declined, or whose
  // phone could not get a fix in a garage, has not done anything wrong.
  const none = describeArrival({ distanceM: null });
  assert.equal(none.state, 'unknown');
  assert.match(none.label, /not shared/i);
  assert.ok(!/fail|invalid|refus/i.test(none.label), 'a missing fix must not read as an accusation');

  // A vague fix cannot confirm anything, however close it claims to be. Treating
  // it as proof is how a verification feature starts lying.
  const vague = describeArrival({ distanceM: 120, accuracyM: 2400 });
  assert.equal(vague.state, 'imprecise');
  assert.notEqual(vague.state, 'confirmed', 'a 2.4km-accurate fix must never confirm a 120m distance');
  console.log('PASS a missing or imprecise fix is reported, never treated as a failure or a match');
}

// ── Consent ─────────────────────────────────────────────────────────────────
{
  assert.equal(locationConsentOk({}), false, 'silence is not consent');
  assert.equal(locationConsentOk({ location_consent_at: '2026-08-01T00:00:00Z' }), true);
  assert.equal(
    locationConsentOk({ location_consent_at: '2026-08-01T00:00:00Z', location_declined_at: '2026-08-20T00:00:00Z' }),
    false,
    'a later refusal beats an earlier consent',
  );
  console.log('PASS location is never recorded without recorded consent');
}

// ── The handler captures but never gates ────────────────────────────────────
{
  const src = await fs.readFile(new URL('../api/booking/easer-status.js', import.meta.url), 'utf8');
  assert.ok(/locationConsentOk\(profile\)/.test(src), 'capture must be gated on recorded consent');
  assert.ok(/stage === EASER_STAGE\.ARRIVED/.test(src), 'capture happens only at arrival, never on every call');

  // The critical property: no early return, no 4xx, nothing conditional on the
  // location anywhere in the capture block. A bad fix must not block a check-in.
  const block = src.slice(src.indexOf('// ── Arrival verification'), src.indexOf('let updateQuery'));
  assert.ok(!/return res\./.test(block), 'the location block must never return a response — it cannot block a check-in');
  assert.ok(!/throw /.test(block), 'the location block must never throw');
  console.log('PASS location is captured at arrival only, and can never block a check-in');
}

// ── Arrival only — never a trail ────────────────────────────────────────────
{
  const sql = await fs.readFile(new URL('../api/migrations/079_arrival_verification.sql', import.meta.url), 'utf8');
  assert.ok(/arrived_lat/.test(sql) && /arrived_distance_m/.test(sql));
  assert.ok(/location_consent_at/.test(sql), 'consent must be a recorded column');
  assert.ok(/purge_stale_arrival_coordinates/.test(sql), 'sensitive coordinates must have a retention path');

  // There must be nowhere to put a continuous track. Monitoring an independent
  // contractor's whereabouts is a worker-classification risk; a single milestone
  // stamp is not. The schema enforces the distinction by omission.
  assert.ok(!/location_history|location_track|CREATE TABLE[^;]*location/i.test(sql),
    'the schema must offer no table for a location trail');
  console.log('PASS the schema records milestone stamps and has nowhere to store a trail');
}

// ── The nudge ───────────────────────────────────────────────────────────────
{
  const src = await fs.readFile(new URL('../api/cron/easer-arrival-nudge.js', import.meta.url), 'utf8');
  assert.ok(/CRON_SECRET/.test(src), 'the cron must authenticate');
  assert.ok(/MAX_NUDGES = 2/.test(src), 'two asks, then hand it to a human — a third only earns a muted phone');
  assert.ok(/recipientType: 'easer'/.test(src), 'this must nudge the EASER; the owner already gets no-show-check');

  // It must never assert arrival on the Easer's behalf.
  assert.ok(!/checked_in_at:\s*(now|new Date)/.test(src),
    'the cron must never set checked_in_at — only the Easer can say they are there (Article 16)');
  assert.ok(!/status:\s*['"]arrived/.test(src), 'the cron must never advance booking status');

  // Concurrency: two overlapping runs must not double-nudge.
  assert.ok(/\.eq\('arrival_nudge_count', sentCount\)/.test(src),
    'the nudge claim must be compare-and-set so overlapping runs cannot double-send');
  console.log('PASS the nudge asks twice, never claims arrival, and cannot double-send');
}

// ── It is actually scheduled ────────────────────────────────────────────────
{
  const vercel = JSON.parse(await fs.readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
  const job = (vercel.crons || []).find(c => c.path === '/api/cron/easer-arrival-nudge');
  assert.ok(job, 'an unscheduled cron never runs — this is the whole fix');
  assert.equal(job.schedule, '*/15 * * * *');
  console.log('PASS the nudge is scheduled every 15 minutes');
}

console.log('\nArrival verification tests passed.');
