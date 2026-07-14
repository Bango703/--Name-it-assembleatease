// AssembleCash — future-booking CREDIT (never cash, never withdrawable).
// Email-keyed (no customer login). The ledger is the source of truth for
// balance; all money guardrails are enforced here, server-side. Every function
// degrades gracefully if migration 025 is not applied (missing table) so it can
// never break a booking or completion.
import crypto from 'crypto';
import { isMissingTableError } from './_promotions.js';

export const ASSEMBLECASH = Object.freeze({
  EARN_RATE_PCT: 5,
  MAX_REDEEM_CENTS: 2000,   // $20 cap per booking
  EXPIRY_DAYS: 180,
  CODE_TTL_MIN: 10,
  CODE_MAX_ATTEMPTS: 5,
  TOKEN_TTL_MIN: 30,
});

export function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function tokenSecret() {
  return process.env.ASSEMBLECASH_TOKEN_SECRET
    || process.env.CRON_SECRET
    || process.env.STRIPE_WEBHOOK_SECRET
    || 'aae-assemblecash-dev-secret';
}

function isMissingRpcError(error) {
  const msg = String(error?.message || '');
  return error?.code === '42883'
    || error?.code === 'PGRST202'
    || /Could not find the function/i.test(msg)
    || /does not exist/i.test(msg);
}

// ── Earning ──────────────────────────────────────────────────────────────────
// Credit 5% of the captured total. Idempotent: a unique index on booking_id
// (WHERE amount_earned_cents > 0) makes a second call a no-op, so a retry or an
// owner/Easer race can never double-credit a job.
export async function earnForBooking(sb, { bookingId, bookingRef, customerEmail, amountChargedCents }) {
  const email = normalizeEmail(customerEmail);
  const amount = Math.round(Number(amountChargedCents) || 0);
  if (!sb || !email || !bookingId || amount <= 0) return 0;
  const earned = Math.round(amount * ASSEMBLECASH.EARN_RATE_PCT / 100);
  if (earned <= 0) return 0;
  const expiresAt = new Date(Date.now() + ASSEMBLECASH.EXPIRY_DAYS * 86400000).toISOString();
  try {
    const { error } = await sb.from('assemblecash_ledger').insert({
      customer_email: email,
      booking_id: bookingId,
      booking_ref: bookingRef || null,
      amount_earned_cents: earned,
      status: 'available',
      reason: 'earn:booking_complete',
      expires_at: expiresAt,
    });
    if (error) {
      if (error.code === '23505') return 0;        // already earned for this booking
      if (isMissingTableError(error)) return 0;     // migration 025 not applied yet
      throw error;
    }
    return earned;
  } catch (e) {
    if (isMissingTableError(e)) return 0;
    console.warn('AssembleCash earnForBooking error:', e && (e.message || e));
    return 0;
  }
}

// ── Balance ──────────────────────────────────────────────────────────────────
export async function getAvailableBalanceCents(sb, email) {
  const e = normalizeEmail(email);
  if (!sb || !e) return 0;
  try {
    const { data, error } = await sb.rpc('assemblecash_available_balance', { p_email: e });
    if (error) { if (isMissingTableError(error)) return 0; throw error; }
    return Math.max(0, Math.round(Number(data) || 0));
  } catch (err) {
    if (isMissingTableError(err)) return 0;
    console.warn('AssembleCash balance error:', err && (err.message || err));
    return 0;
  }
}

// ── Reverse on refund/cancel ─────────────────────────────────────────────────
// Only un-redeemed, still-available earn rows are reversed. Credit a customer
// already spent is never clawed back here.
export async function reverseForBooking(sb, bookingId, reason) {
  if (!sb || !bookingId) return { ok: false, error: 'AssembleCash reversal input is incomplete' };
  try {
    const { data, error } = await sb.from('assemblecash_ledger')
      .update({ status: 'reversed', reason: reason || 'reverse:refund', updated_at: new Date().toISOString() })
      .eq('booking_id', bookingId)
      .gt('amount_earned_cents', 0)
      .eq('status', 'available')
      .select('id');
    if (error) {
      if (isMissingTableError(error)) return { ok: false, unavailable: true, error: error.message || String(error) };
      throw error;
    }
    return { ok: true, reversedCount: data?.length || 0 };
  } catch (e) {
    if (!isMissingTableError(e)) console.warn('AssembleCash reverse error:', e && (e.message || e));
    return { ok: false, unavailable: isMissingTableError(e), error: e?.message || String(e) };
  }
}

