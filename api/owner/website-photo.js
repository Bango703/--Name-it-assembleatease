import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';
import { logActivity } from '../booking/_activity.js';
import {
  WEBSITE_PHOTO_BUCKET, WEBSITE_PHOTO_CHECKLIST, isWebsiteService, websiteCitySlug, websitePhotoPath, photoUseForBooking,
  stripImageMetadata,
} from '../_website-photos.js';

const EVIDENCE_BUCKET = 'booking-evidence';
const REFUSAL = {
  earlier_terms: 'This booking was made before the Terms allowed website photos, so its photos are never used.',
  opted_out: 'This customer asked us not to use photos from their bookings.',
};

/**
 * POST /api/owner/website-photo
 *
 *   { evidenceId, action: 'collect', checklistConfirmed: true }   save to the collection
 *   { evidenceId, action: 'uncollect' }                           remove from the collection
 *   { evidenceId, action: 'publish', service, alt }               post a collected photo
 *   { evidenceId, action: 'unpublish' }                           take it off the website
 *   { bookingId,  action: 'opt_out' }                             customer opted out
 *
 * Terms version 2026-10-20 lets completion photos be shown with identifying
 * details left out; bookings under earlier Terms, and customers who opt out,
 * are never used (photoUseForBooking). Collecting is the privacy check;
 * posting is a separate choice. A posted photo is a copy in the public
 * job-photos bucket; the private original never becomes public.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const { evidenceId, bookingId, action } = req.body || {};
  const sb = getSupabase();

  if (action === 'opt_out') return optOut(sb, res, bookingId);
  if (!evidenceId) return res.status(400).json({ error: 'evidenceId is required' });

  const { data: row, error: rowErr } = await sb
    .from('booking_evidence')
    .select('id, booking_id, evidence_type, storage_path, mime_type, website_collected_at, website_published_at, website_public_path')
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

  if (action === 'unpublish') return unpublish(sb, res, row);
  if (action === 'uncollect') {
    if (row.website_published_at) {
      const down = await takeDown(sb, row);
      if (!down.ok) return res.status(down.status).json({ error: down.error });
    }
    const { error } = await sb.from('booking_evidence').update({ website_collected_at: null }).eq('id', row.id);
    if (error) return res.status(500).json({ error: 'The photo could not be removed from the collection. Refresh and try again.' });
    await log(sb, row, 'website_photo_uncollected', 'Completion photo removed from the website collection.');
    return res.status(200).json({ ok: true, collected: false, published: false });
  }
  if (action !== 'collect' && action !== 'publish') return res.status(400).json({ error: 'Unknown action.' });

  if (row.evidence_type !== 'completion_photo') {
    return res.status(400).json({ error: 'Only a completion photo can be used on the website.', code: 'NOT_COMPLETION_PHOTO' });
  }
  const { data: booking, error: bookingErr } = await sb
    .from('bookings')
    .select('id, ref, service_city, customer_terms_version, website_photo_opt_out_at')
    .eq('id', row.booking_id)
    .maybeSingle();
  if (bookingErr || !booking) return res.status(500).json({ error: 'The booking for this photo could not be loaded.' });
  const use = photoUseForBooking(booking);
  if (!use.allowed) return res.status(409).json({ error: REFUSAL[use.reason], code: `PHOTO_USE_${use.reason.toUpperCase()}` });

  // ── Save to the collection: the privacy check happens here ─────────────
  if (action === 'collect') {
    if (req.body.checklistConfirmed !== true) {
      return res.status(400).json({ error: `Confirm the photo shows: ${WEBSITE_PHOTO_CHECKLIST.join('; ')}.`, code: 'CHECKLIST_REQUIRED' });
    }
    const { error } = await sb.from('booking_evidence')
      .update({ website_collected_at: new Date().toISOString() }).eq('id', row.id);
    if (error) return res.status(500).json({ error: 'The photo could not be saved to the collection.' });
    await log(sb, row, 'website_photo_collected', 'Completion photo saved to the website collection.');
    return res.status(200).json({ ok: true, collected: true, published: Boolean(row.website_published_at) });
  }

  // ── Post a collected photo to a service page ───────────────────────────
  if (!row.website_collected_at) {
    return res.status(409).json({ error: 'Save the photo to the collection before posting it.', code: 'NOT_COLLECTED' });
  }
  const { service, alt } = req.body;
  if (!isWebsiteService(service)) {
    return res.status(400).json({ error: 'Choose which service page this photo belongs on.', code: 'SERVICE_REQUIRED' });
  }
  const altText = String(alt || '').trim().replace(/\s+/g, ' ').slice(0, 160);
  if (altText.length < 10) {
    return res.status(400).json({ error: 'Describe the photo in a few words, for example "Two TVs mounted above a brick fireplace".', code: 'ALT_REQUIRED' });
  }

  const { data: blob, error: downloadErr } = await sb.storage.from(EVIDENCE_BUCKET).download(row.storage_path);
  if (downloadErr || !blob) {
    console.error('[website-photo] download failed:', downloadErr?.message);
    return res.status(502).json({ error: 'The original photo could not be read. Nothing was posted.' });
  }
  const contentType = blob.type || row.mime_type || 'image/jpeg';
  // The public copy never carries the original's metadata (GPS location in
  // particular): stripped here whatever device or app uploaded it.
  const cleaned = stripImageMetadata(Buffer.from(await blob.arrayBuffer()), contentType);
  if (!cleaned.ok) {
    console.error('[website-photo] metadata strip refused:', cleaned.reason);
    return res.status(415).json({ error: 'This photo is not a JPEG, PNG or WebP image, so it cannot be posted. Nothing was posted.', code: 'UNSUPPORTED_IMAGE' });
  }
  const path = websitePhotoPath(service, row.id, contentType);
  if (row.website_public_path && row.website_public_path !== path) {
    await sb.storage.from(WEBSITE_PHOTO_BUCKET).remove([row.website_public_path]).catch(() => {});
  }
  const { error: uploadErr } = await sb.storage.from(WEBSITE_PHOTO_BUCKET).upload(
    // Short cache: a photo taken down (or a customer who opts out) must leave
    // the site within minutes, not stay cached for a day.
    path, cleaned.buffer, { contentType, cacheControl: '600', upsert: true },
  );
  if (uploadErr) {
    console.error('[website-photo] public upload failed:', uploadErr.message);
    return res.status(502).json({ error: 'The photo could not be copied to the website. Nothing was posted.' });
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
    return res.status(500).json({ error: 'The photo could not be posted. Nothing is on the website.' });
  }
  await log(sb, row, 'website_photo_published',
    `Completion photo posted on the ${service} pages${citySlug ? ` (${citySlug})` : ''}.`, { service, citySlug, alt: altText });
  const { data: pub } = sb.storage.from(WEBSITE_PHOTO_BUCKET).getPublicUrl(path);
  return res.status(200).json({ ok: true, collected: true, published: true, url: pub?.publicUrl || null, service, citySlug });
}

async function takeDown(sb, row) {
  if (row.website_public_path) {
    const { error } = await sb.storage.from(WEBSITE_PHOTO_BUCKET).remove([row.website_public_path]);
    if (error) {
      console.error('[website-photo] public copy removal failed:', error.message);
      return { ok: false, status: 502, error: 'The public copy could not be deleted, so the photo is still on the website. Try again.' };
    }
  }
  const { error } = await sb.from('booking_evidence').update({
    website_published_at: null, website_published_by: null, website_service: null,
    website_city_slug: null, website_alt: null, website_public_path: null,
  }).eq('id', row.id);
  if (error) return { ok: false, status: 500, error: 'The public copy was deleted, but the record could not be updated. Refresh and try again.' };
  return { ok: true };
}

async function unpublish(sb, res, row) {
  const down = await takeDown(sb, row);
  if (!down.ok) return res.status(down.status).json({ error: down.error });
  await log(sb, row, 'website_photo_removed', 'Completion photo taken off the website; it stays in the collection.');
  return res.status(200).json({ ok: true, collected: Boolean(row.website_collected_at), published: false });
}

// A customer who asks us not to use their photos: every photo from every one
// of their bookings leaves the website and the collection, and none can be
// collected again.
async function optOut(sb, res, bookingId) {
  if (!bookingId) return res.status(400).json({ error: 'bookingId is required' });
  const { data: booking, error } = await sb.from('bookings').select('id, customer_email').eq('id', bookingId).maybeSingle();
  if (error || !booking) return res.status(404).json({ error: 'Booking not found' });
  const email = String(booking.customer_email || '').trim().toLowerCase();
  const { data: bookings, error: listErr } = email
    // Case-insensitive exact match: escape the ILIKE wildcards an email can hold.
    ? await sb.from('bookings').select('id').ilike('customer_email', email.replace(/[\\%_]/g, '\\$&'))
    : { data: [{ id: booking.id }], error: null };
  if (listErr) return res.status(500).json({ error: "The customer's bookings could not be loaded. Nothing changed." });
  const ids = (bookings || []).map(b => b.id);

  const { data: photos, error: photoErr } = await sb.from('booking_evidence')
    .select('id, booking_id, website_public_path, website_published_at, website_collected_at')
    .in('booking_id', ids)
    .or('website_collected_at.not.is.null,website_published_at.not.is.null');
  if (photoErr) return res.status(500).json({ error: "The customer's photos could not be loaded. Nothing changed." });
  for (const photo of photos || []) {
    if (photo.website_published_at) {
      const down = await takeDown(sb, photo);
      if (!down.ok) return res.status(down.status).json({ error: down.error });
    }
    await sb.from('booking_evidence').update({ website_collected_at: null }).eq('id', photo.id);
  }
  const { error: markErr } = await sb.from('bookings')
    .update({ website_photo_opt_out_at: new Date().toISOString() })
    .in('id', ids).is('website_photo_opt_out_at', null);
  if (markErr) return res.status(500).json({ error: 'Photos were removed, but the opt-out could not be recorded. Try again.' });
  await logActivity(sb, {
    bookingId: booking.id, eventType: 'website_photo_opt_out', actorType: 'owner', actorName: 'Owner',
    description: `Customer opted out of website photos; ${(photos || []).length} photo(s) removed from the collection and website.`,
    metadata: { bookings: ids.length, photos: (photos || []).length },
  }).catch(() => {});
  return res.status(200).json({ ok: true, bookings: ids.length, photosRemoved: (photos || []).length });
}

function log(sb, row, eventType, description, metadata = {}) {
  return logActivity(sb, {
    bookingId: row.booking_id, eventType, actorType: 'owner', actorName: 'Owner', description,
    metadata: { evidenceId: row.id, ...metadata },
  }).catch(() => {});
}
