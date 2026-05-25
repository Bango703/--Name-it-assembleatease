import { timingSafeEqual } from 'crypto';
import { getSupabase } from './_supabase.js';

const LOGO = 'https://www.assembleatease.com/images/logo.jpg';
const SITE = 'https://www.assembleatease.com';

export function esc(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
  try {
    const sb = getSupabase();
    await sb.from('notification_log').insert({
      channel:           'email',
      booking_id:        meta.bookingId        || null,
      notification_type: meta.notificationType || 'transactional',
      recipient_type:    meta.recipientType    || null,
      recipient_email:   recipient,
      recipient_user_id: meta.recipientUserId  || null,
      subject,
      status,
      provider_id:  providerId,
      error_text:   errorText,
    });
  } catch (_) { /* non-fatal */ }

  if (status === 'failed') return { ok: false, error: errorText };
  return { ok: true, providerId };
}

export function ownerEmail() {
  return process.env.NOTIFY_EMAIL || 'service@assembleatease.com';
}

/**
 * Verify owner authorization via password header.
 * Returns true if authorized.
 */
export function verifyOwner(req) {
  const pw = process.env.OWNER_PASSWORD;
  if (!pw) return false;
  const provided = req.headers['x-owner-password'] || req.body?.ownerPassword;
  if (!provided) return false;
  try {
    const a = Buffer.from(String(pw));
    const b = Buffer.from(String(provided));
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch { return false; }
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
