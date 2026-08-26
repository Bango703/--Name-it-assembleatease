import { getSupabase } from '../_supabase.js';
import { sendEmail, ownerEmail, esc } from '../_email.js';
import { sendPushToUser } from '../_push.js';
import { logCron } from './_cron-logger.js';
import { loadActiveAnnouncements, ruleFor, isReminderDue } from '../_announcements.js';
import { minSendIntervalMs, remainingDailyBudget } from '../_send-governor.js';

const SITE = 'https://www.assembleatease.com';
// Per-run cap AND a pace. The loop is sequential, but a sequential loop still
// clears far more than Resend's 2/second default, so each send waits its turn.
// The platform-wide 24h ceiling in _send-governor.js sits above both.
const MAX_PER_RUN = 300;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * GET /api/cron/easer-announcements — daily.
 *
 * Drives active Easer required-action campaigns (first use case: Stripe Connect
 * payout setup). For each active announcement:
 *   1. marks deliveries complete for Easers who finished the action,
 *   2. sends email + push reminders to still-incomplete Easers on the cadence.
 * The in-app banner is always-on via /api/assembler/required-actions, so it needs
 * no send here. Never blocks anything; failures are logged, not fatal.
 */
function actionUrl(a) {
  const path = String(a.action_url || '/assembler/my-assignments');
  return path.startsWith('http') ? path : `${SITE}${path}`;
}

function buildEmailHtml(a) {
  const url = actionUrl(a);
  return `
    <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#0a1628">
      <h2 style="color:#0a1628;margin:0 0 12px">${esc(a.title)}</h2>
      <p style="font-size:15px;line-height:1.6;color:#334155">${esc(a.body)}</p>
      <p style="margin:22px 0">
        <a href="${esc(url)}" style="display:inline-block;background:#00BFFF;color:#04222c;font-weight:800;text-decoration:none;padding:12px 22px;border-radius:999px">${esc(a.action_label || 'Open AssembleAtEase')}</a>
      </p>
      <p style="font-size:12px;color:#64748b">You're receiving this because it needs your attention on your AssembleAtEase Easer account.</p>
    </div>`;
}

