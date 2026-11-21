/**
 * Easer referrals (owner, 2026-11-21: "let's work on getting easers"). The ONE
 * owner of the referral rules: the reward, what qualifies, the link, and how a
 * code becomes a referrer. Read by the application (api/assembler/apply.js),
 * the Easer's referral card (api/assembler/referral.js), the daily check
 * (api/cron/referral-rewards.js), the owner panel (api/owner/referral-rewards.js)
 * and contractor tax totals (api/owner/_contractor-tax.js). Migration 134.
 *
 * The reward is paid only after the new Easer has done real, paid work, as gig
 * platforms do (DoorDash ties referral bonuses to completed deliveries), so a
 * sign-up alone earns nothing and a fake friend costs nothing.
 */
import { randomInt } from 'node:crypto';

export const EASER_REFERRAL_POLICY = Object.freeze({
  rewardCents: 7500,        // $75 to the referring Easer
  qualifyingJobs: 2,        // completed, paid, non-test jobs by the new Easer
  windowDays: 90,           // counted from the application
});

const SITE = 'https://www.assembleatease.com';
const CODE_PATTERN = /^[A-Z]{1,8}[0-9]{3}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

export function normalizeReferralCode(value) {
  const code = String(value || '').trim().toUpperCase();
  return CODE_PATTERN.test(code) ? code : null;
}

/** A new code from the Easer's first name: letters only, up to 8, plus 3 digits. */
export function referralCodeCandidate(fullName, digits = randomInt(100, 1000)) {
  const letters = String(fullName || '').trim().split(/\s+/)[0].toUpperCase().replace(/[^A-Z]/g, '').slice(0, 8) || 'EASER';
  return `${letters}${String(digits).padStart(3, '0').slice(-3)}`;
}

/**
 * The link an Easer shares. It lands on the recruiting hub and carries the
 * code in UTM tags, which the site's existing attribution capture keeps until
 * the application is sent (api/_attribution.js, assets/js/attribution.js).
 */
export function referralLink(code) {
  const clean = normalizeReferralCode(code);
  if (!clean) return null;
  const url = new URL('/become-an-easer', SITE);
  url.searchParams.set('utm_source', 'easer_referral');
  url.searchParams.set('utm_medium', 'referral');
  url.searchParams.set('utm_campaign', `referral_${clean.toLowerCase()}`);
  return url.toString();
}

/** The code from an application's cleaned attribution, or null. */
export function referralCodeFromAttribution(attribution = {}) {
  if (!attribution || attribution.utmSource !== 'easer_referral') return null;
  const match = /^referral_([a-z]{1,8}[0-9]{3})$/.exec(String(attribution.utmCampaign || ''));
  return match ? normalizeReferralCode(match[1]) : null;
}

/** The Easer's code, created on first use (unique; a collision retries). */
export async function ensureReferralCode(sb, profile) {
  const existing = normalizeReferralCode(profile?.referral_code);
  if (existing) return existing;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const candidate = referralCodeCandidate(profile?.full_name);
    const { data, error } = await sb.from('profiles')
      .update({ referral_code: candidate })
      .eq('id', profile.id)
      .is('referral_code', null)
      .select('referral_code')
      .maybeSingle();
    if (!error && data?.referral_code) return normalizeReferralCode(data.referral_code);
    if (!error && !data) {
      // Someone (another tab) set it first: read it back.
      const { data: row } = await sb.from('profiles').select('referral_code').eq('id', profile.id).maybeSingle();
      if (normalizeReferralCode(row?.referral_code)) return normalizeReferralCode(row.referral_code);
    }
    if (error && !/duplicate key|23505/i.test(`${error.code || ''} ${error.message || ''}`)) {
      throw new Error(`Referral code could not be saved: ${error.message || error}`);
    }
  }
  throw new Error('Referral code could not be created');
}

