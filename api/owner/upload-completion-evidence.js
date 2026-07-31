import crypto from 'crypto';
import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';
import { logActivity } from '../booking/_activity.js';

export const config = { api: { bodyParser: { sizeLimit: '10mb' } } };

const BUCKET = 'booking-evidence';
const MAX_RAW_BYTES = 5 * 1024 * 1024;
const MIME_EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
};

function matchesMagic(mimeType, buf) {
  if (mimeType === 'image/jpeg') return buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF;
  if (mimeType === 'image/png') return buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47;
  if (mimeType === 'image/webp') {
    return buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP';
  }
  if (mimeType === 'image/heic' || mimeType === 'image/heif') {
    return buf.length >= 12 && buf.slice(4, 8).toString('ascii') === 'ftyp';
  }
  return false;
}

async function cleanupStorage(sb, storagePath) {
  try {
    const { error } = await sb.storage.from(BUCKET).remove([storagePath]);
    return { ok: !error, error: error?.message || null };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const payload = req.body && typeof req.body === 'object' ? req.body : {};
  const bookingId = String(payload.bookingId || '').trim();
  const mimeType = String(payload.mimeType || '').trim().toLowerCase();
  const notes = String(payload.notes || '').trim().slice(0, 2000);
  const fileBase64 = typeof payload.fileBase64 === 'string' ? payload.fileBase64 : '';
  if (!isUuid(bookingId) || !fileBase64) return res.status(400).json({ error: 'A valid booking and evidence file are required.' });
  if (!Object.hasOwn(MIME_EXT, mimeType)) return res.status(400).json({ error: 'Use a JPEG, PNG, WebP, HEIC, or HEIF image.' });
  if (notes.length < 10) return res.status(400).json({ error: 'Add a short note explaining what this completion evidence shows.' });

  const raw = fileBase64.includes(',') ? fileBase64.split(',')[1] : fileBase64;
  let buf;
  try {
    buf = Buffer.from(raw, 'base64');
  } catch {
    return res.status(400).json({ error: 'The evidence file could not be decoded.' });
  }
  if (!buf.length || buf.length > MAX_RAW_BYTES) {
    return res.status(400).json({ error: 'Evidence must be a non-empty image no larger than 5 MB.' });
  }
  if (!matchesMagic(mimeType, buf)) {
    return res.status(400).json({ error: 'The evidence file content does not match its image type.' });
  }

  const sb = getSupabase();
  const { data: booking, error: bookingError } = await sb
    .from('bookings')
    .select('id, ref, source, status, payment_status, assembler_id, assembler_name, financial_operation_key, financial_operation_type, financial_operation_started_at')
    .eq('id', bookingId)
    .maybeSingle();
  if (bookingError || !booking) return res.status(404).json({ error: 'Booking not found' });
  if (booking.source !== 'owner_manual'
      || booking.status !== 'completed'
      || booking.payment_status !== 'offline_recorded'
      || !booking.assembler_id) {
    return res.status(409).json({
      error: 'Link this completed owner booking to the owner-Easer before uploading historical evidence.',
      code: 'OWNER_EASER_LINK_REQUIRED',
    });
  }

  const { data: ownerEaser, error: ownerEaserError } = await sb
    .from('profiles')
    .select('id, full_name, is_owner, role')
    .eq('id', booking.assembler_id)
    .eq('role', 'assembler')
    .eq('is_owner', true)
    .maybeSingle();
  if (ownerEaserError || !ownerEaser) {
    return res.status(409).json({
      error: 'Historical evidence is limited to the configured owner-Easer account.',
      code: 'OWNER_EASER_REQUIRED',
    });
  }

  const month = new Date().toISOString().slice(0, 7);
  const storagePath = `evidence/${booking.id}/${month}/${crypto.randomUUID()}.${MIME_EXT[mimeType]}`;
  const { error: uploadError } = await sb.storage.from(BUCKET).upload(storagePath, buf, {
    contentType: mimeType,
    upsert: false,
  });
  if (uploadError) {
    console.error('Owner historical evidence upload failed:', uploadError);
    return res.status(503).json({ error: 'Evidence upload failed. Nothing was recorded.' });
  }

  const { data: rows, error: recordError } = await sb.rpc('record_owner_manual_completion_evidence', {
    p_booking_id: booking.id,
    p_uploaded_by: ownerEaser.id,
    p_storage_path: storagePath,
    p_mime_type: mimeType,
    p_file_size_bytes: buf.length,
    p_notes: notes,
  });
  const recorded = Array.isArray(rows) ? rows[0] : rows;
  if (recordError || !recorded) {
    const cleanup = await cleanupStorage(sb, storagePath);
    console.error('Owner historical evidence record failed:', recordError || 'no row returned');
    const migrationMissing = /record_owner_manual_completion_evidence|does not exist/i.test(String(recordError?.message || ''));
    return res.status(migrationMissing ? 503 : 409).json({
      error: migrationMissing
        ? 'Historical evidence storage is unavailable. Apply migration 047 and retry.'
        : (recordError?.message || (cleanup.ok
          ? 'Evidence was not recorded; the uploaded file was removed.'
          : 'Evidence was not recorded and storage cleanup requires review. Do not upload it again yet.')),
      code: migrationMissing ? 'MIGRATION_047_REQUIRED' : 'OWNER_EVIDENCE_CONFLICT',
      storageCleanupFailed: cleanup.ok ? undefined : true,
    });
  }

  const activity = await logActivity(sb, {
    bookingId: booking.id,
    eventType: 'completion_evidence_added',
    actorType: 'owner',
    actorId: ownerEaser.id,
    actorName: ownerEaser.full_name || 'Owner-Easer',
    description: 'Owner added historical completion evidence after the job was completed.',
    metadata: { evidenceId: recorded.evidence_id, notes },
  });

  return res.status(201).json({
    ok: true,
    evidenceId: recorded.evidence_id,
    bookingRef: booking.ref,
    evidenceType: recorded.evidence_type,
    mimeType: recorded.mime_type,
    sizeBytes: recorded.file_size_bytes,
    createdAt: recorded.created_at,
    timelineLogged: activity.ok,
    timelineWarning: activity.ok ? undefined : 'Evidence was saved, but its timeline entry needs review.',
  });
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}