// Refund/cancellation reconciliation must serialize against redemption for the
// same customer. The database RPC uses the same advisory lock as
// assemblecash_try_redeem, so a refund cannot race a checkout that is spending
// credit from the refunded source booking.
export async function reconcileBookingCredits(sb, {
  bookingId,
  releaseRedemption = false,
  reason,
} = {}) {
  if (!sb || !bookingId) {
    return { ok: false, error: 'AssembleCash reconciliation input is incomplete' };
  }
  try {
    const { data, error } = await sb.rpc('assemblecash_reconcile_booking_credits', {
      p_booking_id: bookingId,
      p_release_redemption: !!releaseRedemption,
      p_reason: reason || 'reverse:booking_financial_reversal',
    });
    if (error) {
      if (isMissingTableError(error) || isMissingRpcError(error)) {
        return { ok: false, unavailable: true, error: error.message || String(error) };
      }
      throw error;
    }
    const result = Array.isArray(data) ? data[0] : data;
    const earnedReconciled = result?.earned_reconciled === true;
    const redemptionReconciled = result?.redemption_reconciled === true;
    const counts = {
      reversedEarnCount: Math.max(0, Number(result?.reversed_earn_count || 0)),
      releasedRedemptionCount: Math.max(0, Number(result?.released_redemption_count || 0)),
    };
    if (!earnedReconciled || !redemptionReconciled) {
      return {
        ok: false,
        unavailable: false,
        error: 'AssembleCash durable ledger truth does not match the booking summary',
        ...counts,
        earnedReconciled,
        redemptionReconciled,
      };
    }
    return {
      ok: true,
      ...counts,
      earnedReconciled,
      redemptionReconciled,
    };
  } catch (error) {
    if (!isMissingTableError(error)) {
      console.warn('AssembleCash booking reconciliation error:', error && (error.message || error));
    }
    return {
      ok: false,
      unavailable: isMissingTableError(error) || isMissingRpcError(error),
      error: error?.message || String(error),
    };
  }
}

// ── Redemption math (server-authoritative) ───────────────────────────────────
// Max credit applyable without (a) exceeding the $20 cap, (b) exceeding the
// balance, or (c) pushing the pre-tax service base below the platform margin floor.
export function maxRedeemableCents({ balanceCents, pretaxBaseCents, marginFloorCents }) {
  const bal = Math.max(0, Math.round(Number(balanceCents) || 0));
  const base = Math.max(0, Math.round(Number(pretaxBaseCents) || 0));
  const floor = Math.max(0, Math.round(Number(marginFloorCents) || 0));
  const headroom = Math.max(0, base - floor);
  return Math.min(bal, ASSEMBLECASH.MAX_REDEEM_CENTS, headroom);
}

// ── Redemption recording ─────────────────────────────────────────────────────
export async function recordRedemption(sb, { bookingId, bookingRef, customerEmail, amountCents }) {
  const email = normalizeEmail(customerEmail);
  const amt = Math.round(Number(amountCents) || 0);
  if (!sb || !email || amt <= 0) return 0;
  try {
    const { error } = await sb.from('assemblecash_ledger').insert({
      customer_email: email,
      booking_id: bookingId || null,
      booking_ref: bookingRef || null,
      amount_redeemed_cents: amt,
      status: 'redeemed',
      reason: 'redeem:booking',
    });
    if (error) { if (isMissingTableError(error)) return 0; throw error; }
    return amt;
  } catch (e) {
    if (isMissingTableError(e)) return 0;
    console.warn('AssembleCash recordRedemption error:', e && (e.message || e));
    return 0;
  }
}

export async function reserveRedemption(sb, { customerEmail, requestedAmountCents, bookingRef }) {
  const email = normalizeEmail(customerEmail);
  const requested = Math.max(0, Math.round(Number(requestedAmountCents) || 0));
  if (!sb || !email || requested <= 0) return 0;
  try {
    const { data, error } = await sb.rpc('assemblecash_try_redeem', {
      p_email: email,
      p_amount_cents: requested,
      p_booking_ref: bookingRef || null,
    });
    if (error) {
      if (isMissingTableError(error)) return 0;
      if (isMissingRpcError(error)) {
        const rpcErr = new Error('AssembleCash reservation function is missing');
        rpcErr.code = 'AC_REDEMPTION_RPC_MISSING';
        throw rpcErr;
      }
      throw error;
    }
    return Math.max(0, Math.round(Number(data) || 0));
  } catch (error) {
    if (isMissingTableError(error)) return 0;
    if (error?.code === 'AC_REDEMPTION_RPC_MISSING') throw error;
    console.warn('AssembleCash reserveRedemption error:', error && (error.message || error));
    return 0;
  }
}

