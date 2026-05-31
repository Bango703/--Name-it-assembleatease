import { createClient } from '@supabase/supabase-js';
import { getSupabase } from '../_supabase.js';

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
  'completion_photo', 'before_photo', 'damage_claim', 'customer_confirmation',
]);

const UPLOAD_ALLOWED_STATUSES = new Set(['arrived', 'in_progress', 'completed']);

const MAX_RAW_BYTES = 5 * 1024 * 1024; // 5 MB decoded limit

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
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  const token = auth.slice(7);

  const userClient = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY,
  );
  const { data: { user }, error: authError } = await userClient.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: 'Invalid session' });

  const sb = getSupabase(); // service key — bypasses RLS for reads/writes

  // ── Verify active assembler ───────────────────────────────────────────────
  const { data: profile, error: profileErr } = await sb
    .from('profiles')
    .select('id, role, status')
    .eq('id', user.id)
    .maybeSingle();

  if (profileErr || !profile) return res.status(404).json({ error: 'Profile not found' });
  if (profile.role !== 'assembler') return res.status(403).json({ error: 'Only Easers can upload evidence' });
  if (profile.status !== 'active') return res.status(403).json({ error: 'Account is not active' });

  // ── Validate input ────────────────────────────────────────────────────────
  const payload = req.body && typeof req.body === 'object' ? req.body : {};
  const { bookingId, fileBase64, mimeType, evidenceType = 'completion_photo', notes } = payload;

  if (!bookingId) return res.status(400).json({ error: 'bookingId is required' });
  if (!fileBase64) return res.status(400).json({ error: 'fileBase64 is required' });
  if (!mimeType)   return res.status(400).json({ error: 'mimeType is required' });

  if (!ALLOWED_MIME.has(mimeType)) {
    return res.status(400).json({ error: 'Unsupported file type. Allowed: jpeg, png, webp, heic, heif' });
  }

  if (!VALID_EVIDENCE_TYPES.has(evidenceType)) {
    return res.status(400).json({ error: 'Invalid evidenceType' });
  }

  // ── Verify booking ownership ──────────────────────────────────────────────
  const { data: booking, error: bookingErr } = await sb
    .from('bookings')
    .select('id, ref, status, assembler_id')
    .eq('id', bookingId)
    .eq('assembler_id', user.id)
    .maybeSingle();

  if (bookingErr || !booking) {
    return res.status(404).json({ error: 'Booking not found or not assigned to you' });
  }

  if (!UPLOAD_ALLOWED_STATUSES.has(booking.status)) {
    return res.status(400).json({
      error: `Evidence can only be uploaded for active or completed jobs. Current status: ${booking.status}`,
    });
  }

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

  // ── 5-file limit ─────────────────────────────────────────────────────────
  const { count: evidenceCount } = await sb
    .from('booking_evidence')
    .select('id', { count: 'exact', head: true })
    .eq('booking_id', bookingId);
  if (evidenceCount >= 5)
    return res.status(409).json({ error: 'Maximum 5 evidence files per booking.' });

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
  const { data: evidenceRow, error: insertErr } = await sb
    .from('booking_evidence')
    .insert({
      booking_id:      booking.id,
      uploaded_by:     user.id,
      storage_path:    storagePath,
      evidence_type:   evidenceType,
      mime_type:       mimeType,
      file_size_bytes: buf.length,
      visibility:      'owner',
      notes:           notes?.trim() || null,
    })
    .select('id, evidence_type, mime_type, file_size_bytes, created_at')
    .single();

  if (insertErr) {
    // Storage upload succeeded but DB insert failed — log orphaned path for manual cleanup
    console.error(`[upload-evidence] DB insert failed for ${storagePath}:`, insertErr);
    return res.status(500).json({ error: 'Evidence recorded in storage but failed to save record. Contact support.' });
  }

  return res.status(201).json({
    ok:           true,
    evidenceId:   evidenceRow.id,
    bookingRef:   booking.ref,
    evidenceType: evidenceRow.evidence_type,
    mimeType:     evidenceRow.mime_type,
    sizeBytes:    evidenceRow.file_size_bytes,
    createdAt:    evidenceRow.created_at,
  });
}
