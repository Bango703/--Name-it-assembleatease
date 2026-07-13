import { timingSafeEqual } from 'crypto';
import { getSupabase } from './_supabase.js';
import { createHmac, randomBytes } from 'crypto';

const LOGO = 'https://www.assembleatease.com/images/logo.jpg';
const SITE = 'https://www.assembleatease.com';
const DEDUPE_WINDOWS_MIN = {
  critical: 2,
  standard: 30,
  bulk: 24 * 60,
};
const BULK_DAILY_CAP = 2;

const CRITICAL_NOTIFICATION_TYPES = new Set([
  'booking_confirmed',
  'assignment_confirmation',
  'job_accepted',
  'completion',
  'payment_receipt',
  'cancellation',
  'refund',
  'payment_failed',
  'capture_failed',
  'dispatch_offer',
]);

const BULK_NOTIFICATION_TYPES = new Set([
  'review_request',
  'reminder',
  'daily_summary',
  'weekly_summary',
  'cron_alert',
]);

export function esc(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function inferNotificationType(subject, explicitType) {
  if (explicitType) return String(explicitType).toLowerCase();
  const s = String(subject || '').toLowerCase();
  if (s.includes('daily summary')) return 'daily_summary';
  if (s.includes('weekly summary')) return 'weekly_summary';
  if (s.includes('review')) return 'review_request';
  if (s.includes('reminder')) return 'reminder';
  if (s.includes('new job assignment')) return 'assignment_confirmation';
  if (s.includes('new job available')) return 'dispatch_offer';
  if (s.includes('job accepted') || s.includes('easer is confirmed')) return 'job_accepted';
  if (s.includes('booking confirmed')) return 'booking_confirmed';
  if (s.includes('booking cancelled') || s.includes('customer cancelled')) return 'cancellation';
  if (s.includes('refund')) return 'refund';
  if (s.includes('payment failed')) return 'payment_failed';
  if (s.includes('payment receipt') || s.includes('job complete')) return 'payment_receipt';
  if (s.includes('action required') || s.includes('urgent')) return 'cron_alert';
  return 'transactional';
}

function inferPriority(notificationType) {
  if (CRITICAL_NOTIFICATION_TYPES.has(notificationType)) return 'critical';
  if (BULK_NOTIFICATION_TYPES.has(notificationType)) return 'bulk';
  return 'standard';
}

function normalizeEmail(addr) {
  return String(addr || '').trim().toLowerCase();
}

async function insertNotificationLog(sb, payload) {
  try {
    const { error } = await sb.from('notification_log').insert(payload);
    if (error) throw error;
    return { ok: true, error: null };
  } catch (err) {
    console.error('notification_log insert failed:', err?.message || err);
    return { ok: false, error: err?.message || String(err) };
  }
}

async function getSuppressionReason(sb, { recipientEmail, subject, notificationType, priority, meta }) {
  if (meta?.disableDedupe) return null;

  const dedupeWindowMin = Number.isFinite(Number(meta?.dedupeWindowMin))
    ? Number(meta.dedupeWindowMin)
    : DEDUPE_WINDOWS_MIN[priority];
  const dedupeSince = new Date(Date.now() - dedupeWindowMin * 60000).toISOString();

  const { data: recent } = await sb
    .from('notification_log')
    .select('id')
    .eq('channel', 'email')
    .eq('recipient_email', recipientEmail)
    .eq('notification_type', notificationType)
    .eq('subject', subject)
    .in('status', ['sent', 'suppressed'])
    .gte('sent_at', dedupeSince)
    .limit(1);

  if (recent?.length) {
    return `duplicate_within_${dedupeWindowMin}m`;
  }

  if (priority === 'bulk' && !meta?.disableDailyCap) {
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const dayCap = Number.isFinite(Number(meta?.dailyCap)) ? Number(meta.dailyCap) : BULK_DAILY_CAP;

    const { count } = await sb
      .from('notification_log')
      .select('id', { count: 'exact', head: true })
      .eq('channel', 'email')
      .eq('recipient_email', recipientEmail)
      .eq('notification_type', notificationType)
      .eq('status', 'sent')
      .gte('sent_at', dayStart.toISOString());

    if ((count || 0) >= dayCap) {
      return `daily_cap_reached_${dayCap}`;
    }
  }

  return null;
}

/**
 * Send a transactional email via Resend and log the attempt to notification_log.
 *
 * meta (optional) — context for the log row:
 *   bookingId       UUID   — links the log entry to a booking
 *   notificationType TEXT  — e.g. 'dispatch_offer', 'job_accepted', 'completion'
 *   recipientType   TEXT   — 'customer' | 'easer' | 'owner'
 *   recipientUserId UUID   — Supabase user ID if known
 */
export async function sendEmail({ to, from, subject, html, replyTo, meta = {} }) {
  const KEY = process.env.RESEND_API_KEY;
  if (!KEY) throw new Error('Missing RESEND_API_KEY');

  const recipient = Array.isArray(to) ? to[0] : to;
  const recipientEmail = normalizeEmail(recipient);
  const notificationType = inferNotificationType(subject, meta.notificationType);
  const priority = meta.priority || inferPriority(notificationType);
  const recipientType = meta.recipientType || null;

  if (!recipientEmail) return { ok: false, error: 'Missing recipient email' };

  const sb = getSupabase();
  const suppressionReason = await getSuppressionReason(sb, {
    recipientEmail,
    subject,
    notificationType,
    priority,
    meta,
  });

  if (suppressionReason) {
    const logResult = await insertNotificationLog(sb, {
      channel: 'email',
      booking_id: meta.bookingId || null,
      notification_type: notificationType,
      recipient_type: recipientType,
      recipient_email: recipientEmail,
      recipient_user_id: meta.recipientUserId || null,
      subject,
      status: 'suppressed',
      provider_id: null,
      error_text: suppressionReason,
    });
    return { ok: true, suppressed: true, reason: suppressionReason, logged: logResult.ok, logError: logResult.error };
  }

  const body = { from, to: Array.isArray(to) ? to : [to], subject, html };
  if (replyTo) body.reply_to = replyTo;

  let providerId = null;
  let status = 'sent';
  let errorText = null;

  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      errorText = await resp.text();
      status = 'failed';
      console.error('Resend error:', errorText);
    } else {
      const data = await resp.json().catch(() => ({}));
      providerId = data?.id || null;
    }
  } catch (fetchErr) {
    errorText = fetchErr.message;
    status = 'failed';
    console.error('Resend fetch error:', fetchErr.message);
  }

  // Non-blocking log — never let logging failure break the caller
  const logResult = await insertNotificationLog(sb, {
    channel: 'email',
    booking_id: meta.bookingId || null,
    notification_type: notificationType,
    recipient_type: recipientType,
    recipient_email: recipientEmail,
    recipient_user_id: meta.recipientUserId || null,
    subject,
    status,
    provider_id: providerId,
    error_text: errorText,
  });

  if (status === 'failed') return { ok: false, error: errorText, logged: logResult.ok, logError: logResult.error };
  return { ok: true, providerId, notificationType, priority, logged: logResult.ok, logError: logResult.error };
}

