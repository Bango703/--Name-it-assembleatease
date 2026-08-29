import { getSupabase } from '../_supabase.js';
import { rateLimit } from '../_ratelimit.js';
import { ownerEmail, esc } from '../_email.js';
import { randomToken, sha256 } from '../_payment-security.js';
import { normalizeEmail, verifyCode } from '../_assemblecash.js';
import { ACTIVE_BOOKING_STATUSES } from '../_source-of-truth.js';

/**
 * POST /api/track/verify-code  { email, code }
 * Verifies the one-time code (proves inbox ownership), then hands back the
 * customer's current bookings each with a FRESH mutation token.
 *
 * The token minted here is an ordinary guest mutation token — identical in kind
 * to the one api/booking/request-track-link.js emails. Every view / reschedule /
 * cancel still flows through the unchanged endpoints, which enforce the
 * cancellation fee, reschedule cap, status gates and payment-window rules AFTER
 * auth. Proving inbox ownership here never bypasses a single rule — it only saves
 * the customer the email round-trip.
 *
 * Bookings returned: active ones, plus anything terminal within the last 45 days
 * (so a just-finished or just-cancelled job is still viewable). Older bookings are
 * left untouched — their tokens are never rotated.
 */
const RECENT_TERMINAL_DAYS = 45;
const MAX_BOOKINGS = 8;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (!await rateLimit(ip, 'booking')) return res.status(429).json({ error: 'Too many requests. Please wait a moment.' });

  const email = normalizeEmail((req.body || {}).email);
  const code = String((req.body || {}).code || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || !/^\d{6}$/.test(code)) {
    return res.status(400).json({ error: 'Enter your email and the 6-digit code from your email.' });
  }

  const sb = getSupabase();

  let ok = false;
  try {
    ok = await verifyCode(sb, email, code, 'track');
  } catch (e) {
    console.error('Track verify-code error:', e && (e.message || e));
    return res.status(503).json({ error: 'We could not verify your code right now. Please try again shortly.' });
  }
  if (!ok) {
    return res.status(400).json({ error: 'That code is invalid or expired. Request a new one.' });
  }

  // Code is valid + now consumed. Load this customer's current bookings.
  const cutoffIso = new Date(Date.now() - RECENT_TERMINAL_DAYS * 24 * 60 * 60 * 1000).toISOString();
  let rows = [];
  try {
    const { data, error } = await sb
      .from('bookings')
      .select('id, ref, service, date, time, status, customer_email, guest_mutation_token_hash, created_at')
      .ilike('customer_email', email)
      .order('created_at', { ascending: false })
      .limit(30);
    if (error) throw error;
    rows = data || [];
  } catch (e) {
    console.error('Track verify-code booking lookup error:', e && (e.message || e));
    return res.status(503).json({ error: 'We verified your email but could not load your bookings. Please try again shortly.' });
  }

  const visible = rows
    .filter(b => ACTIVE_BOOKING_STATUSES.includes(b.status)
      || b.status === 'pending'
      || (b.created_at && b.created_at >= cutoffIso))
    .slice(0, MAX_BOOKINGS);

  // Mint a fresh mutation token per returned booking (atomic CAS, same pattern as
  // request-track-link). A booking whose token changes underneath us is skipped
  // rather than clobbered.
  const bookings = [];
  for (const b of visible) {
    try {
      const token = randomToken(32);
      const tokenHash = sha256(token);
      let upd = sb.from('bookings').update({ guest_mutation_token_hash: tokenHash }).eq('id', b.id);
      upd = b.guest_mutation_token_hash == null
        ? upd.is('guest_mutation_token_hash', null)
        : upd.eq('guest_mutation_token_hash', b.guest_mutation_token_hash);
      const { data: updated, error: updErr } = await upd.select('id');
      if (updErr || !updated?.length) continue;
      bookings.push({ ref: b.ref, service: b.service, date: b.date, time: b.time, status: b.status, token });
    } catch (e) {
      console.error('Track verify-code token mint error:', e && (e.message || e));
    }
  }

  return res.status(200).json({ ok: true, bookings });
}
