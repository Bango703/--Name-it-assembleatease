import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';
import { isStripeConnectEnabled } from '../_stripe-connect.js';
import { normalizeAssemblerProfile } from '../_assembler-state.js';
import { getEaserReadiness, getEaserApprovalReadiness } from '../_easer-readiness.js';
import { hasEffectiveEaserMembership } from '../_easer-membership.js';
import { inspectApplicationText } from '../booking/_relay-contact-guard.js';
import { ACTIVE_BOOKING_STATUSES } from '../_source-of-truth.js';
import { chicagoTodayIso } from '../booking/_appt-date.js';
import { loadAcceptanceTallies, acceptanceRateFor, ACCEPTANCE_MIN_DECISIONS, ACCEPTANCE_WINDOW_DAYS } from '../_easer-acceptance.js';

/**
 * GET /api/assembler/list
 * Owner-only: returns all Easer profiles using clean status/tier separation.
 * Status: pending | active | suspended | rejected
 * Tier:   starter | professional | elite (null for non-active)
 */
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const sb = getSupabase();
  const { status, tier, search } = req.query;

  let query = sb
    .from('profiles')
    .select('*')
    .eq('role', 'assembler')
    .order('created_at', { ascending: false });

  if (status && status !== 'all') query = query.eq('status', status);
  if (tier && tier !== 'all') query = query.eq('tier', tier);
  if (search) query = query.ilike('full_name', `%${search}%`);

  const { data, error } = await query;
  if (error) {
    console.error('Assembler list error:', error);
    return res.status(500).json({ error: 'Failed to fetch assemblers: ' + error.message });
  }

  const profiles = (data || []).map(sanitizeAssemblerForOwner);
  const requireConnect = isStripeConnectEnabled();
  // Work activity read from bookings and decisions now, not from profile
  // counters: jobs reach an Easer by dispatch or by owner assignment, and both
  // count the same (owner, 2026-10-28).
  const [workByEaser, acceptance] = await Promise.all([
    loadOpenWork(sb),
    loadAcceptanceTallies(sb).catch(error => ({ tallies: null, error })),
  ]);
  if (acceptance.error) console.error('Assembler list acceptance tally error:', acceptance.error.message || acceptance.error);
  // Two DIFFERENT questions, both answered here so the browser never has to
  // reimplement either:
  //   readiness         — can this Easer take a JOB right now?
  //   approvalReadiness — can the owner APPROVE this application?
  // The owner dashboard previously had no server answer to the second and kept a
  // hand-copy of the paid-XOR-waived fee rule to decide whether to enable the
  // Approve button. Two copies of one money rule is exactly the drift that let an
  // Easer sit permanently un-approvable with a greyed-out button and no reason.
  const assemblers = await Promise.all(profiles.map(async profile => {
    const assembler = normalizeAssemblerProfile(profile);
    return {
      ...assembler,
      // Display normalization may infer active status from a legacy tier. Job
      // readiness must use the stored approval evidence, as dispatch does.
      readiness: await getEaserReadiness(profile, { connectRequired: requireConnect }),
      approvalReadiness: getEaserApprovalReadiness(assembler),
      // Same verdict the approve action enforces (api/assembler/update.js).
      applicationScreen: inspectApplicationText(profile.bio),
      workActivity: workActivityFor(profile.id, workByEaser, acceptance.tallies),
    };
  }));

  const stats = {
    total:         assemblers.length,
    pending:       assemblers.filter(a => a.status === 'pending').length,
    active:        assemblers.filter(a => a.status === 'active').length,
    suspended:     assemblers.filter(a => a.status === 'suspended').length,
    rejected:      assemblers.filter(a => a.status === 'rejected').length,
    starter:       assemblers.filter(a => a.status === 'active' && a.tier === 'starter').length,
    professional:  assemblers.filter(a => a.status === 'active' && a.tier === 'professional').length,
    elite:         assemblers.filter(a => a.status === 'active' && a.tier === 'elite').length,
    dispatchEligible: assemblers.filter(a => a.readiness.isReady).length,
    connectRequired: requireConnect,
  };

  return res.status(200).json({ assemblers, stats });
}

// Open jobs: every active booking assigned to the Easer, accepted or still
// waiting on them. Jobs today: those whose next visit is today (a return visit
// counts on its own date). null when bookings could not be read, so the
// dashboard shows "unavailable" rather than a confident 0.
export async function loadOpenWork(sb, today = chicagoTodayIso()) {
  const { data, error } = await sb.from('bookings')
    .select('assembler_id, date, assembler_accepted_at, return_visit_required, return_visit_date')
    .in('status', ACTIVE_BOOKING_STATUSES)
    .not('assembler_id', 'is', null);
  if (error) {
    console.error('Assembler list open-work error:', error.message);
    return null;
  }
  const byEaser = new Map();
  for (const b of data || []) {
    const w = byEaser.get(b.assembler_id) || { openJobs: 0, awaitingAcceptance: 0, jobsToday: 0 };
    w.openJobs += 1;
    if (!b.assembler_accepted_at) w.awaitingAcceptance += 1;
    const visitDate = b.return_visit_required && b.return_visit_date ? b.return_visit_date : b.date;
    if (String(visitDate || '').slice(0, 10) === today) w.jobsToday += 1;
    byEaser.set(b.assembler_id, w);
  }
  return byEaser;
}

export function workActivityFor(easerId, workByEaser, tallies) {
  const work = workByEaser ? (workByEaser.get(easerId) || { openJobs: 0, awaitingAcceptance: 0, jobsToday: 0 }) : null;
  const tally = tallies ? (tallies.get(easerId) || { accepted: 0, declined: 0, expired: 0, total: 0 }) : null;
  return {
    openJobs: work ? work.openJobs : null,
    awaitingAcceptance: work ? work.awaitingAcceptance : null,
    jobsToday: work ? work.jobsToday : null,
    acceptance: tally ? {
      ...tally,
      rate: acceptanceRateFor(tally),
      windowDays: ACCEPTANCE_WINDOW_DAYS,
      minDecisions: ACCEPTANCE_MIN_DECISIONS,
    } : null,
  };
}

function sanitizeAssemblerForOwner(profile = {}) {
  // Owner operations need readiness evidence, not reusable bearer secrets or
  // raw device/network fingerprints in browser memory.
  const {
    identity_resume_token,
    contractor_agreement_ip,
    contractor_agreement_user_agent,
    ...safeProfile
  } = profile;
  return {
    ...safeProfile,
    has_membership: hasEffectiveEaserMembership(profile),
  };
}
