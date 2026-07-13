import Stripe from 'stripe';
import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';
import { isStripeConnectEnabled } from '../_stripe-connect.js';
import { getEaserReadiness } from '../_easer-readiness.js';

function taxReadinessFromAccount(account) {
  if (!account) return { code: 'unknown', label: 'Unknown' };

  const req = account.requirements || {};
  const currentlyDue = Array.isArray(req.currently_due) ? req.currently_due : [];
  const pastDue = Array.isArray(req.past_due) ? req.past_due : [];
  const disabledReason = req.disabled_reason || null;
  const taxPattern = /(tax|tin|ssn|ein|w9|1099)/i;
  const hasTaxDue = currentlyDue.concat(pastDue).some(field => taxPattern.test(String(field || '')));

  if (!currentlyDue.length && !pastDue.length && account.payouts_enabled) {
    return { code: 'ready', label: 'Ready' };
  }
  if (hasTaxDue || (disabledReason && taxPattern.test(disabledReason))) {
    return { code: 'action_required', label: 'Action Required' };
  }
  if (!account.details_submitted) return { code: 'not_started', label: 'Not Started' };
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

  const connectRequired = isStripeConnectEnabled();
  let account = null;
  if (connectRequired && process.env.STRIPE_SECRET_KEY && profile.stripe_connect_account_id) {
    try {
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
      account = await stripe.accounts.retrieve(profile.stripe_connect_account_id);
      const updates = {
        stripe_connect_details_submitted: !!account.details_submitted,
        stripe_connect_charges_enabled: !!account.charges_enabled,
        stripe_connect_payouts_enabled: !!account.payouts_enabled,
        stripe_connect_onboarding_complete: !!(account.details_submitted && account.charges_enabled && account.payouts_enabled),
        stripe_connect_updated_at: new Date().toISOString(),
      };
      const { error: syncErr } = await sb.from('profiles').update(updates).eq('id', profile.id);
      if (syncErr) console.error('owner/easer-readiness profile sync error:', syncErr.message);
      Object.assign(profile, updates);
    } catch (err) {
      console.error('owner/easer-readiness stripe sync error:', err?.message || err);
    }
  }

  const readiness = await getEaserReadiness(profile, {
    connectRequired,
    stripeAccount: connectRequired ? account : null,
  });
  const w9Labels = {
    not_requested: 'W-9 Not Requested',
    requested: 'W-9 Requested',
    received: 'W-9 Received - Validation Pending',
    validated: 'W-9 Validated',
    not_required: 'W-9 Marked Not Required',
  };
  const w9Status = profile.w9_status || 'not_requested';
  const taxReadiness = connectRequired
    ? taxReadinessFromAccount(account)
    : { code: w9Status, label: w9Labels[w9Status] || 'W-9 Status Unknown' };
  const missingItems = [...readiness.missingItems];
  if (connectRequired && taxReadiness.code === 'action_required') {
    missingItems.push('Tax readiness status: Action Required');
  }

  return res.status(200).json({
    ok: true,
    readiness: {
      ...readiness,
      taxReadinessStatus: taxReadiness.label,
      w9Status,
      finalStatus: missingItems.length === 0 ? 'READY FOR JOBS' : 'ACTION REQUIRED',
      missingItems,
      checkedAt: new Date().toISOString(),
    },
  });
}