export function ownerEmail() {
  return process.env.NOTIFY_EMAIL || 'service@assembleatease.com';
}

const OWNER_AUTH_WINDOW_MS = 10 * 60 * 1000;
const OWNER_AUTH_LOCK_MS = 15 * 60 * 1000;
const OWNER_AUTH_MAX_FAILS = 5;
const ownerAuthAttempts = new Map();

function getClientIp(req) {
  const forwarded = String(req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  const realIp = String(req?.headers?.['x-real-ip'] || '').trim();
  const cfIp = String(req?.headers?.['cf-connecting-ip'] || '').trim();
  return forwarded || realIp || cfIp || 'unknown';
}

function getOwnerAuthKey(req) {
  // Key brute-force lockout by IP ONLY. Including the User-Agent let an attacker
  // reset their attempt budget simply by spoofing the UA header on each request,
  // which defeated the lockout. IP-only is the correct, standard choice.
  return getClientIp(req);
}

function ownerAuthLocked(req) {
  const key = getOwnerAuthKey(req);
  const now = Date.now();
  const state = ownerAuthAttempts.get(key);
  if (!state) return false;
  if (state.lockUntil && state.lockUntil > now) return true;
  if (state.windowStart && now - state.windowStart > OWNER_AUTH_WINDOW_MS) {
    ownerAuthAttempts.delete(key);
  }
  return false;
}

function recordOwnerAuthFailure(req) {
  const key = getOwnerAuthKey(req);
  const now = Date.now();
  const state = ownerAuthAttempts.get(key);

  if (!state || now - (state.windowStart || 0) > OWNER_AUTH_WINDOW_MS) {
    ownerAuthAttempts.set(key, { fails: 1, windowStart: now, lockUntil: 0 });
    return;
  }

  state.fails += 1;
  if (state.fails >= OWNER_AUTH_MAX_FAILS) {
    state.lockUntil = now + OWNER_AUTH_LOCK_MS;
    state.fails = 0;
    state.windowStart = now;
  }
  ownerAuthAttempts.set(key, state);
}

function recordOwnerAuthSuccess(req) {
  const key = getOwnerAuthKey(req);
  ownerAuthAttempts.delete(key);
}

export function verifyOwnerPassword(req, suppliedPassword) {
  if (ownerAuthLocked(req)) return false;

  const pw = process.env.OWNER_PASSWORD;
  if (!pw) {
    recordOwnerAuthFailure(req);
    return false;
  }

  const provided = suppliedPassword ?? req.headers?.['x-owner-password'] ?? req.body?.ownerPassword;
  if (!provided) {
    recordOwnerAuthFailure(req);
    return false;
  }

  try {
    const a = Buffer.from(String(pw));
    const b = Buffer.from(String(provided));
    if (a.length !== b.length) {
      recordOwnerAuthFailure(req);
      return false;
    }
    const ok = timingSafeEqual(a, b);
    if (!ok) {
      recordOwnerAuthFailure(req);
      return false;
    }
    recordOwnerAuthSuccess(req);
    return true;
  } catch {
    recordOwnerAuthFailure(req);
    return false;
  }
}

const OWNER_SESSION_TTL_SECONDS = 8 * 60 * 60;

function ownerSessionSecret() {
  return String(process.env.OWNER_SESSION_SECRET || '').trim();
}

function signOwnerSessionPayload(encodedPayload) {
  const secret = ownerSessionSecret();
  if (secret.length < 32) return null;
  return createHmac('sha256', secret).update(encodedPayload).digest('base64url');
}

export function createOwnerSessionToken() {
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({
    v: 1,
    sub: 'owner',
    iat: now,
    exp: now + OWNER_SESSION_TTL_SECONDS,
    nonce: randomBytes(16).toString('hex'),
  })).toString('base64url');
  const signature = signOwnerSessionPayload(payload);
  if (!signature) return null;
  return {
    token: `${payload}.${signature}`,
    expiresAt: new Date((now + OWNER_SESSION_TTL_SECONDS) * 1000).toISOString(),
  };
}

function verifyOwnerSessionToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2) return false;
  const [payload, suppliedSignature] = parts;
  const expectedSignature = signOwnerSessionPayload(payload);
  if (!expectedSignature) return false;

  try {
    const a = Buffer.from(expectedSignature);
    const b = Buffer.from(suppliedSignature);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const now = Math.floor(Date.now() / 1000);
    return decoded?.v === 1
      && decoded?.sub === 'owner'
      && Number.isInteger(decoded?.iat)
      && Number.isInteger(decoded?.exp)
      && decoded.iat <= now + 60
      && decoded.exp > now
      && decoded.exp - decoded.iat <= OWNER_SESSION_TTL_SECONDS;
  } catch {
    return false;
  }
}

/**
 * Verify owner authorization using a short-lived signed bearer session.
 * Direct password headers remain available only outside production for local
 * operational scripts unless explicitly enabled during a controlled migration.
 */
export function verifyOwner(req) {
  const authorization = String(req.headers?.authorization || '');
  if (/^Bearer\s+/i.test(authorization)) {
    return verifyOwnerSessionToken(authorization.replace(/^Bearer\s+/i, '').trim());
  }

  const allowLegacyPassword = process.env.VERCEL_ENV !== 'production'
    || process.env.ALLOW_LEGACY_OWNER_PASSWORD === 'true';
  return allowLegacyPassword ? verifyOwnerPassword(req) : false;
}

