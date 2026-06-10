import { getSupabase } from '../_supabase.js';
import { sendEmail, ownerEmail, esc } from '../_email.js';
import { logActivity } from '../booking/_activity.js';

/**
 * GET /api/cron/followup  — daily.
 *
 * The loyalty / word-of-mouth touch. ~3 weeks after a completed job — once the
 * immediate receipt + 2-day review email are done and a new need may have
 * appeared — send a warm note that drives REBOOKING and REFERRALS. Distinct
 * from the review-request email (that one handles the day-2 check-in + review).
 *
 * Deduped via an activity_logs 'followup_sent' event (no new column).
 */
const LOGO = 'https://www.assembleatease.com/images/logo.jpg';
const FOLLOWUP_DAYS = 21;
const WINDOW_DAYS   = 14; // only look at the 21–35 day band so old jobs aren't re-scanned forever

export default async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.authorization !== 'Bearer ' + cronSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const sb = getSupabase();
  const now = Date.now();
  const olderThan = new Date(now - FOLLOWUP_DAYS * 86400000).toISOString();
  const newerThan = new Date(now - (FOLLOWUP_DAYS + WINDOW_DAYS) * 86400000).toISOString();

  const { data: bookings, error } = await sb
    .from('bookings')
    .select('id, ref, service, customer_name, customer_email, completed_at')
    .eq('status', 'completed')
    .lt('completed_at', olderThan)
    .gt('completed_at', newerThan)
    .limit(50);

  if (error) {
    console.error('Followup cron error:', error);
    return res.status(500).json({ error: 'Query failed' });
  }
  if (!bookings || !bookings.length) {
    return res.status(200).json({ sent: 0, message: 'No bookings due for follow-up' });
  }

  const bookUrl = 'https://www.assembleatease.com/book';
  let sent = 0;

  for (const b of bookings) {
    if (!b.customer_email) continue;

    // Dedup: skip if this booking already got a follow-up.
    try {
      const { data: prior } = await sb
        .from('activity_logs')
        .select('id')
        .eq('booking_id', b.id)
        .eq('event_type', 'followup_sent')
        .limit(1);
      if (prior && prior.length) continue;
    } catch (e) { /* if check fails, fall through */ }

    const firstName = esc((b.customer_name || '').split(' ')[0] || 'there');
    try {
      await sendEmail({
        to: b.customer_email,
        from: 'AssembleAtEase <booking@assembleatease.com>',
        subject: `Got another project, ${firstName}? We're here.`,
        replyTo: ownerEmail(),
        html: `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1a1a1a">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px 8px 0 0;border-bottom:1px solid #e4e4e7"><tr><td style="padding:20px 24px;text-align:center">
    <img src="${LOGO}" alt="AssembleAtEase" width="44" height="44" style="border-radius:50%;display:inline-block"/>
    <p style="margin:8px 0 0;font-size:17px;font-weight:700;color:#1a1a1a">AssembleAtEase</p>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-left:1px solid #e4e4e7;border-right:1px solid #e4e4e7"><tr><td style="padding:32px 24px 24px">
    <p style="margin:0 0 12px;font-size:22px;font-weight:700;color:#1a1a1a">Hope it's all still holding up, ${firstName}!</p>
    <p style="margin:0 0 18px;font-size:15px;color:#52525b;line-height:1.7">It's been a few weeks since we handled your <strong>${esc(b.service)}</strong>. If anything's not perfect, just reply — we'll make it right.</p>
    <p style="margin:0 0 18px;font-size:15px;color:#52525b;line-height:1.7">And if you've got another project — more furniture, a TV to mount, smart-home gear, a playset — we'd love to help again. Same flat pricing, same pay-after-completion.</p>
    <table cellpadding="0" cellspacing="0" style="margin:0 0 22px"><tr><td style="background:#00BFFF;border-radius:8px"><a href="${bookUrl}" style="display:inline-block;padding:13px 34px;color:#ffffff;font-size:15px;font-weight:700;text-decoration:none;border-radius:8px">Book Another Service</a></td></tr></table>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f9ff;border:1px solid #bae6fd;border-radius:8px"><tr><td style="padding:16px 18px">
      <p style="margin:0 0 4px;font-size:14px;font-weight:700;color:#0c4a6e">Know someone moving or setting up a home?</p>
      <p style="margin:0;font-size:13px;color:#0369a1;line-height:1.6">Forward them this email — a referral from a happy customer means the world to a small local business like ours.</p>
    </td></tr></table>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-top:none;border-radius:0 0 8px 8px"><tr><td style="padding:16px 24px;text-align:center;font-size:11px;color:#a1a1aa">
    AssembleAtEase &bull; Austin, TX &bull; <a href="mailto:service@assembleatease.com" style="color:#71717a">service@assembleatease.com</a>
  </td></tr></table>
</div></body></html>`,
        meta: { bookingId: b.id, notificationType: 'followup', recipientType: 'customer' },
      });

      logActivity(sb, {
        bookingId: b.id,
        eventType: 'followup_sent',
        actorType: 'system',
        actorName: 'followup_cron',
        description: `Sent ${FOLLOWUP_DAYS}-day rebook/referral follow-up to customer.`,
      });
      sent++;
    } catch (err) {
      console.error('Followup email error for ' + b.ref + ':', err.message);
    }
  }

  return res.status(200).json({ sent, scanned: bookings.length });
}
