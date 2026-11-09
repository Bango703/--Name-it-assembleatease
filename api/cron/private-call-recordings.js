import { getSupabase } from '../_supabase.js';
import { logActivity } from '../booking/_activity.js';
import { logCron } from './_cron-logger.js';

/**
 * GET /api/cron/private-call-recordings — daily.
 *
 * Private call recordings are kept 90 days, then deleted from Telnyx (which
 * would otherwise keep them a year). The written summary on the booking
 * timeline stays. Each deletion is recorded, so a recording is never deleted
 * twice and the owner can see when it went.
 */
export const RECORDING_RETENTION_DAYS = 90;
const BATCH = 50;

export default async function handler(req, res, deps = {}) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers?.authorization !== 'Bearer ' + cronSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const started = Date.now();
  const sb = deps.sb || getSupabase();
  const apiKey = String(process.env.TELNYX_API_KEY || '').trim();
  const now = deps.now || Date.now();
  const cutoff = new Date(now - RECORDING_RETENTION_DAYS * 86400000).toISOString();
  const log = deps.log || logActivity;
  const remove = deps.remove || ((id) => deleteRecording(apiKey, id));

  const { data: recorded, error } = await sb.from('activity_logs')
    .select('id, booking_id, created_at, metadata')
    .eq('event_type', 'private_call_recorded')
    .lte('created_at', cutoff)
    .order('created_at', { ascending: true })
    .limit(BATCH);
  if (error) {
    await logCron('private-call-recordings', { status: 'error', error: error.message, duration: Date.now() - started });
    return res.status(500).json({ error: 'Recording list could not be read.' });
  }
  const candidates = (recorded || []).filter((row) => row.metadata?.recordingId);
  if (!candidates.length) {
    await logCron('private-call-recordings', { status: 'ok', records: 0, duration: Date.now() - started });
    return res.status(200).json({ deleted: 0 });
  }

  const ids = candidates.map((row) => row.metadata.recordingId);
  const { data: done, error: doneError } = await sb.from('activity_logs')
    .select('metadata')
    .eq('event_type', 'private_call_recording_deleted')
    .in('metadata->>recordingId', ids);
  if (doneError) {
    await logCron('private-call-recordings', { status: 'error', error: doneError.message, duration: Date.now() - started });
    return res.status(500).json({ error: 'Deletion history could not be read.' });
  }
  const already = new Set((done || []).map((row) => row.metadata?.recordingId));

  let deleted = 0;
  let failed = 0;
  if (!apiKey && !deps.remove) {
    await logCron('private-call-recordings', { status: 'error', error: 'TELNYX_API_KEY not set', duration: Date.now() - started });
    return res.status(503).json({ error: 'Telnyx is not configured.' });
  }
  for (const row of candidates) {
    const recordingId = row.metadata.recordingId;
    if (already.has(recordingId)) continue;
    const result = await remove(recordingId);
    if (!result.ok) { failed++; continue; }
    deleted++;
    await log(sb, {
      bookingId: row.booking_id, eventType: 'private_call_recording_deleted', actorType: 'system', actorName: 'private_call_recordings',
      description: `Call recording deleted after ${RECORDING_RETENTION_DAYS} days. The summary stays on this booking.`,
      metadata: { recordingId, recordedAt: row.created_at, alreadyGone: result.alreadyGone === true },
    }).catch(() => {});
  }
  await logCron('private-call-recordings', { status: failed ? 'error' : 'ok', records: deleted, errorText: failed ? `${failed} recording(s) could not be deleted; retried tomorrow` : null, duration: Date.now() - started });
  return res.status(200).json({ deleted, failed });
}

/** DELETE one Telnyx recording. A recording already gone counts as deleted. Never throws. */
export async function deleteRecording(apiKey, recordingId, fetchImpl = fetch) {
  try {
    const resp = await fetchImpl(`https://api.telnyx.com/v2/recordings/${encodeURIComponent(recordingId)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (resp.ok) return { ok: true };
    if (resp.status === 404) return { ok: true, alreadyGone: true };
    return { ok: false, error: `HTTP ${resp.status}` };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}
