// Easer cancellation strikes: record, count, pause, excuse.
//
// Policy numbers and the classification rule live in _source-of-truth.js
// (EASER_RELIABILITY_POLICY, classifyEaserCancellation). This module only
// stores and counts. Strikes are rows in activity_logs so every one is on the
// booking timeline the owner already reads:
//   easer_cancelled             metadata { easerId, kind, strikes, hoursUntilStart, reason }
//   easer_cancellation_excused  metadata { easerId, excusedLogId, excusedBy }
//   easer_reliability_paused    metadata { easerId, strikes }
// No new table or column, so there is no migration to run before this works.

import { EASER_RELIABILITY_POLICY } from './_source-of-truth.js';

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
    .in('event_type', ['easer_cancelled', 'easer_cancellation_excused'])
    .gte('created_at', reliabilityWindowStartIso(nowMs))
    .order('created_at', { ascending: true });
  if (error) throw new Error(`Reliability history could not be read: ${error.message}`);
  const excused = new Set();
  for (const row of data || []) {
    if (row.event_type === 'easer_cancellation_excused' && row.metadata?.excusedLogId) excused.add(row.metadata.excusedLogId);
  }
  for (const row of data || []) {
    if (row.event_type !== 'easer_cancelled') continue;
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
      reason: row.metadata?.reason || null,
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
export async function pauseEaserIfOverLimit(sb, { easerId, easerName, strikes, bookingId = null }) {
  if (strikes < EASER_RELIABILITY_POLICY.pauseAtStrikes) return { paused: false };
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
    description: `${easerName} paused from new jobs: ${strikes} reliability strikes in ${EASER_RELIABILITY_POLICY.windowDays} days. Owner reviews reactivation.`,
    metadata: { easerId, strikes },
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
  if (!row || row.event_type !== 'easer_cancelled') return { ok: false, status: 404, error: 'Cancellation not found.' };
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