/**
 * Build a styled status email for customers.
 */
export function buildStatusEmail({ customerName, ref, status, statusColor, statusBg, headline, bodyHtml }) {
  const sName = esc(customerName);
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1a1a1a">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px 8px 0 0;border-bottom:1px solid #e4e4e7"><tr><td style="padding:20px 24px;text-align:center">
    <img src="${LOGO}" alt="AssembleAtEase" width="44" height="44" style="border-radius:50%;display:inline-block"/>
    <p style="margin:8px 0 0;font-size:17px;font-weight:700;color:#1a1a1a">AssembleAtEase</p>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-left:1px solid #e4e4e7;border-right:1px solid #e4e4e7"><tr><td style="padding:32px 24px 24px">
    <p style="margin:0 0 6px;font-size:24px;font-weight:700;color:#1a1a1a">${headline}</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-radius:6px;margin:20px 0"><tr><td style="padding:18px 20px">
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr><td style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:#71717a;padding-bottom:6px">Booking Reference</td><td style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:#71717a;padding-bottom:6px;text-align:right">Status</td></tr>
        <tr><td style="font-size:16px;font-weight:700;color:#1a1a1a">${esc(ref)}</td><td style="text-align:right"><span style="display:inline-block;background:${statusBg};color:${statusColor};font-size:11px;font-weight:700;padding:3px 10px;border-radius:99px">${status}</span></td></tr>
      </table>
    </td></tr></table>
    ${bodyHtml}
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:24px"><tr><td style="text-align:center;padding:8px 0">
      <a href="mailto:service@assembleatease.com" style="display:inline-block;background:#00BFFF;color:#ffffff;padding:12px 32px;border-radius:6px;text-decoration:none;font-size:14px;font-weight:600">Contact Us</a>
    </td></tr></table>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-top:none;border-radius:0 0 8px 8px"><tr><td style="padding:20px 24px;text-align:center">
    <img src="${LOGO}" alt="AssembleAtEase" width="28" height="28" style="border-radius:50%;display:inline-block"/>
    <p style="margin:8px 0 4px;font-size:12px;font-weight:600;color:#71717a">AssembleAtEase</p>
    <p style="margin:0 0 8px;font-size:11px;color:#a1a1aa;line-height:1.5">Professional Assembly &amp; Handyman Services<br/>Austin, TX 78701 &bull; (737) 290-6129</p>
    <p style="margin:0 0 6px;font-size:11px;color:#a1a1aa"><a href="${SITE}" style="color:#71717a;text-decoration:none">assembleatease.com</a> &bull; <a href="mailto:service@assembleatease.com" style="color:#71717a;text-decoration:none">service@assembleatease.com</a></p>
    <p style="margin:0;font-size:10px;color:#c4c4c4">This is a transactional email related to your booking. To opt out of non-essential emails, <a href="${SITE}/contact?subject=Email+Preferences" style="color:#a1a1aa;text-decoration:underline">contact us here</a>.</p>
  </td></tr></table>
</div></body></html>`;
}
