import { upsertContact, addNote } from './_hubspot.js';
import { rateLimit } from './_ratelimit.js';

/**
 * POST /api/business-inquiry
 * Dedicated B2B lead intake — property managers, apartments, realtors, offices,
 * furniture stores. These are recurring, high-LTV opportunities, so they get a
 * distinct, urgent owner alert (scope broken out) and a partnership-grade
 * auto-response — not the generic contact-form treatment.
 *
 * Body: { name, company, email, location, timeline, type, frequency, details, phone? }
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  try {
    if (!await rateLimit(ip, 'default')) return res.status(429).json({ error: 'Too many requests. Please wait a minute and try again.' });
  } catch (rlErr) { /* fail open if Redis down */ }

  const { name, company, email, phone, location, timeline, type, frequency, details } = req.body || {};
  const cleanPhone = typeof phone === 'string' ? phone.trim() : '';
  if (!name || !company || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || !type || !details) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const KEY = process.env.RESEND_API_KEY;
  const TO  = process.env.NOTIFY_EMAIL || 'service@assembleatease.com';
  const ref = 'B2B-' + Date.now().toString(36).toUpperCase();
  const LOGO = 'https://www.assembleatease.com/images/logo.jpg';
  const SITE = 'https://www.assembleatease.com';
  const esc = s => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

  // Is this likely recurring revenue? Flag it for the owner.
  const recurring = /recurring|ongoing|multi|monthly|weekly|each|every|units|turn|move-?in/i.test(`${frequency} ${type} ${details}`);

  const row = (label, val) => val
    ? `<tr><td style="padding:9px 0;border-bottom:1px solid #f0f0f0;color:#71717a;width:130px;vertical-align:top">${label}</td><td style="padding:9px 0;border-bottom:1px solid #f0f0f0;font-weight:600">${esc(val)}</td></tr>`
    : '';

  const ownerHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1a1a1a">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;border:1px solid #e4e4e7;border-top:4px solid #0099CC"><tr><td style="padding:24px">
    <p style="margin:0 0 4px;font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:0.5px;color:#0099CC">New Business Lead${recurring ? ' &bull; likely recurring revenue' : ''} &bull; ${ref}</p>
    <p style="margin:0 0 18px;font-size:22px;font-weight:700;color:#111">${esc(company)}</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;margin-bottom:18px">
      ${row('Contact', name)}
      ${row('Email', email).replace(esc(email), `<a href="mailto:${esc(email)}" style="color:#00BFFF;text-decoration:none">${esc(email)}</a>`)}
      ${cleanPhone ? row('Phone', cleanPhone).replace(esc(cleanPhone), `<a href="tel:${esc(cleanPhone)}" style="color:#00BFFF;text-decoration:none">${esc(cleanPhone)}</a>`) : ''}
      ${row('Location', location)}
      ${row('Type of work', type)}
      ${row('Frequency', frequency)}
      ${row('Timeline', timeline)}
    </table>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-radius:6px;margin-bottom:18px"><tr><td style="padding:16px 18px">
      <p style="margin:0 0 6px;font-size:11px;font-weight:700;text-transform:uppercase;color:#71717a;letter-spacing:0.5px">Project Details</p>
      <p style="margin:0;font-size:14px;color:#1a1a1a;line-height:1.7;white-space:pre-line">${esc(details)}</p>
    </td></tr></table>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#ecfdf5;border:1px solid #a7f3d0;border-radius:6px"><tr><td style="padding:14px 18px">
      <p style="margin:0;font-size:13px;color:#065f46;line-height:1.6"><strong>Why this matters:</strong> business accounts are recurring, low-acquisition-cost revenue. Aim to reply within a few hours. Reply straight to this email.</p>
    </td></tr></table>
  </td></tr></table>
