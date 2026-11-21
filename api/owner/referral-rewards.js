import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';
import { writeFinancialAudit } from '../_financial-audit.js';
import { EASER_REFERRAL_POLICY } from '../_easer-referrals.js';

/**
 * Owner: Easer referral rewards (migration 134, api/_easer-referrals.js).
 *
 * GET  /api/owner/referral-rewards
 *   Every reward with referrer and new Easer names, status and amount. The
 *   counts are the lengths of the lists returned (count = list).
 * POST /api/owner/referral-rewards  { id, action: 'mark_paid', method, reference }
 *   Records that an EARNED reward was paid. method is 'stripe_transfer' (sent
 *   through Stripe Connect, so Stripe's own 1099 already counts it) or
 *   'outside_stripe' (Zelle, cash: added to the 1099 delta file).
 * POST { id, action: 'void', reason }  cancels a pending or earned reward.
 *
 * Nothing here moves money: the owner pays, then records it, the same as a
 * manual payout. A paid reward is final.
 */
export default async function handler(req, res) {
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });
  const sb = getSupabase();

  if (req.method === 'GET') {
    const { data: rewards, error } = await sb.from('easer_referral_rewards')
      .select('id, referrer_id, referee_id, referral_code, status, amount_cents, qualifying_jobs, referred_at, earned_at, paid_at, paid_method, paid_reference, void_reason')
      .order('referred_at', { ascending: false })
      .limit(500);
    if (error) {
      if (/easer_referral_rewards|42P01|PGRST205/i.test(`${error.code || ''} ${error.message || ''}`)) {
        return res.status(200).json({ ok: true, unavailable: true, reason: 'Referral rewards need migration 134.', rewards: [], owed: [], policy: EASER_REFERRAL_POLICY });
      }
      return res.status(503).json({ error: 'Referral rewards could not be read.' });
    }
    const ids = [...new Set((rewards || []).flatMap(r => [r.referrer_id, r.referee_id]))];
    let names = new Map();
    if (ids.length) {
      const { data: people } = await sb.from('profiles').select('id, full_name, city, zip').in('id', ids);
      names = new Map((people || []).map(p => [p.id, p]));
    }
    const rows = (rewards || []).map(r => ({
      ...r,
      referrerName: names.get(r.referrer_id)?.full_name || 'Easer',
      refereeName: names.get(r.referee_id)?.full_name || 'Applicant',
      refereeArea: [names.get(r.referee_id)?.city, names.get(r.referee_id)?.zip].filter(Boolean).join(' '),
    }));
    const owed = rows.filter(r => r.status === 'earned');
    return res.status(200).json({
      ok: true,
      policy: EASER_REFERRAL_POLICY,
      rewards: rows,
      owed,
      owedCents: owed.reduce((sum, r) => sum + Number(r.amount_cents || 0), 0),
    });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { id, action, method, reference, reason } = req.body || {};
  if (!id) return res.status(400).json({ error: 'id is required' });
  const { data: reward, error: readError } = await sb.from('easer_referral_rewards')
    .select('id, referrer_id, referee_id, status, amount_cents')
    .eq('id', id)
    .maybeSingle();
  if (readError || !reward) return res.status(404).json({ error: 'Referral reward not found' });

  if (action === 'mark_paid') {
    if (reward.status !== 'earned') {
      return res.status(409).json({ error: reward.status === 'paid' ? 'This reward is already recorded as paid.' : 'Only an earned reward can be paid.', code: 'NOT_EARNED' });
    }
    if (!['stripe_transfer', 'outside_stripe'].includes(method)) {
      return res.status(400).json({ error: 'Say how it was paid: through Stripe, or outside Stripe.', code: 'METHOD_REQUIRED' });
    }
    const paidAt = new Date().toISOString();
    const { data: updated, error } = await sb.from('easer_referral_rewards')
      .update({ status: 'paid', paid_at: paidAt, paid_method: method, paid_reference: String(reference || '').trim().slice(0, 200) || null })
      .eq('id', id)
      .eq('status', 'earned')
      .select('id')
      .maybeSingle();
    if (error || !updated) return res.status(409).json({ error: 'The reward changed before it could be saved. Refresh and try again.' });
    await writeFinancialAudit(sb, {
      eventType: 'easer_referral_reward_paid',
      eventSource: 'owner_dashboard',
      status: 'processed',
      metadata: { rewardId: id, referrerId: reward.referrer_id, refereeId: reward.referee_id, amountCents: reward.amount_cents, method, reference: reference || null },
    }).catch(err => console.error('[referral-rewards] audit failed:', err?.message || err));
    return res.status(200).json({ ok: true, status: 'paid', paidAt });
  }

  if (action === 'void') {
    const why = String(reason || '').trim().slice(0, 300);
    if (why.length < 3) return res.status(400).json({ error: 'Say why this reward is cancelled.', code: 'REASON_REQUIRED' });
    if (!['pending', 'earned'].includes(reward.status)) return res.status(409).json({ error: 'Only a pending or earned reward can be cancelled.' });
    const { error } = await sb.from('easer_referral_rewards')
      .update({ status: 'void', void_reason: why })
      .eq('id', id)
      .in('status', ['pending', 'earned']);
    if (error) return res.status(503).json({ error: 'The reward could not be cancelled.' });
    return res.status(200).json({ ok: true, status: 'void' });
  }

  return res.status(400).json({ error: 'Unknown action' });
}
