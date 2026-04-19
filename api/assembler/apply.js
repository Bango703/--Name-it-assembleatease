import Stripe from 'stripe';
import { getSupabase } from '../_supabase.js';
import { sendEmail, ownerEmail, esc } from '../_email.js';
import { rateLimit } from '../_ratelimit.js';

const LOGO = 'https://www.assembleatease.com/images/logo.jpg';
const SITE = 'https://www.assembleatease.com';

const VALID_SERVICES = [
  'Furniture Assembly',
  'TV & Display Mounting',
  'Smart Home Installation',
  'Home Repairs',
  'Junk Removal',
];

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
  if (!rateLimit(ip, 3, 300000)) return res.status(429).json({ error: 'Too many requests. Please try again later.' });

  const {
    fullName, email, password, city, zip,
    servicesOffered, hasTools, hasTransport,
    yearsExperience, bio, codeOfConduct, inviteToken,
    paymentMethodId,
  } = req.body;

  // â”€â”€ Validation â”€â”€
  if (!fullName?.trim()) return res.status(400).json({ error: 'Full name is required' });
  if (!email?.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Valid email is required' });
  if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (!city?.trim()) return res.status(400).json({ error: 'City is required' });
  if (!zip?.trim()) return res.status(400).json({ error: 'Zip code is required' });
  if (!Array.isArray(servicesOffered) || !servicesOffered.length) return res.status(400).json({ error: 'Select at least one service' });
  const validServices = servicesOffered.filter(s => VALID_SERVICES.includes(s));
  if (!validServices.length) return res.status(400).json({ error: 'Invalid service selection' });
  if (typeof hasTools !== 'boolean') return res.status(400).json({ error: 'Tools question is required' });
  if (typeof hasTransport !== 'boolean') return res.status(400).json({ error: 'Transportation question is required' });
  if (!yearsExperience || yearsExperience < 0) return res.status(400).json({ error: 'Years of experience is required' });
  if (!codeOfConduct) return res.status(400).json({ error: 'You must agree to the code of conduct' });
  if (!paymentMethodId) return res.status(400).json({ error: 'Payment is required to submit your application' });

  const sb = getSupabase();
  const cleanName = fullName.trim();
  const cleanEmail = email.trim().toLowerCase();

  // â”€â”€ Create Supabase auth user â”€â”€
  const { data: authData, error: authError } = await sb.auth.admin.createUser({
    email: cleanEmail,
    password,
    email_confirm: true,
    user_metadata: { role: 'assembler', full_name: cleanName },
  });

  if (authError) {
    console.error('Auth create error:', authError);
    if (authError.message?.includes('already')) {
      return res.status(409).json({ error: 'An account with this email already exists. Please log in instead.' });
    }
    return res.status(500).json({ error: 'Failed to create account' });
  }

  const userId = authData.user.id;

  // â”€â”€ Upsert profile (core fields first, then assembler-specific) â”€â”€
  const coreProfile = {
    id: userId,
    full_name: cleanName,
    email: cleanEmail,
    role: 'assembler',
    city: city.trim(),
    zip: zip.trim(),
  };

  let { error: profileError } = await sb.from('profiles').upsert(coreProfile, { onConflict: 'id' });

  if (profileError) {
    console.error('Profile upsert error:', JSON.stringify(profileError));
    return res.status(500).json({ error: 'Failed to save application. ' + (profileError.message || '') });
  }

  // Assembler-specific columns â€” may not exist in schema yet, non-blocking
  const { error: extError } = await sb.from('profiles').update({
    services_offered: validServices,
    has_tools: hasTools,
    has_transport: hasTransport,
    years_experience: parseInt(yearsExperience, 10),
    bio: bio?.trim() || null,
    tier: 'pending',
    identity_verified: false,
    code_of_conduct_agreed_at: new Date().toISOString(),
  }).eq('id', userId);
  if (extError) console.warn('Assembler columns update skipped:', extError.message);

  // â”€â”€ If invite token, validate and update waitlist â”€â”€
  if (inviteToken) {
    try {
      const { data: wlEntry } = await sb
        .from('assembler_waitlist')
        .select('id, status, invite_expires_at')
        .eq('invite_token', inviteToken)
        .maybeSingle();

      if (wlEntry && wlEntry.status === 'invited') {
        const expired = wlEntry.invite_expires_at && new Date(wlEntry.invite_expires_at) < new Date();
        if (!expired) {
          await sb.from('assembler_waitlist')
            .update({ status: 'applied', applied_at: new Date().toISOString() })
            .eq('id', wlEntry.id);
        }
      }
    } catch (wlErr) {
      console.error('Waitlist token update error:', wlErr);
      // Non-blocking â€” application still proceeds
    }
  }

  // â”€â”€ Stripe: charge $30 application fee + create Identity session â”€â”€
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  let verificationUrl = null;
  let paymentIntentId = null;
  let stripeCustomerId = null;
  let verificationSessionId = null;

  try {
    // Create Stripe customer
    const customer = await stripe.customers.create({
      email: cleanEmail,
      name: cleanName,
      metadata: { userId, role: 'assembler' },
    });
    stripeCustomerId = customer.id;

    // Charge $30 application fee
    const paymentIntent = await stripe.paymentIntents.create({
      amount: 3000,
      currency: 'usd',
      customer: customer.id,
      payment_method: paymentMethodId,
      confirm: true,
      metadata: { userId, type: 'assembler_application_fee' },
      description: 'AssembleAtEase Assembler Application Fee',
      receipt_email: cleanEmail,
      automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
    });

    if (paymentIntent.status !== 'succeeded') {
      await sb.auth.admin.deleteUser(userId).catch(() => {});
      return res.status(402).json({ error: 'Payment failed. Please check your card details and try again.' });
    }

    paymentIntentId = paymentIntent.id;

    // Create Stripe Identity verification session
    const verificationSession = await stripe.identity.verificationSessions.create({
      type: 'document',
      options: {
        document: {
          require_live_capture: true,
          require_matching_selfie: true,
          allowed_types: ['driving_license', 'id_card', 'passport'],
        },
      },
      metadata: { userId },
      return_url: `${SITE}/assembler/apply?verification=complete`,
    });

    verificationUrl = verificationSession.url;
    verificationSessionId = verificationSession.id;

    // Persist Stripe data to profile (non-blocking on failure)
    await sb.from('profiles').update({
      stripe_customer_id: stripeCustomerId,
      stripe_payment_intent_id: paymentIntentId,
      stripe_verification_id: verificationSessionId,
      payment_confirmed: true,
      application_fee_paid: true,
    }).eq('id', userId);

  } catch (stripeErr) {
    console.error('Stripe error:', stripeErr);
    if (!paymentIntentId) {
      // Payment itself failed â€” clean up auth user
      await sb.auth.admin.deleteUser(userId).catch(() => {});
      const msg = stripeErr?.raw?.message || stripeErr?.message || 'Payment failed. Please check your card details.';
      return res.status(402).json({ error: msg });
    }
    // Payment succeeded but identity setup failed â€” still proceed
    console.warn('Stripe Identity session creation failed after payment â€” proceeding without verification URL');
  }

  // â”€â”€ Send owner notification â”€â”€
  try {
    const servicesList = validServices.map(s => `<li style="padding:3px 0">${esc(s)}</li>`).join('');
    await sendEmail({
      to: ownerEmail(),
      from: 'AssembleAtEase <booking@assembleatease.com>',
      replyTo: cleanEmail,
      subject: 'New Assembler Application â€” ' + cleanName,
      html: buildOwnerEmail({ cleanName, cleanEmail, city, zip, yearsExperience, hasTools, hasTransport, bio, servicesList, paymentIntentId }),
    });
  } catch (e) { console.error('Owner email error:', e); }

  // â”€â”€ Send applicant confirmation â”€â”€
  try {
    await sendEmail({
      to: cleanEmail,
      from: 'AssembleAtEase <booking@assembleatease.com>',
      subject: 'Application Received â€” AssembleAtEase',
      html: buildApplicantEmail(cleanName.split(' ')[0]),
      replyTo: ownerEmail(),
    });
  } catch (e) { console.error('Applicant email error:', e); }

  return res.status(200).json({ success: true, verificationUrl });
}

