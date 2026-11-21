import { getSupabase } from '../_supabase.js';
import { sendEmail, ownerEmail, esc } from '../_email.js';
import { logCron } from './_cron-logger.js';
import { qualifyingJobCount, referralRewardDecision, refereeDisplayName } from '../_easer-referrals.js';

/**
 * GET /api/cron/referral-rewards, daily.
 *
 * For every pending referral reward (migration 134): when the new Easer has
 * completed enough paid jobs inside the window, mark it earned and tell the
 * owner (who pays it) and the referrer. When the window passes, or the new
 * Easer is rejected or closes their account, void it. Never moves money: the
 * owner pays and records it in the dashboard (api/owner/referral-rewards.js).
 * Each email is keyed to the reward, so a re-run never sends twice.
 */
export default async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.authorization !== 'Bearer ' + cronSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const startedAt = Date.now();
  const sb = getSupabase();
  const result = { checked: 0, earned: 0, voided: 0, failed: [] };

  try {
    const { data: pending, error } = await sb.from('easer_referral_rewards')
      .select('id, referrer_id, referee_id, status, amount_cents, qualifying_jobs, referred_at')
      .eq('status', 'pending')
      .limit(500);
    if (error) {
      // Before migration 134 there is nothing to check.
      if (/easer_referral_rewards|42P01|PGRST205/i.test(`${error.code || ''} ${error.message || ''}`)) {
        await logCron('referral-rewards', { status: 'ok', records: 0, duration: Date.now() - startedAt });
        return res.status(200).json({ ...result, unavailable: true });
      }
      throw error;
    }

    for (const reward of pending || []) {
      result.checked += 1;
      try {
        const { data: people } = await sb.from('profiles')
          .select('id, full_name, email, application_status, account_closure_status')
          .in('id', [reward.referrer_id, reward.referee_id]);
        const referrer = (people || []).find(p => p.id === reward.referrer_id) || {};
        const referee = (people || []).find(p => p.id === reward.referee_id) || {};
        const completedJobs = await qualifyingJobCount(sb, { refereeId: reward.referee_id, referredAt: reward.referred_at });
        const decision = referralRewardDecision(reward, { completedJobs, referee });

        if (decision.action === 'earned') {
          const { data: updated } = await sb.from('easer_referral_rewards')
            .update({ status: 'earned', earned_at: new Date().toISOString() })
            .eq('id', reward.id).eq('status', 'pending')
            .select('id').maybeSingle();
          if (!updated) continue;
          result.earned += 1;
          const amount = `$${(Number(reward.amount_cents || 0) / 100).toFixed(2)}`;
          await sendEmail({
            to: ownerEmail(),
            subject: `Referral reward earned: ${amount} to ${esc(referrer.full_name || 'an Easer')}`,
            html: `<p><strong>${esc(referee.full_name || 'A new Easer')}</strong> completed ${completedJobs} paid jobs, so <strong>${esc(referrer.full_name || 'the referring Easer')}</strong> earned a ${esc(amount)} referral reward.</p>
              <p>Pay it, then record it under Easers &gt; Referral rewards in the dashboard.</p>`,
            meta: { notificationType: 'referral_reward_earned_owner', recipientType: 'owner', notificationKey: `referral-earned:${reward.id}:owner` },
          });
          if (referrer.email) {
            await sendEmail({
              to: referrer.email,
              subject: `You earned a ${amount} referral reward`,
              html: `<p style="font-size:15px;color:#1f2933">Hi ${esc(refereeDisplayName(referrer.full_name))},</p>
                <p style="font-size:15px;color:#1f2933;line-height:1.6">${esc(refereeDisplayName(referee.full_name))} completed ${completedJobs} jobs, so you earned a ${esc(amount)} referral reward. We will send it to you.</p>
                <p style="margin:18px 0 0;font-size:14px;color:#1f2933">The AssembleAtEase Team</p>`,
              replyTo: ownerEmail(),
              meta: { notificationType: 'referral_reward_earned_easer', recipientType: 'easer', recipientUserId: reward.referrer_id, notificationKey: `referral-earned:${reward.id}:easer` },
            });
          }
        } else if (decision.action === 'void') {
          const { error: voidError } = await sb.from('easer_referral_rewards')
            .update({ status: 'void', void_reason: decision.reason })
            .eq('id', reward.id).eq('status', 'pending');
          if (!voidError) result.voided += 1;
        }
      } catch (err) {
        result.failed.push({ id: reward.id, error: String(err?.message || err).slice(0, 200) });
      }
    }

    await logCron('referral-rewards', {
      status: result.failed.length ? 'error' : 'ok',
      records: result.earned + result.voided,
      duration: Date.now() - startedAt,
      errorText: result.failed.length ? JSON.stringify(result.failed).slice(0, 500) : null,
    });
    return res.status(200).json(result);
  } catch (err) {
    await logCron('referral-rewards', { error: String(err?.message || err), duration: Date.now() - startedAt });
    return res.status(500).json({ error: 'Referral reward check failed', ...result });
  }
}
