import { timingSafeEqual } from 'crypto';
const LOGO = 'https://www.assembleatease.com/images/logo.jpg';
const SITE = 'https://www.assembleatease.com';

export function esc(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export async function sendEmail({ to, from, subject, html, replyTo }) {
  const KEY = process.env.RESEND_API_KEY;
  if (!KEY) throw new Error('Missing RESEND_API_KEY');
  const body = { from, to: Array.isArray(to) ? to : [to], subject, html };
  if (replyTo) body.reply_to = replyTo;
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const err = await resp.text();
    console.error('Resend error:', err);
    return { ok: false, error: err };
  }
  return { ok: true };
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
      <a href="mailto:service@assembleatease.com" style="display:inline-block;background:#0097a7;color:#ffffff;padding:12px 32px;border-radius:6px;text-decoration:none;font-size:14px;font-weight:600">Contact Us</a>
    </td></tr></table>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-top:none;border-radius:0 0 8px 8px"><tr><td style="padding:20px 24px;text-align:center">
    <img src="${LOGO}" alt="AssembleAtEase" width="28" height="28" style="border-radius:50%;display:inline-block"/>
    <p style="margin:8px 0 4px;font-size:12px;font-weight:600;color:#71717a">AssembleAtEase</p>
    <p style="margin:0 0 8px;font-size:11px;color:#a1a1aa;line-height:1.5">Professional Assembly &amp; Handyman Services<br/>Austin, TX &bull; Licensed &bull; Insured &bull; Background Checked</p>
    <p style="margin:0;font-size:11px;color:#a1a1aa"><a href="${SITE}" style="color:#71717a;text-decoration:none">assembleatease.com</a> &bull; <a href="mailto:service@assembleatease.com" style="color:#71717a;text-decoration:none">service@assembleatease.com</a></p>
  </td></tr></table>
</div></body></html>`;
}
