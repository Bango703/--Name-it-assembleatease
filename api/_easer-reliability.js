// Easer reliability: strikes (record, count, pause, excuse) and going offline
// when offers go unanswered.
//
// Policy numbers and the classification rule live in _source-of-truth.js
// (EASER_RELIABILITY_POLICY, classifyEaserCancellation). This module only
// stores and counts. Everything is a row in activity_logs so it is on the
// booking timeline the owner already reads:
//   easer_cancelled             metadata { easerId, kind, strikes, hoursUntilStart, reason }
//   easer_strike                metadata { easerId, kind: late_arrival|quality|damage, strikes, note }
//   easer_cancellation_excused  metadata { easerId, excusedLogId, excusedBy }
//   easer_reliability_paused    metadata { easerId, strikes }
//   offer_unanswered            metadata { easerId, offerId }   (actor_id = Easer)
//   easer_auto_offline          metadata { easerId, unanswered } (actor_id = Easer)
// No new table or column, so there is no migration to run before this works.

import { EASER_RELIABILITY_POLICY } from './_source-of-truth.js';

const STRIKE_EVENT_TYPES = ['easer_cancelled', 'easer_strike'];

// Problems on a job the owner confirms after checking (owner, 2026-10-28).
export const CONFIRMED_ISSUES = Object.freeze({
  late_arrival: {
    strikes: EASER_RELIABILITY_POLICY.lateArrivalStrikes,
    label: 'Late arrival (30+ minutes, confirmed)',
    statuses: ['confirmed', 'en_route', 'arrived', 'in_progress', 'completed'],
    pausesNow: false,
  },
  quality: {
    strikes: EASER_RELIABILITY_POLICY.qualityStrikes,
    label: 'Workmanship problem (confirmed)',
    statuses: ['in_progress', 'completed'],
    pausesNow: false,
  },
  damage: {
    strikes: EASER_RELIABILITY_POLICY.damageStrikes,
    label: 'Property damage (confirmed)',
    statuses: ['arrived', 'in_progress', 'completed'],
    pausesNow: true,
  },
});

export function reliabilityWindowStartIso(nowMs = Date.now()) {
  return new Date(nowMs - EASER_RELIABILITY_POLICY.windowDays * 86400000).toISOString();
}

// Strike totals for several Easers at once. Returns Map<easerId, { strikes, events }>.
// Throws on a read error; callers decide whether to fail open (dispatch) or closed.
export async function loadEaserStrikes(sb, easerIds, { nowMs = Date.now() } = {}) {
  const ids = [...new Set((easerIds || []).filter(Boolean))];
  const out = new Map(ids.map((id) => [id, { strikes: 0, events: [] }]));
  if (!ids.length) return out;
  const { data, error } = await sb
    .from('activity_logs')
    .select('id, booking_id, event_type, metadata, created_at')
    .in('event_type', [...STRIKE_EVENT_TYPES, 'easer_cancellation_excused'])
    .gte('created_at', reliabilityWindowStartIso(nowMs))
    .order('created_at', { ascending: true });
  if (error) throw new Error(`Reliability history could not be read: ${error.message}`);
  const excused = new Set();
  for (const row of data || []) {
    if (row.event_type === 'easer_cancellation_excused' && row.metadata?.excusedLogId) excused.add(row.metadata.excusedLogId);
  }
  for (const row of data || []) {
    if (!STRIKE_EVENT_TYPES.includes(row.event_type)) continue;
    const easerId = row.metadata?.easerId;
    if (!out.has(easerId)) continue;
    const strikes = Number(row.metadata?.strikes || 0);
    const isExcused = excused.has(row.id);
    const entry = out.get(easerId);
    entry.events.push({
      logId: row.id,
      bookingId: row.booking_id,
      kind: row.metadata?.kind || null,
      strikes,
      excused: isExcused,
      reason: row.metadata?.reason || row.metadata?.note || null,
      hoursUntilStart: row.metadata?.hoursUntilStart ?? null,
      createdAt: row.created_at,
    });
    if (!isExcused) entry.strikes += strikes;
  }
  return out;
}

export async function loadEaserStrikeSummary(sb, easerId, opts) {
  const map = await loadEaserStrikes(sb, [easerId], opts);
  const entry = map.get(easerId) || { strikes: 0, events: [] };
  return {
    ...entry,
    windowDays: EASER_RELIABILITY_POLICY.windowDays,
    pauseAtStrikes: EASER_RELIABILITY_POLICY.pauseAtStrikes,
  };
}