export async function attachRedemptionToBooking(sb, { bookingId, bookingRef, customerEmail }) {
  const email = normalizeEmail(customerEmail);
  if (!sb || !bookingId || !bookingRef || !email) return;
  try {
    await sb
      .from('assemblecash_ledger')
      .update({
        booking_id: bookingId,
        reason: 'redeem:booking',
        updated_at: new Date().toISOString(),
      })
      .eq('customer_email', email)
      .eq('booking_ref', bookingRef)
      .eq('status', 'redeemed')
      .is('booking_id', null);
  } catch (error) {
    if (!isMissingTableError(error)) {
      console.warn('AssembleCash attachRedemptionToBooking error:', error && (error.message || error));
    }
  }
}

export async function releasePendingRedemption(sb, { bookingId, bookingRef, customerEmail, reason }) {
  const email = normalizeEmail(customerEmail);
  if (!sb || (!bookingId && (!bookingRef || !email))) {
    return { ok: false, error: 'AssembleCash redemption release input is incomplete' };
  }
  try {
    const payload = {
      status: 'reversed',
      reason: reason || 'reverse:booking_setup_failed',
      updated_at: new Date().toISOString(),
    };
    let query;
    if (bookingId) {
      query = sb
        .from('assemblecash_ledger')
        .update(payload)
        .eq('booking_id', bookingId)
        .eq('status', 'redeemed');
    } else {
      query = sb
        .from('assemblecash_ledger')
        .update(payload)
        .eq('customer_email', email)
        .eq('booking_ref', bookingRef)
        .eq('status', 'redeemed');
    }
    const { data, error } = await query.select('id');
    if (error) {
      if (isMissingTableError(error)) return { ok: false, unavailable: true, error: error.message || String(error) };
      throw error;
    }
    return { ok: true, releasedCount: data?.length || 0 };
  } catch (error) {
    if (!isMissingTableError(error)) {
      console.warn('AssembleCash releasePendingRedemption error:', error && (error.message || error));
    }
    return { ok: false, unavailable: isMissingTableError(error), error: error?.message || String(error) };
  }
}

// ── Passwordless email codes (OTP) ───────────────────────────────────────────
export function hashCode(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex');
}

export async function generateAndStoreCode(sb, email, purpose) {
  const e = normalizeEmail(email);
  const p = purpose || 'assemblecash';
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const expiresAt = new Date(Date.now() + ASSEMBLECASH.CODE_TTL_MIN * 60000).toISOString();
  const { error } = await sb.from('customer_verification_codes').insert({
    email: e, code_hash: hashCode(code), purpose: p, expires_at: expiresAt,
  });
  if (error) throw error;
  return code;
}

export async function verifyCode(sb, email, code, purpose) {
  const e = normalizeEmail(email);
  const p = purpose || 'assemblecash';
  const codeStr = String(code || '').trim();
  if (!/^\d{6}$/.test(codeStr)) return false;
  const { data: rows, error } = await sb
    .from('customer_verification_codes')
    .select('id, code_hash, attempts, expires_at, consumed_at')
    .eq('email', e).eq('purpose', p)
    .is('consumed_at', null)
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  const row = rows && rows[0];
  if (!row) return false;
  if (new Date(row.expires_at).getTime() < Date.now()) return false;
  if ((row.attempts || 0) >= ASSEMBLECASH.CODE_MAX_ATTEMPTS) return false;
  if (row.code_hash !== hashCode(codeStr)) {
    await sb.from('customer_verification_codes').update({ attempts: (row.attempts || 0) + 1 }).eq('id', row.id);
    return false;
  }
  await sb.from('customer_verification_codes').update({ consumed_at: new Date().toISOString() }).eq('id', row.id);
  return true;
}

// ── Redemption token (proves email ownership through checkout) ───────────────
// Issued after a verified code; the booking endpoint re-verifies it before
// honoring any credit, so credit cannot be applied from a typed email alone.
export function issueRedemptionToken(email) {
  const e = normalizeEmail(email);
  const exp = Date.now() + ASSEMBLECASH.TOKEN_TTL_MIN * 60000;
  const payload = e + '|' + exp;
  const sig = crypto.createHmac('sha256', tokenSecret()).update(payload).digest('hex');
  return Buffer.from(payload).toString('base64url') + '.' + sig;
}

export function verifyRedemptionToken(token, email) {
  try {
    const e = normalizeEmail(email);
    const parts = String(token || '').split('.');
    if (parts.length !== 2) return false;
    const payload = Buffer.from(parts[0], 'base64url').toString('utf8');
    const expected = crypto.createHmac('sha256', tokenSecret()).update(payload).digest('hex');
    const sigBuf = Buffer.from(parts[1]);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return false;
    const seg = payload.split('|');
    if (seg[0] !== e) return false;
    if (Number(seg[1]) < Date.now()) return false;
    return true;
  } catch (_) { return false; }
}
