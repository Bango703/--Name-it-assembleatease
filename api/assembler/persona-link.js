import { getSupabase } from '../_supabase.js';

/**
 * GET /api/assembler/persona-link
 * Returns fresh Persona verification URLs for any incomplete checks.
 * Called from the assembler profile page when persona_verified is false.
 *
 * Generates one-time resume links for existing inquiries (still in created/pending state),
 * or creates new inquiries for checks that were never started.
 */
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // Auth: require assembler JWT
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '').trim();
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  const sb = getSupabase();

  const { data: { user }, error: authErr } = await sb.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: 'Invalid token' });

  const { data: profile, error: profileErr } = await sb.from('profiles')
    .select('id, full_name, email, role, persona_verified, persona_checks, persona_inquiry_id')
    .eq('id', user.id)
    .maybeSingle();

  if (profileErr || !profile) return res.status(404).json({ error: 'Profile not found' });
  if (profile.role !== 'assembler') return res.status(403).json({ error: 'Assembler accounts only' });
  if (profile.persona_verified) return res.status(200).json({ alreadyVerified: true });

  const personaApiKey = process.env.PERSONA_API_KEY;
  const templates = {
    gov: process.env.PERSONA_TEMPLATE_GOV_ID,
    selfie: process.env.PERSONA_TEMPLATE_SELFIE,
    db: process.env.PERSONA_TEMPLATE_DATABASE,
  };

  if (!personaApiKey || !templates.gov || !templates.selfie || !templates.db) {
    return res.status(503).json({ error: 'Verification service not configured' });
  }

  const personaHeaders = {
    'Authorization': 'Bearer ' + personaApiKey,
    'Content-Type': 'application/json',
    'Persona-Version': '2023-01-05',
    'Key-Inflection': 'camel',
  };

  const checks = profile.persona_checks || {};
  const storedIds = (() => {
    try { return JSON.parse(profile.persona_inquiry_id || 'null') || {}; } catch { return {}; }
  })();

  const links = {};
  const newIdMap = { ...storedIds };

  for (const [key, templateId] of Object.entries(templates)) {
    // Skip checks already passed
    if (checks[key] === true) {
      links[key] = null;
      continue;
    }

    const existingId = storedIds[key];

    // Try to generate a one-time resume link for the existing inquiry
    if (existingId) {
      try {
        const resumeResp = await fetch(
          `https://withpersona.com/api/v1/inquiries/${encodeURIComponent(existingId)}/generate-one-time-link`,
          { method: 'POST', headers: personaHeaders }
        );

        if (resumeResp.ok) {
          const resumeData = await resumeResp.json();
          const url = resumeData.data?.attributes?.oneTimeLink || resumeData.data?.attributes?.url || null;
          if (url) {
            links[key] = url;
            continue;
          }
        }
        // Fall through to create a new inquiry if resume fails
      } catch (e) {
        console.warn(`Persona resume failed for ${key}:`, e.message);
      }
    }

    // Create a new inquiry for this check
    try {
      const pResp = await fetch('https://withpersona.com/api/v1/inquiries', {
        method: 'POST',
        headers: personaHeaders,
        body: JSON.stringify({
          data: {
            attributes: {
              inquiryTemplateId: templateId,
              referenceId: user.id,
              fields: {
                nameFirst: (profile.full_name || '').split(' ')[0],
                nameLast: (profile.full_name || '').split(' ').slice(1).join(' ') || '',
                emailAddress: profile.email || '',
              },
            },
          },
        }),
      });

      if (pResp.ok) {
        const pData = await pResp.json();
        const inquiryId = pData.data?.id || null;
        const sessionToken = pData.data?.attributes?.sessionToken || null;

        if (inquiryId) {
          newIdMap[key] = inquiryId;
          let url = `https://withpersona.com/verify?inquiry-id=${encodeURIComponent(inquiryId)}`;
          if (sessionToken) url += `&session-token=${encodeURIComponent(sessionToken)}`;
          links[key] = url;
        } else {
          links[key] = null;
        }
      } else {
        console.error(`Persona new inquiry ${key} error:`, await pResp.text());
        links[key] = null;
      }
    } catch (err) {
      console.error(`Persona new inquiry ${key} exception:`, err);
      links[key] = null;
    }
  }

  // Persist any new inquiry IDs back to profile
  const newIds = JSON.stringify(newIdMap);
  if (newIds !== profile.persona_inquiry_id) {
    await sb.from('profiles').update({ persona_inquiry_id: newIds }).eq('id', user.id);
  }

  return res.status(200).json({ links });
}