// Record an Easer cancellation. Checked write: a strike that silently fails to
// save would make every reliability number wrong.
export async function recordEaserCancellation(sb, { booking, easerId, easerName, classification, reason = null, note = null }) {
  const { data, error } = await sb.from('activity_logs').insert({
    booking_id: booking.id,
    event_type: 'easer_cancelled',
    actor_type: 'easer',
    actor_id: easerId,
    actor_name: easerName,
    description: classification.strikes > 0
      ? `${easerName} cancelled an accepted job (${classification.kind.replace('_', '-')}): ${classification.strikes} reliability strike${classification.strikes === 1 ? '' : 's'}`
      : `${easerName} cancelled an accepted job (${classification.kind}): no strike`,
    metadata: {
      easerId,
      kind: classification.kind,
      strikes: classification.strikes,
      hoursUntilStart: classification.hoursUntilStart == null ? null : Math.round(classification.hoursUntilStart * 10) / 10,
      minutesSinceAccept: Number.isFinite(classification.minutesSinceAccept) ? Math.round(classification.minutesSinceAccept) : null,
      reason,
      note,
      ref: booking.ref || null,
    },
  }).select('id').single();
  if (error) return { ok: false, error: error.message };
  return { ok: true, logId: data.id };
}

// Pause an Easer who has reached the strike limit. Compare-and-set on
// status='active' so it never overrides an owner's own decision.
// `force` pauses below the limit (confirmed property damage pauses at once).
export async function pauseEaserIfOverLimit(sb, { easerId, easerName, strikes, bookingId = null, force = false, why = null }) {
  if (!force && strikes < EASER_RELIABILITY_POLICY.pauseAtStrikes) return { paused: false };
  const { data, error } = await sb.from('profiles')
    .update({ status: 'suspended', is_available: false })
    .eq('id', easerId)
    .eq('status', 'active')
    .select('id');
  if (error) return { paused: false, error: error.message };
  if (!data?.length) return { paused: false, alreadyInactive: true };
  await sb.from('activity_logs').insert({
    booking_id: bookingId,
    event_type: 'easer_reliability_paused',
    actor_type: 'system',
    actor_name: 'reliability',
    description: why
      ? `${easerName} paused from new jobs: ${why}. Owner reviews reactivation.`
      : `${easerName} paused from new jobs: ${strikes} reliability strikes in ${EASER_RELIABILITY_POLICY.windowDays} days. Owner reviews reactivation.`,
    metadata: { easerId, strikes, ...(why ? { why } : {}) },
  });
  return { paused: true };
}

// Owner excuses one cancellation (for a real emergency). Does not unpause:
// reactivation stays an explicit owner decision.
export async function excuseEaserCancellation(sb, { logId, excusedBy = 'Owner', note = null }) {
  const { data: row, error } = await sb.from('activity_logs')
    .select('id, booking_id, event_type, metadata')
    .eq('id', logId)
    .maybeSingle();
  if (error) return { ok: false, status: 503, error: 'Cancellation history could not be read.' };
  if (!row || !STRIKE_EVENT_TYPES.includes(row.event_type)) return { ok: false, status: 404, error: 'Strike not found.' };
  const easerId = row.metadata?.easerId;
  const { data: existing } = await sb.from('activity_logs')
    .select('id')
    .eq('event_type', 'easer_cancellation_excused')
    .contains('metadata', { excusedLogId: logId })
    .limit(1);
  if (existing?.length) return { ok: true, alreadyExcused: true, easerId };
  const { error: insertError } = await sb.from('activity_logs').insert({
    booking_id: row.booking_id,
    event_type: 'easer_cancellation_excused',
    actor_type: 'owner',
    actor_name: excusedBy,
    description: `Owner excused a cancellation (${row.metadata?.strikes || 0} strike${row.metadata?.strikes === 1 ? '' : 's'} removed)${note ? ': ' + note : ''}`,
    metadata: { easerId, excusedLogId: logId, excusedBy, note },
  });
  if (insertError) return { ok: false, status: 503, error: 'The excusal could not be saved.' };
  return { ok: true, easerId };
}

// Record an owner-confirmed problem on a job (CONFIRMED_ISSUES). One per
// booking, Easer and kind. Checked write, like a cancellation strike.
export async function recordConfirmedIssue(sb, { booking, easerId, easerName, kind, note = null }) {
  const issue = CONFIRMED_ISSUES[kind];
  if (!issue) return { ok: false, status: 400, error: 'Unknown issue type.' };
  const { data: existing, error: existingError } = await sb.from('activity_logs')
    .select('id').eq('booking_id', booking.id).eq('event_type', 'easer_strike')
    .contains('metadata', { easerId, kind }).limit(1);
  if (existingError) return { ok: false, status: 503, error: 'Reliability history could not be read.' };
  if (existing?.length) return { ok: true, alreadyRecorded: true, logId: existing[0].id };
  const { data, error } = await sb.from('activity_logs').insert({
    booking_id: booking.id,
    event_type: 'easer_strike',
    actor_type: 'owner',
    actor_id: easerId,
    actor_name: 'Owner',
    description: `${issue.label} on ${booking.ref || 'this job'} for ${easerName}: ${issue.strikes} reliability strike${issue.strikes === 1 ? '' : 's'}${note ? ' (' + note + ')' : ''}`,
    metadata: { easerId, kind, strikes: issue.strikes, note, ref: booking.ref || null },
  }).select('id').single();
  if (error) return { ok: false, status: 503, error: 'The strike could not be saved. Nothing was changed.' };
  return { ok: true, logId: data.id };
}

