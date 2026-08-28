import { upsertContact, addNote } from './_hubspot.js';
import { rateLimit } from './_ratelimit.js';
import { getSupabase } from './_supabase.js';

import { sendEmail, ownerEmail, esc } from './_email.js';
import { formatUsPhone } from './_phone.js';
import { validateWaitlistInput, saveWaitlistRecord, WAITLIST_SOURCE } from './_waitlist-core.js';


export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  if (!await rateLimit(ip, 'default')) return res.status(429).json({ error: 'Too many requests. Please wait a minute and try again.' });
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const TO = ownerEmail();

  // Every waitlist door validates identically — see api/_waitlist-core.js.
  const check = validateWaitlistInput(body);
  if (!check.ok) return res.status(400).json({ error: check.error });
  const { name, email, phone, city, state } = check.value;

  const sName = esc(name);
  const sEmail = esc(email);
  const displayPhone = formatUsPhone(phone);
  const sPhone = esc(displayPhone);
  const sCity = esc(city);
  const sState = esc(state);

  const LOGO = 'https://www.assembleatease.com/images/logo.jpg';
  const SITE = 'https://www.assembleatease.com';

  // Save first: the database is the waitlist source of truth. Email is notification only.
  let saved;
  try {
    const sb = getSupabase();
    saved = await saveWaitlistRecord(sb, { name, email, phone, city, state, source: WAITLIST_SOURCE.PUBLIC_FORM });
  } catch (dbErr) {
    console.error('Waitlist DB save error:', dbErr);
    return res.status(500).json({ error: 'We could not save your waitlist request. Please try again.' });
  }

  const ownerHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1a1a1a">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
  <!-- Header -->
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px 8px 0 0;border-bottom:3px solid #00BFFF"><tr><td style="padding:20px 24px">
    <table cellpadding="0" cellspacing="0"><tr>
      <td><img src="${LOGO}" alt="AssembleAtEase" width="36" height="36" style="border-radius:50%;display:block"/></td>
      <td style="padding-left:12px;font-size:16px;font-weight:700;color:#1a1a1a">AssembleAtEase</td>
    </tr></table>
  </td><td style="padding:20px 24px;text-align:right;font-size:12px;color:#71717a">Internal Notification</td></tr></table>

  <!-- Body -->
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-left:1px solid #e4e4e7;border-right:1px solid #e4e4e7"><tr><td style="padding:28px 24px">
    <p style="margin:0 0 4px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:#71717a">Assembler Waitlist</p>
    <p style="margin:0 0 24px;font-size:22px;font-weight:700;color:#1a1a1a">New Signup</p>

    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-radius:6px;margin-bottom:20px"><tr><td style="padding:16px 18px">
      <table width="100%" cellpadding="0" cellspacing="0">
      <tr><td style="padding:4px 0"><span style="font-size:11px;font-weight:600;text-transform:uppercase;color:#71717a;letter-spacing:0.5px">Name</span><br/><span style="font-size:15px;font-weight:700;color:#1a1a1a">${sName}</span></td></tr>
      <tr><td style="padding:4px 0"><span style="font-size:11px;font-weight:600;text-transform:uppercase;color:#71717a;letter-spacing:0.5px">Email</span><br/><span style="font-size:15px;font-weight:700"><a href="mailto:${sEmail}" style="color:#00BFFF;text-decoration:none">${sEmail}</a></span></td></tr>
      <tr><td style="padding:4px 0"><span style="font-size:11px;font-weight:600;text-transform:uppercase;color:#71717a;letter-spacing:0.5px">Phone</span><br/><span style="font-size:15px;font-weight:700"><a href="tel:${sPhone}" style="color:#00BFFF;text-decoration:none">${sPhone}</a></span></td></tr>
      <tr><td style="padding:4px 0"><span style="font-size:11px;font-weight:600;text-transform:uppercase;color:#71717a;letter-spacing:0.5px">Location</span><br/><span style="font-size:15px;font-weight:700;color:#1a1a1a">${sCity}, ${sState}</span></td></tr>
      </table>
    </td></tr></table>

    <table width="100%" cellpadding="0" cellspacing="0" style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:6px"><tr><td style="padding:14px 18px">
      <p style="margin:0 0 4px;font-size:13px;font-weight:700;color:#1e40af">Follow Up Required</p>
      <p style="margin:0;font-size:13px;color:#1e40af;line-height:1.6">Review coverage and Easer demand for <strong>${sCity}, ${sState}</strong>. Contact ${sName} only when the market is ready for applications; a waitlist entry is not approval to receive jobs.</p>
    </td></tr></table>
  </td></tr></table>

  <!-- Footer -->
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-top:none;border-radius:0 0 8px 8px"><tr><td style="padding:16px 24px;text-align:center;font-size:11px;color:#a1a1aa;line-height:1.6">
    AssembleAtEase &bull; <a href="mailto:service@assembleatease.com" style="color:#71717a">service@assembleatease.com</a><br/>Professional home-service marketplace
  </td></tr></table>
