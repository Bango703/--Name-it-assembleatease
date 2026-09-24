import { timingSafeEqual } from 'crypto';
import { getSupabase } from './_supabase.js';
import { prepareNotification, settleNotification } from './_notification-policy.js';
import { unsubscribeUrl, broadcastFooter, normalizeEmail as normalizeSuppressionEmail } from './_broadcast.js';
import { createHmac, randomBytes } from 'crypto';

const LOGO = 'https://www.assembleatease.com/images/logo.jpg';
const SITE = 'https://www.assembleatease.com';
const DEDUPE_WINDOWS_MIN = {
  critical: 2,
  standard: 30,
  bulk: 24 * 60,
};
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

/**
 * Mail a person did not ask for on this occasion. CAN-SPAM applies: it needs a
 * one-click unsubscribe, a physical postal address, and it must never reach
 * someone already on the opt-out list.
 *
 * email_suppressions existed and was honoured in exactly ONE place —
 * api/owner/broadcast.js — so every other re-engagement send could email a
 * person who had already unsubscribed. The check belongs here, in the one
 * function they all go through, not in each caller that remembers.
 *
 * Transactional mail is deliberately absent. Someone who opts out of marketing
 * must still receive their own booking confirmation and receipts.
 */
const MARKETING_NOTIFICATION_TYPES = new Set([
  'customer_rebook_invite',
  'rebook_payment_method_requested',
  'rebook_card_saved',
  'review_request',
  'followup',
  'waitlist_invite',
  'broadcast',
  'broadcast_test',
  'announcement',
]);

const BULK_NOTIFICATION_TYPES = new Set([
  'review_request',
  'followup',
  'reminder',
  'daily_summary',
  'weekly_summary',
  'cron_alert',
]);