/**
 * Record who referred this applicant. Never blocks an application: any
 * failure (no migration 134, unknown code, self-referral) records nothing.
 * Only an approved, active Easer can be a referrer.
 */
export async function recordReferralFromAttribution(sb, { refereeId, attribution, nowIso = new Date().toISOString() }) {
  try {
    const code = referralCodeFromAttribution(attribution);
    if (!code || !refereeId) return { recorded: false, reason: 'no_code' };
    const { data: referrer, error } = await sb.from('profiles')
      .select('id, role, status, application_status, account_closure_status, referral_code')
      .eq('referral_code', code)
      .maybeSingle();
    if (error || !referrer) return { recorded: false, reason: 'unknown_code' };
    if (referrer.id === refereeId) return { recorded: false, reason: 'self_referral' };
    if (referrer.role !== 'assembler' || referrer.status !== 'active' || referrer.account_closure_status) {
      return { recorded: false, reason: 'referrer_not_active' };
    }
    const { error: profileError } = await sb.from('profiles')
      .update({ referred_by_easer_id: referrer.id })
      .eq('id', refereeId)
      .is('referred_by_easer_id', null);
    if (profileError) return { recorded: false, reason: 'profile_write_failed' };
    const { error: rewardError } = await sb.from('easer_referral_rewards').insert({
      referrer_id: referrer.id,
      referee_id: refereeId,
      referral_code: code,
      status: 'pending',
      amount_cents: EASER_REFERRAL_POLICY.rewardCents,
      qualifying_jobs: EASER_REFERRAL_POLICY.qualifyingJobs,
      referred_at: nowIso,
    });
    if (rewardError && !/duplicate key|23505/i.test(`${rewardError.code || ''} ${rewardError.message || ''}`)) {
      return { recorded: false, reason: 'reward_write_failed' };
    }
    return { recorded: true, referrerId: referrer.id, code };
  } catch {
    return { recorded: false, reason: 'error' };
  }
}

/**
 * What should happen to a pending reward now:
 *   earned  the new Easer completed enough paid jobs inside the window
 *   void    the window passed, or the new Easer was rejected or closed
 *   wait    neither yet
 */
export function referralRewardDecision(reward, { completedJobs = 0, referee = {}, nowMs = Date.now() } = {}) {
  if (!reward || reward.status !== 'pending') return { action: 'none' };
  const needed = Number(reward.qualifying_jobs || EASER_REFERRAL_POLICY.qualifyingJobs);
  if (completedJobs >= needed) return { action: 'earned' };
  const status = String(referee.application_status || '').toLowerCase();
  if (status === 'rejected' || referee.account_closure_status === 'closed') return { action: 'void', reason: 'referee_not_approved' };
  const deadline = Date.parse(reward.referred_at) + EASER_REFERRAL_POLICY.windowDays * DAY_MS;
  if (Number.isFinite(deadline) && nowMs > deadline) return { action: 'void', reason: 'window_expired' };
  return { action: 'wait' };
}

/** Completed, paid, non-test jobs an Easer finished inside the reward window. */
export async function qualifyingJobCount(sb, { refereeId, referredAt }) {
  const start = referredAt;
  const end = new Date(Date.parse(referredAt) + EASER_REFERRAL_POLICY.windowDays * DAY_MS).toISOString();
  const { data, error } = await sb.from('bookings')
    .select('id, status, payment_status, is_test_booking, completed_at')
    .eq('assembler_id', refereeId)
    .eq('status', 'completed')
    .gte('completed_at', start)
    .lte('completed_at', end);
  if (error) throw new Error(`Referral job count failed: ${error.message || error}`);
  return (data || []).filter(b => b.is_test_booking !== true && b.payment_status === 'captured').length;
}

/** First name only: an Easer sees who they referred, not their details. */
export function refereeDisplayName(fullName) {
  return String(fullName || '').trim().split(/\s+/)[0] || 'Your referral';
}
