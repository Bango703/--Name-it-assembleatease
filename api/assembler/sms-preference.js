import { createClient } from '@supabase/supabase-js';
import { getSupabase } from '../_supabase.js';

/**
 * GET/POST /api/assembler/sms-preference — an Easer's own job-text consent.
 *
 * Until now the ONLY place an Easer's SMS consent could be recorded was the
 * optional checkbox on the application form (api/assembler/apply.js). Anyone
 * already approved who skipped that box had no way to turn job texts on, ever:
 * api/_sms.js refuses to send without `sms_consent_at`, and nothing on the
 * dashboard could set it. On 2026-09-08 that was two of four active Easers,
 * including one doing real, paid work.
 *
 * Writing that timestamp on their behalf is not an option. TCPA consent has to
 * come from the person, which is exactly why apply.js takes it from a ticked box
 * and never from the presence of a phone number. This endpoint is the missing
 * consent surface: the Easer asks, the server timestamps it.
 *
 * Opting out here mirrors what a carrier STOP does, so the two cannot disagree —
 * `sms_opted_out_at` is what smsEligibility() checks first, and the inbound
 * webhook writes the same column when someone texts STOP.
 */
export default async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  res.setHeader('Cache-Control', 'private, no-store');

  const authorization = String(req.headers?.authorization || '');
  if (!authorization.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });

  const authClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const { data: { user } = {}, error: authError } = await authClient.auth.getUser(authorization.slice(7));
  if (authError || !user) return res.status(401).json({ error: 'Invalid session' });

  const sb = getSupabase();
  // Scoped to the caller's own row. An Easer can only ever change their own
  // consent, so there is no id in the request to tamper with.
  const { data: profile, error: profileError } = await sb.from('profiles')
    .select('id, phone, sms_consent_at, sms_consent_source, sms_opted_out_at')
    .eq('id', user.id)
    .eq('role', 'assembler')
    .maybeSingle();

  if (profileError) {
    console.error('[sms-preference] Profile lookup failed:', profileError.message || profileError);
    return res.status(503).json({ error: 'Your text-message setting could not be loaded. Please try again.' });
  }
  if (!profile) return res.status(403).json({ error: 'Easer access required' });

  const state = row => ({
    enabled: Boolean(row.sms_consent_at) && !row.sms_opted_out_at,
    hasPhone: Boolean(String(row.phone || '').trim()),
    // Surfaced so the page can explain a carrier-level STOP, which the Easer
    // may not remember sending and which we cannot undo for them silently.
    optedOut: Boolean(row.sms_opted_out_at),
  });

  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, ...state(profile) });
  }

  const enable = req.body?.enabled;
  if (typeof enable !== 'boolean') {
    return res.status(400).json({ error: 'enabled must be true or false' });
  }

  if (enable && !String(profile.phone || '').trim()) {
    return res.status(400).json({
      error: 'Add a mobile number to your profile before turning on job texts.',
      code: 'NO_PHONE_ON_FILE',
    });
  }

  // Consent is a server timestamp. The browser never supplies one, matching how
  // the application form records it.
  const now = new Date().toISOString();
  const update = enable
    ? { sms_consent_at: now, sms_consent_source: 'easer_dashboard', sms_opted_out_at: null, sms_opt_out_keyword: null }
    : { sms_opted_out_at: now };

  const { data: updated, error: updateError } = await sb.from('profiles')
    .update(update)
    .eq('id', user.id)
    .eq('role', 'assembler')
    .select('id, phone, sms_consent_at, sms_consent_source, sms_opted_out_at')
    .maybeSingle();

  if (updateError || !updated) {
    console.error('[sms-preference] Update failed:', updateError?.message || updateError);
    return res.status(503).json({ error: 'Your text-message setting could not be saved. Please try again.' });
  }

  return res.status(200).json({ ok: true, ...state(updated) });
}