// ── Online but not answering ────────────────────────────────────────────────
// An Easer who stays online and lets offers expire leaves customers waiting on
// someone who is not there. After unansweredOffersOffline different jobs in a
// row go unanswered (no accept or decline since, inside the window), the Easer
// is set offline and told how to come back. It is not a strike.

function unansweredWindowStartIso(nowMs) {
  return new Date(nowMs - EASER_RELIABILITY_POLICY.unansweredWindowDays * 86400000).toISOString();
}

// Record offers that just expired with no answer. `offers` are dispatch_offers
// rows { id, booking_id, easer_id }. A job counts once per Easer, however many
// times its offer is renewed and expires again. Returns the Easer ids touched.
export async function recordUnansweredOffers(sb, offers, { nowMs = Date.now() } = {}) {
  const windowStart = unansweredWindowStartIso(nowMs);
  const touched = new Set();
  for (const offer of offers || []) {
    if (!offer?.easer_id || !offer?.booking_id) continue;
    const { data: existing, error } = await sb.from('activity_logs')
      .select('id').eq('booking_id', offer.booking_id).eq('event_type', 'offer_unanswered')
      .eq('actor_id', offer.easer_id).gte('created_at', windowStart).limit(1);
    if (error) { console.error('[reliability] unanswered lookup failed:', error.message); continue; }
    touched.add(offer.easer_id);
    if (existing?.length) continue;
    const { error: insertError } = await sb.from('activity_logs').insert({
      booking_id: offer.booking_id,
      event_type: 'offer_unanswered',
      actor_type: 'easer',
      actor_id: offer.easer_id,
      actor_name: 'Easer',
      description: 'Job offer expired with no answer',
      metadata: { easerId: offer.easer_id, offerId: offer.id },
    });
    if (insertError) console.error('[reliability] unanswered record failed:', insertError.message);
  }
  return [...touched];
}

// How many different jobs in a row this Easer has left unanswered: offers that
// expired after their last accept or decline (dispatch offer or owner
// assignment) and after they were last set offline for this.
export async function unansweredStreak(sb, easerId, { nowMs = Date.now() } = {}) {
  const windowStart = unansweredWindowStartIso(nowMs);
  const [offers, decisions, events] = await Promise.all([
    sb.from('dispatch_offers').select('accepted_at, declined_at')
      .eq('easer_id', easerId).gte('created_at', windowStart)
      .or('accepted_at.not.is.null,declined_at.not.is.null'),
    sb.from('activity_logs').select('created_at')
      .eq('actor_id', easerId).in('event_type', ['easer_accepted', 'assignment_declined'])
      .gte('created_at', windowStart),
    sb.from('activity_logs').select('booking_id, event_type, created_at')
      .eq('actor_id', easerId).in('event_type', ['offer_unanswered', 'easer_auto_offline'])
      .gte('created_at', windowStart),
  ]);
  const failed = [offers, decisions, events].find(r => r.error);
  if (failed) throw new Error(`Offer history could not be read: ${failed.error.message}`);
  let since = Date.parse(windowStart);
  for (const o of offers.data || []) {
    for (const t of [o.accepted_at, o.declined_at]) if (t) since = Math.max(since, Date.parse(t));
  }
  for (const d of decisions.data || []) since = Math.max(since, Date.parse(d.created_at));
  for (const e of events.data || []) {
    if (e.event_type === 'easer_auto_offline') since = Math.max(since, Date.parse(e.created_at));
  }
  const jobs = new Set();
  for (const e of events.data || []) {
    if (e.event_type === 'offer_unanswered' && e.booking_id && Date.parse(e.created_at) > since) jobs.add(e.booking_id);
  }
  return jobs.size;
}

// Set an Easer offline when the streak reaches the limit. Compare-and-set on
// is_available so an Easer who already went offline is left alone.
export async function setOfflineIfUnanswered(sb, easerId, { nowMs = Date.now() } = {}) {
  const streak = await unansweredStreak(sb, easerId, { nowMs });
  if (streak < EASER_RELIABILITY_POLICY.unansweredOffersOffline) return { offline: false, streak };
  const { data, error } = await sb.from('profiles')
    .update({ is_available: false })
    .eq('id', easerId)
    .eq('is_available', true)
    .select('id, full_name, email, phone, sms_consent_at, sms_opted_out_at');
  if (error) return { offline: false, streak, error: error.message };
  if (!data?.length) return { offline: false, streak, alreadyOffline: true };
  await sb.from('activity_logs').insert({
    booking_id: null,
    event_type: 'easer_auto_offline',
    actor_type: 'system',
    actor_id: easerId,
    actor_name: 'reliability',
    description: `${data[0].full_name || 'Easer'} set offline: offers for ${streak} jobs in a row expired with no answer`,
    metadata: { easerId, unanswered: streak },
  });
  return { offline: true, streak, easer: data[0] };
}
