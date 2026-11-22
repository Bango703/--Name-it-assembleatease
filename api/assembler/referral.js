import { authenticateBearerUser, respondWithEaserAccessError } from '../_easer-access.js';
import { getSupabase } from '../_supabase.js';
import { EASER_REFERRAL_POLICY, canRefer, ensureReferralCode, referralLink, refereeDisplayName } from '../_easer-referrals.js';

/**
 * GET /api/assembler/referral — the Easer's referral link, the reward terms,
 * and the people they referred (first name and progress only). Approved,
 * active Easers only: only they can be credited (api/_easer-referrals.js).
 * `unavailable: true` until migration 134 is applied.
 */
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  res.setHeader('Cache-Control', 'private, no-store');

  const authenticated = await authenticateBearerUser(req);
  if (!authenticated.ok) return respondWithEaserAccessError(res, authenticated);
  const userId = authenticated.user.id;
  const sb = getSupabase();

  const terms = {
    rewardCents: EASER_REFERRAL_POLICY.rewardCents,
    qualifyingJobs: EASER_REFERRAL_POLICY.qualifyingJobs,
    windowDays: EASER_REFERRAL_POLICY.windowDays,
  };

  const { data: profile, error } = await sb.from('profiles')
    .select('id, role, status, full_name, referral_code, account_closure_status')
    .eq('id', userId)
    .maybeSingle();
  if (error) {
    // Before migration 134 the column does not exist.
    if (/referral_code|42703|PGRST204/i.test(`${error.code || ''} ${error.message || ''}`)) {
      return res.status(200).json({ ok: true, unavailable: true, terms });
    }
    return res.status(503).json({ error: 'Your referral link could not be loaded. Try again.' });
  }
  if (!profile || profile.role !== 'assembler') return res.status(403).json({ error: 'An Easer account is required.' });
  if (!canRefer(profile)) {
    return res.status(200).json({ ok: true, eligible: false, terms, message: 'Your referral link opens once your account is approved.' });
  }

  let code;
  try {
    code = await ensureReferralCode(sb, profile);
  } catch (codeError) {
    console.error('[referral] code failed:', codeError?.message || codeError);
    return res.status(503).json({ error: 'Your referral link could not be created. Try again.' });
  }

  const { data: rewards } = await sb.from('easer_referral_rewards')
    .select('id, referee_id, status, amount_cents, referred_at, earned_at, paid_at')
    .eq('referrer_id', userId)
    .order('referred_at', { ascending: false })
    .limit(50);
  const refereeIds = (rewards || []).map(r => r.referee_id);
  let names = new Map();
  if (refereeIds.length) {
    const { data: people } = await sb.from('profiles').select('id, full_name').in('id', refereeIds);
    names = new Map((people || []).map(p => [p.id, refereeDisplayName(p.full_name)]));
  }

  return res.status(200).json({
    ok: true,
    eligible: true,
    code,
    link: referralLink(code),
    terms,
    referrals: (rewards || []).map(r => ({
      id: r.id,
      name: names.get(r.referee_id) || 'Your referral',
      status: r.status,
      amountCents: r.amount_cents,
      referredAt: r.referred_at,
      earnedAt: r.earned_at,
      paidAt: r.paid_at,
    })),
  });
}
