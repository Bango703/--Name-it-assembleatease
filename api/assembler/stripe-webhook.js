import Stripe from 'stripe';
import { getSupabase } from '../_supabase.js';
import { sendEmail, ownerEmail, esc } from '../_email.js';

const LOGO = 'https://www.assembleatease.com/images/logo.jpg';

// Vercel: disable body parser so we can verify webhook signature
export const config = { api: { bodyParser: false } };

/**
 * POST /api/assembler/stripe-webhook
 * Handles Stripe Identity and PaymentIntent webhook events.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!sig || !webhookSecret) {
    return res.status(400).json({ error: 'Missing Stripe signature or webhook secret' });
  }

  // Read raw body for signature verification
  const rawBody = await new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  let event;

  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err) {
    console.error('Stripe webhook signature verification failed:', err.message);
    return res.status(400).json({ error: 'Invalid Stripe webhook signature' });
  }

  const sb = getSupabase();

  try {
    switch (event.type) {
      // ── Identity: verification completed successfully ──
      case 'identity.verification_session.verified': {
        const session = event.data.object;
        const userId = session.metadata?.userId;
        if (!userId) { console.warn('No userId in verified session metadata'); break; }

        await sb.from('profiles').update({
          identity_verified: true,
          identity_verified_at: new Date().toISOString(),
        }).eq('id', userId);

        // Notify owner
        const { data: profile } = await sb.from('profiles')
          .select('full_name, email')
          .eq('id', userId)
          .maybeSingle();

        if (profile) {
          try {
            await sendEmail({
              to: ownerEmail(),
              from: 'AssembleAtEase <booking@assembleatease.com>',
              subject: `Identity Verified — ${esc(profile.full_name)}`,
              html: buildVerifiedEmail(profile.full_name, profile.email, 'verified'),
            });
          } catch (e) { console.error('Owner verified email error:', e); }
        }
        break;
      }

      // ── Identity: verification requires additional input (failed/expired) ──
      case 'identity.verification_session.requires_input': {
        const session = event.data.object;
        const userId = session.metadata?.userId;
        if (!userId) { console.warn('No userId in requires_input session metadata'); break; }

        await sb.from('profiles').update({
          identity_verified: false,
        }).eq('id', userId);

        // Notify both owner and assembler
        const { data: profile } = await sb.from('profiles')
          .select('full_name, email')
          .eq('id', userId)
          .maybeSingle();

        if (profile) {
          const lastError = session.last_error?.reason || 'verification could not be completed';
          try {
            await sendEmail({
              to: ownerEmail(),
              from: 'AssembleAtEase <booking@assembleatease.com>',
              subject: `Identity Verification Failed — ${esc(profile.full_name)}`,
              html: buildVerifiedEmail(profile.full_name, profile.email, 'failed', lastError),
            });
          } catch (e) { console.error('Owner failed email error:', e); }

          try {
            await sendEmail({
              to: profile.email,
              from: 'AssembleAtEase <booking@assembleatease.com>',
              subject: 'Action Required — Identity Verification',
              html: buildAssemblerFailEmail(profile.full_name.split(' ')[0], lastError),
              replyTo: ownerEmail(),
            });
          } catch (e) { console.error('Assembler failed email error:', e); }
        }
        break;
      }

      // ── Payment: succeeded (belt-and-suspenders sync) ──
      case 'payment_intent.succeeded': {
        const pi = event.data.object;
        const userId = pi.metadata?.userId;
        if (userId && pi.metadata?.type === 'assembler_application_fee') {
          await sb.from('profiles').update({
            payment_confirmed: true,
            application_fee_paid: true,
          }).eq('id', userId);
        }
        break;
      }

      // ── Payment: failed ──
      case 'payment_intent.payment_failed': {
        const pi = event.data.object;
        const userId = pi.metadata?.userId;
        if (!userId || pi.metadata?.type !== 'assembler_application_fee') break;

        const { data: profile } = await sb.from('profiles')
          .select('full_name, email')
          .eq('id', userId)
          .maybeSingle();

        if (profile) {
          const reason = pi.last_payment_error?.message || 'Your payment could not be processed.';
          try {
            await sendEmail({
              to: profile.email,
              from: 'AssembleAtEase <booking@assembleatease.com>',
              subject: 'Payment Failed — AssembleAtEase Application',
              html: buildPaymentFailEmail(profile.full_name.split(' ')[0], reason),
              replyTo: ownerEmail(),
            });
          } catch (e) { console.error('Payment failed email error:', e); }
        }
        break;
      }

      default:
        // Unhandled event type — ignore silently
        break;
    }
  } catch (err) {
    console.error('Stripe webhook handler error:', err);
    // Still return 200 to prevent Stripe retries for logic errors
    return res.status(200).json({ received: true, warning: 'Handler error logged' });
  }

  return res.status(200).json({ received: true });
}

function buildVerifiedEmail(fullName, email, status, reason = '') {
  const isVerified = status === 'verified';
  const bgColor = isVerified ? '#f0fdf4' : '#fef2f2';
  const borderColor = isVerified ? '#bbf7d0' : '#fecaca';
  const textColor = isVerified ? '#166534' : '#991b1b';
  const headline = isVerified
    ? `${esc(fullName)} — Identity Verified ✓`
    : `${esc(fullName)} — Identity Verification Failed`;
  const detail = isVerified
    ? 'The assembler has successfully completed identity verification and is ready for approval.'
    : `Verification could not be completed. Reason: ${esc(reason)}`;

  return `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif">
<div style="max-width:520px;margin:0 auto;padding:24px 16px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;border:1px solid #e4e4e7"><tr><td style="padding:24px">
    <table cellpadding="0" cellspacing="0"><tr>
      <td><img src="${LOGO}" alt="AssembleAtEase" width="32" height="32" style="border-radius:50%"/></td>
      <td style="padding-left:10px;font-size:15px;font-weight:700;color:#1a1a1a">AssembleAtEase</td>
    </tr></table>
    <p style="margin:16px 0 4px;font-size:17px;font-weight:700;color:#1a1a1a">${headline}</p>
    <p style="margin:0 0 16px;font-size:13px;color:#52525b">${esc(email)}</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:${bgColor};border:1px solid ${borderColor};border-radius:6px"><tr>
      <td style="padding:12px 16px;font-size:13px;color:${textColor}">${detail}</td>
    </tr></table>
  </td></tr></table>
</div></body></html>`;
}

function buildAssemblerFailEmail(firstName, reason) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif">
<div style="max-width:520px;margin:0 auto;padding:24px 16px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;border:1px solid #e4e4e7"><tr><td style="padding:28px 24px">
    <p style="margin:0 0 12px;font-size:20px;font-weight:700;color:#1a1a1a">Action required, ${esc(firstName)}</p>
    <p style="margin:0 0 16px;font-size:14px;color:#52525b;line-height:1.6">Your identity verification could not be completed. Reason: <strong>${esc(reason)}</strong></p>
    <p style="margin:0 0 16px;font-size:14px;color:#52525b;line-height:1.6">Please contact us at <a href="mailto:service@assembleatease.com" style="color:#0097a7">service@assembleatease.com</a> to resolve this.</p>
  </td></tr></table>
</div></body></html>`;
}

function buildPaymentFailEmail(firstName, reason) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif">
<div style="max-width:520px;margin:0 auto;padding:24px 16px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;border:1px solid #e4e4e7"><tr><td style="padding:28px 24px">
    <p style="margin:0 0 12px;font-size:20px;font-weight:700;color:#1a1a1a">Payment issue, ${esc(firstName)}</p>
    <p style="margin:0 0 16px;font-size:14px;color:#52525b;line-height:1.6">We were unable to process your $30 application fee. Reason: <strong>${esc(reason)}</strong></p>
    <p style="margin:0 0 0;font-size:14px;color:#52525b;line-height:1.6">Please contact us at <a href="mailto:service@assembleatease.com" style="color:#0097a7">service@assembleatease.com</a> to retry.</p>
  </td></tr></table>
</div></body></html>`;
}
