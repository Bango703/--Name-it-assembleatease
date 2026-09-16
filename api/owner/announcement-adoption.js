import { getSupabase } from '../_supabase.js';
import { verifyOwner, sendEmail, ownerEmail, esc } from '../_email.js';
import { loadActiveAnnouncements, ruleFor } from '../_announcements.js';

function actionUrl(announcement) {
  const path = String(announcement?.action_url || '/assembler/profile');
  return path.startsWith('http') ? path : `https://www.assembleatease.com${path}`;
}

// Owner view of Easer required-action campaigns (e.g. payout setup):
//   GET  → adoption stats ("X of Y done") + pending Easers with reminder state.
//   POST {action:'resend', key, easerId} → reset that Easer's reminder state so
//         the next easer-announcements cron run re-notifies them.
export default async function handler(req, res) {
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });
  const sb = getSupabase();

  if (req.method === 'POST') {
    const key = String(req.body?.key || '').trim();
    const easerId = String(req.body?.easerId || '').trim();
    if (!key || !easerId) return res.status(400).json({ error: 'key and easerId are required' });
    const { data: ann, error: annErr } = await sb.from('easer_announcements').select('*').eq('key', key).maybeSingle();
    if (annErr || !ann) return res.status(404).json({ error: 'Announcement not found' });
    if (key === 'sms_job_texts') {
      const { data: easer, error: easerErr } = await sb.from('profiles')
        .select('id, full_name, email, sms_consent_at, sms_opted_out_at, status, application_status')
        .eq('id', easerId).eq('role', 'assembler').maybeSingle();
      if (easerErr || !easer) return res.status(404).json({ error: 'Easer not found' });
      if (easer.sms_opted_out_at) return res.status(409).json({ error: 'This Easer opted out of text messages. Do not re-contact them for SMS consent.' });
      if (easer.sms_consent_at) return res.status(409).json({ error: 'This Easer already has job texts enabled.' });
      if (!easer.email) return res.status(409).json({ error: 'This Easer has no email address for the opt-in instructions.' });
      const firstName = String(easer.full_name || 'Easer').split(/\s+/)[0];
      const emailResult = await sendEmail({
        to: easer.email,
        from: 'AssembleAtEase <booking@assembleatease.com>',
        subject: 'Turn on AssembleAtEase job texts',
        replyTo: ownerEmail(),
        html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#0a1628"><h2 style="color:#0a1628">Turn on job texts, ${esc(firstName)}</h2><p style="font-size:15px;line-height:1.6;color:#334155">Job offers and arrival reminders are sent by text. Open your profile and turn on job texts so you can receive new offers.</p><p style="margin:22px 0"><a href="${esc(actionUrl(ann))}" style="display:inline-block;background:#00BFFF;color:#04222c;font-weight:800;text-decoration:none;padding:12px 22px;border-radius:8px">Turn on job texts</a></p><p style="font-size:12px;color:#64748b">Message and data rates may apply. Reply STOP to any text to turn messages off.</p></div>`,
        meta: { notificationType: 'easer_required_action_sms_job_texts', recipientType: 'easer', recipientUserId: easer.id, disableDedupe: true },
      });
      if (!emailResult?.ok || emailResult?.suppressed) return res.status(503).json({ error: 'The opt-in email could not be sent.' });
      return res.status(200).json({ ok: true, message: 'Opt-in email sent.' });
    }
    const { error: upErr } = await sb.from('easer_announcement_deliveries')
      .update({ last_reminded_at: null, reminder_count: 0, updated_at: new Date().toISOString() })
      .eq('announcement_id', ann.id)
      .eq('easer_id', easerId)
      .is('completed_at', null);
    if (upErr) return res.status(503).json({ error: 'Resend could not be queued' });
    return res.status(200).json({ ok: true, message: 'Reminder re-queued; it will send on the next run.' });
  }

  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const announcements = await loadActiveAnnouncements(sb);
    const out = [];
    for (const a of announcements) {
      const rule = ruleFor(a);
      if (!rule) continue;

      // Total eligible active/approved Easers (denominator).
      const { count: totalEligible } = await sb.from('profiles')
        .select('id', { count: 'exact', head: true })
        .eq('role', 'assembler').eq('status', 'active').eq('application_status', 'approved');

      // Currently incomplete (the pending list).
      const { data: incomplete } = await rule.query(sb);
      const pending = incomplete || [];
      const pendingIds = pending.map((p) => p.id);

      // Reminder state for the pending Easers.
      let deliveryByEaser = new Map();
      if (pendingIds.length) {
        const { data: dels } = await sb.from('easer_announcement_deliveries')
          .select('easer_id, first_notified_at, last_reminded_at, reminder_count, channels_sent')
          .eq('announcement_id', a.id).in('easer_id', pendingIds);
        deliveryByEaser = new Map((dels || []).map((d) => [d.easer_id, d]));
      }

      const total = Number(totalEligible || 0);
      out.push({
        key: a.key,
        title: a.title,
        total,
        completed: Math.max(0, total - pending.length),
        pending: pending.length,
        blocksOffers: a.blocks_offers === true,
        pendingEasers: pending.map((p) => {
          const d = deliveryByEaser.get(p.id) || null;
          return {
            id: p.id,
            name: p.full_name || null,
            email: p.email || null,
            reminderCount: d ? Number(d.reminder_count || 0) : 0,
            firstNotifiedAt: d?.first_notified_at || null,
            lastRemindedAt: d?.last_reminded_at || null,
            channelsSent: d?.channels_sent || [],
          };
        }),
      });
    }
    return res.status(200).json({ announcements: out });
  } catch (e) {
    console.error('[announcement-adoption] error:', e.message || e);
    return res.status(503).json({ error: 'Adoption stats unavailable' });
  }
}
