import Stripe from 'stripe';
import { randomUUID } from 'crypto';
import { getSupabase } from '../_supabase.js';
import { sendEmail, ownerEmail, esc } from '../_email.js';
import { rateLimit } from '../_ratelimit.js';

const LOGO = 'https://www.assembleatease.com/images/logo.jpg';
const SITE = 'https://www.assembleatease.com';

const VALID_SERVICES = [
  'Furniture Assembly',
  'TV & Display Mounting',
  'Smart Home Installation',
  'Fitness Equipment',
  'Outdoor & Playsets',
  'Office Assembly',
];

const FOUNDING_EASER_FREE_APPLICATION_LIMIT = parseInt(process.env.FOUNDING_EASER_FREE_APPLICATION_LIMIT || '20', 10);
const CONTRACTOR_AGREEMENT_VERSION = '2026-06-08';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
  if (!await rateLimit(ip, 'apply')) return res.status(429).json({ error: 'Too many requests. Please try again later.' });

  const {
    fullName, email, phone, city, zip,
    servicesOffered, hasTools, hasTransport,
    yearsExperience, bio, codeOfConduct, inviteToken,
    paymentMethodId,
    contractorAgreementSigned,
  } = req.body;

  // ---- Validation ----
  if (!fullName?.trim()) return res.status(400).json({ error: 'Full name is required' });
  if (!email?.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Valid email is required' });
  if (!phone?.trim() || !/^\+?[\d\s().-]{7,}$/.test(phone.trim())) return res.status(400).json({ error: 'Valid phone number is required' });
  if (!city?.trim()) return res.status(400).json({ error: 'City is required' });
  if (!zip?.trim()) return res.status(400).json({ error: 'Zip code is required' });
  if (!Array.isArray(servicesOffered) || !servicesOffered.length) return res.status(400).json({ error: 'Select at least one service' });
  const validServices = servicesOffered.filter(s => VALID_SERVICES.includes(s));
  if (!validServices.length) return res.status(400).json({ error: 'Invalid service selection' });
  if (typeof hasTools !== 'boolean') return res.status(400).json({ error: 'Tools question is required' });
  if (typeof hasTransport !== 'boolean') return res.status(400).json({ error: 'Transportation question is required' });
  if (!yearsExperience || yearsExperience < 0) return res.status(400).json({ error: 'Years of experience is required' });
  if (!codeOfConduct) return res.status(400).json({ error: 'You must agree to the code of conduct' });
  if (!contractorAgreementSigned) return res.status(400).json({ error: 'You must read and sign the Independent Contractor Agreement' });

  const sb = getSupabase();
  const foundingApplication = await getFoundingApplicationStatus(sb);
  if (!foundingApplication.feeWaived && !paymentMethodId) {
    return res.status(400).json({ error: 'Payment is required to submit your application' });
  }

  const cleanName = fullName.trim();
  const cleanEmail = email.trim().toLowerCase();
  const cleanPhone = phone.trim();
  const agreementIp = getClientIp(req);
  const agreementUserAgent = String(req.headers['user-agent'] || '').slice(0, 500);

  // Generate a random temporary password — assembler sets their real password via the approval email link
  const tempPassword = randomUUID() + randomUUID();

  // ── Create Supabase auth user ──
  const { data: authData, error: authError } = await sb.auth.admin.createUser({
    email: cleanEmail,
    password: tempPassword,
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

  // ---- Upsert profile (core fields first, then assembler-specific) ----
  const coreProfile = {
    id: userId,
    full_name: cleanName,
    email: cleanEmail,
    phone: cleanPhone,
    role: 'assembler',
    city: city.trim(),
    zip: zip.trim(),
  };

  let { error: profileError } = await sb.from('profiles').upsert(coreProfile, { onConflict: 'id' });

  if (profileError) {
    console.error('Profile upsert error:', JSON.stringify(profileError));
    return res.status(500).json({ error: 'Failed to save application. ' + (profileError.message || '') });
  }

  // Assembler-specific columns — all known-good after migration 018
  const { error: extError } = await sb.from('profiles').update({
    services_offered: validServices,
    has_tools: hasTools,
    has_transport: hasTransport,
    years_experience: parseInt(yearsExperience, 10),
    bio: bio?.trim() || null,
    tier: 'pending',
    identity_verified: false,
    application_status: 'applied',
  }).eq('id', userId);
  if (extError) {
    console.error('Assembler core columns update failed:', extError.message);
    return res.status(500).json({ error: 'Failed to save application details. Please try again.' });
  }

  // Agreement timestamps — added in migration 019; isolated so a schema gap fails
  // only this block and doesn't suppress the core application write above.
  const agreementTs = new Date().toISOString();
  const { error: agreementErr } = await sb.from('profiles').update({
    code_of_conduct_agreed_at: agreementTs,
    contractor_agreement_signed_at: agreementTs,
    contractor_agreement_version: CONTRACTOR_AGREEMENT_VERSION,
    contractor_agreement_ip: agreementIp,
    contractor_agreement_user_agent: agreementUserAgent,
    contractor_agreement_signed_name: cleanName,
  }).eq('id', userId);
  if (agreementErr) {
    // This only fails if migration 019 hasn't been run yet. Log prominently.
    console.error('Agreement timestamp columns missing — run migration 019:', agreementErr.message);
  }

  // Founding Easer launch columns are additive; keep them separate so older schemas
  // still save the core application fields before migration 018 is applied.
  const { error: foundingErr } = await sb.from('profiles').update({
    application_fee_waived: foundingApplication.feeWaived,
    founding_easer: foundingApplication.feeWaived,
    founding_easer_number: foundingApplication.foundingNumber,
  }).eq('id', userId);
  if (foundingErr) console.warn('Founding Easer columns update skipped:', foundingErr.message);

  // ---- If invite token, validate and update waitlist ----
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
      // Non-blocking - application still proceeds
    }
  }

  // ---- Stripe: optionally charge application fee + create Identity session ----
  const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
  let verificationUrl = null;
  let paymentIntentId = null;
  let stripeCustomerId = null;
  let verificationSessionId = null;

  if (!stripe && !foundingApplication.feeWaived) {
    await sb.auth.admin.deleteUser(userId).catch(() => {});
    return res.status(500).json({ error: 'Payment processing is not configured. Please try again later.' });
  }

  try {
    if (!stripe) throw new Error('Stripe is not configured; skipping Identity session for founding application.');

    // Create Stripe customer
    const customer = await stripe.customers.create({
      email: cleanEmail,
      name: cleanName,
      metadata: { userId, role: 'assembler' },
    });
    stripeCustomerId = customer.id;

    if (!foundingApplication.feeWaived) {
      // Charge $30 application fee when the Founding Easer waiver is no longer available.
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
    }

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
      payment_confirmed: !foundingApplication.feeWaived,
      application_fee_paid: !foundingApplication.feeWaived,
    }).eq('id', userId);

  } catch (stripeErr) {
    console.error('Stripe error:', stripeErr);
    if (!foundingApplication.feeWaived && !paymentIntentId) {
      // Payment itself failed - clean up auth user
      await sb.auth.admin.deleteUser(userId).catch(() => {});
      const msg = stripeErr?.raw?.message || stripeErr?.message || 'Payment failed. Please check your card details.';
      return res.status(402).json({ error: msg });
    }
    // Founding application or paid application succeeded but identity setup failed - still proceed.
    console.warn('Stripe Identity session creation failed - proceeding without verification URL');
  }

  // ---- Send owner notification ----
  try {
    const servicesList = validServices.map(s => `<li style="padding:3px 0">${esc(s)}</li>`).join('');
    await sendEmail({
      to: ownerEmail(),
      from: 'AssembleAtEase <booking@assembleatease.com>',
      replyTo: cleanEmail,
      subject: 'New Assembler Application - ' + cleanName,
      html: buildOwnerEmail({ cleanName, cleanEmail, cleanPhone, city, zip, yearsExperience, hasTools, hasTransport, bio, servicesList, paymentIntentId, feeWaived: foundingApplication.feeWaived, foundingNumber: foundingApplication.foundingNumber, verificationSessionId }),
    });
  } catch (e) { console.error('Owner email error:', e); }

  // ---- Send applicant confirmation ----
  try {
    await sendEmail({
      to: cleanEmail,
      from: 'AssembleAtEase <booking@assembleatease.com>',
      subject: 'Application Received - AssembleAtEase',
      html: buildApplicantEmail(cleanName.split(' ')[0], { feeWaived: foundingApplication.feeWaived, verificationUrl }),
      replyTo: ownerEmail(),
    });
  } catch (e) { console.error('Applicant email error:', e); }

  return res.status(200).json({ success: true, verificationUrl, feeWaived: foundingApplication.feeWaived, foundingProgram: foundingApplication.feeWaived });
}

function getClientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const realIp = String(req.headers['x-real-ip'] || '').trim();
  const cfIp = String(req.headers['cf-connecting-ip'] || '').trim();
  return (forwarded || realIp || cfIp || req.socket?.remoteAddress || 'unknown').slice(0, 120);
}

async function getFoundingApplicationStatus(sb) {
  const limit = Number.isFinite(FOUNDING_EASER_FREE_APPLICATION_LIMIT)
    ? Math.max(0, FOUNDING_EASER_FREE_APPLICATION_LIMIT)
    : 20;

  if (limit <= 0) return { feeWaived: false, foundingNumber: null };

  try {
    const { count, error } = await sb
      .from('profiles')
      .select('id', { count: 'exact', head: true })
      .eq('role', 'assembler');

    if (error) throw error;
    const existingCount = count || 0;
    return {
      feeWaived: existingCount < limit,
      foundingNumber: existingCount < limit ? existingCount + 1 : null,
    };
  } catch (err) {
    console.warn('Founding Easer count unavailable; waiving application fee for launch safety:', err.message || err);
    return { feeWaived: true, foundingNumber: null };
  }
}

function buildOwnerEmail({ cleanName, cleanEmail, cleanPhone, city, zip, yearsExperience, hasTools, hasTransport, bio, servicesList, paymentIntentId, feeWaived, foundingNumber, verificationSessionId }) {
  const paymentLine = feeWaived
    ? `&#10003; Founding Easer application &bull; $30 fee waived${foundingNumber ? ` &bull; Founding #${foundingNumber}` : ''}`
    : '&#10003; $30 application fee paid';
  const verificationLine = verificationSessionId ? ' &bull; Stripe Identity initiated' : ' &bull; Identity verification pending';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1a1a1a">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px 8px 0 0;border-bottom:3px solid #00BFFF"><tr><td style="padding:20px 24px">
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
      <tr><td style="padding:8px 0;border-bottom:1px solid #f0f0f0;color:#71717a">Phone</td><td style="padding:8px 0;border-bottom:1px solid #f0f0f0">${esc(cleanPhone)}</td></tr>
      <tr><td style="padding:8px 0;border-bottom:1px solid #f0f0f0;color:#71717a">Location</td><td style="padding:8px 0;border-bottom:1px solid #f0f0f0">${esc(city.trim())}, ${esc(zip.trim())}</td></tr>
      <tr><td style="padding:8px 0;border-bottom:1px solid #f0f0f0;color:#71717a">Experience</td><td style="padding:8px 0;border-bottom:1px solid #f0f0f0">${parseInt(yearsExperience,10)} year(s)</td></tr>
      <tr><td style="padding:8px 0;border-bottom:1px solid #f0f0f0;color:#71717a">Own tools</td><td style="padding:8px 0;border-bottom:1px solid #f0f0f0">${hasTools ? 'Yes' : 'No'}</td></tr>
      <tr><td style="padding:8px 0;border-bottom:1px solid #f0f0f0;color:#71717a">Transportation</td><td style="padding:8px 0;border-bottom:1px solid #f0f0f0">${hasTransport ? 'Yes' : 'No'}</td></tr>
      <tr><td style="padding:8px 0;border-bottom:1px solid #f0f0f0;color:#71717a;vertical-align:top">Services</td><td style="padding:8px 0;border-bottom:1px solid #f0f0f0"><ul style="margin:0;padding-left:16px">${servicesList}</ul></td></tr>
      <tr><td style="padding:8px 0;color:#71717a;vertical-align:top">About</td><td style="padding:8px 0">${esc(bio?.trim() || 'Not provided')}</td></tr>
    </table>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px"><tr><td style="padding:14px 18px">
      <p style="margin:0;font-size:13px;color:#166534;font-weight:600">${paymentLine}${verificationLine}</p>
      ${paymentIntentId ? `<p style="margin:4px 0 0;font-size:12px;color:#15803d">Stripe Payment ID: ${esc(paymentIntentId)}</p>` : ''}
    </td></tr></table>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-top:none;border-radius:0 0 8px 8px"><tr><td style="padding:16px 24px;text-align:center;font-size:11px;color:#a1a1aa">
    AssembleAtEase &bull; Austin, TX
  </td></tr></table>
</div></body></html>`;
}

function buildApplicantEmail(firstName, { feeWaived, verificationUrl }) {
  const paymentCopy = feeWaived
    ? 'Your Founding Easer application was submitted with no application fee collected.'
    : 'Your $30 application fee has been received.';
  const statusCopy = verificationUrl
    ? '&#10003; Application submitted &bull; Identity verification ready'
    : '&#10003; Application submitted &bull; Identity verification pending';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1a1a1a">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px 8px 0 0;border-bottom:1px solid #e4e4e7"><tr><td style="padding:20px 24px;text-align:center">
    <img src="${LOGO}" alt="AssembleAtEase" width="44" height="44" style="border-radius:50%;display:inline-block"/>
    <p style="margin:8px 0 0;font-size:17px;font-weight:700;color:#1a1a1a">AssembleAtEase</p>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-left:1px solid #e4e4e7;border-right:1px solid #e4e4e7"><tr><td style="padding:32px 24px 24px">
    <p style="margin:0 0 8px;font-size:24px;font-weight:700;color:#1a1a1a">Application received, ${esc(firstName)}!</p>
    <p style="margin:0 0 16px;font-size:14px;color:#52525b;line-height:1.6">Thank you for applying to join the AssembleAtEase team. ${paymentCopy}</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;margin-bottom:20px"><tr><td style="padding:14px 18px;text-align:center">
      <p style="margin:0;font-size:13px;color:#166534;font-weight:600">${statusCopy}</p>
    </td></tr></table>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-radius:6px"><tr><td style="padding:18px 20px">
      <p style="margin:0 0 4px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:#71717a">What happens next</p>
      <ol style="margin:8px 0 0;padding-left:16px;font-size:14px;color:#52525b;line-height:1.8">
        <li>Complete identity verification if a Stripe Identity link is shown</li>
        <li>Our team reviews your application</li>
        <li>Once approved, you will start receiving job assignments</li>
      </ol>
    </td></tr></table>
    <p style="margin:20px 0 0;font-size:13px;color:#52525b;line-height:1.6">Questions? Email <a href="mailto:service@assembleatease.com" style="color:#00BFFF;text-decoration:none">service@assembleatease.com</a>.</p>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-top:none;border-radius:0 0 8px 8px"><tr><td style="padding:16px 24px;text-align:center;font-size:11px;color:#a1a1aa">
    AssembleAtEase &bull; Austin, TX &bull; <a href="mailto:service@assembleatease.com" style="color:#71717a">service@assembleatease.com</a>
  </td></tr></table>
</div></body></html>`;
}