function buildOwnerEmail({ cleanName, cleanEmail, city, zip, yearsExperience, hasTools, hasTransport, bio, servicesList, paymentIntentId }) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1a1a1a">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px 8px 0 0;border-bottom:3px solid #0097a7"><tr><td style="padding:20px 24px">
    <table cellpadding="0" cellspacing="0"><tr>
      <td><img src="${LOGO}" alt="AssembleAtEase" width="36" height="36" style="border-radius:50%;display:block"/></td>
      <td style="padding-left:12px;font-size:16px;font-weight:700;color:#1a1a1a">AssembleAtEase</td>
    </tr></table>
  </td><td style="padding:20px 24px;text-align:right;font-size:12px;color:#71717a">New Application</td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-left:1px solid #e4e4e7;border-right:1px solid #e4e4e7"><tr><td style="padding:28px 24px">
    <p style="margin:0 0 4px;font-size:20px;font-weight:700;color:#1a1a1a">New Assembler Application</p>
    <p style="margin:0 0 20px;font-size:13px;color:#71717a">${esc(cleanName)} wants to join the team</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="font-size:14px">
      <tr><td style="padding:8px 0;border-bottom:1px solid #f0f0f0;color:#71717a;width:140px">Name</td><td style="padding:8px 0;border-bottom:1px solid #f0f0f0;font-weight:600">${esc(cleanName)}</td></tr>
      <tr><td style="padding:8px 0;border-bottom:1px solid #f0f0f0;color:#71717a">Email</td><td style="padding:8px 0;border-bottom:1px solid #f0f0f0">${esc(cleanEmail)}</td></tr>
      <tr><td style="padding:8px 0;border-bottom:1px solid #f0f0f0;color:#71717a">Location</td><td style="padding:8px 0;border-bottom:1px solid #f0f0f0">${esc(city.trim())}, ${esc(zip.trim())}</td></tr>
      <tr><td style="padding:8px 0;border-bottom:1px solid #f0f0f0;color:#71717a">Experience</td><td style="padding:8px 0;border-bottom:1px solid #f0f0f0">${parseInt(yearsExperience,10)} year(s)</td></tr>
      <tr><td style="padding:8px 0;border-bottom:1px solid #f0f0f0;color:#71717a">Own tools</td><td style="padding:8px 0;border-bottom:1px solid #f0f0f0">${hasTools ? 'Yes' : 'No'}</td></tr>
      <tr><td style="padding:8px 0;border-bottom:1px solid #f0f0f0;color:#71717a">Transportation</td><td style="padding:8px 0;border-bottom:1px solid #f0f0f0">${hasTransport ? 'Yes' : 'No'}</td></tr>
      <tr><td style="padding:8px 0;border-bottom:1px solid #f0f0f0;color:#71717a;vertical-align:top">Services</td><td style="padding:8px 0;border-bottom:1px solid #f0f0f0"><ul style="margin:0;padding-left:16px">${servicesList}</ul></td></tr>
      <tr><td style="padding:8px 0;color:#71717a;vertical-align:top">About</td><td style="padding:8px 0">${esc(bio?.trim() || 'Not provided')}</td></tr>
    </table>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px"><tr><td style="padding:14px 18px">
      <p style="margin:0;font-size:13px;color:#166534;font-weight:600">&#10003; $30 application fee paid &bull; Stripe Identity verification initiated</p>
      ${paymentIntentId ? `<p style="margin:4px 0 0;font-size:12px;color:#15803d">Payment Intent: ${esc(paymentIntentId)}</p>` : ''}
    </td></tr></table>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-top:none;border-radius:0 0 8px 8px"><tr><td style="padding:16px 24px;text-align:center;font-size:11px;color:#a1a1aa">
    AssembleAtEase &bull; Austin, TX
  </td></tr></table>
