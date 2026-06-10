import Stripe from 'stripe';
import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';
import { isStripeConnectEnabled } from '../_stripe-connect.js';

function taxReadinessFromAccount(account, dueCount) {
  if (!account) {
    return { code: 'unknown', label: 'Unknown' };
  }

  const req = account.requirements || {};
  const currentlyDue = Array.isArray(req.currently_due) ? req.currently_due : [];
  const disabledReason = req.disabled_reason || null;
  const taxPattern = /(tax|tin|ssn|ein|w9|1099)/i;
  const hasTaxDue = currentlyDue.some((field) => taxPattern.test(String(field || '')));

  if (dueCount === 0 && account.payouts_enabled) {
    return { code: 'ready', label: 'Ready' };
  }
  if (hasTaxDue || (disabledReason && taxPattern.test(disabledReason))) {
    return { code: 'action_required', label: 'Action Required' };
  }
  if (!account.details_submitted) {
    return { code: 'not_started', label: 'Not Started' };
  }
  return { code: 'pending', label: 'Pending Stripe Requirements' };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const assemblerId = String(req.query.assemblerId || '').trim();
  if (!assemblerId) return res.status(400).json({ error: 'assemblerId is required' });

  const sb = getSupabase();
  const { data: profile, error: profileErr } = await sb
    .from('profiles')
    .select('*')
    .eq('id', assemblerId)
    .eq('role', 'assembler')
    .maybeSingle();

  if (profileErr || !profile) return res.status(404).json({ error: 'Easer not found' });

  let dueCount = null;
  let disabledReason = null;
  let account = null;
  const connectRequired = isStripeConnectEnabled();

  if (process.env.STRIPE_SECRET_KEY && profile.stripe_connect_account_id) {
    try {
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
      account = await stripe.accounts.retrieve(profile.stripe_connect_account_id);

      const reqs = account.requirements || {};
      const currentlyDue = Array.isArray(reqs.currently_due) ? reqs.currently_due : [];
      dueCount = currentlyDue.length;
      disabledReason = reqs.disabled_reason || null;

      const updates = {
        stripe_connect_details_submitted: !!account.details_submitted,
        stripe_connect_charges_enabled: !!account.charges_enabled,
        stripe_connect_payouts_enabled: !!account.payouts_enabled,
        stripe_connect_onboarding_complete: !!(account.details_submitted && account.charges_enabled && account.payouts_enabled),
        stripe_connect_updated_at: new Date().toISOString(),
      };
      await sb.from('profiles').update(updates).eq('id', profile.id);
      Object.assign(profile, updates);
    } catch (err) {
      console.error('owner/easer-readiness stripe sync error:', err?.message || err);
    }
  }

  const applicationSubmitted = !!profile.created_at && ['applied', 'approved', 'rejected'].includes(String(profile.application_status || '').toLowerCase());
  const contractorAgreementAccepted = !!profile.contractor_agreement_signed_at;
  const agreementVersion = profile.contractor_agreement_version || profile.agreement_version || null;
  const identityVerified = profile.identity_verified === true;
  const ownerApproved = String(profile.status || '').toLowerCase() === 'active' || String(profile.application_status || '').toLowerCase() === 'approved';
  const connectStarted = !!profile.stripe_connect_account_id;
  const connectComplete = !!profile.stripe_connect_onboarding_complete;
  const payoutsEnabled = !!profile.stripe_connect_payouts_enabled;
  const requirementsDueCount = Number.isInteger(dueCount) ? dueCount : null;

  const taxReadiness = taxReadinessFromAccount(account, requirementsDueCount == null ? 0 : requirementsDueCount);

  const missingItems = [];
  if (!applicationSubmitted) missingItems.push('Application submitted');
  if (!contractorAgreementAccepted) missingItems.push('Contractor agreement accepted');
  // Agreement VERSION is informational, not a dispatch blocker. If the Pro accepted
  // the agreement, a missing version string is just a recording gap (older signups
  // predate version tracking) — it must not hold an otherwise-ready Pro in limbo.
  if (!identityVerified) missingItems.push('Identity verified');
  if (!ownerApproved) missingItems.push('Owner approved');
  if (connectRequired) {
    if (!connectStarted) missingItems.push('Stripe Connect started');
    if (!connectComplete) missingItems.push('Stripe Connect complete');
    if (!payoutsEnabled) missingItems.push('Payouts enabled');
    if (requirementsDueCount != null && requirementsDueCount > 0) missingItems.push('Stripe requirements due: ' + requirementsDueCount);
    if (disabledReason) missingItems.push('Stripe disabled reason: ' + disabledReason);
    if (taxReadiness.code === 'action_required') missingItems.push('Tax readiness status: Action Required');
  }

  const finalStatus = missingItems.length === 0 ? 'READY FOR JOBS' : 'ACTION REQUIRED';

  return res.status(200).json({
    ok: true,
    readiness: {
      connectRequired,
      applicationSubmitted,
      contractorAgreementAccepted,
      agreementVersion: agreementVersion || (contractorAgreementAccepted ? 'Accepted (version not recorded)' : null),
      identityVerified,
      ownerApproved,
      connectStarted,
      connectComplete,
      payoutsEnabled,
      requirementsDueCount,
      disabledReason,
      taxReadinessStatus: taxReadiness.label,
      finalStatus,
      missingItems,
      checkedAt: new Date().toISOString(),
    },
  });
}