export function esc(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Normalize a free-typed street address into a clean, consistent, professional
// format for every customer/Easer/owner surface. Collapses stray whitespace,
// fixes comma spacing, drops trailing commas, and uppercases (mailing-label
// style) so "500 main st,  dallas, tx" reads "500 MAIN ST, DALLAS, TX".
// Not a validator — purely presentational. Escape the result with esc() before
// embedding in HTML.
export function formatAddress(raw) {
  if (!raw) return '';
  return String(raw)
    .split(',')
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(', ')
    .toUpperCase();
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

async function reconcileEarlyProviderEvent(sb, providerId) {
  if (!providerId) return;
  try {
    const { error } = await sb.rpc('reconcile_resend_delivery_events_v1', { p_provider_id: providerId });
    if (error && !['42883', 'PGRST202'].includes(error.code)) console.error('email provider reconciliation failed:', error.message);
  } catch (error) { console.error('email provider reconciliation unavailable:', error?.message); }
}

/** One shared, durable delivery path. An accepted send is not proof of inbox
 * delivery. A deferred/failed send is never reported as a successful duplicate. */
export async function sendEmail({ to, from, subject, html, replyTo, meta = {} }) {
  const KEY = process.env.RESEND_API_KEY;
  if (!KEY) return { ok: false, error: 'Email provider is not configured.' };
  const recipientEmail = normalizeEmail(Array.isArray(to) ? to[0] : to);
  if (!recipientEmail) return { ok: false, error: 'Missing recipient email' };
  if (Array.isArray(to) && to.length > 1) return { ok: false, error: 'Send one recipient per notification so delivery and preferences remain attributable.' };
  const notificationType = inferNotificationType(subject, meta.notificationType);
  const priority = meta.priority || inferPriority(notificationType);
  const explicitType = String(meta.recipientType || '').toLowerCase();
  const recipientType = ['customer', 'easer', 'owner'].includes(explicitType) ? explicitType
    : recipientEmail === normalizeEmail(ownerEmail()) ? 'owner' : 'unknown';
  const context = { ...meta, notificationType, recipientType,
    dedupeWindowMin: meta.dedupeWindowMin ?? DEDUPE_WINDOWS_MIN[priority] };
  const isMarketing = MARKETING_NOTIFICATION_TYPES.has(notificationType) && recipientType !== 'owner';
  const sb = getSupabase();

  // Opt-out is honoured HERE, for every caller. Checked before anything is
  // built or claimed, so an unsubscribed address costs nothing and leaves no
  // half-written log row. A failed lookup refuses the send rather than
  // guessing: mailing someone who opted out cannot be undone.
  // An unsubscribe link is signed with UNSUBSCRIBE_SECRET (or CRON_SECRET).
  // With neither set the token is empty and /api/unsubscribe rejects every
  // click, so the mail would carry an opt-out that silently does nothing.
  // Refuse to send rather than ship a dead unsubscribe: a misconfigured
  // environment must not be able to put unopt-outable marketing in an inbox.
  if (isMarketing && !/&t=.+$/.test(unsubscribeUrl(recipientEmail))) {
    console.error('[email] marketing send blocked: UNSUBSCRIBE_SECRET/CRON_SECRET is not set, so the unsubscribe link cannot be signed');
    return { ok: false, error: 'Unsubscribe links cannot be signed in this environment. No marketing email was sent.' };
  }

  if (isMarketing) {
    const { data: suppressed, error: suppressErr } = await sb
      .from('email_suppressions').select('email')
      .eq('email', normalizeSuppressionEmail(recipientEmail)).maybeSingle();
    if (suppressErr) return { ok: false, error: 'Could not verify the opt-out list. Nothing was sent.' };
    if (suppressed) return { ok: true, suppressed: true, reason: 'unsubscribed', notificationType };
  }

  // Marketing mail carries the two CAN-SPAM must-haves: a physical postal
  // address and a one-click unsubscribe that opts out this address alone.
  // The broadcast tool and the follow-up cron already append it themselves, so
  // only add it when genuinely absent: two unsubscribe links in one email looks
  // broken and invites the reader to distrust both.
  const alreadyHasOptOut = /\/api\/unsubscribe/.test(String(html || ''));
  const bodyHtml = isMarketing && !alreadyHasOptOut
    ? `${html}${broadcastFooter(recipientEmail)}`
    : html;
  const body = { from, to: [recipientEmail], subject,
    html: ensureEmailShell(bodyHtml, recipientType, meta.preheader), text: htmlToText(bodyHtml) };
  if (replyTo) body.reply_to = replyTo;
  const oneClick = typeof meta.listUnsubscribe === 'string' && /^https:\/\//.test(meta.listUnsubscribe)
    ? meta.listUnsubscribe
    : isMarketing ? unsubscribeUrl(recipientEmail) : null;
  if (oneClick) {
    body.headers = { 'List-Unsubscribe': `<${oneClick}>, <mailto:service@assembleatease.com?subject=unsubscribe>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' };
  } else if (priority === 'bulk') {
    body.headers = { 'List-Unsubscribe': '<mailto:service@assembleatease.com?subject=unsubscribe>, <https://www.assembleatease.com/contact?subject=Email%20Preferences>' };
  }
  const prepared = await prepareNotification(sb, { channel: 'email', recipient: recipientEmail, subject, meta: context,
    payload: { kind: 'email', body, original: { to: recipientEmail, from, subject, html, replyTo } } });
  if (!prepared.claim) return prepared;
  const claim = prepared.claim;
  // Always reuse the frozen provider request with its key, even if the caller
  // rebuilds a signed link or template while retrying an uncertain request.
  let status = 'provider_accepted', providerId = null, errorText = null, retryable = false;
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST', signal: AbortSignal.timeout(20000),
      headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', 'Idempotency-Key': claim.key },
      body: JSON.stringify(claim.payload.body),
    });
    const response = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      status = 'failed';
      errorText = response.message || `Email provider rejected the send (HTTP ${resp.status}).`;
      retryable = resp.status === 429 || resp.status >= 500 || (resp.status === 409 && response.name === 'concurrent_idempotent_requests');
    } else if (!response.id) {
      status = 'failed'; errorText = 'Email provider response had no message reference.'; retryable = true;
    } else providerId = response.id;
  } catch (error) {
    status = 'failed'; errorText = error?.message || 'Email request timed out.'; retryable = true;
  }
  const logged = await settleNotification(sb, claim, { status, providerId, error: errorText, retryable });
  if (providerId) await reconcileEarlyProviderEvent(sb, providerId);
  return status === 'provider_accepted'
    ? { ok: true, providerAccepted: true, deliveryStatus: status, providerId, notificationType, priority, logged: logged.ok, logError: logged.error }
    : { ok: false, error: errorText, retryScheduled: logged.ok && retryable && claim.attempt < 4, logged: logged.ok, logError: logged.error };
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
 * operational scripts. Production accepts signed bearer sessions only.
 */
export function verifyOwner(req) {
  const authorization = String(req.headers?.authorization || '');
  if (/^Bearer\s+/i.test(authorization)) {
    return verifyOwnerSessionToken(authorization.replace(/^Bearer\s+/i, '').trim());
  }

  const allowLegacyPassword = process.env.VERCEL_ENV !== 'production';
  return allowLegacyPassword ? verifyOwnerPassword(req) : false;
}

/**
 * Build a styled status email for customers.
 */
/* ── The one email frame ────────────────────────────────────────────────────
 * Header and footer live here so every email looks like it came from the same
 * company. The wordmark is TEXT under the logo on purpose: Gmail and Outlook
 * block remote images by default, and a header that collapses to nothing when
 * images are off is not branding.
 */
const EMAIL_HEADER = `  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px 8px 0 0;border-bottom:1px solid #e4e4e7"><tr><td style="padding:20px 24px;text-align:center">
    <img src="${LOGO}" alt="AssembleAtEase" width="44" height="44" style="border-radius:50%;display:inline-block"/>
    <p style="margin:8px 0 0;font-size:17px;font-weight:700;color:#1a1a1a">AssembleAtEase</p>
  </td></tr></table>`;

/* The opt-out line is for people who could reasonably want out. The owner
 * cannot unsubscribe from his own operational alerts, so telling him he can
 * would be noise. */
function emailFooter(recipientType) {
  const optOut = recipientType === 'owner'
    ? ''
    : `\n    <p style="margin:0;font-size:10px;color:#c4c4c4">This is a transactional email related to your booking. To opt out of non-essential emails, <a href="${SITE}/contact?subject=Email+Preferences" style="color:#a1a1aa;text-decoration:underline">contact us here</a>.</p>`;
  return `  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-top:none;border-radius:0 0 8px 8px"><tr><td style="padding:20px 24px;text-align:center">
    <img src="${LOGO}" alt="AssembleAtEase" width="28" height="28" style="border-radius:50%;display:inline-block"/>
    <p style="margin:8px 0 4px;font-size:12px;font-weight:600;color:#71717a">AssembleAtEase</p>
    <p style="margin:0 0 8px;font-size:11px;color:#a1a1aa;line-height:1.5">Professional Assembly &amp; Handyman Services<br/>Serving customers across Texas &bull; (979) 232-5139</p>
    <p style="margin:0 0 6px;font-size:11px;color:#a1a1aa"><a href="${SITE}" style="color:#71717a;text-decoration:none">assembleatease.com</a> &bull; <a href="mailto:service@assembleatease.com" style="color:#71717a;text-decoration:none">service@assembleatease.com</a></p>${optOut}
  </td></tr></table>`;
}

const EMAIL_DOC_OPEN = `<!DOCTYPE html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1a1a1a">`;

/* The inbox preview line. Without one, Gmail shows whatever text comes first —
 * which, now that every email has a logo, is the logo's alt text. The trailing
 * entities stop the client from dragging footer text into the preview. */
function preheaderBlock(text) {
  const line = String(text || '').trim();
  if (!line) return '';
  return `\n<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;height:0;width:0">${esc(line)}${'&#8204;&nbsp;'.repeat(60)}</div>`;
}

/* First real sentence of the email, used as the preview line when the caller
 * does not supply one. */
export function derivePreheader(html, limit = 140) {
  const text = htmlToText(html).split('\n').map(s => s.trim()).filter(Boolean)[0] || '';
  if (text.length <= limit) return text;
  return text.slice(0, limit - 1).replace(/\s+\S*$/, '') + '…';
}

const ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'",
  '&nbsp;': ' ', '&bull;': '·', '&mdash;': '—', '&ndash;': '–', '&rsquo;': '’',
  '&lsquo;': '‘', '&ldquo;': '“', '&rdquo;': '”', '&hellip;': '…', '&#8204;': '',
};

/* A text/plain alternative. HTML-only mail scores worse with spam filters and
 * reads badly on watches and screen readers, and until now every email this
 * platform sent was HTML-only. */
export function htmlToText(html) {
  return String(html || '')
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, '')
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href, label) => {
      const text = label.replace(/<[^>]+>/g, '').trim();
      const url = href.replace(/^mailto:/i, '');
      if (!text) return url;
      return text === url ? text : `${text} (${url})`;
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|h[1-6]|li|table)>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&#?\w+;/g, m => (m in ENTITIES ? ENTITIES[m] : m))
    .split('\n').map(line => line.replace(/[ \t]+/g, ' ').trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* A caller that already built a whole document keeps it. Everything else is a
 * fragment and gets the frame — which is how 33 senders were shipping bare <p>
 * tags with no logo, no footer and no opt-out line. */
export function isFullEmailDocument(html) {
  return /<!DOCTYPE|<html[\s>]/i.test(String(html || ''));
}

export function ensureEmailShell(html, recipientType, preheader) {
  const raw = String(html || '');
  // A hand-rolled full document keeps its own layout, but it may not keep
  // its own idea of a footer. Six of them shipped to customers and Easers
  // with no phone number, no contact address and no opt-out line, because
  // pass-through meant pass-through of the footer too. Rewriting six
  // bespoke templates risks six new layout bugs; giving them the house
  // footer does not, and it closes the whole class at once.
  if (isFullEmailDocument(raw)) {
    if (recipientType === 'owner' || /assembleatease\.com<\/a>|232-5139/.test(raw)) return raw;
    const close = raw.lastIndexOf('</body>');
    if (close === -1) return `${raw}${emailFooter(recipientType)}`;
    return `${raw.slice(0, close)}${emailFooter(recipientType)}${raw.slice(close)}`;
  }
  const preview = preheader === undefined ? derivePreheader(raw) : preheader;
  return `${EMAIL_DOC_OPEN}${preheaderBlock(preview)}
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
${EMAIL_HEADER}
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-left:1px solid #e4e4e7;border-right:1px solid #e4e4e7"><tr><td style="padding:32px 24px 24px;font-size:15px;line-height:1.7;color:#3f3f46">
${raw}
  </td></tr></table>
${emailFooter(recipientType)}
</div></body></html>`;
}

export function buildStatusEmail({ customerName, ref, status, statusColor, statusBg, headline, bodyHtml, preheader }) {
  const sName = esc(customerName);
  const preview = preheader === undefined ? derivePreheader(bodyHtml) : preheader;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1a1a1a">${preheaderBlock(preview)}
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
${EMAIL_HEADER}
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
${emailFooter('customer')}
</div></body></html>`;
}

// Completion emails confirm the outcome only. The separate secure review
// request collects the canonical platform review, then offers Google as an
// optional second step after submission.
export function buildReviewCta() {
  return `<p style="margin:0 0 12px;font-size:15px;color:#52525b;line-height:1.7">We will send a separate secure review link so you can rate the service and share feedback.</p>`;
}