</div></body></html>`;
}

function buildApplicantEmail(firstName) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1a1a1a">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px 8px 0 0;border-bottom:1px solid #e4e4e7"><tr><td style="padding:20px 24px;text-align:center">
    <img src="${LOGO}" alt="AssembleAtEase" width="44" height="44" style="border-radius:50%;display:inline-block"/>
    <p style="margin:8px 0 0;font-size:17px;font-weight:700;color:#1a1a1a">AssembleAtEase</p>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-left:1px solid #e4e4e7;border-right:1px solid #e4e4e7"><tr><td style="padding:32px 24px 24px">
    <p style="margin:0 0 8px;font-size:24px;font-weight:700;color:#1a1a1a">Application received, ${esc(firstName)}!</p>
    <p style="margin:0 0 16px;font-size:14px;color:#52525b;line-height:1.6">Thank you for applying to join the AssembleAtEase team. Your $30 application fee has been received.</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;margin-bottom:20px"><tr><td style="padding:14px 18px;text-align:center">
      <p style="margin:0;font-size:13px;color:#166534;font-weight:600">&#10003; Payment confirmed &bull; &#10003; Application submitted</p>
    </td></tr></table>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-radius:6px"><tr><td style="padding:18px 20px">
      <p style="margin:0 0 4px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:#71717a">What happens next</p>
      <ol style="margin:8px 0 0;padding-left:16px;font-size:14px;color:#52525b;line-height:1.8">
        <li>Complete your identity verification (link provided after payment)</li>
        <li>Our team reviews your application</li>
        <li>Once approved, you will start receiving job assignments</li>
      </ol>
    </td></tr></table>
    <p style="margin:20px 0 0;font-size:13px;color:#52525b;line-height:1.6">Questions? Email <a href="mailto:service@assembleatease.com" style="color:#0097a7;text-decoration:none">service@assembleatease.com</a>.</p>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-top:none;border-radius:0 0 8px 8px"><tr><td style="padding:16px 24px;text-align:center;font-size:11px;color:#a1a1aa">
    AssembleAtEase &bull; Austin, TX &bull; <a href="mailto:service@assembleatease.com" style="color:#71717a">service@assembleatease.com</a>
  </td></tr></table>
</div></body></html>`;
}
