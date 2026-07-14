import { getSupabase } from '../_supabase.js';
import { requireAssignedWorkEaser, respondWithEaserAccessError } from '../_easer-access.js';
import { sendEmail, ownerEmail, esc } from '../_email.js';
import { logActivity } from './_activity.js';

// Raise body-parser limit: base64 of a 5 MB image is ~6.7 MB JSON
export const config = { api: { bodyParser: { sizeLimit: '10mb' } } };

const BUCKET = 'booking-evidence';

const ALLOWED_MIME = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
]);

const MIME_EXT = {
  'image/jpeg': 'jpg',
  'image/png':  'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
};

// Inline magic-byte checks — no library needed
function matchesMagic(mimeType, buf) {
  switch (mimeType) {
    case 'image/jpeg':
      return buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF;
    case 'image/png':
      return buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47;
    case 'image/webp':
      return buf.slice(0, 4).toString('latin1') === 'RIFF' &&
             buf.slice(8, 12).toString('latin1') === 'WEBP';
    case 'image/heic':
    case 'image/heif':
      // HEIC/HEIF: ISO Base Media File Format — bytes 4-7 are 'ftyp'
      return buf.length >= 12 && buf.slice(4, 8).toString('ascii') === 'ftyp';
    default:
      return false;
  }
}

const VALID_EVIDENCE_TYPES = new Set([
  'completion_photo', 'before_photo', 'damage_claim',
]);

const MAX_RAW_BYTES = 5 * 1024 * 1024; // 5 MB decoded limit

function evidenceWorkflowError(booking, evidenceType) {
  if (!booking.assembler_accepted_at) {
    return { error: 'Accept this assignment before uploading job evidence.', code: 'ASSIGNMENT_NOT_ACCEPTED' };
  }
  if (booking.financial_operation_key) {
    return { error: 'A payment action is in progress. Reload the job before uploading evidence.', code: 'FINANCIAL_OPERATION_ACTIVE' };
  }
  if (evidenceType === 'before_photo' && !['arrived', 'in_progress'].includes(booking.status)) {
    return { error: 'Before photos can only be uploaded after arrival and before completion.', code: 'INVALID_EVIDENCE_WORKFLOW' };
  }
  if (evidenceType === 'completion_photo'
      && (!['in_progress', 'completed'].includes(booking.status) || !booking.job_started_at)) {
    return { error: 'Start the job before uploading the completion photo.', code: 'WORK_NOT_STARTED' };
  }
  if (evidenceType === 'damage_claim'
      && !['arrived', 'in_progress', 'completed'].includes(booking.status)) {
    return { error: 'Damage evidence can only be uploaded after arrival or for a completed job.', code: 'INVALID_EVIDENCE_WORKFLOW' };
  }
  return null;
}

async function removeUploadedObject(sb, storagePath) {
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const { error } = await sb.storage.from(BUCKET).remove([storagePath]);
      if (!error) return { ok: true };
      lastError = error;
    } catch (error) {
      lastError = error;
    }
  }
  console.error(`[upload-evidence] Storage cleanup failed for ${storagePath}:`, lastError);
  return { ok: false, error: lastError?.message || String(lastError || 'unknown cleanup error') };
}

