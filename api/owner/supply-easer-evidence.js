import crypto from 'crypto';
import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';
import { logActivity } from '../booking/_activity.js';

/**
 * POST /api/owner/supply-easer-evidence
 *
 * The owner supplies completion evidence FOR an Easer who could not upload it.
 *
 * WHY THIS EXISTS
 * Requesting evidence sets bookings.evidence_requested_at, which holds the
 * payout until a completion photo exists for the assigned Easer. If that Easer
 * cannot upload — phone died, left the platform, lost the photo, stopped
 * answering — the money is stranded and the owner has no way to release it.
 *
 * WHAT IT DOES NOT DO
 * It does not write a false author. uploaded_by is literally the uploader;
 * the Easer it was supplied for is recorded in uploaded_on_behalf_of, and
 * the timeline says the OWNER did this. The owner may then complete the job
 * through their own completion path — which is the point, because otherwise
 * an Easer who cannot upload deadlocks the job forever.
 *
 * Evidence with the wrong author is worse than no evidence, because it looks
 * trustworthy in exactly the dispute where trustworthiness matters.
 *
 * The historical owner-manual path (api/owner/upload-completion-evidence.js)
 * is untouched — that one covers the owner's OWN jobs and goes through its own
 * RPC. This covers a real Easer's job.
 *
 * Body: { bookingId, fileBase64, mimeType, notes }
 */

const BUCKET = 'booking-evidence';
const MIME_EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
};
const MAX_BYTES = 5 * 1024 * 1024;

const MAGIC = {
  'image/jpeg': buf => buf.length > 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF,
  'image/png': buf => buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])),
  'image/webp': buf => buf.length > 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP',
  'image/heic': buf => buf.length > 12 && buf.subarray(4, 8).toString('ascii') === 'ftyp',
  'image/heif': buf => buf.length > 12 && buf.subarray(4, 8).toString('ascii') === 'ftyp',
};

const isUuid = v => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