</div></body></html>`;

  const bizHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1a1a1a">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px 8px 0 0;border-bottom:1px solid #e4e4e7"><tr><td style="padding:20px 24px;text-align:center">
    <img src="${LOGO}" alt="AssembleAtEase" width="44" height="44" style="border-radius:50%;display:inline-block"/>
    <p style="margin:8px 0 0;font-size:17px;font-weight:700;color:#1a1a1a">AssembleAtEase</p>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fff;border-left:1px solid #e4e4e7;border-right:1px solid #e4e4e7"><tr><td style="padding:32px 24px 24px">
    <p style="margin:0 0 8px;font-size:23px;font-weight:700;color:#1a1a1a">Thanks, ${esc((name||'').split(' ')[0])}. We received your request for ${esc(company)}.</p>
    <p style="margin:0 0 18px;font-size:15px;color:#52525b;line-height:1.7">Our team will review the scope and reply by email with the next steps for assembly, mounting, or setup work.</p>
    <p style="margin:0 0 12px;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#71717a">What happens next</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:22px">
      <tr><td style="width:26px;vertical-align:top;padding:6px 0"><div style="width:22px;height:22px;background:#0099CC;border-radius:50%;text-align:center;line-height:22px;font-size:11px;font-weight:700;color:#fff">1</div></td><td style="padding:6px 0 6px 10px;font-size:14px;color:#52525b;line-height:1.6"><strong style="color:#1a1a1a">A real person reviews your scope</strong> &mdash; usually within a few hours, and within 24 hours at the latest.</td></tr>
      <tr><td style="vertical-align:top;padding:6px 0"><div style="width:22px;height:22px;background:#0099CC;border-radius:50%;text-align:center;line-height:22px;font-size:11px;font-weight:700;color:#fff">2</div></td><td style="padding:6px 0 6px 10px;font-size:14px;color:#52525b;line-height:1.6"><strong style="color:#1a1a1a">We send a tailored quote</strong> &mdash; volume pricing for recurring or multi-unit work, and a single point of contact.</td></tr>
      <tr><td style="vertical-align:top;padding:6px 0"><div style="width:22px;height:22px;background:#0099CC;border-radius:50%;text-align:center;line-height:22px;font-size:11px;font-weight:700;color:#fff">3</div></td><td style="padding:6px 0 6px 10px;font-size:14px;color:#52525b;line-height:1.6"><strong style="color:#1a1a1a">We become your go-to</strong> &mdash; reliable, identity-verified pros and a partner who makes your residents and clients happy.</td></tr>
    </table>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-radius:6px"><tr><td style="padding:14px 18px;font-size:13px;color:#52525b;line-height:1.6">
      <strong style="color:#1a1a1a">Reference:</strong> ${ref}. Need to add anything else? Reply to this email.
    </td></tr></table>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-top:none;border-radius:0 0 8px 8px"><tr><td style="padding:16px 24px;text-align:center;font-size:11px;color:#a1a1aa">
    AssembleAtEase &bull; Austin, TX &bull; <a href="${SITE}/business" style="color:#71717a">assembleatease.com/business</a>
  </td></tr></table>
</div></body></html>`;

  if (!KEY) { console.error('RESEND_API_KEY not set'); return res.status(500).json({ error: 'Email service not configured' }); }

  try {
    const ownerResp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'AssembleAtEase Business <contact@assembleatease.com>',
        to: [TO],
        subject: `New Business Lead - ${company}${recurring ? ' (recurring?)' : ''}`,
        html: ownerHtml,
        reply_to: email,
      }),
    });
    if (!ownerResp.ok) { console.error('Resend owner error:', await ownerResp.text()); return res.status(500).json({ error: 'Failed to send' }); }

    // Partnership-grade auto-response to the business (non-blocking on failure)
    const bizResp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'AssembleAtEase <contact@assembleatease.com>',
        to: [email],
        subject: `We received your request - ${company}`,
        html: bizHtml,
        reply_to: TO,
      }),
    });
    if (!bizResp.ok) console.error('Resend business error:', await bizResp.text());

    // HubSpot — tag as a business lead with structured detail
    if (process.env.HUBSPOT_ACCESS_TOKEN) {
      try {
        const contactId = await upsertContact({ email, name, phone: cleanPhone || null, lifecycleStage: 'lead' });
        if (contactId) {
          const noteLines = [
            `<strong>BUSINESS LEAD</strong> (${ref})`,
            `Company: ${esc(company)}`,
            `Type: ${esc(type)}`,
            `Frequency: ${esc(frequency || 'n/a')}`,
            `Timeline: ${esc(timeline || 'n/a')}`,
            `Location: ${esc(location || 'n/a')}`,
          ];
          if (cleanPhone) noteLines.push(`Phone: ${esc(cleanPhone)}`);
          noteLines.push('', esc(details));
          await addNote({ contactId, body: noteLines.join('<br>') });
        }
      } catch (err) { console.error('HubSpot business lead error:', err); }
    }

    return res.status(200).json({ success: true, ref });
  } catch (e) {
    console.error('business-inquiry error:', e);
    return res.status(500).json({ error: 'Failed' });
  }
}