/**
 * POST /api/booking/upload-evidence
 * Easer-only: upload a completion photo or evidence image for a booking.
 * Auth: Bearer JWT (assembler session token).
 *
 * Body (JSON):
 *   bookingId    string  required
 *   fileBase64   string  required — raw base64 or data:mime;base64,... prefix accepted
 *   mimeType     string  required — must be in ALLOWED_MIME
 *   evidenceType string  optional — default 'completion_photo'
 *   notes        string  optional
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ── Auth: Easer JWT ───────────────────────────────────────────────────────
  const sb = getSupabase(); // service key — bypasses RLS for reads/writes

  // ── Verify active assembler ───────────────────────────────────────────────
  const access = await requireAssignedWorkEaser(req, { supabase: sb });
  if (!access.ok) return respondWithEaserAccessError(res, access);
  const { user } = access;

  // ── Validate input ────────────────────────────────────────────────────────
  const payload = req.body && typeof req.body === 'object' ? req.body : {};
  const { bookingId, fileBase64, mimeType, evidenceType = 'completion_photo', notes } = payload;

  if (!bookingId) return res.status(400).json({ error: 'bookingId is required' });
  if (typeof fileBase64 !== 'string' || !fileBase64) return res.status(400).json({ error: 'fileBase64 is required' });
  if (!mimeType)   return res.status(400).json({ error: 'mimeType is required' });

  if (!ALLOWED_MIME.has(mimeType)) {
    return res.status(400).json({ error: 'Unsupported file type. Allowed: jpeg, png, webp, heic, heif' });
  }

  if (!VALID_EVIDENCE_TYPES.has(evidenceType)) {
    return res.status(400).json({ error: 'Invalid evidenceType' });
  }
  const cleanNotes = String(notes || '').trim();
  if (evidenceType === 'damage_claim' && cleanNotes.length < 10) {
    return res.status(400).json({ error: 'Damage reports require a clear description of what happened.' });
  }
  if (cleanNotes.length > 2000) {
    return res.status(400).json({ error: 'Evidence notes must be 2,000 characters or fewer.' });
  }

  // ── Verify booking ownership ──────────────────────────────────────────────
  const { data: booking, error: bookingErr } = await sb
    .from('bookings')
    .select('id, ref, service, date, time, status, assembler_id, assembler_name, assembler_accepted_at, job_started_at, financial_operation_key')
    .eq('id', bookingId)
    .eq('assembler_id', user.id)
    .maybeSingle();

  if (bookingErr || !booking) {
    return res.status(404).json({ error: 'Booking not found or not assigned to you' });
  }

  // Complete every assignment/workflow authorization gate before decoding the
  // customer-supplied base64 or writing anything to storage. The RPC repeats
  // these checks under a booking row lock to close assignment/payout races.
  const workflowError = evidenceWorkflowError(booking, evidenceType);
  if (workflowError) return res.status(409).json(workflowError);

  // ── Decode and validate file ──────────────────────────────────────────────
  // Strip data-URL prefix if present: "data:image/jpeg;base64,<data>"
  const raw = fileBase64.includes(',') ? fileBase64.split(',')[1] : fileBase64;

  let buf;
  try {
    buf = Buffer.from(raw, 'base64');
  } catch {
    return res.status(400).json({ error: 'Invalid base64 encoding' });
  }

  if (buf.length === 0) {
    return res.status(400).json({ error: 'File is empty' });
  }

  if (buf.length > MAX_RAW_BYTES) {
    return res.status(400).json({ error: 'File exceeds 5 MB limit' });
  }

  if (!matchesMagic(mimeType, buf)) {
    return res.status(400).json({ error: 'File content does not match declared MIME type' });
  }

  // ── Generate storage path ─────────────────────────────────────────────────
  // Format: evidence/{bookingId}/{YYYY-MM}/{uuid}.{ext}
  const month       = new Date().toISOString().slice(0, 7);
  const ext         = MIME_EXT[mimeType];
  const fileId      = crypto.randomUUID();
  const storagePath = `evidence/${booking.id}/${month}/${fileId}.${ext}`;

  // ── Upload to private storage bucket ─────────────────────────────────────
  const { error: uploadErr } = await sb.storage
    .from(BUCKET)
    .upload(storagePath, buf, {
      contentType: mimeType,
      upsert: false, // no overwrites — each upload gets a unique path
    });

  if (uploadErr) {
    console.error('Storage upload error:', uploadErr);
    return res.status(500).json({ error: 'Upload failed. Please try again.' });
  }

  // ── Insert booking_evidence row ───────────────────────────────────────────
  // Record the immutable evidence row and (for a damage report) open its payout
  // hold in one row-locked database transaction. The RPC also serializes the
  // five-file limit, so concurrent uploads cannot create a sixth record.
  const { data: evidenceRows, error: recordError } = await sb.rpc('record_booking_evidence', {
    p_booking_id: booking.id,
    p_uploaded_by: user.id,
    p_storage_path: storagePath,
    p_evidence_type: evidenceType,
    p_mime_type: mimeType,
    p_file_size_bytes: buf.length,
    p_notes: cleanNotes || null,
  });
  const recorded = Array.isArray(evidenceRows) ? evidenceRows[0] : evidenceRows;

  if (recordError || !recorded) {
    // No evidence row was committed; remove the just-uploaded private object.
    const cleanup = await removeUploadedObject(sb, storagePath);
    console.error(`[upload-evidence] Evidence RPC failed for ${storagePath}:`, recordError || 'no row returned');
    const conflict = ['22000', '23514', '23505', '55P03'].includes(recordError?.code);
    const forbidden = recordError?.code === '42501';
    const notFound = recordError?.code === 'P0002';
    return res.status(forbidden ? 403 : (notFound ? 404 : (conflict ? 409 : 503))).json({
      error: conflict
        ? recordError.message
        : (cleanup.ok
            ? 'Evidence could not be saved. The uploaded object was removed; please reload and try again.'
            : 'Evidence could not be saved and storage cleanup needs support review. Do not upload again yet.'),
      code: conflict ? 'EVIDENCE_WORKFLOW_CONFLICT' : 'EVIDENCE_RECORD_FAILED',
      storageCleanupFailed: cleanup.ok ? undefined : true,
    });
  }
  const evidenceRow = {
    id: recorded.evidence_id,
    evidence_type: recorded.evidence_type,
    mime_type: recorded.mime_type,
    file_size_bytes: recorded.file_size_bytes,
    created_at: recorded.created_at,
  };

  let ownerNotification = null;
  if (evidenceType === 'damage_claim') {
    await logActivity(sb, {
      bookingId: booking.id,
      eventType: 'damage_claim_reported',
      actorType: 'easer',
      actorId: user.id,
      actorName: booking.assembler_name || 'Easer',
      description: `${booking.assembler_name || 'Easer'} reported possible damage and uploaded evidence`,
      metadata: { evidenceId: evidenceRow.id, notes: cleanNotes },
    });
    ownerNotification = await sendEmail({
      to: ownerEmail(),
      from: 'AssembleAtEase <booking@assembleatease.com>',
      subject: `Owner action required: damage reported — ${booking.ref}`,
      replyTo: ownerEmail(),
      html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px">
        <h2 style="color:#991b1b">Damage report requires review</h2>
        <p><strong>${esc(booking.assembler_name || 'An Easer')}</strong> reported possible damage on booking <strong>${esc(booking.ref)}</strong>.</p>
        <p><strong>Service:</strong> ${esc(booking.service || '')}<br/><strong>Appointment:</strong> ${esc(booking.date || '')} ${esc(booking.time || '')}</p>
        <p><strong>Easer notes:</strong><br/>${esc(cleanNotes)}</p>
        <p>Open the booking timeline and evidence panel before contacting the customer or making a financial decision.</p>
        <p><a href="https://www.assembleatease.com/owner/">Open owner dashboard</a></p>
      </div>`,
      meta: { bookingId: booking.id, notificationType: 'damage_claim_reported', recipientType: 'owner', disableDedupe: true },
    }).catch(err => ({ ok: false, error: err?.message || String(err) }));
    if (!ownerNotification?.ok) {
      await logActivity(sb, {
        bookingId: booking.id,
        eventType: 'damage_claim_notification_failed',
        actorType: 'system',
        actorName: 'notifications',
        description: 'Damage evidence was saved, but the owner email failed',
        metadata: { evidenceId: evidenceRow.id, error: ownerNotification?.error || null },
      });
    }
    if (ownerNotification?.logged === false) {
      await logActivity(sb, {
        bookingId: booking.id,
        eventType: 'notification_audit_failed',
        actorType: 'system',
        actorName: 'notifications',
        description: 'Damage report owner email was attempted, but its notification log could not be saved',
        metadata: { evidenceId: evidenceRow.id, error: ownerNotification.logError || null },
      });
    }
  }
  return res.status(201).json({
    ok:           true,
    evidenceId:   evidenceRow.id,
    bookingRef:   booking.ref,
    evidenceType: evidenceRow.evidence_type,
    mimeType:     evidenceRow.mime_type,
    sizeBytes:    evidenceRow.file_size_bytes,
    createdAt:    evidenceRow.created_at,
    damageReviewStatus: recorded.damage_review_status,
    ownerNotified: evidenceType === 'damage_claim' ? ownerNotification?.ok === true && !ownerNotification?.suppressed : undefined,
    warning: evidenceType === 'damage_claim' && (!ownerNotification?.ok || ownerNotification?.logged === false)
      ? (ownerNotification?.ok
          ? 'Damage evidence was saved and the owner email was sent, but the notification audit log needs owner review.'
          : 'Damage evidence was saved, but the owner notification needs retry.')
      : undefined,
  });
}
