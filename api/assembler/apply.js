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
    fullName, email, password, phone, city, zip,
    servicesOffered, hasTools, hasTransport,
    yearsExperience, bio, codeOfConduct, inviteToken,
  } = req.body;

  // ── Validation ──
  if (!fullName?.trim()) return res.status(400).json({ error: 'Full name is required' });
  if (!email?.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Valid email is required' });
  if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (!phone?.trim()) return res.status(400).json({ error: 'Phone number is required' });
  if (!city?.trim()) return res.status(400).json({ error: 'City is required' });
  if (!zip?.trim()) return res.status(400).json({ error: 'Zip code is required' });
  if (!Array.isArray(servicesOffered) || !servicesOffered.length) return res.status(400).json({ error: 'Select at least one service' });
  const validServices = servicesOffered.filter(s => VALID_SERVICES.includes(s));
  if (!validServices.length) return res.status(400).json({ error: 'Invalid service selection' });
  if (typeof hasTools !== 'boolean') return res.status(400).json({ error: 'Tools question is required' });
  if (typeof hasTransport !== 'boolean') return res.status(400).json({ error: 'Transportation question is required' });
  if (!yearsExperience || yearsExperience < 0) return res.status(400).json({ error: 'Years of experience is required' });
  if (!codeOfConduct) return res.status(400).json({ error: 'You must agree to the code of conduct' });

  const sb = getSupabase();
  const cleanName = fullName.trim();
  const cleanEmail = email.trim().toLowerCase();

  // ── Create Supabase auth user ──
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

  // ── Upsert profile (core fields first, then assembler-specific) ──
  const coreProfile = {
    id: userId,
    full_name: cleanName,
    email: cleanEmail,
    role: 'assembler',
    phone: phone.trim(),
    city: city.trim(),
    zip: zip.trim(),
  };

  let { error: profileError } = await sb.from('profiles').upsert(coreProfile, { onConflict: 'id' });

  if (profileError) {
    console.error('Profile upsert error:', JSON.stringify(profileError));
    return res.status(500).json({ error: 'Failed to save application. ' + (profileError.message || '') });
  }

  // Assembler-specific columns — may not exist in schema yet, non-blocking
  const { error: extError } = await sb.from('profiles').update({
    services_offered: validServices,
    has_tools: hasTools,
    has_transport: hasTransport,
    years_experience: parseInt(yearsExperience, 10),
    bio: bio?.trim() || null,
    tier: 'pending',
    persona_verified: false,
    code_of_conduct_agreed_at: new Date().toISOString(),
  }).eq('id', userId);
  if (extError) console.warn('Assembler columns update skipped:', extError.message);

  // ── If invite token, validate and update waitlist ──
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
      // Non-blocking — application still proceeds
    }
  }

  // ── Persona integration (3-step verification) ──
  let personaInquiries = null;
  const personaApiKey = process.env.PERSONA_API_KEY;
  const templates = {
    gov: process.env.PERSONA_TEMPLATE_GOV_ID,
    selfie: process.env.PERSONA_TEMPLATE_SELFIE,
    db: process.env.PERSONA_TEMPLATE_DATABASE,
  };
  const hasPersona = personaApiKey && templates.gov && templates.selfie && templates.db;

  if (hasPersona) {
    personaInquiries = {};
    const personaHeaders = {
      'Authorization': 'Bearer ' + personaApiKey,
      'Content-Type': 'application/json',
      'Persona-Version': '2023-01-05',
      'Key-Inflection': 'camel',
    };
    const fields = {
      nameFirst: cleanName.split(' ')[0],
      nameLast: cleanName.split(' ').slice(1).join(' ') || '',
      emailAddress: cleanEmail,
    };

    for (const [key, templateId] of Object.entries(templates)) {
      try {
        const pResp = await fetch('https://withpersona.com/api/v1/inquiries', {
          method: 'POST',
          headers: personaHeaders,
          body: JSON.stringify({
            data: {
              attributes: {
                inquiryTemplateId: templateId,
                referenceId: userId,
                fields,
              },
            },
          }),
        });

        if (pResp.ok) {
          const pData = await pResp.json();
          const inquiryId = pData.data?.id || null;
          const sessionToken = pData.data?.attributes?.sessionToken || null;
          personaInquiries[key] = inquiryId ? { id: inquiryId, sessionToken } : null;
        } else {
          console.error(`Persona ${key} API error:`, await pResp.text());
          personaInquiries[key] = null;
        }
      } catch (err) {
        console.error(`Persona ${key} integration error:`, err);
        personaInquiries[key] = null;
      }
    }

    // Store only inquiry IDs (session tokens are short-lived, not worth persisting)
    const anyCreated = Object.values(personaInquiries).some(Boolean);
    if (anyCreated) {
      const idMap = Object.fromEntries(
        Object.entries(personaInquiries).map(([k, v]) => [k, v?.id || null])
      );
      const { error: pStoreErr } = await sb.from('profiles')
        .update({
          persona_inquiry_id: JSON.stringify(idMap),
          persona_checks: { gov: false, selfie: false, db: false },
        })
        .eq('id', userId);
      if (pStoreErr) console.warn('Persona inquiry storage skipped (columns may not exist):', pStoreErr.message);
    }
  }

  const personaCreated = personaInquiries && Object.values(personaInquiries).some(Boolean);

  // ── Send owner notification email ──
  try {
    const servicesList = validServices.map(s => `<li style="padding:3px 0">${esc(s)}</li>`).join('');
    const ownerHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1a1a1a">
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
      <tr><td style="padding:8px 0;border-bottom:1px solid #f0f0f0;color:#71717a">Phone</td><td style="padding:8px 0;border-bottom:1px solid #f0f0f0">${esc(phone.trim())}</td></tr>
      <tr><td style="padding:8px 0;border-bottom:1px solid #f0f0f0;color:#71717a">Location</td><td style="padding:8px 0;border-bottom:1px solid #f0f0f0">${esc(city.trim())}, ${esc(zip.trim())}</td></tr>
      <tr><td style="padding:8px 0;border-bottom:1px solid #f0f0f0;color:#71717a">Experience</td><td style="padding:8px 0;border-bottom:1px solid #f0f0f0">${parseInt(yearsExperience,10)} year(s)</td></tr>
      <tr><td style="padding:8px 0;border-bottom:1px solid #f0f0f0;color:#71717a">Own tools</td><td style="padding:8px 0;border-bottom:1px solid #f0f0f0">${hasTools ? 'Yes' : 'No'}</td></tr>
      <tr><td style="padding:8px 0;border-bottom:1px solid #f0f0f0;color:#71717a">Transportation</td><td style="padding:8px 0;border-bottom:1px solid #f0f0f0">${hasTransport ? 'Yes' : 'No'}</td></tr>
      <tr><td style="padding:8px 0;border-bottom:1px solid #f0f0f0;color:#71717a;vertical-align:top">Services</td><td style="padding:8px 0;border-bottom:1px solid #f0f0f0"><ul style="margin:0;padding-left:16px">${servicesList}</ul></td></tr>
      <tr><td style="padding:8px 0;color:#71717a;vertical-align:top">About</td><td style="padding:8px 0">${esc(bio?.trim() || 'Not provided')}</td></tr>
    </table>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px;background:${personaCreated ? '#eff6ff' : '#fef3c7'};border:1px solid ${personaCreated ? '#bfdbfe' : '#fde68a'};border-radius:6px"><tr><td style="padding:14px 18px">
      <p style="margin:0;font-size:13px;color:${personaCreated ? '#1e40af' : '#92400e'}">
        ${personaCreated
          ? 'Persona 3-step verification initiated (Gov ID, Selfie, Database). IDs: ' + esc(JSON.stringify(personaInquiries))
          : 'Persona not configured — manual verification required.'}
      </p>
    </td></tr></table>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-top:none;border-radius:0 0 8px 8px"><tr><td style="padding:16px 24px;text-align:center;font-size:11px;color:#a1a1aa">
    AssembleAtEase &bull; Austin, TX
  </td></tr></table>
</div></body></html>`;

    await sendEmail({
      to: ownerEmail(),
      from: 'AssembleAtEase <booking@assembleatease.com>',
      replyTo: cleanEmail,
      subject: 'New Assembler Application — ' + cleanName,
      html: ownerHtml,
    });
  } catch (e) {
    console.error('Owner notification email error:', e);
  }

  // ── Send applicant confirmation email ──
  try {
    const applicantHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1a1a1a">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px 8px 0 0;border-bottom:1px solid #e4e4e7"><tr><td style="padding:20px 24px;text-align:center">
    <img src="${LOGO}" alt="AssembleAtEase" width="44" height="44" style="border-radius:50%;display:inline-block"/>
    <p style="margin:8px 0 0;font-size:17px;font-weight:700;color:#1a1a1a">AssembleAtEase</p>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-left:1px solid #e4e4e7;border-right:1px solid #e4e4e7"><tr><td style="padding:32px 24px 24px">
    <p style="margin:0 0 8px;font-size:24px;font-weight:700;color:#1a1a1a">Application received, ${esc(cleanName.split(' ')[0])}!</p>
    <p style="margin:0 0 20px;font-size:14px;color:#52525b;line-height:1.6">Thank you for applying to join the AssembleAtEase team. We&rsquo;re reviewing your application and will get back to you shortly.</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-radius:6px"><tr><td style="padding:18px 20px">
      <p style="margin:0 0 4px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:#71717a">What happens next</p>
      <ol style="margin:8px 0 0;padding-left:16px;font-size:14px;color:#52525b;line-height:1.8">
        ${personaCreated
          ? '<li>Complete your 3-step identity verification (links below)</li>'
          : '<li>We&rsquo;ll verify your information</li>'}
        <li>Our team reviews your application</li>
        <li>Once approved, you&rsquo;ll start receiving job assignments</li>
      </ol>
    </td></tr></table>
    <p style="margin:20px 0 0;font-size:13px;color:#52525b;line-height:1.6">If you have any questions, email us at <a href="mailto:service@assembleatease.com" style="color:#0097a7;text-decoration:none">service@assembleatease.com</a>.</p>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-top:none;border-radius:0 0 8px 8px"><tr><td style="padding:16px 24px;text-align:center;font-size:11px;color:#a1a1aa">
    AssembleAtEase &bull; Austin, TX &bull; <a href="mailto:service@assembleatease.com" style="color:#71717a">service@assembleatease.com</a>
  </td></tr></table>
</div></body></html>`;

    await sendEmail({
      to: cleanEmail,
      from: 'AssembleAtEase <booking@assembleatease.com>',
      subject: 'Application Received — AssembleAtEase',
      html: applicantHtml,
      replyTo: ownerEmail(),
    });
  } catch (e) {
    console.error('Applicant confirmation email error:', e);
  }

  return res.status(200).json({
    success: true,
    personaInquiries: personaInquiries || null,
  });
}
