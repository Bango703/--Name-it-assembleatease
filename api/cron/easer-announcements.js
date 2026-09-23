import { getSupabase } from '../_supabase.js';
import { sendEmail, ownerEmail, esc } from '../_email.js';
import { sendPushToUser } from '../_push.js';
import { logCron } from './_cron-logger.js';
import { loadActiveAnnouncements, ruleFor, isReminderDue } from '../_announcements.js';
import { minSendIntervalMs, remainingDailyBudget } from '../_send-governor.js';
import { acquireNotificationLease, releaseNotificationLease } from '../_notification-policy.js';

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

export async function processAnnouncement(sb, a, counters, dependencies = {}) {
  const email = dependencies.sendEmail || (message => sendEmail(message));
  const push = dependencies.sendPushToUser || ((userId, payload, meta) => sendPushToUser(userId, payload, meta));
  const acquire = dependencies.acquireLease || acquireNotificationLease;
  const release = dependencies.releaseLease || releaseNotificationLease;
  const wait = dependencies.sleep || sleep;
  const rule = ruleFor(a);
  if (!rule) return;

  // 1) Currently-incomplete Easers (the targets).
  const { data: targets, error: targetErr } = await rule.query(sb);
  if (targetErr) throw new Error(`Announcement ${a.key} targets could not be verified: ${targetErr.message}`);
  const incomplete = targets || [];
  const incompleteIds = new Set(incomplete.map((p) => p.id));

  // 2) Existing deliveries for this announcement.
  const { data: deliveries, error: delErr } = await sb
    .from('easer_announcement_deliveries')
    .select('id, easer_id, channels_sent, first_notified_at, last_reminded_at, reminder_count, completed_at, reminder_state')
    .eq('announcement_id', a.id);
  if (delErr) throw new Error(`Announcement ${a.key} delivery state could not be verified: ${delErr.message}`);

  // 3) Mark completions: open deliveries whose Easer is no longer incomplete.
  const nowIso = new Date().toISOString();
  const completedIds = (deliveries || [])
    .filter((d) => !d.completed_at && !incompleteIds.has(d.easer_id))
    .map((d) => d.id);
  if (completedIds.length) {
    const { error } = await sb.from('easer_announcement_deliveries')
      .update({ completed_at: nowIso, updated_at: nowIso })
      .in('id', completedIds);
    if (error) throw error;
    counters.completed += completedIds.length;
  }

  // 4) Send reminders to still-incomplete Easers whose cadence is due.
  const channels = Array.isArray(a.channels) ? a.channels : [];
  for (const easer of incomplete) {
    if (counters.sent >= (counters.runCap || MAX_PER_RUN)) break;
    const leaseKey = `announcement:${a.id}:${easer.id}`;
    const lease = await acquire(sb, leaseKey);
    if (!lease.ok) {
      if (lease.error) {
        counters.failed = Number(counters.failed || 0) + 1;
        console.error('[easer-announcements] reminder lock unavailable:', lease.error);
      }
      continue;
    }
    try {
      // Read again under the lease: another run may have completed a channel.
      const { data: existing, error: loadError } = await sb.from('easer_announcement_deliveries')
        .select('*').eq('announcement_id', a.id).eq('easer_id', easer.id).maybeSingle();
      if (loadError) throw loadError;
      let delivery = existing;
      if (delivery?.completed_at) continue;
      const wanted = channels.filter(channel => channel === 'push' || (channel === 'email' && easer.email));
      if (!wanted.length) continue; // an in-app banner is not an outbound send
      let state = delivery?.reminder_state || {};
      const hasPending = state.step && wanted.some(channel => !(state.completed_channels || []).includes(channel));
      if (!hasPending && !isReminderDue(delivery, a.reminder_days)) continue;

      // Smart completion: before nagging, confirm against the LIVE source of truth
      // (e.g. Stripe payouts_enabled) that the Easer genuinely still needs this —
      // never email someone who already finished just because a cached flag lagged.
      // Side effect: self-heals the cached flag, so the in-app banner clears too.
      if (typeof rule.confirmStillIncomplete === 'function') {
        const check = await rule.confirmStillIncomplete(sb, easer);
        if (!check.stillIncomplete) {
          if (delivery && !delivery.completed_at) {
            const { error } = await sb.from('easer_announcement_deliveries')
              .update({ completed_at: nowIso, updated_at: nowIso })
              .eq('id', delivery.id);
            if (error) throw error;
          }
          counters.completed += 1;
          continue;
        }
        if (!check.verified) continue; // could not verify — don't nag on uncertainty
      }

      if (!hasPending) {
        state = { cycle: state.cycle || 'initial', step: Number(delivery?.reminder_count || 0) + 1, sent_channels: [], completed_channels: [], uncertain_channels: [] };
      }
      const cumulative = new Set(delivery?.channels_sent || []);
      if (channels.includes('in_app')) cumulative.add('in_app');
      const persist = async () => {
        const accepted = (state.sent_channels || []).length > 0;
        const patch = {
          channels_sent: [...cumulative], reminder_state: state, updated_at: new Date().toISOString(),
          ...(accepted ? {
            reminder_count: Math.max(Number(delivery?.reminder_count || 0), state.step),
            first_notified_at: delivery?.first_notified_at || state.first_sent_at,
            last_reminded_at: state.first_sent_at,
          } : {}),
        };
        let result;
        if (delivery) {
          result = await sb.from('easer_announcement_deliveries').update(patch).eq('id', delivery.id).select('*').single();
        } else {
          result = await sb.from('easer_announcement_deliveries')
            .insert({ announcement_id: a.id, easer_id: easer.id, ...patch }).select('*').single();
        }
        if (result.error || !result.data) throw result.error || new Error('Announcement delivery state was not saved');
        delivery = result.data;
      };
      await persist(); // fail closed before attempting a provider call
      let acceptedThisRun = false;
      for (const channel of wanted) {
        if (state.completed_channels.includes(channel) || state.uncertain_channels.includes(channel)) continue;
        let result;
        if (channel === 'email') {
          if (counters.sent > 0) await wait(minSendIntervalMs());
          result = await email({
            to: easer.email,
            from: 'AssembleAtEase <booking@assembleatease.com>',
            subject: a.title,
            html: buildEmailHtml(a),
            replyTo: ownerEmail(),
            meta: {
              notificationType: `easer_required_action_${a.key}`, recipientType: 'easer', recipientUserId: easer.id,
              notificationKey: `announcement:${a.id}:${easer.id}:${state.cycle || 'initial'}:${state.step}:email`, routine: true,
              announcementCycle: state.cycle || 'initial',
            },
          });
        } else {
          // Push has no provider idempotency key. Persist uncertainty BEFORE the
          // attempt so a process crash cannot replay a push already accepted.
          state.uncertain_channels.push('push');
          await persist();
          result = await push(easer.id, {
            title: a.title,
            body: a.action_label ? `${a.action_label} →` : 'Action needed on your account',
            url: String(a.action_url || '/assembler/my-assignments'),
          }, { notificationType: `required_action_${a.key}_${state.step}`, recipientType: 'easer' });
          state.uncertain_channels = state.uncertain_channels.filter(value => value !== 'push');
        }
        if (result?.ok) {
          state.sent_channels.push(channel);
          state.completed_channels.push(channel);
          state.first_sent_at ||= new Date().toISOString();
          cumulative.add(channel);
          acceptedThisRun = true;
        } else if (channel === 'push' && result?.reason === 'no_push_subscriptions') {
          // No destination exists. It is unavailable, never counted as sent.
          state.completed_channels.push(channel);
        } else {
          const field = result?.deferred ? 'deferred' : 'failed';
          counters[field] = Number(counters[field] || 0) + 1;
        }
        await persist();
      }
      if (acceptedThisRun) counters.sent += 1;
      if (state.uncertain_channels.length) {
        counters.uncertain = Number(counters.uncertain || 0) + 1;
        console.error(`[easer-announcements] ${a.key}/${easer.id}: push outcome needs review; not replayed`);
      }
    } catch (error) {
      counters.failed = Number(counters.failed || 0) + 1;
      console.error(`[easer-announcements] ${a.key}/${easer.id}:`, error.message);
    } finally {
      await release(sb, leaseKey, lease.token);
    }
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
    const needsAttention = Number(counters.failed || 0) + Number(counters.uncertain || 0);
    await logCron('easer-announcements', {
      status: needsAttention ? 'error' : 'ok', records: counters.sent,
      errorText: needsAttention ? `${counters.failed || 0} failed attempts; ${counters.uncertain || 0} uncertain outcomes need review` : null,
      duration: Date.now() - t,
    });
    return res.status(200).json({ ok: true, ...counters });
  } catch (e) {
    console.error('[easer-announcements] fatal:', e.message || e);
    await logCron('easer-announcements', { status: 'error', error: e.message || String(e), duration: Date.now() - t });
    return res.status(500).json({ error: 'Announcement run failed' });
  }
}