async function processAnnouncement(sb, a, counters) {
  const rule = ruleFor(a);
  if (!rule) return;

  // 1) Currently-incomplete Easers (the targets).
  const { data: targets, error: targetErr } = await rule.query(sb);
  if (targetErr) { console.error(`[easer-announcements] target query failed for ${a.key}:`, targetErr.message); return; }
  const incomplete = targets || [];
  const incompleteIds = new Set(incomplete.map((p) => p.id));

  // 2) Existing deliveries for this announcement.
  const { data: deliveries, error: delErr } = await sb
    .from('easer_announcement_deliveries')
    .select('id, easer_id, channels_sent, first_notified_at, last_reminded_at, reminder_count, completed_at')
    .eq('announcement_id', a.id);
  if (delErr) { console.error(`[easer-announcements] delivery load failed for ${a.key}:`, delErr.message); return; }
  const byEaser = new Map((deliveries || []).map((d) => [d.easer_id, d]));

  // 3) Mark completions: open deliveries whose Easer is no longer incomplete.
  const nowIso = new Date().toISOString();
  const completedIds = (deliveries || [])
    .filter((d) => !d.completed_at && !incompleteIds.has(d.easer_id))
    .map((d) => d.id);
  if (completedIds.length) {
    await sb.from('easer_announcement_deliveries')
      .update({ completed_at: nowIso, updated_at: nowIso })
      .in('id', completedIds);
    counters.completed += completedIds.length;
  }

  // 4) Send reminders to still-incomplete Easers whose cadence is due.
  const channels = Array.isArray(a.channels) ? a.channels : [];
  let processed = 0;
  for (const easer of incomplete) {
    if (counters.sent >= (counters.runCap || MAX_PER_RUN)) break;
    const delivery = byEaser.get(easer.id) || null;
    if (!isReminderDue(delivery, a.reminder_days)) continue;

    // Smart completion: before nagging, confirm against the LIVE source of truth
    // (e.g. Stripe payouts_enabled) that the Easer genuinely still needs this —
    // never email someone who already finished just because a cached flag lagged.
    // Side effect: self-heals the cached flag, so the in-app banner clears too.
    if (typeof rule.confirmStillIncomplete === 'function') {
      const check = await rule.confirmStillIncomplete(sb, easer);
      if (!check.stillIncomplete) {
        if (delivery && !delivery.completed_at) {
          await sb.from('easer_announcement_deliveries')
            .update({ completed_at: nowIso, updated_at: nowIso })
            .eq('id', delivery.id);
        }
        counters.completed += 1;
        continue;
      }
      if (!check.verified) continue; // could not verify — don't nag on uncertainty
    }

    const sent = new Set(delivery?.channels_sent || []);
    if (channels.includes('in_app')) sent.add('in_app'); // banner is always live

    if (channels.includes('email') && easer.email) {
      // Hold the provider's pace. Without this the loop can clear well past
      // Resend's 2/second default and the overflow comes back as 429 — which
      // sendEmail records as a failure and never retries, silently losing it.
      if (counters.sent > 0) await sleep(minSendIntervalMs());
      try {
        await sendEmail({
          to: easer.email,
          from: 'AssembleAtEase <booking@assembleatease.com>',
          subject: a.title,
          html: buildEmailHtml(a),
          replyTo: ownerEmail(),
          meta: { notificationType: `easer_required_action_${a.key}`, recipientType: 'easer', recipientUserId: easer.id },
        });
        sent.add('email');
      } catch (e) { console.error(`[easer-announcements] email failed (${a.key}) ${easer.id}:`, e.message); }
    }

    if (channels.includes('push')) {
      try {
        await sendPushToUser(easer.id, {
          title: a.title,
          body: a.action_label ? `${a.action_label} →` : 'Action needed on your account',
          url: String(a.action_url || '/assembler/my-assignments'),
        }, { type: `required_action_${a.key}` });
        sent.add('push');
      } catch (e) { console.error(`[easer-announcements] push failed (${a.key}) ${easer.id}:`, e.message); }
    }

    const patch = {
      channels_sent: [...sent],
      last_reminded_at: nowIso,
      reminder_count: Number(delivery?.reminder_count || 0) + 1,
      first_notified_at: delivery?.first_notified_at || nowIso,
      updated_at: nowIso,
    };
    if (delivery) {
      await sb.from('easer_announcement_deliveries').update(patch).eq('id', delivery.id);
    } else {
      await sb.from('easer_announcement_deliveries').insert({ announcement_id: a.id, easer_id: easer.id, ...patch });
    }
    counters.sent += 1;
    processed += 1;
  }
  counters.announcements += 1;
  counters.targetsSeen += incomplete.length;
}

export default async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.authorization !== 'Bearer ' + cronSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const t = Date.now();
  const counters = { announcements: 0, targetsSeen: 0, sent: 0, completed: 0 };
  try {
    const sb = getSupabase();
    const active = await loadActiveAnnouncements(sb);
    if (!active.length) {
      await logCron('easer-announcements', { status: 'ok', records: 0, duration: Date.now() - t });
      return res.status(200).json({ ok: true, message: 'No active announcements', ...counters });
    }
    // One fuse above every campaign: if the platform has already sent its 24h
    // allowance, this run does nothing rather than adding to a burst.
    const budget = await remainingDailyBudget(sb);
    if (budget.remaining <= 0) {
      await logCron('easer-announcements', {
        status: 'ok',
        records: 0,
        errorText: `skipped: platform 24h email ceiling reached (${budget.used}/${budget.ceiling})`,
        duration: Date.now() - t,
      });
      return res.status(200).json({
        ok: true,
        skipped: true,
        reason: 'daily_email_ceiling',
        ceiling: budget.ceiling,
        used: budget.used,
      });
    }
    // Never let one cron run spend more than what is genuinely left today.
    const runCap = Math.min(MAX_PER_RUN, budget.remaining);
    counters.runCap = runCap;

    for (const a of active) {
      await processAnnouncement(sb, a, counters);
    }
    await logCron('easer-announcements', { status: 'ok', records: counters.sent, duration: Date.now() - t });
    return res.status(200).json({ ok: true, ...counters });
  } catch (e) {
    console.error('[easer-announcements] fatal:', e.message || e);
    await logCron('easer-announcements', { status: 'error', error: e.message || String(e), duration: Date.now() - t });
    return res.status(500).json({ error: 'Announcement run failed' });
  }
}
