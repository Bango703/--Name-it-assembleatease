import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';
import { loadActiveAnnouncements, ruleFor } from '../_announcements.js';

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
    const { data: ann, error: annErr } = await sb.from('easer_announcements').select('id').eq('key', key).maybeSingle();
    if (annErr || !ann) return res.status(404).json({ error: 'Announcement not found' });
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
