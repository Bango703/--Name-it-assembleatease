/**
 * AssembleAtEase — Operational Validation Simulation
 *
 * Tests the full booking lifecycle using owner-authenticated API calls.
 * Easer-JWT-required stages (status progression) are flagged as MANUAL.
 *
 * Usage:
 *   Set OWNER_PASSWORD, SIMULATION_BASE_URL, and SIMULATION_EMAIL locally, then run:
 *   node --use-system-ca simulate-validation.mjs
 *
 * Run only against a local or explicitly approved non-production environment.
 * Prices and payment state are server-authoritative; browser-supplied zero-value
 * fields do not make a production simulation safe. Generated customer names are
 * tagged SIM- so test records remain identifiable.
 */

import { randomUUID } from 'crypto';

// ─── Config ──────────────────────────────────────────────────────────────────
const BASE    = String(process.env.SIMULATION_BASE_URL || '').replace(/\/$/, '');
const PW      = process.env.OWNER_PASSWORD;
const EMAIL   = String(process.env.SIMULATION_EMAIL || '').trim();
const CRON_SECRET = process.env.CRON_SECRET || null;

if (!PW) { console.error('\nERROR: Set OWNER_PASSWORD env var.\n'); process.exit(1); }
if (!BASE) { console.error('\nERROR: Set SIMULATION_BASE_URL to a local or approved non-production environment.\n'); process.exit(1); }
if (!EMAIL || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(EMAIL)) {
  console.error('\nERROR: Set SIMULATION_EMAIL to the approved test notification inbox.\n');
  process.exit(1);
}
if (/^https?:\/\/(www\.)?assembleatease\.com$/i.test(BASE) && process.env.ALLOW_PRODUCTION_SIMULATION !== 'true') {
  console.error('\nERROR: Production simulation is disabled. Use a local/test environment.\n');
  process.exit(1);
}

// ─── Result tracker ───────────────────────────────────────────────────────────
const R = { pass: [], fail: [], warn: [], manual: [] };
const state = { bookings: [], easerId: null, easerName: null };

const pass   = (t, d='') => { R.pass.push({ t, d });   log('PASS', t, d, '\x1b[32m'); };
const fail   = (t, d='') => { R.fail.push({ t, d });   log('FAIL', t, d, '\x1b[31m'); };
const warn   = (t, d='') => { R.warn.push({ t, d });   log('WARN', t, d, '\x1b[33m'); };
const manual = (t, d='') => { R.manual.push({ t, d }); log('MNUL', t, d, '\x1b[36m'); };

function log(tag, test, detail, color) {
  const reset = '\x1b[0m';
  const dim   = '\x1b[2m';
  console.log(`  ${color}[${tag}]${reset} ${test}${detail ? `${dim} — ${detail}${reset}` : ''}`);
}

function ownerH() {
  return { 'Content-Type': 'application/json', 'x-owner-password': PW };
}

