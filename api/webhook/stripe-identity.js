import Stripe from 'stripe';
import { getSupabase } from '../_supabase.js';
import { sendEmail, ownerEmail, esc } from '../_email.js';

/**
 * POST /api/webhook/stripe-identity
 * Handles Stripe Identity verification session webhooks.
 * Auto-updates id_verified, id_verification_status on profiles.
 *
 * Events handled:
 *   identity.verification_session.verified   → id_verified=true
 *   identity.verification_session.requires_input → id_verification_status=failed
 *   identity.verification_session.processing → id_verification_status=pending (no change)
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_IDENTITY_WEBHOOK_SECRET;

  if (!webhookSecret) {
    console.warn('STRIPE_IDENTITY_WEBHOOK_SECRET not set — webhook not validated');
    return res.status(500).json({ error: 'Webhook secret not configured' });
  }

  let event;
  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    // req.body must be the raw buffer — Vercel provides it as Buffer when content-type is application/json
    const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch(err) {
    console.error('Stripe Identity webhook signature error:', err.message);
    return res.status(400).json({ error: `Webhook signature verification failed: ${err.message}` });
  }

  const sb = getSupabase();
  const session = event.data.object;

  // Find the Easer by their stripe_identity_session_id or stripe_verification_id
  const { data: profile } = await sb
    .from('profiles')
    .select('id, full_name, email, status, tier, id_verification_status')
    .or(`stripe_identity_session_id.eq.${session.id},stripe_verification_id.eq.${session.id}`)
    .eq('role', 'assembler')
    .maybeSingle();

  if (!profile) {
    // Session not linked to an Easer — log and return 200 (Stripe expects 200 ACK)
    console.warn('Stripe Identity webhook: no Easer found for session', session.id);
    return res.status(200).json({ received: true, note: 'No matching Easer found' });
  }

  if (event.type === 'identity.verification_session.verified') {
    // Identity verification passed
    await sb.from('profiles').update({
      identity_verified: true,
      identity_verified_at: new Date().toISOString(),
      id_verification_status: 'verified',
      stripe_identity_session_id: session.id,
    }).eq('id', profile.id);

    // Notify owner to approve the applicant
    sendEmail({
      to: ownerEmail(),
      from: 'AssembleAtEase <booking@assembleatease.com>',
      subject: `ID Verified — ${esc(profile.full_name)} is ready to approve`,
      html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:2rem">
        <h2 style="color:#0097a7">Easer ID Verified</h2>
        <p><strong>${esc(profile.full_name)}</strong> (${esc(profile.email)}) has successfully completed Stripe Identity verification.</p>
        <p>Their account status is <strong>${esc(profile.status || 'pending')}</strong>. You can now approve their application.</p>
        <p><a href="https://www.assembleatease.com/owner/" style="color:#0097a7">Open Owner Dashboard to Approve</a></p>
      </div>`,
    }).catch(e => console.error('ID verified owner email error:', e));

    console.log('Stripe Identity: verified for', profile.full_name, profile.id);

  } else if (event.type === 'identity.verification_session.requires_input') {
    // Verification failed or needs more info
    const failureCode = session.last_error?.code || 'unknown';
    const failureReason = session.last_error?.reason || 'Verification could not be completed';

    await sb.from('profiles').update({
      id_verification_status: 'failed',
      stripe_identity_session_id: session.id,
    }).eq('id', profile.id);

    // Notify owner
    sendEmail({
      to: ownerEmail(),
      from: 'AssembleAtEase <booking@assembleatease.com>',
      subject: `ID Verification Failed — ${esc(profile.full_name)}`,
      html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:2rem">
        <h2 style="color:#dc2626">ID Verification Failed</h2>
        <p><strong>${esc(profile.full_name)}</strong> (${esc(profile.email)}) failed Stripe Identity verification.</p>
        <p><strong>Code:</strong> ${esc(failureCode)}<br><strong>Reason:</strong> ${esc(failureReason)}</p>
        <p>Review their application in the <a href="https://www.assembleatease.com/owner/" style="color:#0097a7">owner dashboard</a> and decide whether to reject or request re-verification.</p>
      </div>`,
    }).catch(e => console.error('ID failed owner email error:', e));

    console.log('Stripe Identity: failed for', profile.full_name, failureCode);

  } else if (event.type === 'identity.verification_session.processing') {
    // Still processing — update session ID if not set
    await sb.from('profiles').update({
      stripe_identity_session_id: session.id,
      id_verification_status: 'pending',
    }).eq('id', profile.id);

    console.log('Stripe Identity: processing for', profile.full_name);
  }

  return res.status(200).json({ received: true, event: event.type, profileId: profile.id });
}
