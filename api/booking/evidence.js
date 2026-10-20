import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';
import { WEBSITE_PHOTO_SERVICES, WEBSITE_PHOTO_CHECKLIST, websiteServicesForBooking } from '../_website-photos.js';

const BUCKET = 'booking-evidence';
const SIGNED_URL_EXPIRY_SECONDS = 3600; // 1-hour ephemeral URLs

/**
 * GET /api/booking/evidence?bookingId={uuid}
 * Owner-only: retrieve all evidence records for a booking with signed download URLs.
 * Signed URLs are generated fresh on every request and expire in 1 hour.
 * URLs are never stored in the database.
 */
export default async function handler(req, res) {
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  // ── POST: designate (or withdraw) the Customer-Facing Final Photo ────────
  // An Easer upload is INTERNAL. booking_evidence.visibility defaults to
  // 'owner', and nothing a customer sees may read a row that still says so.
  // Promoting one is a deliberate human act, and this endpoint is that act.
  if (req.method === 'POST') {
    const { evidenceId, customerFacing } = req.body || {};
    if (!evidenceId) return res.status(400).json({ error: 'evidenceId is required' });

    const sbPost = getSupabase();
    const { data: row, error: rowErr } = await sbPost
      .from('booking_evidence')
      .select('id, booking_id, evidence_type')
      .eq('id', evidenceId)
      .maybeSingle();
    if (rowErr || !row) return res.status(404).json({ error: 'Evidence not found' });

    // Only finished-work photos are shareable. Damage claims and before-photos
    // are internal documentation and must never become customer-facing.
    if (row.evidence_type !== 'completion_photo') {
      return res.status(400).json({
        error: 'Only a completion photo can be shown to the customer.',
        code: 'NOT_SHAREABLE_TYPE',
      });
    }

    const promote = customerFacing === true;
    if (promote) {
      // Exactly one final photo per booking. Every customer surface picks the
      // most recent approved row, so leaving old ones approved would make which
      // photo the customer sees depend on timestamps rather than a decision.
      const { error: demoteErr } = await sbPost
        .from('booking_evidence')
        .update({ visibility: 'owner' })
        .eq('booking_id', row.booking_id)
        .neq('id', evidenceId);
      if (demoteErr) {
        console.error('[evidence] demote siblings failed:', demoteErr.message);
        return res.status(500).json({ error: 'Could not update the other photos. Nothing was changed.' });
      }
    }

    const { error: updErr } = await sbPost
      .from('booking_evidence')
      .update({ visibility: promote ? 'all' : 'owner' })
      .eq('id', evidenceId);
    if (updErr) {
      console.error('[evidence] visibility update failed:', updErr.message);
      return res.status(500).json({ error: 'Could not update this photo.' });
    }

    return res.status(200).json({ ok: true, evidenceId, customerFacing: promote });
  }

  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { bookingId } = req.query;
  if (!bookingId) return res.status(400).json({ error: 'bookingId is required' });

  const sb = getSupabase(); // service key — bypasses RLS

  // Confirm booking exists
  const loadBooking = columns => sb.from('bookings').select(columns).eq('id', bookingId).maybeSingle();
  let { data: booking, error: bookingErr } = await loadBooking('id, ref, status, service, website_photo_consent_at');
  if (bookingErr && /website_photo_consent_at|42703|PGRST204/i.test(String(bookingErr.message || bookingErr.code || ''))) {
    ({ data: booking, error: bookingErr } = await loadBooking('id, ref, status, service'));
  }

  if (bookingErr || !booking) {
    return res.status(404).json({ error: 'Booking not found' });
  }

  // Fetch all evidence rows for this booking
  // Website-photo fields arrive with migration 118; until then the list must
  // still load, so a missing column falls back to the original projection.
  const BASE_COLUMNS = 'id, uploaded_by, uploaded_on_behalf_of, storage_path, evidence_type, mime_type, file_size_bytes, visibility, notes, created_at';
  const loadRows = columns => sb.from('booking_evidence').select(columns)
    .eq('booking_id', bookingId).order('created_at', { ascending: true });
  let { data: rows, error: fetchErr } = await loadRows(`${BASE_COLUMNS}, website_published_at, website_service, website_alt`);
  if (fetchErr && /website_|42703|PGRST204/i.test(String(fetchErr.message || fetchErr.code || ''))) {
    ({ data: rows, error: fetchErr } = await loadRows(BASE_COLUMNS));
  }

  if (fetchErr) {
    console.error('evidence fetch error:', fetchErr);
    return res.status(500).json({ error: 'Failed to fetch evidence records' });
  }

  // What the owner needs to put a completion photo on the website.
  const website = {
    customerPermission: Boolean(booking.website_photo_consent_at),
    suggestedServices: websiteServicesForBooking(booking.service),
    services: WEBSITE_PHOTO_SERVICES,
    checklist: WEBSITE_PHOTO_CHECKLIST,
  };

  if (!rows?.length) {
    return res.status(200).json({ evidence: [], bookingRef: booking.ref, total: 0, website });
  }

  // Enrich with uploader names. uploaded_on_behalf_of is resolved too: the
  // owner can upload a photo for an Easer who could not, and a record showing
  // only who pressed the button reads as though the owner did the work.
  const uploaderIds = [...new Set(rows.flatMap(r => [r.uploaded_by, r.uploaded_on_behalf_of]).filter(Boolean))];
  const { data: profiles } = await sb
    .from('profiles')
    .select('id, full_name, role')
    .in('id', uploaderIds);
  const profileMap = Object.fromEntries((profiles || []).map(p => [p.id, p]));

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
        website_published_at: row.website_published_at || null,
        website_service:     row.website_service || null,
        website_alt:         row.website_alt || null,
        notes:               row.notes || null,
        created_at:          row.created_at,
        uploaded_by_id:      row.uploaded_by,
        uploaded_by_name:    profileMap[row.uploaded_by]?.full_name || 'Unknown',
        uploaded_by_role:    profileMap[row.uploaded_by]?.role === 'assembler' ? 'Easer' : 'Platform user',
        uploaded_on_behalf_of_id:   row.uploaded_on_behalf_of || null,
        uploaded_on_behalf_of_name: row.uploaded_on_behalf_of
          ? (profileMap[row.uploaded_on_behalf_of]?.full_name || 'Unknown')
          : null,
        signed_url:          signed?.signedUrl || null,
        signed_url_expires_at: signed?.signedUrl ? signedUrlExpiresAt : null,
      };
    }),
  );

  return res.status(200).json({
    evidence:   enriched,
    bookingRef: booking.ref,
    total:      enriched.length,
    website,
  });
}