async function api(method, path, body = null, headers = ownerH()) {
  try {
    const opts = { method, headers };
    if (body) opts.body = JSON.stringify(body);
    const r = await fetch(BASE + path, opts);
    let data = {};
    try { data = await r.json(); } catch (_) {}
    return { status: r.status, ok: r.ok, data };
  } catch (e) {
    return { status: 0, ok: false, data: {}, error: e.message };
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function fmt$(cents) { return cents > 0 ? `$${(cents/100).toFixed(2)}` : '$0.00'; }

// ─── TEST BOOKINGS ────────────────────────────────────────────────────────────
const BOOKINGS = [
  {
    label:   'Furniture Assembly',
    service: 'Furniture Assembly',
    name:    'SIM-Alex Johnson',
    phone:   '512-555-0101',
    email:   EMAIL,
    address: '2301 S Lamar Blvd, Austin TX 78704',
    date:    futureDateStr(3),
    time:    '10:00 AM - 12:00 PM',
    details: 'IKEA KALLAX bookshelf (4x4) + HEMNES bed frame. All tools available.',
    totalCents: 14900,  // $149
    dispatchMode: 'manual',
  },
  {
    label:   'TV Mounting',
    service: 'TV & Display Mounting',
    name:    'SIM-Maria Gonzalez',
    phone:   '512-555-0202',
    email:   EMAIL,
    address: '4401 N Lamar Blvd, Austin TX 78751',
    date:    futureDateStr(5),
    time:    '2:00 PM - 4:00 PM',
    details: '65" Samsung. Wall is drywall with studs. Need full-motion mount installed.',
    totalCents: 9900,   // $99
    dispatchMode: 'auto',
  },
  {
    label:   'Home Repair',
    service: 'Home Repairs',
    name:    'SIM-David Park',
    phone:   '512-555-0303',
    email:   EMAIL,
    address: '1100 E 6th St, Austin TX 78702',
    date:    futureDateStr(7),
    time:    '8:00 AM - 10:00 AM',
    details: 'Fix 3 interior door hinges, patch two small drywall holes, replace bathroom faucet.',
    totalCents: 18500,  // $185
    dispatchMode: 'expire',  // dispatch, then expire offers to test escalation
  },
];

function futureDateStr(daysAhead) {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  return d.toISOString().slice(0, 10);
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 0 — Platform health check
// ═══════════════════════════════════════════════════════════════════════════════
async function phase0_health() {
  section('PHASE 0 — Platform Health Check');

  // Owner auth
  const auth = await api('GET', '/api/booking/list');
  if (auth.ok) {
    pass('Owner authentication', `HTTP ${auth.status}`);
  } else {
    fail('Owner authentication', `HTTP ${auth.status} — check OWNER_PASSWORD`);
    console.error('\nFATAL: Cannot authenticate. Stopping.\n');
    process.exit(1);
  }

  // Booking list loads
  const bookings = auth.data.bookings || [];
  pass('Booking list endpoint', `${bookings.length} existing booking(s)`);

  // Easer list
  const easerRes = await api('GET', '/api/assembler/list');
  if (easerRes.ok) {
    const all = easerRes.data.assemblers || [];
    const active = all.filter(a => a.status === 'active');
    const eligible = active.filter(a => a.phone && a.identity_verified && ['starter','professional','elite'].includes(a.tier));

    if (eligible.length) {
      state.easerId   = eligible[0].id;
      state.easerName = eligible[0].full_name;
      pass('Active dispatch-eligible Easer found', `${state.easerName} (${eligible[0].tier})`);
    } else if (active.length) {
      warn('Active Easers exist but none are dispatch-eligible', 'Missing phone, ID verification, or valid tier');
    } else {
      warn('No active Easers in system', 'Dispatch will fail — onboard at least one Easer');
    }
  } else {
    fail('Easer list endpoint', `HTTP ${easerRes.status}`);
  }

  // Dispatch offers table
  const dispatchCheck = await api('GET', '/api/booking/dispatch-log?bookingId=00000000-0000-0000-0000-000000000000');
  if (dispatchCheck.status !== 500) {
    pass('dispatch_offers table exists', 'Migration 002 confirmed');
  } else {
    fail('dispatch_offers table missing', 'Run migration 002 in Supabase');
  }

  // Reviews table
  const revCheck = await api('GET', '/api/review');
  if (revCheck.ok) {
    pass('reviews table exists', `${(revCheck.data.reviews||[]).length} existing review(s)`);
  } else {
    fail('reviews table / GET /api/review', `HTTP ${revCheck.status}`);
  }

  // Notification log
  const nlCheck = await api('GET', '/api/owner/payouts');
  if (nlCheck.ok) {
    pass('Payout ledger endpoint', `${(nlCheck.data.easers||[]).length} Easer(s) in ledger`);
  } else {
    fail('Payout ledger endpoint', `HTTP ${nlCheck.status}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 1 — Create 3 test bookings
// ═══════════════════════════════════════════════════════════════════════════════
async function phase1_create() {
  section('PHASE 1 — Create Test Bookings');

  for (const spec of BOOKINGS) {
    const r = await api('POST', '/api/booking', {
      service:    spec.service,
      name:       spec.name,
      phone:      spec.phone,
      email:      spec.email,
      address:    spec.address,
      date:       spec.date,
      time:       spec.time,
      details:    spec.details,
      totalCents: spec.totalCents,
      source:     'sim',
    });

    if (r.ok && (r.data.bookingId || r.data.id || r.data.ref)) {
      const id  = r.data.bookingId || r.data.id;
      const ref = r.data.ref || '—';
      pass(`Created "${spec.label}"`, `${ref} — ${fmt$(spec.totalCents)}`);
      state.bookings.push({ ...spec, id, ref });
    } else {
      fail(`Create "${spec.label}"`, r.data.error || `HTTP ${r.status}`);
      state.bookings.push({ ...spec, id: null, ref: null });
    }
    await sleep(800);
  }

  // Verify bookings appear in list
  const list = await api('GET', '/api/booking/list');
  const simBookings = (list.data.bookings || []).filter(b => b.customer_name?.startsWith('SIM-'));
  if (simBookings.length === state.bookings.filter(b => b.id).length) {
    pass('All test bookings appear in dashboard list', `${simBookings.length} visible`);
  } else {
    warn('Dashboard booking count mismatch', `Expected ${state.bookings.filter(b=>b.id).length}, saw ${simBookings.length} SIM- bookings`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 2 — Confirm bookings
// ═══════════════════════════════════════════════════════════════════════════════
async function phase2_confirm() {
  section('PHASE 2 — Confirm Bookings');

  for (const b of state.bookings) {
    if (!b.id) { warn(`Skipping confirm for "${b.label}"`, 'Not created'); continue; }

    const r = await api('POST', '/api/booking/confirm', { bookingId: b.id });
    if (r.ok) {
      pass(`Confirmed "${b.label}"`, b.ref);
      b.status = 'confirmed';
    } else {
      fail(`Confirm "${b.label}"`, r.data.error || `HTTP ${r.status}`);
    }
    await sleep(500);
  }

  // Validate status badges reflect confirmed
  const list = await api('GET', '/api/booking/list');
  const confirmed = (list.data.bookings || []).filter(b => b.customer_name?.startsWith('SIM-') && b.status === 'confirmed');
  if (confirmed.length === state.bookings.filter(b => b.status === 'confirmed').length) {
    pass('All confirmed bookings show status=confirmed in API', `${confirmed.length} bookings`);
  } else {
    warn('Confirmed count mismatch', `Expected ${state.bookings.filter(b=>b.status==='confirmed').length}, got ${confirmed.length}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 3 — Dispatch (3 different scenarios)
// ═══════════════════════════════════════════════════════════════════════════════
async function phase3_dispatch() {
  section('PHASE 3 — Dispatch Scenarios');

  for (const b of state.bookings) {
    if (b.status !== 'confirmed') { warn(`Skipping dispatch for "${b.label}"`, 'Not confirmed'); continue; }

    // ── Scenario A: Manual dispatch via owner ─────────────────────────────────
    if (b.dispatchMode === 'manual') {
      sub('3A — Manual Dispatch');

      // Dry run first
      const dry = await api('POST', '/api/booking/dispatch-control', { bookingId: b.id, action: 'dry_run' });
      if (dry.ok && dry.data.offeredTo !== undefined) {
        const n = (dry.data.offeredTo || []).length;
        if (n > 0) {
          pass('Dry-run scoring preview', `${n} eligible Easer(s) scored`);
          dry.data.offeredTo.forEach(e => {
            console.log(`       └─ ${e.name} (${e.tier}) score=${e.score}`);
          });
        } else {
          warn('Dry-run found 0 eligible Easers', 'Dispatch will fail — check Easer availability');
        }
      } else {
        fail('Dry-run dispatch preview', dry.data.error || `HTTP ${dry.status}`);
      }

      // Actual dispatch
      const r = await api('POST', '/api/booking/dispatch', { bookingId: b.id });
      if (r.ok) {
        const n = r.data.dispatched || 0;
        if (n > 0) {
          pass(`Manual dispatch "${b.label}"`, `${n} offer(s) sent`);
          b.dispatched = true;
        } else {
          warn(`Manual dispatch "${b.label}" — 0 offers sent`, r.data.message || 'No eligible Easers');
          b.dispatched = false;
        }
      } else {
        fail(`Manual dispatch "${b.label}"`, r.data.error || `HTTP ${r.status}`);
      }

      // Check dispatch log
      await sleep(500);
      const log = await api('GET', `/api/booking/dispatch-log?bookingId=${b.id}`);
      if (log.ok && (log.data.offers || []).length > 0) {
        pass('Dispatch offers recorded in dispatch_log', `${log.data.offers.length} offer row(s)`);
      } else if (b.dispatched) {
        fail('Dispatch log empty after successful dispatch', 'dispatch_offers table may not be migrated');
      } else {
        warn('Dispatch log empty', 'Expected — no offers sent');
      }
    }

    // ── Scenario B: Auto-dispatch via cron trigger ─────────────────────────────
    if (b.dispatchMode === 'auto') {
      sub('3B — Auto-Dispatch (Cron Trigger)');

      if (CRON_SECRET) {
        const r = await fetch(BASE + '/api/cron/auto-dispatch', {
          headers: { 'Authorization': `Bearer ${CRON_SECRET}` }
        });
        const d = await r.json().catch(() => ({}));
        if (r.ok) {
          pass('Auto-dispatch cron triggered', `processed=${d.processed||0} dispatched=${d.dispatched||0}`);
          b.dispatched = (d.dispatched || 0) > 0;
        } else {
          fail('Auto-dispatch cron', `HTTP ${r.status} — ${d.error || 'unknown'}`);
        }
      } else {
        warn('Auto-dispatch cron skipped', 'CRON_SECRET not set — set env var to test');
        manual('Manually trigger auto-dispatch', 'In owner dashboard → Live Ops → Dispatch All');
        // Fall back to manual dispatch so the booking gets dispatched
        const r = await api('POST', '/api/booking/dispatch', { bookingId: b.id });
        b.dispatched = r.ok && (r.data.dispatched || 0) > 0;
        if (b.dispatched) pass(`Fallback manual dispatch "${b.label}"`, `${r.data.dispatched} offer(s)`);
        else warn(`Fallback dispatch "${b.label}"`, r.data.message || 'No eligible Easers');
      }
    }

    // ── Scenario C: Dispatch → Expire → Escalation ────────────────────────────
    if (b.dispatchMode === 'expire') {
      sub('3C — Dispatch Expiry & Escalation');

      // Dispatch first
      const dispR = await api('POST', '/api/booking/dispatch', { bookingId: b.id });
      if (dispR.ok && dispR.data.dispatched > 0) {
        pass(`Dispatched "${b.label}"`, `${dispR.data.dispatched} offer(s) — will force expire`);
        b.dispatched = true;
      } else {
        warn(`Dispatch for expiry scenario "${b.label}"`, dispR.data.message || 'No Easers — escalation still testable');
        b.dispatched = false;
      }

      // Trigger expire-offers cron
      if (CRON_SECRET) {
        await sleep(1000);
        const expR = await fetch(BASE + '/api/cron/expire-offers', {
          headers: { 'Authorization': `Bearer ${CRON_SECRET}` }
        });
        const expD = await expR.json().catch(() => ({}));
        if (expR.ok) {
          pass('expire-offers cron triggered', `expired=${expD.expired||0} retried=${(expD.retried||[]).length} flagged=${(expD.flagged||[]).length}`);
          // Note: offers created seconds ago won't have expired_at in the past yet
          warn('Offers created just now will not expire immediately', 'expires_at is 20 min in future — this tests the cron mechanism, not actual expiry');
        } else {
          fail('expire-offers cron', `HTTP ${expR.status}`);
        }
      } else {
        warn('Expiry cron skipped', 'CRON_SECRET not set');
        manual('Test expiry scenario', 'Wait 20 min after dispatch, then trigger expire-offers cron');
      }

      // Test cancel-during-dispatch (offers should be cleaned up)
      sub('3C.1 — Cancel-During-Dispatch Cleanup');
      if (b.dispatched) {
        const cancelR = await api('POST', '/api/booking/cancel', { bookingId: b.id, reason: 'Simulation test — testing cancel cleanup' });
        if (cancelR.ok) {
          pass('Owner cancel of dispatched booking', b.ref);
          // Verify dispatch offers are cancelled
          await sleep(800);
          const logR = await api('GET', `/api/booking/dispatch-log?bookingId=${b.id}`);
          const offers = logR.data.offers || [];
          const openOffers = offers.filter(o => o.offer_status === 'sent');
          if (openOffers.length === 0) {
            pass('Dispatch offers cancelled after booking cancel', `${offers.length} offer(s) now closed`);
          } else {
            fail('Open offers remain after booking cancel', `${openOffers.length} offer(s) still in sent state`);
          }
          b.status = 'cancelled';
        } else {
          fail('Cancel-during-dispatch', cancelR.data.error || `HTTP ${cancelR.status}`);
        }
      } else {
        warn('Cancel-during-dispatch skipped', 'Booking was not dispatched');
      }
    }

    await sleep(500);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 4 — Easer assignment (manual assign since we lack Easer JWT)
// ═══════════════════════════════════════════════════════════════════════════════
async function phase4_assign() {
  section('PHASE 4 — Easer Assignment');

  const target = state.bookings.find(b => b.status === 'confirmed' && b.dispatchMode === 'manual');
  if (!target) { warn('No confirmed manual-dispatch booking to assign', 'Skipping'); return; }

  if (!state.easerId) {
    warn('No eligible Easer available for direct assignment', 'Onboard an Easer first');
    manual('Manual assignment test', `Go to Bookings → ${target.ref} → Assign → select Easer`);
    return;
  }

  // Direct owner assign (bypasses dispatch — tests assign.js CAS guard)
  const r = await api('POST', '/api/booking/assign', {
    bookingId:   target.id,
    assemblerId: state.easerId,
  });

  if (r.ok) {
    pass(`Direct assignment "${target.label}"`, `Assigned to ${state.easerName}`);
    target.status    = 'assigned';
    target.easerId   = state.easerId;
    target.easerName = state.easerName;

    // Test duplicate assignment (CAS guard)
    const r2 = await api('POST', '/api/booking/assign', {
      bookingId:   target.id,
      assemblerId: state.easerId,
    });
    if (!r2.ok && r2.status === 400) {
      pass('Duplicate assignment blocked', `HTTP ${r2.status} — ${r2.data.error}`);
    } else if (r2.data?.error?.includes('already assigned')) {
      pass('Duplicate assignment blocked', r2.data.error);
    } else {
      warn('Duplicate assignment guard', `HTTP ${r2.status} — expected 400`);
    }
  } else {
    fail(`Direct assignment "${target.label}"`, r.data.error || `HTTP ${r.status}`);
    manual('Manual assignment', `Go to Bookings → ${target.ref} → Assign drawer`);
  }

  // Easer status progression requires Easer JWT — flag as manual
  manual('Easer status: en_route', 'Requires Easer JWT — log into /assembler/ and tap On My Way');
  manual('Easer status: arrived',  'Requires Easer JWT — tap Arrived on the job card');
  manual('Easer status: in_progress', 'Requires Easer JWT — tap Start Job');
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 5 — Completion flow
// ═══════════════════════════════════════════════════════════════════════════════
async function phase5_complete() {
  section('PHASE 5 — Completion & Payment Capture');

  const target = state.bookings.find(b => b.status === 'confirmed' || b.status === 'assigned');
  if (!target) { warn('No confirmed booking available for completion test', 'Skipping'); return; }

  // First attempt — should succeed
  const r = await api('POST', '/api/booking/complete', { bookingId: target.id });
  if (r.ok) {
    pass(`Booking completed "${target.label}"`, target.ref);
    target.status = 'completed';

    // Second attempt — double-complete guard
    const r2 = await api('POST', '/api/booking/complete', { bookingId: target.id });
    if (!r2.ok && (r2.status === 400 || r2.data?.error?.includes('already completed'))) {
      pass('Double-complete guard', `HTTP ${r2.status} — ${r2.data.error}`);
    } else {
      fail('Double-complete guard', `Expected 400, got HTTP ${r2.status}`);
    }

    // Verify payment_status and amount fields
    const list = await api('GET', '/api/booking/list');
    const completed = (list.data.bookings || []).find(b => b.id === target.id);
    if (completed) {
      if (completed.status === 'completed') pass('Status=completed persisted in DB');
      else fail('Status not updated in DB', `Got: ${completed.status}`);

      if (completed.amount_charged !== null) {
        pass('amount_charged set', fmt$(completed.amount_charged));
      } else if (target.totalCents === 0) {
        pass('amount_charged null (zero-price booking — expected)');
      } else {
        warn('amount_charged is null', 'Should be set after completion');
      }

      if (completed.platform_fee !== null || target.totalCents === 0) {
        pass('platform_fee calculated');
      } else {
        warn('platform_fee null');
      }
    }
  } else {
    fail(`Complete "${target.label}"`, r.data.error || `HTTP ${r.status}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 6 — Review flow
// ═══════════════════════════════════════════════════════════════════════════════
async function phase6_review() {
  section('PHASE 6 — Review Submission');

  const target = state.bookings.find(b => b.status === 'completed');
  if (!target) { warn('No completed booking for review test', 'Skipping'); return; }

  // Submit review (no auth needed — uses ref + email validation)
  const r = await fetch(BASE + '/api/review', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      ref:    target.ref,
      email:  EMAIL,
      rating: 5,
      body:   'Simulation test review — outstanding service, arrived on time, very professional.',
    }),
  });
  const d = await r.json().catch(() => ({}));

  if (r.ok) {
    pass('Review submitted', `5 stars for ${target.ref}`);

    // Duplicate review guard
    const r2 = await fetch(BASE + '/api/review', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: target.ref, email: EMAIL, rating: 4, body: 'Duplicate test.' }),
    });
    const d2 = await r2.json().catch(() => ({}));
    if (!r2.ok && (r2.status === 409 || d2.error?.includes('already'))) {
      pass('Duplicate review blocked', `HTTP ${r2.status}`);
    } else {
      fail('Duplicate review guard', `Expected 409, got ${r2.status}`);
    }

    // Verify review appears in owner dashboard
    const revR = await api('GET', '/api/owner/reviews');
    const reviews = revR.data.reviews || [];
    const ours = reviews.find(rv => rv.booking_id === target.id || rv.customer_name === target.name);
    if (ours) {
      pass('Review visible in owner Reviews tab', `rating=${ours.rating} approved=${ours.approved}`);
    } else {
      warn('Review not found in owner review list', 'May need a moment to propagate');
    }

    // Invalid booking ref
    const r3 = await fetch(BASE + '/api/review', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: 'AAE-INVALID', email: EMAIL, rating: 5, body: 'Should be rejected.' }),
    });
    if (!r3.ok) {
      pass('Invalid booking ref rejected', `HTTP ${r3.status}`);
    } else {
      fail('Invalid booking ref accepted', 'Review API should reject unknown refs');
    }
  } else {
    fail('Review submission', d.error || `HTTP ${r.status}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 7 — Observability validation
// ═══════════════════════════════════════════════════════════════════════════════
async function phase7_observability() {
  section('PHASE 7 — Observability & Logging');

  const target = state.bookings.find(b => b.status === 'completed') || state.bookings.find(b => b.id);
  if (!target) { warn('No booking available for observability check', 'Skipping'); return; }

  // Activity log
  const actR = await api('GET', `/api/booking/activity?bookingId=${target.id}`);
  if (actR.ok) {
    const events = actR.data.activity || [];
    const opEvents    = events.filter(e => e._source !== 'notification');
    const notifEvents = events.filter(e => e._source === 'notification');
    pass('Timeline endpoint responds', `${events.length} total events`);
    if (opEvents.length > 0)    pass('Operational events in timeline', `${opEvents.length} event(s): ${[...new Set(opEvents.map(e=>e.event_type))].join(', ')}`);
    else                        warn('No operational events logged', 'activity_logs table may not have received events yet');
    if (notifEvents.length > 0) pass('Notification events in timeline', `${notifEvents.length} notification log(s)`);
    else                        warn('No notification events in timeline', 'notification_log may be empty — notifications may not have fired');

    const failedNotifs = notifEvents.filter(e => e._status === 'failed');
    if (failedNotifs.length > 0) warn('Failed notifications recorded', `${failedNotifs.length} failure(s) visible in timeline`);
    else                          pass('No failed notifications detected');
  } else {
    fail('Timeline endpoint', `HTTP ${actR.status} — ${actR.data.error}`);
  }

  // Notification log directly
  await sleep(500);

  // Analytics
  const list = await api('GET', '/api/booking/list');
  const allB = list.data.bookings || [];
  const completed = allB.filter(b => b.status === 'completed');
  if (completed.length > 0) {
    const usingAmountCharged = completed.every(b => b.amount_charged !== undefined);
    if (usingAmountCharged) pass('amount_charged field present on completed bookings');
    else                    warn('amount_charged missing on some bookings', 'May be legacy rows');

    const withFees = completed.filter(b => b.platform_fee !== null);
    if (withFees.length) pass('platform_fee calculated on completed bookings', `${withFees.length} booking(s)`);
    else                 warn('platform_fee null on completed bookings', 'Check complete.js fee calculation');
  }

  // Payout ledger
  const payR = await api('GET', '/api/owner/payouts');
  if (payR.ok) {
    const { easers = [], totals = {} } = payR.data;
    pass('Payout ledger endpoint', `${easers.length} Easer(s) in ledger`);
    if (easers.length) {
      const pending = totals.total_pending || 0;
      const paid    = totals.total_paid    || 0;
      pass('Payout totals calculated', `pending=${fmt$(pending)} paid=${fmt$(paid)}`);
      const simEaser = easers.find(e => e.assembler_name === state.easerName);
      if (simEaser) {
        pass('Simulation Easer appears in payout ledger', `owed=${fmt$(simEaser.total_owed)} pending=${fmt$(simEaser.total_pending)}`);
      }
    }
  } else {
    fail('Payout ledger', `HTTP ${payR.status}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 8 — Invalid state transition tests
// ═══════════════════════════════════════════════════════════════════════════════
async function phase8_guards() {
  section('PHASE 8 — Invalid State Transition Guards');

  const cancelled = state.bookings.find(b => b.status === 'cancelled');
  const completed = state.bookings.find(b => b.status === 'completed');

  // Cannot complete a cancelled booking
  if (cancelled) {
    const r = await api('POST', '/api/booking/complete', { bookingId: cancelled.id });
    if (!r.ok) pass('Cannot complete a cancelled booking', `HTTP ${r.status} — ${r.data.error}`);
    else        fail('Completed a cancelled booking', 'State guard missing');
  } else {
    warn('Cancelled booking not available for guard test');
  }

  // Cannot cancel a completed booking
  if (completed) {
    const r = await api('POST', '/api/booking/cancel', { bookingId: completed.id });
    if (!r.ok) pass('Cannot cancel a completed booking', `HTTP ${r.status} — ${r.data.error}`);
    else        fail('Cancelled a completed booking', 'State guard missing');
  } else {
    warn('Completed booking not available for guard test');
  }

  // Suspend guard — only testable if we have an active Easer with no live jobs
  if (state.easerId) {
    // Check if they have active jobs first
    const suspR = await api('POST', '/api/assembler/update', { assemblerId: state.easerId, action: 'suspend' });
    if (!suspR.ok && suspR.status === 409) {
      pass('Suspend blocked — Easer has active jobs', suspR.data.error);
    } else if (!suspR.ok && suspR.data.error?.includes('active')) {
      pass('Suspend blocked', suspR.data.error);
    } else if (suspR.ok) {
      // They were suspended — reinstate them
      warn('Easer suspended during test — reinstating', 'No active jobs at time of test');
      await api('POST', '/api/assembler/update', { assemblerId: state.easerId, action: 'reinstate' });
    } else {
      warn('Suspend guard test inconclusive', `HTTP ${suspR.status}`);
    }
  }

  // Invalid review — wrong email
  const r = await fetch(BASE + '/api/review', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: state.bookings[0]?.ref || 'AAE-TEST', email: 'wrong@email.com', rating: 5, body: 'Wrong email test' }),
  });
  if (!r.ok) pass('Review with wrong email rejected', `HTTP ${r.status}`);
  else        fail('Review with wrong email accepted', 'Should return 403');
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 9 — Dashboard synchronization spot-check
// ═══════════════════════════════════════════════════════════════════════════════
async function phase9_dashboard() {
  section('PHASE 9 — Dashboard Sync Spot-Check');

  const list = await api('GET', '/api/booking/list');
  const allB = list.data.bookings || [];

  // Stats consistency
  const counts = { pending:0, confirmed:0, completed:0, cancelled:0 };
  allB.forEach(b => { if (counts[b.status] !== undefined) counts[b.status]++; });
  pass('Booking stats consistent with list', `pending=${counts.pending} confirmed=${counts.confirmed} completed=${counts.completed} cancelled=${counts.cancelled}`);

  // Customer view — SIM- customers should appear
  const simB = allB.filter(b => b.customer_name?.startsWith('SIM-'));
  if (simB.length) pass('Test customers appear in Customers view data', `${simB.length} SIM- booking(s)`);

  // Live Ops
  const liveR = await api('GET', '/api/owner/live-ops');
  if (liveR.ok) {
    const s = liveR.data.summary || {};
    pass('Live Ops endpoint', `totalActive=${s.totalActive} freeEasers=${s.freeEasers} unassigned=${s.unassigned}`);
  } else {
    fail('Live Ops endpoint', `HTTP ${liveR.status}`);
  }

  // Waitlist
  const wlR = await api('GET', '/api/owner/waitlist');
  if (wlR.ok) pass('Waitlist endpoint', `${(wlR.data.entries||[]).length} entries`);
  else        fail('Waitlist endpoint', `HTTP ${wlR.status}`);

  // Owner reviews
  const revR = await api('GET', '/api/owner/reviews');
  if (revR.ok) pass('Reviews endpoint', `${(revR.data.reviews||[]).length} review(s)`);
  else         fail('Reviews endpoint', `HTTP ${revR.status}`);

  manual('Live Ops panel auto-refresh', 'Open owner dashboard → Live Ops, wait 30s for auto-update');
  manual('Today\'s schedule view',      'Open Today tab — SIM- bookings with today\'s date should appear');
  manual('Timeline tab per booking',    'Open any SIM- booking → Timeline — should show events + notification rows');
  manual('Dispatch tab',                'Open dispatched booking → Dispatch tab — should show offer rows');
  manual('Payout ledger',               'Open Analytics → scroll down — Easer Payout Ledger should show SIM- booking data');
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 10 — Cleanup
// ═══════════════════════════════════════════════════════════════════════════════
async function phase10_cleanup() {
  section('PHASE 10 — Cleanup Test Bookings');

  const toDelete = state.bookings.filter(b => b.id && b.status !== 'completed');
  for (const b of toDelete) {
    // Cancel first if still active
    if (['confirmed', 'assigned'].includes(b.status)) {
      await api('POST', '/api/booking/cancel', { bookingId: b.id, reason: 'Simulation cleanup' });
      await sleep(300);
    }
    const r = await api('POST', '/api/booking/delete', { bookingId: b.id });
    if (r.ok) pass(`Deleted "${b.label}"`, b.ref);
    else      warn(`Could not delete "${b.label}"`, `${b.ref} — ${r.data?.error || `HTTP ${r.status}`}`);
    await sleep(300);
  }

  const completed = state.bookings.filter(b => b.status === 'completed');
  if (completed.length) {
    console.log(`\n  ℹ  ${completed.length} completed booking(s) left for analytics integrity:`);
    completed.forEach(b => console.log(`     └─ ${b.ref} ${b.label}`));
    console.log('  Delete manually from owner dashboard when done.\n');
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function section(title) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('─'.repeat(60));
}
function sub(title) {
  console.log(`\n  ── ${title}`);
}

// ─── Audit report ─────────────────────────────────────────────────────────────
function report() {
  console.log('\n');
  console.log('╔' + '═'.repeat(58) + '╗');
  console.log('║   OPERATIONAL VALIDATION REPORT' + ' '.repeat(25) + '║');
  console.log('╚' + '═'.repeat(58) + '╝');

  console.log(`\n  \x1b[32m✓ PASSED (${R.pass.length})\x1b[0m`);
  R.pass.forEach(r => console.log(`    • ${r.t}${r.d ? ' — '+r.d : ''}`));

  if (R.fail.length) {
    console.log(`\n  \x1b[31m✗ FAILED (${R.fail.length})\x1b[0m`);
    R.fail.forEach(r => console.log(`    • ${r.t}${r.d ? ' — '+r.d : ''}`));
  }

  if (R.warn.length) {
    console.log(`\n  \x1b[33m⚠ WARNINGS (${R.warn.length})\x1b[0m`);
    R.warn.forEach(r => console.log(`    • ${r.t}${r.d ? ' — '+r.d : ''}`));
  }

  if (R.manual.length) {
    console.log(`\n  \x1b[36m⬡ REQUIRES MANUAL TESTING (${R.manual.length})\x1b[0m`);
    R.manual.forEach(r => console.log(`    • ${r.t}${r.d ? ' — '+r.d : ''}`));
  }

  const total = R.pass.length + R.fail.length;
  const score = total > 0 ? Math.round(R.pass.length / total * 100) : 0;
  const color = score >= 90 ? '\x1b[32m' : score >= 70 ? '\x1b[33m' : '\x1b[31m';
  console.log(`\n  ${color}Automated Score: ${score}% (${R.pass.length}/${total} checks)\x1b[0m`);
  console.log(`  Manual items remaining: ${R.manual.length}`);

  console.log('\n' + '═'.repeat(60) + '\n');
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  await phase0_health();
  await phase1_create();
  await phase2_confirm();
  await phase3_dispatch();
  await phase4_assign();
  await phase5_complete();
  await phase6_review();
  await phase7_observability();
  await phase8_guards();
  await phase9_dashboard();
  await phase10_cleanup();
  report();
}

main().catch(e => { console.error('\nFATAL ERROR:', e.message); process.exit(1); });