async function cleanupStorage(sb, path) {
  try {
    const { error } = await sb.storage.from(BUCKET).remove([path]);
    return { ok: !error };
  } catch { return { ok: false }; }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const { bookingId, fileBase64, mimeType } = req.body || {};
  const notes = String(req.body?.notes || '').trim().slice(0, 2000);

  if (!isUuid(bookingId) || !fileBase64) {
    return res.status(400).json({ error: 'A valid booking and evidence file are required.' });
  }
  if (!Object.hasOwn(MIME_EXT, mimeType)) {
    return res.status(400).json({ error: 'Use a JPEG, PNG, WebP, HEIC, or HEIF image.' });
  }
  // A note is required. Evidence supplied by someone who was not on site needs
  // to say where it came from, or it is an unexplained photo in the record.
  if (notes.length < 10) {
    return res.status(400).json({ error: 'Add a short note explaining where this photo came from and who provided it.' });
  }

  let buf;
  try {
    buf = Buffer.from(String(fileBase64).replace(/^data:[^;]+;base64,/, ''), 'base64');
  } catch {
    return res.status(400).json({ error: 'The evidence file could not be decoded.' });
  }
  if (!buf.length || buf.length > MAX_BYTES) {
    return res.status(400).json({ error: 'Evidence must be a non-empty image no larger than 5 MB.' });
  }
  if (!MAGIC[mimeType]?.(buf)) {
    return res.status(400).json({ error: 'The evidence file content does not match its image type.' });
  }

  const sb = getSupabase();

  const { data: booking, error: bookingError } = await sb
    .from('bookings')
    .select('id, ref, status, assembler_id, assembler_name, job_started_at, completed_at, evidence_requested_at')
    .eq('id', bookingId)
    .maybeSingle();
  if (bookingError || !booking) return res.status(404).json({ error: 'Booking not found' });

  // Work must have STARTED, not finished. Requiring completion created a
  // deadlock: an Easer who cannot upload cannot press Complete, the owner
  // cannot complete the job either (complete.js needs a photo), and the owner
  // could not supply one because the job was not complete. The job stuck in
  // progress forever with money held behind it.
  const workStarted = Boolean(booking.job_started_at) || booking.status === 'completed';
  if (!workStarted) {
    return res.status(409).json({
      error: 'This job has not started yet, so there is no completed work to document.',
      code: 'WORK_NOT_STARTED',
    });
  }
  if (['cancelled', 'declined', 'refunded'].includes(String(booking.status || '').toLowerCase())) {
    return res.status(409).json({
      error: `This job is ${booking.status}. Completion evidence does not apply.`,
      code: 'JOB_NOT_LIVE',
    });
  }
  if (!booking.assembler_id) {
    return res.status(409).json({
      error: 'This job has no assigned Easer, so there is nobody to supply evidence for.',
      code: 'NO_EASER',
    });
  }

  // The owner's identity in the system. uploaded_by references profiles, and it
  // must name a real person rather than borrowing the Easer's id.
  const { data: ownerProfile } = await sb
    .from('profiles')
    .select('id, full_name')
    .eq('is_owner', true)
    .maybeSingle();
  if (!ownerProfile) {
    return res.status(409).json({
      error: 'No owner profile is configured, so the upload cannot be attributed to anyone.',
      code: 'OWNER_PROFILE_MISSING',
    });
  }
  // Supplying evidence for yourself is just uploading it — that is the existing
  // owner-manual path, and the DB CHECK rejects on_behalf_of = uploaded_by.
  if (ownerProfile.id === booking.assembler_id) {
    return res.status(409).json({
      error: 'You are the assigned Easer on this job. Use the historical evidence upload instead.',
      code: 'USE_OWNER_MANUAL_UPLOAD',
    });
  }

  const month = new Date().toISOString().slice(0, 7);
  const storagePath = `evidence/${booking.id}/${month}/${crypto.randomUUID()}.${MIME_EXT[mimeType]}`;
  const { error: uploadError } = await sb.storage.from(BUCKET).upload(storagePath, buf, {
    contentType: mimeType,
    upsert: false,
  });
  if (uploadError) {
    console.error('[supply-easer-evidence] upload failed:', uploadError);
    return res.status(503).json({ error: 'Evidence upload failed. Nothing was recorded.' });
  }

  // created_at must sit inside the window the payout check accepts, which is
  // "after work started, and after any evidence request". NOW() satisfies both
  // for a completed job.
  const { data: inserted, error: recordError } = await sb
    .from('booking_evidence')
    .insert({
      booking_id: booking.id,
      uploaded_by: ownerProfile.id,
      uploaded_on_behalf_of: booking.assembler_id,
      storage_path: storagePath,
      evidence_type: 'completion_photo',
      mime_type: mimeType,
      file_size_bytes: buf.length,
      // INTERNAL by default, exactly like an Easer upload. Supplying evidence
      // does not publish it — the owner still has to share it deliberately.
      visibility: 'owner',
      notes,
    })
    .select('id')
    .single();

  if (recordError || !inserted) {
    const cleanup = await cleanupStorage(sb, storagePath);
    console.error('[supply-easer-evidence] record failed:', recordError?.message || recordError);
    const columnMissing = /uploaded_on_behalf_of/i.test(String(recordError?.message || ''));
    return res.status(columnMissing ? 503 : 409).json({
      error: columnMissing
        ? 'Supplying evidence for an Easer needs migration 084. Apply it and retry.'
        : (recordError?.message || 'Evidence was not recorded.'),
      code: columnMissing ? 'MIGRATION_084_REQUIRED' : 'EVIDENCE_RECORD_FAILED',
      storageCleanupFailed: cleanup.ok ? undefined : true,
    });
  }

  // The timeline says who actually did this. An Easer reading their own job
  // history must not find a photo they never took attributed to them.
  await logActivity(sb, {
    bookingId: booking.id,
    eventType: 'completion_evidence_added',
    actorType: 'owner',
    actorName: ownerProfile.full_name || 'Owner',
    description: `Owner supplied a completion photo on behalf of ${booking.assembler_name || 'the Easer'}`,
    metadata: { evidenceId: inserted.id, onBehalfOf: booking.assembler_id, notes },
  }).catch(() => {});

  return res.status(200).json({
    ok: true,
    evidenceId: inserted.id,
    onBehalfOf: booking.assembler_id,
    // The owner's next question is always "does this release the money?"
    releasesPayoutHold: Boolean(booking.evidence_requested_at),
  });
}
