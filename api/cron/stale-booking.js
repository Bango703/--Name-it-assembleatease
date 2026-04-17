import { getSupabase } from '../_supabase.js';
import { sendEmail, ownerEmail, esc } from '../_email.js';

const STALE_DAYS = 7; // auto-decline bookings pending for this many days

export default async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.authorization !== 'Bearer ' + cronSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const sb = getSupabase();
  const cutoff = new Date(Date.now() - STALE_DAYS * 86400000).toISOString();

  // Find pending bookings older than STALE_DAYS
  const { data: bookings, error } = await sb
    .from('bookings')
    .select('*')
    .eq('status', 'pending')
    .lt('created_at', cutoff)
    .limit(50);

  if (error) {
    console.error('Stale booking cron error:', error);
    return res.status(500).json({ error: 'Query failed' });
  }

  if (!bookings || !bookings.length) {
    return res.status(200).json({ declined: 0, message: 'No stale bookings' });
  }

  const LOGO = 'https://www.assembleatease.com/images/logo.jpg';
  let declined = 0;

  for (const b of bookings) {
    try {
      // Update status to declined
      await sb
        .from('bookings')
        .update({
          status: 'declined',
          declined_at: new Date().toISOString(),
          decline_reason: 'Auto-declined after ' + STALE_DAYS + ' days without response',
        })
        .eq('id', b.id);

      // Notify customer
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1a1a1a">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px 8px 0 0;border-bottom:1px solid #e4e4e7"><tr><td style="padding:20px 24px;text-align:center">
    <img src="${LOGO}" alt="AssembleAtEase" width="44" height="44" style="border-radius:50%;display:inline-block"/>
    <p style="margin:8px 0 0;font-size:17px;font-weight:700;color:#1a1a1a">AssembleAtEase</p>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-left:1px solid #e4e4e7;border-right:1px solid #e4e4e7"><tr><td style="padding:32px 24px 24px">
    <p style="margin:0 0 8px;font-size:24px;font-weight:700;color:#1a1a1a">Booking Update</p>
    <p style="margin:0 0 20px;font-size:14px;color:#52525b;line-height:1.6">Hi ${esc(b.customer_name)}, your booking request <strong>${esc(b.ref)}</strong> for <strong>${esc(b.service)}</strong> has expired as we were unable to confirm it within our scheduling window.</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fef2f2;border:1px solid #fecaca;border-radius:6px"><tr><td style="padding:14px 18px">
      <p style="margin:0;font-size:13px;color:#991b1b;line-height:1.6">If you'd still like to schedule this service, please submit a new booking request and we'll get back to you promptly.</p>
    </td></tr></table>
    <table cellpadding="0" cellspacing="0" style="margin:20px 0 0"><tr><td style="background:#1d9e75;border-radius:8px;padding:0"><a href="https://www.assembleatease.com" style="display:inline-block;padding:12px 28px;color:#ffffff;font-size:14px;font-weight:700;text-decoration:none;border-radius:8px">Book Again</a></td></tr></table>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-top:none;border-radius:0 0 8px 8px"><tr><td style="padding:16px 24px;text-align:center;font-size:11px;color:#a1a1aa">
    AssembleAtEase &bull; Austin, TX &bull; <a href="mailto:service@assembleatease.com" style="color:#71717a">service@assembleatease.com</a>
  </td></tr></table>
</div></body></html>`;

      await sendEmail({
        to: b.customer_email,
        from: 'AssembleAtEase <booking@assembleatease.com>',
        subject: 'Booking ' + b.ref + ' — Update',
        html,
        replyTo: ownerEmail(),
      });

      declined++;
    } catch (err) {
      console.error('Stale booking error for ' + b.ref + ':', err);
    }
  }

  // Notify owner summary
  if (declined > 0) {
    try {
      await sendEmail({
        to: ownerEmail(),
        from: 'AssembleAtEase System <booking@assembleatease.com>',
        subject: 'Auto-declined ' + declined + ' stale booking(s)',
        html: '<p>' + declined + ' pending booking(s) were auto-declined after ' + STALE_DAYS + ' days.</p><p>Refs: ' + bookings.map(function(b){return esc(b.ref)}).join(', ') + '</p>',
        replyTo: ownerEmail(),
      });
    } catch (e) {
      console.error('Owner notification error:', e);
    }
  }

  return res.status(200).json({ declined, total: bookings.length });
}