</div></body></html>`;

  const assemblerHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1a1a1a">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
  <!-- Header -->
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px 8px 0 0;border-bottom:1px solid #e4e4e7"><tr><td style="padding:24px;text-align:center">
    <img src="${LOGO}" alt="AssembleAtEase" width="44" height="44" style="border-radius:50%;display:inline-block"/>
    <p style="margin:8px 0 0;font-size:17px;font-weight:700;color:#1a1a1a">AssembleAtEase</p>
  </td></tr></table>

  <!-- Body -->
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-left:1px solid #e4e4e7;border-right:1px solid #e4e4e7"><tr><td style="padding:32px 24px 24px">
    <p style="margin:0 0 6px;font-size:24px;font-weight:700;color:#1a1a1a">You're on the waitlist, ${sName}.</p>
    <p style="margin:0 0 24px;font-size:15px;color:#52525b;line-height:1.7">Thank you for your interest in joining AssembleAtEase. We're building a trusted network of skilled professionals in <strong>${sCity}, ${sState}</strong>, and we're glad you want to be part of it.</p>

    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-radius:6px;margin-bottom:24px"><tr><td style="padding:18px 20px">
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr><td style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:#71717a;padding-bottom:6px">Your Status</td></tr>
        <tr><td><span style="display:inline-block;background:#dbeafe;color:#1e40af;font-size:11px;font-weight:700;padding:3px 10px;border-radius:99px">ON WAITLIST</span></td></tr>
      </table>
    </td></tr></table>

    <p style="margin:0 0 12px;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#71717a">What Happens Next</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px">
      <tr><td style="width:28px;vertical-align:top;padding:6px 0"><div style="width:22px;height:22px;background:#00BFFF;border-radius:50%;text-align:center;line-height:22px;font-size:11px;font-weight:700;color:#fff">1</div></td><td style="padding:6px 0 6px 10px;font-size:14px;color:#52525b;line-height:1.6"><strong style="color:#1a1a1a">We review your request</strong> — Our team evaluates new applications as spots become available.</td></tr>
      <tr><td style="vertical-align:top;padding:6px 0"><div style="width:22px;height:22px;background:#00BFFF;border-radius:50%;text-align:center;line-height:22px;font-size:11px;font-weight:700;color:#fff">2</div></td><td style="padding:6px 0 6px 10px;font-size:14px;color:#52525b;line-height:1.6"><strong style="color:#1a1a1a">We reach out</strong> — When a spot opens in your area, you'll be among the first contacted.</td></tr>
      <tr><td style="vertical-align:top;padding:6px 0"><div style="width:22px;height:22px;background:#00BFFF;border-radius:50%;text-align:center;line-height:22px;font-size:11px;font-weight:700;color:#fff">3</div></td><td style="padding:6px 0 6px 10px;font-size:14px;color:#52525b;line-height:1.6"><strong style="color:#1a1a1a">Start earning</strong> — Get matched with local customers and begin completing jobs.</td></tr>
    </table>

    <p style="margin:0 0 12px;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#71717a">Why Professionals Choose Us</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;margin-bottom:24px">
      <tr><td style="padding:8px 0;color:#52525b;line-height:1.5;border-bottom:1px solid #f0f0f0">Review job scope and estimated earnings before accepting.</td></tr>
      <tr><td style="padding:8px 0;color:#52525b;line-height:1.5;border-bottom:1px solid #f0f0f0">Receive offers only after application, verification, and owner approval.</td></tr>
      <tr><td style="padding:8px 0;color:#52525b;line-height:1.5;border-bottom:1px solid #f0f0f0">Customer booking and scheduling are managed through the platform.</td></tr>
      <tr><td style="padding:8px 0;color:#52525b;line-height:1.5">If invited, you will see all application requirements and any applicable fee before submitting.</td></tr>
    </table>

    <table width="100%" cellpadding="0" cellspacing="0"><tr><td style="text-align:center;padding:8px 0">
      <a href="${SITE}" style="display:inline-block;background:#00BFFF;color:#ffffff;padding:12px 32px;border-radius:6px;text-decoration:none;font-size:14px;font-weight:600">Visit AssembleAtEase</a>
    </td></tr></table>
  </td></tr></table>

  <!-- Footer -->
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-top:none;border-radius:0 0 8px 8px"><tr><td style="padding:20px 24px;text-align:center">
    <img src="${LOGO}" alt="AssembleAtEase" width="28" height="28" style="border-radius:50%;display:inline-block"/>
    <p style="margin:8px 0 4px;font-size:12px;font-weight:600;color:#71717a">AssembleAtEase</p>
    <p style="margin:0 0 8px;font-size:11px;color:#a1a1aa;line-height:1.5">Professional Assembly &amp; Handyman Services<br/>Market availability varies by service area.</p>
    <p style="margin:0;font-size:11px;color:#a1a1aa"><a href="${SITE}" style="color:#71717a;text-decoration:none">assembleatease.com</a> &bull; <a href="mailto:service@assembleatease.com" style="color:#71717a;text-decoration:none">service@assembleatease.com</a></p>
    <p style="margin:10px 0 0;font-size:10px;color:#d4d4d8">You received this email because you signed up for the AssembleAtEase assembler waitlist. If you did not make this request, please disregard this email.</p>
  </td></tr></table>
</div></body></html>`;

  const ownerMail = sendEmail({
    to: TO,
    from: 'AssembleAtEase Waitlist <waitlist@assembleatease.com>',
    subject: 'New Easer waitlist signup - ' + name + ' (' + city + ', ' + state + ')',
    html: ownerHtml,
    replyTo: email,
    meta: { notificationType: 'easer_waitlist', recipientType: 'owner', disableDedupe: true },
  });
  const easerMail = sendEmail({
    to: email,
    from: 'AssembleAtEase <waitlist@assembleatease.com>',
    subject: 'Your AssembleAtEase Easer waitlist request',
    html: assemblerHtml,
    replyTo: TO,
    meta: { notificationType: 'easer_waitlist_confirmation', recipientType: 'easer' },
  });
  const hubspot = process.env.HUBSPOT_ACCESS_TOKEN
    ? (async () => {
        const contactId = await upsertContact({ email, name, phone, address: city + ', ' + state, lifecycleStage: 'subscriber' });
        if (contactId) {
          await addNote({ contactId, body: `<strong>Easer Waitlist Signup</strong><br>Name: ${esc(name)}<br>Phone: ${esc(displayPhone)}<br>Location: ${esc(city)}, ${esc(state)}<br>Interested in joining the AssembleAtEase professional network.` });
        }
      })()
    : Promise.resolve();

  const [ownerResult, easerResult, hubspotResult] = await Promise.allSettled([ownerMail, easerMail, hubspot]);
  if (ownerResult.status === 'rejected' || ownerResult.value?.ok === false) console.error('Waitlist owner notification failed');
  if (easerResult.status === 'rejected' || easerResult.value?.ok === false) console.error('Waitlist confirmation failed');
  if (hubspotResult.status === 'rejected') console.error('HubSpot waitlist error:', hubspotResult.reason);

  return res.status(200).json({
    success: true,
    status: saved.status,
    confirmationSent: easerResult.status === 'fulfilled' && easerResult.value?.ok === true,
  });
}





