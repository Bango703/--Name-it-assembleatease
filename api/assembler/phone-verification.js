import { createClient } from '@supabase/supabase-js';
import { getSupabase } from '../_supabase.js';
import { normalizeUsPhone, formatUsPhone } from '../_phone.js';
import { isSmsEnabled, sendSms } from '../_sms.js';
import {
  CODE_TTL_MS, newCode, hashCode, sendDecision, verifyDecision,
  consentAfterChange, phoneLookupVariants, samePhone, codeText,
} from '../_phone-verification.js';

/**
 * POST /api/assembler/phone-verification — an Easer changes their phone number.
 *
 *   { action: 'send', phone }  texts a 6-digit code to the new number
 *   { action: 'verify', code } saves the number once the code matches
 *
 * The number on file keeps getting texts until the code is entered. The Easer's
 * own session cannot write a different number (migration 109 trigger), so this
 * is the one way an Easer changes it, on the website and in the app alike.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  res.setHeader('Cache-Control', 'private, no-store');

  const authorization = String(req.headers?.authorization || '');
  if (!authorization.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  const authClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const { data: { user } = {}, error: authError } = await authClient.auth.getUser(authorization.slice(7));
  if (authError || !user) return res.status(401).json({ error: 'Invalid session' });

  const sb = getSupabase();
  const { data: profile, error: profileError } = await sb.from('profiles')
    .select('id, phone, sms_consent_at, sms_opted_out_at')
    .eq('id', user.id)
    .eq('role', 'assembler')
    .maybeSingle();
  if (profileError) {
    console.error('[phone-verification] profile lookup failed:', profileError.message);
    return res.status(503).json({ error: 'Your profile could not be loaded. Try again.' });
  }
  if (!profile) return res.status(403).json({ error: 'Easer access required' });

  const { data: pending, error: pendingError } = await sb.from('easer_phone_verifications')
    .select('easer_id, phone, code_hash, expires_at, attempts, send_count, window_started_at, last_sent_at')
    .eq('easer_id', user.id)
    .maybeSingle();
  if (pendingError) {
    console.error('[phone-verification] pending lookup failed:', pendingError.message);
    return res.status(503).json({ error: 'Phone number changes are unavailable right now. Try again later.' });
  }

  const action = req.body?.action;
  if (action === 'send') return sendCode(req, res, sb, profile, pending);
  if (action === 'verify') return verifyCode(req, res, sb, profile, pending);
  return res.status(400).json({ error: 'action must be send or verify' });
}

async function sendCode(req, res, sb, profile, pending) {
  const phone = normalizeUsPhone(req.body?.phone);
  if (!phone) return res.status(400).json({ error: 'Enter a 10-digit U.S. mobile number.' });
  if (samePhone(phone, profile.phone)) return res.status(400).json({ error: 'That is already your number.' });

  const taken = await numberOnAnotherAccount(sb, phone, profile.id);
  if (taken.error) return res.status(503).json({ error: 'Phone number changes are unavailable right now. Try again later.' });
  if (taken.found) return res.status(409).json({ error: 'That number is on another account. Contact AssembleAtEase.' });

  if (!isSmsEnabled()) {
    return res.status(503).json({ error: 'Codes cannot be texted right now. Contact AssembleAtEase to change your number.' });
  }

  // A different number starts over; the send limits still count.
  const decision = sendDecision(pending);
  if (!decision.ok) {
    if (decision.retryAfterSeconds) res.setHeader('Retry-After', String(decision.retryAfterSeconds));
    return res.status(decision.status).json({ error: decision.error, retryAfterSeconds: decision.retryAfterSeconds });
  }

  const code = newCode();
  const now = new Date();
  const { error: saveError } = await sb.from('easer_phone_verifications').upsert({
    easer_id: profile.id,
    phone,
    code_hash: hashCode(code),
    expires_at: new Date(now.getTime() + CODE_TTL_MS).toISOString(),
    attempts: 0,
    send_count: decision.sendCount,
    window_started_at: decision.windowStartedAt,
    last_sent_at: now.toISOString(),
  }, { onConflict: 'easer_id' });
  if (saveError) {
    console.error('[phone-verification] save failed:', saveError.message);
    return res.status(503).json({ error: 'The code could not be sent. Try again.' });
  }

  // Asking for the code is consent to this one text, so the recipient carries
  // the moment of asking. Job texts still follow the consent on the profile.
  const sent = await sendSms({
    recipient: { id: profile.id, phone, sms_consent_at: now.toISOString(), sms_opted_out_at: null },
    body: codeText(code),
    meta: { notificationType: 'easer_phone_verification', recipientType: 'easer', recipientUserId: profile.id },
  });
  if (!sent.ok) {
    console.error('[phone-verification] text not sent:', sent.error || sent.skipped);
    // A text that did not go is not held against the Easer's limits.
    const undo = pending
      ? sb.from('easer_phone_verifications').upsert(pending, { onConflict: 'easer_id' })
      : sb.from('easer_phone_verifications').delete().eq('easer_id', profile.id);
    const { error: undoError } = await undo;
    if (undoError) console.error('[phone-verification] pending row not restored:', undoError.message);
    return res.status(502).json({ error: 'The code could not be texted to that number. Check it and try again.' });
  }

  return res.status(200).json({
    ok: true,
    phone: formatUsPhone(phone),
    expiresInSeconds: CODE_TTL_MS / 1000,
  });
}

async function verifyCode(req, res, sb, profile, pending) {
  const decision = verifyDecision(pending, req.body?.code);
  if (!decision.ok) {
    if (decision.wrongCode) {
      await sb.from('easer_phone_verifications')
        .update({ attempts: Number(pending.attempts || 0) + 1 })
        .eq('easer_id', profile.id);
    }
    return res.status(decision.status).json({ error: decision.error });
  }

  // Checked again: the number may have been taken since the code was sent.
  const taken = await numberOnAnotherAccount(sb, pending.phone, profile.id);
  if (taken.error) return res.status(503).json({ error: 'Your number could not be saved. Try again.' });
  if (taken.found) return res.status(409).json({ error: 'That number is on another account. Contact AssembleAtEase.' });

  const { data: saved, error: saveError } = await sb.from('profiles')
    .update({ phone: pending.phone, ...consentAfterChange(profile) })
    .eq('id', profile.id)
    .eq('role', 'assembler')
    .select('id, phone')
    .maybeSingle();
  if (saveError || !saved) {
    console.error('[phone-verification] phone save failed:', saveError?.message);
    return res.status(503).json({ error: 'Your number could not be saved. Try again.' });
  }

  const { error: clearError } = await sb.from('easer_phone_verifications').delete().eq('easer_id', profile.id);
  if (clearError) console.error('[phone-verification] pending row not cleared:', clearError.message);

  return res.status(200).json({ ok: true, phone: saved.phone });
}

async function numberOnAnotherAccount(sb, phone, easerId) {
  const variants = phoneLookupVariants(phone);
  const { data, error } = await sb.from('profiles')
    .select('id')
    .in('phone', variants)
    .neq('id', easerId)
    .limit(1);
  if (error) {
    console.error('[phone-verification] duplicate check failed:', error.message);
    return { error: true };
  }
  return { found: (data || []).length > 0 };
}
