import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';

const BUCKET = 'booking-evidence';
const SIGNED_URL_EXPIRY_SECONDS = 3600; // 1-hour ephemeral URLs

/**
 * GET /api/booking/evidence?bookingId={uuid}
 * Owner-only: retrieve all evidence records for a booking with signed download URLs.
 * Signed URLs are generated fresh on every request and expire in 1 hour.
 * URLs are never stored in the database.
 */
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const { bookingId } = req.query;
  if (!bookingId) return res.status(400).json({ error: 'bookingId is required' });

  const sb = getSupabase(); // service key — bypasses RLS

  // Confirm booking exists
  const { data: booking, error: bookingErr } = await sb
    .from('bookings')
    .select('id, ref, status')
    .eq('id', bookingId)
    .maybeSingle();

  if (bookingErr || !booking) {
    return res.status(404).json({ error: 'Booking not found' });
  }

  // Fetch all evidence rows for this booking
  const { data: rows, error: fetchErr } = await sb
    .from('booking_evidence')
    .select('id, uploaded_by, storage_path, evidence_type, mime_type, file_size_bytes, visibility, notes, created_at')
    .eq('booking_id', bookingId)
    .order('created_at', { ascending: true });

  if (fetchErr) {
    console.error('evidence fetch error:', fetchErr);
    return res.status(500).json({ error: 'Failed to fetch evidence records' });
  }

  if (!rows?.length) {
    return res.status(200).json({ evidence: [], bookingRef: booking.ref, total: 0 });
  }

  // Enrich with uploader names
  const uploaderIds = [...new Set(rows.map(r => r.uploaded_by))];
  const { data: profiles } = await sb
    .from('profiles')
    .select('id, full_name')
    .in('id', uploaderIds);
  const profileMap = Object.fromEntries((profiles || []).map(p => [p.id, p.full_name]));

  // Generate signed download URLs in parallel — ephemeral, 1-hour expiry
  const signedUrlExpiresAt = new Date(Date.now() + SIGNED_URL_EXPIRY_SECONDS * 1000).toISOString();

  const enriched = await Promise.all(
    rows.map(async row => {
      const { data: signed, error: signErr } = await sb.storage
        .from(BUCKET)
        .createSignedUrl(row.storage_path, SIGNED_URL_EXPIRY_SECONDS);

      if (signErr) {
        console.error(`[evidence] signed URL failed for ${row.storage_path}:`, signErr);
      }

      return {
        id:                  row.id,
        evidence_type:       row.evidence_type,
        mime_type:           row.mime_type,
        file_size_bytes:     row.file_size_bytes,
        visibility:          row.visibility,
        notes:               row.notes || null,
        created_at:          row.created_at,
        uploaded_by_id:      row.uploaded_by,
        uploaded_by_name:    profileMap[row.uploaded_by] || 'Unknown',
        signed_url:          signed?.signedUrl || null,
        signed_url_expires_at: signed?.signedUrl ? signedUrlExpiresAt : null,
      };
    }),
  );

  return res.status(200).json({
    evidence:   enriched,
    bookingRef: booking.ref,
    total:      enriched.length,
  });
}
