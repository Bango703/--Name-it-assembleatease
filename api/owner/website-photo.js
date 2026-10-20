import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';
import { logActivity } from '../booking/_activity.js';
import {
  WEBSITE_PHOTO_BUCKET, WEBSITE_PHOTO_CHECKLIST, isWebsiteService, websiteCitySlug, websitePhotoPath,
} from '../_website-photos.js';

const EVIDENCE_BUCKET = 'booking-evidence';

/**
 * POST /api/owner/website-photo — publish a completion photo on the website,
 * or take it down.
 *
 * Body: { evidenceId, publish: true, service, alt, checklistConfirmed: true }
 *       { evidenceId, publish: false }
 *
 * Publishing needs all three: a completion photo, the customer's permission on
 * that booking (the Terms promise job photos are not used in marketing without
 * it), and the owner's confirmation of the privacy checklist. A copy goes into
 * the public job-photos bucket; the private original never becomes public.
 * Taking a photo down deletes the public copy.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const { evidenceId, publish, service, alt, checklistConfirmed } = req.body || {};
  if (!evidenceId) return res.status(400).json({ error: 'evidenceId is required' });

  const sb = getSupabase();
  const { data: row, error: rowErr } = await sb
    .from('booking_evidence')
    .select('id, booking_id, evidence_type, storage_path, mime_type, website_published_at, website_public_path')
    .eq('id', evidenceId)
    .maybeSingle();
  if (rowErr) {
    const missing = /website_/i.test(String(rowErr.message || ''));
    return res.status(missing ? 503 : 500).json({
      error: missing ? 'Website photos need migration 118. Apply it and retry.' : 'The photo could not be loaded.',
      code: missing ? 'MIGRATION_118_REQUIRED' : 'EVIDENCE_LOAD_FAILED',
    });
  }
  if (!row) return res.status(404).json({ error: 'Photo not found' });

  // ── Take down ──────────────────────────────────────────────────────────
  if (publish !== true) {
    if (row.website_public_path) {
      const { error: removeErr } = await sb.storage.from(WEBSITE_PHOTO_BUCKET).remove([row.website_public_path]);
      if (removeErr) {
        console.error('[website-photo] public copy removal failed:', removeErr.message);
        return res.status(502).json({ error: 'The public copy could not be deleted, so the photo is still on the website. Try again.' });
      }
    }
    const { error: clearErr } = await sb.from('booking_evidence').update({
      website_published_at: null, website_published_by: null, website_service: null,
      website_city_slug: null, website_alt: null, website_public_path: null,
    }).eq('id', row.id);
    if (clearErr) return res.status(500).json({ error: 'The public copy was deleted, but the record could not be updated. Refresh and try again.' });
    await logActivity(sb, {
      bookingId: row.booking_id, eventType: 'website_photo_removed', actorType: 'owner', actorName: 'Owner',
      description: 'Completion photo removed from the website.', metadata: { evidenceId: row.id },
    }).catch(() => {});
    return res.status(200).json({ ok: true, published: false });
  }

  // ── Publish ────────────────────────────────────────────────────────────
  if (row.evidence_type !== 'completion_photo') {
    return res.status(400).json({ error: 'Only a completion photo can go on the website.', code: 'NOT_COMPLETION_PHOTO' });
  }
  if (!isWebsiteService(service)) {
    return res.status(400).json({ error: 'Choose which service page this photo belongs on.', code: 'SERVICE_REQUIRED' });
  }
  const altText = String(alt || '').trim().replace(/\s+/g, ' ').slice(0, 160);
  if (altText.length < 10) {
    return res.status(400).json({ error: 'Describe the photo in a few words, for example "Two TVs mounted above a brick fireplace".', code: 'ALT_REQUIRED' });
  }
  if (checklistConfirmed !== true) {
    return res.status(400).json({ error: `Confirm the photo shows: ${WEBSITE_PHOTO_CHECKLIST.join('; ')}.`, code: 'CHECKLIST_REQUIRED' });
  }

  const { data: booking, error: bookingErr } = await sb
    .from('bookings')
    .select('id, ref, service_city, website_photo_consent_at')
    .eq('id', row.booking_id)
    .maybeSingle();
  if (bookingErr || !booking) return res.status(500).json({ error: 'The booking for this photo could not be loaded.' });
  if (!booking.website_photo_consent_at) {
    return res.status(409).json({
      error: 'The customer has not given permission to show photos from this job on the website.',
      code: 'CUSTOMER_PERMISSION_REQUIRED',
    });
  }

  const { data: blob, error: downloadErr } = await sb.storage.from(EVIDENCE_BUCKET).download(row.storage_path);
  if (downloadErr || !blob) {
    console.error('[website-photo] download failed:', downloadErr?.message);
    return res.status(502).json({ error: 'The original photo could not be read. Nothing was published.' });
  }
  const contentType = blob.type || row.mime_type || 'image/jpeg';
  const path = websitePhotoPath(service, row.id, contentType);
  if (row.website_public_path && row.website_public_path !== path) {
    await sb.storage.from(WEBSITE_PHOTO_BUCKET).remove([row.website_public_path]).catch(() => {});
  }
  const { error: uploadErr } = await sb.storage.from(WEBSITE_PHOTO_BUCKET).upload(
    path, Buffer.from(await blob.arrayBuffer()), { contentType, cacheControl: '86400', upsert: true },
  );
  if (uploadErr) {
    console.error('[website-photo] public upload failed:', uploadErr.message);
    return res.status(502).json({ error: 'The photo could not be copied to the website. Nothing was published.' });
  }

  const citySlug = websiteCitySlug(booking.service_city);
  const { error: saveErr } = await sb.from('booking_evidence').update({
    website_published_at: new Date().toISOString(),
    website_published_by: 'owner',
    website_service: service,
    website_city_slug: citySlug,
    website_alt: altText,
    website_public_path: path,
  }).eq('id', row.id);
  if (saveErr) {
    await sb.storage.from(WEBSITE_PHOTO_BUCKET).remove([path]).catch(() => {});
    return res.status(500).json({ error: 'The photo could not be published. Nothing is on the website.' });
  }

  await logActivity(sb, {
    bookingId: row.booking_id, eventType: 'website_photo_published', actorType: 'owner', actorName: 'Owner',
    description: `Completion photo published on the ${service} pages${citySlug ? ` (${citySlug})` : ''}.`,
    metadata: { evidenceId: row.id, service, citySlug, alt: altText },
  }).catch(() => {});

  const { data: pub } = sb.storage.from(WEBSITE_PHOTO_BUCKET).getPublicUrl(path);
  return res.status(200).json({ ok: true, published: true, url: pub?.publicUrl || null, service, citySlug });
}
