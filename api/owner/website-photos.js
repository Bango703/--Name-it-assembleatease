import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';
import {
  WEBSITE_PHOTO_SERVICES, WEBSITE_PHOTO_CHECKLIST, websiteServicesForBooking, photoUseForBooking,
} from '../_website-photos.js';

const EVIDENCE_BUCKET = 'booking-evidence';
const PREVIEW_SECONDS = 3600;

/**
 * GET /api/owner/website-photos — the owner's photo library.
 *
 * Completion photos from bookings whose Terms allow website use, newest first,
 * each with where it stands: available, in the collection, or on the website.
 * Photos from bookings under earlier Terms, or from customers who opted out,
 * are left out entirely. Previews are 1-hour signed URLs of the private
 * originals; nothing here makes a photo public.
 */
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const sb = getSupabase();
  const { data: rows, error } = await sb
    .from('booking_evidence')
    .select('id, booking_id, storage_path, created_at, website_collected_at, website_published_at, website_service, website_alt, website_city_slug')
    .eq('evidence_type', 'completion_photo')
    .order('created_at', { ascending: false })
    .limit(300);
  if (error) {
    const missing = /website_/i.test(String(error.message || ''));
    return res.status(missing ? 503 : 500).json({
      error: missing ? 'Website photos need migration 118. Apply it and refresh.' : 'Photos could not be loaded.',
      code: missing ? 'MIGRATION_118_REQUIRED' : 'PHOTOS_LOAD_FAILED',
    });
  }

  const bookingIds = [...new Set((rows || []).map(r => r.booking_id))];
  const { data: bookings, error: bookingErr } = bookingIds.length
    ? await sb.from('bookings')
      .select('id, ref, service, service_city, date, customer_terms_version, website_photo_opt_out_at, is_test_booking')
      .in('id', bookingIds)
    : { data: [], error: null };
  if (bookingErr) return res.status(500).json({ error: 'Bookings for these photos could not be loaded.' });
  const byId = Object.fromEntries((bookings || []).map(b => [b.id, b]));

  const usable = (rows || []).filter(r => {
    const b = byId[r.booking_id];
    return b && b.is_test_booking !== true && photoUseForBooking(b).allowed;
  });

  const photos = await Promise.all(usable.map(async r => {
    const b = byId[r.booking_id];
    const { data: signed } = await sb.storage.from(EVIDENCE_BUCKET).createSignedUrl(r.storage_path, PREVIEW_SECONDS);
    return {
      id: r.id,
      bookingId: b.id,
      bookingRef: b.ref,
      service: b.service,
      city: b.service_city,
      date: b.date,
      takenAt: r.created_at,
      previewUrl: signed?.signedUrl || null,
      state: r.website_published_at ? 'on_website' : r.website_collected_at ? 'collected' : 'available',
      websiteService: r.website_service || null,
      websiteAlt: r.website_alt || null,
      suggestedServices: websiteServicesForBooking(b.service),
    };
  }));

  return res.status(200).json({
    photos,
    counts: {
      available: photos.filter(p => p.state === 'available').length,
      collected: photos.filter(p => p.state === 'collected').length,
      onWebsite: photos.filter(p => p.state === 'on_website').length,
    },
    services: WEBSITE_PHOTO_SERVICES,
    checklist: WEBSITE_PHOTO_CHECKLIST,
  });
}
