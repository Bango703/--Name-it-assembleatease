import { getSupabase } from './_supabase.js';
import { rateLimit } from './_ratelimit.js';
import { logActivity } from './booking/_activity.js';
import { verifyReviewToken } from './_review-token.js';
import { customerAccountUser, usesCustomerAccount } from './booking/_customer-access.js';
import { customerOwnsBooking } from './booking/_customer-booking-auth.js';
import { sendPushToUser } from './_push.js';
import { sendEmail, ownerEmail } from './_email.js';
import { issueReviewReward } from './_review-rewards.js';

export default async function handler(req, res) {
  const sb = getSupabase();

  // ── GET — fetch approved reviews for public display ───────────────
  if (req.method === 'GET') {
    const { data, error } = await sb
      .from('reviews')
      .select('id, customer_name, service, rating, body, created_at')
      .eq('approved', true)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) {
      // Log the real error so it appears in Vercel function logs
      console.error('Reviews GET error:', error.code, error.message);
      return res.status(500).json({
        error: 'Failed to fetch reviews',
      });
    }
    return res.status(200).json({ reviews: (data || []).filter(review => !isLikelyInternalTestReview(review)) });
  }

  // ── POST — submit a new review ────────────────────────────────────
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  try {
    if (!await rateLimit(ip, 'default')) return res.status(429).json({ error: 'Too many requests.' });
  } catch (_) {}

  const payload = (req.body && typeof req.body === 'object') ? req.body : {};
  const { ref, rating, body, token } = payload;
  // Two doors, one review: the secure link in the review email (ref + email +
  // token), or the customer app's signed-in session on a booking it owns.
  const viaApp = !token && usesCustomerAccount(req);
  const appCustomer = viaApp ? await customerAccountUser(sb, req) : null;
  if (viaApp && !appCustomer) return res.status(401).json({ error: 'Sign in again to leave a review.' });
  const email = viaApp ? appCustomer.email : payload.email;
  const normalizedRef = String(ref || '').toUpperCase().trim();
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const parsedRating = parseInt(rating, 10);
  // The written review is OPTIONAL — a star rating is a complete answer.
  // Demanding a paragraph cost the rating AND the tip from every customer who
  // did not feel like writing one, because the tip only runs once the review
  // saves. Rating is the field that must be present.
  if (!ref || !email || !rating) {
    return res.status(400).json({ error: 'Missing required fields: ref, email, rating' });
  }
  if (!token && !viaApp) {
    return res.status(403).json({ error: 'Use the secure review link sent to your booking email.' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(normalizedEmail)) {
    return res.status(400).json({ error: 'Please provide a valid email address.' });
  }
  if (normalizedRef.length < 6) {
    return res.status(400).json({ error: 'Booking reference is invalid.' });
  }
  if (!Number.isInteger(parsedRating) || parsedRating < 1 || parsedRating > 5) {
    return res.status(400).json({ error: 'Rating must be 1-5' });
  }
  // Empty is fine. A half-word is not — if they chose to write, it should say
  // something, or it is noise on the Easer's record.
  const reviewBody = typeof body === 'string' ? body.trim() : '';
  if (reviewBody.length > 0 && reviewBody.length < 10) {
    return res.status(400).json({ error: 'Either leave the review text empty, or write at least a sentence.' });
  }

  // Verify booking exists, is completed, and email matches
  const { data: booking, error: bErr } = await sb
    .from('bookings')
    .select('id, ref, customer_name, service, status, customer_email, customer_id, assembler_id, assembler_name')
    .eq('ref', normalizedRef)
    .single();

  if (bErr || !booking) {
    return res.status(404).json({ error: 'Booking not found. Check your reference number.' });
  }
  if (viaApp) {
    if (!customerOwnsBooking(booking, appCustomer)) {
      return res.status(404).json({ error: 'Booking not found. Check your reference number.' });
    }
  } else if (!booking.customer_email || booking.customer_email.toLowerCase() !== normalizedEmail) {
    return res.status(403).json({ error: 'Email does not match this booking.' });
  }
  if (booking.status !== 'completed') {
    return res.status(400).json({ error: 'Reviews can only be left for completed jobs.' });
  }
  if (!viaApp && !verifyReviewToken(token, {
    bookingId: booking.id,
    ref: booking.ref,
    email: booking.customer_email,
  })) {
    return res.status(403).json({
      error: 'This secure review link is invalid or expired. Ask AssembleAtEase to send a new review link.',
    });
  }

  // Prevent duplicate reviews — use maybeSingle() so missing row is not an error
  const { data: existing, error: dupErr } = await sb
    .from('reviews')
    .select('id')
    .eq('booking_id', booking.id)
    .maybeSingle();

  if (dupErr) {
    console.error('Duplicate review check error:', dupErr.code, dupErr.message);
    return res.status(500).json({ error: 'Unable to verify review status. Please try again.' });
  }
  if (existing) {
    return res.status(409).json({ error: 'A review has already been submitted for this booking.' });
  }

  // Insert review with transient retry and deterministic duplicate handling.
  // Do not write assembler_id here: some environments may not have that column.
  const reviewRow = {
    booking_id: booking.id,
    customer_name: booking.customer_name,
    service: booking.service,
    rating: parsedRating,
    body: reviewBody,
    approved: true,
  };
  let reward;
  try {
    reward = await issueReviewReward(sb, booking);
  } catch (rewardError) {
    console.error('Review reward issuance failed before review submission:', rewardError?.code, rewardError?.message);
    return res.status(503).json({ error: 'The thank-you offer could not be prepared. Your review was not submitted; please try again shortly.' });
  }
  const { error: insErr } = await insertReviewWithRetry(sb, reviewRow, 2);

  if (insErr) {
    await sb.from('review_reward_codes').delete().eq('booking_id', booking.id).eq('code', reward.code);
    if (insErr.code === '23505') {
      return res.status(409).json({ error: 'A review has already been submitted for this booking.' });
    }
    console.error('Review insert error:', insErr.code, insErr.message);
    return res.status(500).json({ error: 'Failed to save review. Please try again.' });
  }

  const expiryDate = new Date(reward.expiresAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
  let rewardEmail = { ok: false, error: 'Email send did not complete' };
  try {
    rewardEmail = await sendEmail({
      to: booking.customer_email,
      from: 'AssembleAtEase <booking@assembleatease.com>',
      replyTo: ownerEmail(),
      subject: 'Your $10 AssembleAtEase thank-you offer',
      html: `<!doctype html><html><body style="margin:0;padding:24px;background:#f4f4f5;font-family:Arial,sans-serif;color:#1a1a1a"><div style="max-width:560px;margin:auto;background:#fff;padding:28px;border:1px solid #e4e4e7;border-radius:8px"><h1 style="font-size:22px">Thank you for sharing your experience</h1><p>Your honest review is appreciated. Any rating qualifies; the reward is not tied to a positive review.</p><p style="font-size:18px">Your code: <strong>${reward.code}</strong></p><p>Use it once for $10 off a future booking with a service subtotal of at least $100. It expires ${expiryDate}. Enter the code and the same email address used for your review at checkout.</p><p><a href="https://www.assembleatease.com/book?promo=${encodeURIComponent(reward.code)}" style="display:inline-block;background:#00BFFF;color:#fff;text-decoration:none;padding:12px 18px;border-radius:6px">Book with this code</a></p><p>This reward applies only to a review submitted on the AssembleAtEase website. Google reviews are optional and are not rewarded.</p><p style="font-size:13px;color:#52525b">Questions? Reply to this email.</p></div></body></html>`,
      meta: { bookingId: booking.id, notificationType: 'review_reward', recipientType: 'customer' },
    });
  } catch (rewardEmailError) {
    rewardEmail = { ok: false, error: rewardEmailError?.message || 'Email send failed' };
  }
  if (!rewardEmail.ok || rewardEmail.suppressed === true) {
    console.error('Review reward email delivery failed:', rewardEmail.error || 'suppressed', booking.id);
  }

  // Log to booking timeline
  logActivity(sb, {
    bookingId:   booking.id,
    eventType:   'review_submitted',
    actorType:   'customer',
    actorName:   booking.customer_name,
    description: `Customer left a ${parsedRating}-star review`,
    metadata:    { rating: parsedRating, reviewRewardIssued: true },
  });

  // Recalculate Easer's average rating from all their approved reviews, and tell
  // the Easer: the review shows in the Reviews screen of their app.
  if (booking.assembler_id) {
    await sendPushToUser(booking.assembler_id, {
      title: `New ${parsedRating}-star review`,
      body: reviewBody ? reviewBody.slice(0, 140) : `For ${booking.service}.`,
      jobId: booking.id,
    }, { bookingId: booking.id, notificationType: 'customer_review', recipientType: 'easer' }).catch(() => {});
    recalcEaserRating(sb, booking.assembler_id).catch(e =>
      console.warn('Rating recalc failed (non-fatal):', e.message)
    );
  }

  return res.status(200).json({ success: true, reward: { code: reward.code, expiresAt: reward.expiresAt, emailSent: rewardEmail.ok === true && rewardEmail.suppressed !== true } });
}

function isLikelyInternalTestReview(review) {
  const text = `${review?.body || ''} ${review?.customer_name || ''} ${review?.service || ''}`;
  return [
    /phase\s*\d/i,
    /post[-\s]?deploy/i,
    /duplicate gate/i,
    /\btest\b/i,
    /seed/i,
  ].some(pattern => pattern.test(text));
}

function isTransientInsertError(error) {
  const transientCodes = new Set(['40001', '40P01', '57P01', '57014']);
  return transientCodes.has(error?.code);
}

async function insertReviewWithRetry(sb, reviewRow, maxAttempts = 2) {
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { error } = await sb.from('reviews').insert(reviewRow);
    if (!error) return { error: null };
    lastError = error;
    if (!isTransientInsertError(error) || attempt === maxAttempts) break;
    await new Promise(resolve => setTimeout(resolve, 100 * attempt));
  }
  return { error: lastError };
}

/**
 * Recalculate and persist an Easer's average rating and review count.
 * Fetches all approved reviews across all bookings assigned to this Easer.
 * Safe: handles empty booking list, skips update if no reviews found.
 */
async function recalcEaserRating(sb, easerId) {
  // Step 1: get all booking IDs assigned to this Easer
  const { data: easerBookings, error: bErr } = await sb
    .from('bookings')
    .select('id')
    .eq('assembler_id', easerId);

  if (bErr) throw new Error('Booking lookup failed: ' + bErr.message);

  const bookingIds = (easerBookings || []).map(b => b.id);
  if (!bookingIds.length) return; // Easer has no bookings yet — nothing to recalculate

  // Step 2: get all approved reviews for those bookings
  const { data: reviews, error: rErr } = await sb
    .from('reviews')
    .select('rating')
    .eq('approved', true)
    .in('booking_id', bookingIds);

  if (rErr) throw new Error('Review lookup failed: ' + rErr.message);
  if (!reviews?.length) return;

  // Step 3: calculate and persist
  const avg = reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length;
  const { error: uErr } = await sb
    .from('profiles')
    .update({
      rating:       parseFloat(avg.toFixed(1)),
      review_count: reviews.length,
    })
    .eq('id', easerId);

  if (uErr) throw new Error('Profile update failed: ' + uErr.message);
}
