import crypto from 'crypto';
import { getSupabase } from '../_supabase.js';
import { rateLimit } from '../_ratelimit.js';
import { verifyOwner } from '../_email.js';
import { requireAssignedWorkEaser, respondWithEaserAccessError } from '../_easer-access.js';
import { bookingEmailMatches } from './_guest-booking-auth.js';
import { safeTokenHashMatch } from '../_payment-security.js';

import { MAX_UPLOAD_BYTES } from '../_upload-limits.js';

// The real ceiling is Vercel's 4.5 MB request body, which this setting cannot
// raise. Kept just above MAX_UPLOAD_BYTES so the two never contradict.
export const config = { api: { bodyParser: { sizeLimit: '5mb' } } };

const BUCKET = 'booking-evidence';
const MAX_BYTES = MAX_UPLOAD_BYTES;
const MIME_EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
  'image/heic': 'heic', 'image/heif': 'heif',
};

function magicMatches(mime, buf) {
  if (mime === 'image/jpeg') return buf.length >= 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF;
  if (mime === 'image/png') return buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));
  if (mime === 'image/webp') return buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP';
  return buf.length >= 12 && buf.subarray(4, 8).toString('ascii') === 'ftyp';
}

const notFound = res => res.status(404).json({ error: 'Booking not found' });

async function loadGuestBooking(sb, { email, ref, token }) {
  if (!email || !ref || !token) return null;
  const { data } = await sb.from('bookings')
    .select('id, ref, customer_email, guest_mutation_token_hash')
    .eq('ref', String(ref).trim().toUpperCase())
    .maybeSingle();
  return data && bookingEmailMatches(data, email) && safeTokenHashMatch(token, data.guest_mutation_token_hash) ? data : null;
}

async function loadAuthorizedBooking(req, sb, input) {
  if (verifyOwner(req)) {
    const { data } = await sb.from('bookings').select('id, ref, assembler_id, assembler_accepted_at').eq('id', input.bookingId).maybeSingle();
    return data || null;
  }
  const easer = await requireAssignedWorkEaser(req, { supabase: sb });
  if (!easer.ok) return { accessError: easer };
  const { data } = await sb.from('bookings').select('id, ref, assembler_id, assembler_accepted_at').eq('id', input.bookingId).maybeSingle();
  if (!data || data.assembler_id !== easer.user.id || !data.assembler_accepted_at) return null;
  return data;
}

async function signedPhotos(sb, bookingId) {
  const { data, error } = await sb.from('booking_customer_photos')
    .select('id, mime_type, file_size_bytes, storage_path, created_at')
    .eq('booking_id', bookingId).order('created_at', { ascending: true });
  if (error) throw error;
  return Promise.all((data || []).map(async photo => {
    const { data: signed } = await sb.storage.from(BUCKET).createSignedUrl(photo.storage_path, 3600);
    return { id: photo.id, mime_type: photo.mime_type, file_size_bytes: photo.file_size_bytes, created_at: photo.created_at, signed_url: signed?.signedUrl || null };
  }));
}

export default async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
  const ip = String(req.headers?.['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  if (!(await rateLimit(ip, 'booking'))) return res.status(429).json({ error: 'Too many requests. Please wait a moment.' });
  const sb = getSupabase();

  if (req.method === 'GET') {
    const { bookingId, email, ref, token } = req.query || {};
    let booking;
    if (email || token || ref) {
      if (bookingId || !(booking = await loadGuestBooking(sb, { email, ref, token }))) return notFound(res);
    } else {
      booking = await loadAuthorizedBooking(req, sb, { bookingId });
      if (booking?.accessError) return respondWithEaserAccessError(res, booking.accessError);
      if (!booking) return notFound(res);
    }
    try { return res.status(200).json({ photos: await signedPhotos(sb, booking.id) }); }
    catch (error) { console.error('Customer photo lookup failed:', error); return res.status(500).json({ error: 'Photos are temporarily unavailable.' }); }
  }

  const { email, ref, token, fileBase64, mimeType } = req.body || {};
  const booking = await loadGuestBooking(sb, { email, ref, token });
  if (!booking) return notFound(res);
  if (!Object.hasOwn(MIME_EXT, mimeType)) return res.status(400).json({ error: 'Use a JPEG, PNG, WebP, HEIC, or HEIF image.' });
  if (typeof fileBase64 !== 'string' || !fileBase64) return res.status(400).json({ error: 'Choose an image to upload.' });
  let buf;
  try { buf = Buffer.from(fileBase64.replace(/^data:[^;]+;base64,/, ''), 'base64'); }
  catch { return res.status(400).json({ error: 'The image could not be decoded.' }); }
  if (!buf.length || buf.length > MAX_BYTES) return res.status(400).json({ error: 'Images must be no larger than 5 MB.' });
  if (!magicMatches(mimeType, buf)) return res.status(400).json({ error: 'The image content does not match its type.' });

  const path = `customer-uploads/${booking.id}/${new Date().toISOString().slice(0, 7)}/${crypto.randomUUID()}.${MIME_EXT[mimeType]}`;
  const { error: uploadError } = await sb.storage.from(BUCKET).upload(path, buf, { contentType: mimeType, upsert: false });
  if (uploadError) return res.status(503).json({ error: 'The image could not be uploaded. Please try again.' });
  const { data: row, error: insertError } = await sb.from('booking_customer_photos').insert({
    booking_id: booking.id, storage_path: path, mime_type: mimeType, file_size_bytes: buf.length,
  }).select('id, created_at').single();
  if (insertError || !row) {
    await sb.storage.from(BUCKET).remove([path]);
    console.error('Customer photo record failed:', insertError);
    return res.status(503).json({ error: 'The image could not be saved. Please try again.' });
  }
  return res.status(201).json({ ok: true, photo: row });
}