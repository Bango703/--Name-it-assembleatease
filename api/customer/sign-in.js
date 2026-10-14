import crypto from 'node:crypto';
import { getSupabase } from '../_supabase.js';
import { sendEmail, ownerEmail, esc } from '../_email.js';
import { rateLimit, rateLimitKey } from '../_ratelimit.js';
import { isValidPromoEmail } from '../_promotions.js';
import { normalizeEmail, generateAndStoreCode, verifyCode, ASSEMBLECASH } from '../_assemblecash.js';

/**
 * POST /api/customer/sign-in — the AssembleAtEase customer app's sign-in.
 *
 *   { action: 'send',   email }        emails a 6-digit code
 *   { action: 'verify', email, code }  returns a session for that email
 *
 * No password: the code proves the customer owns the inbox, the same proof the
 * booking page's emailed link relies on. The first sign-in creates the account
 * with the email already confirmed, so api/booking/_customer-access.js accepts
 * it for every booking sent to that address.
 *
 * An email that belongs to an Easer or the owner is refused here: this route
 * only ever hands out customer sessions.
 *
 * App Review: Apple's reviewers cannot open an emailed code, and Apple asks for
 * sign-in details that work every time. APP_REVIEW_EMAIL is the one customer
 * account that accepts APP_REVIEW_CODE (6 digits) instead of an emailed code.
 * Both unset = no such account. It is still a customer account, sees only its
 * own bookings, and goes through the same rate limits as everyone else.
 */
const PURPOSE = 'app_sign_in';
const STAFF_ROLES = new Set(['assembler', 'admin', 'owner']);

/** The App Review account, when both settings are present and well formed. */
export function reviewAccount(env = process.env) {
  const email = normalizeEmail(env.APP_REVIEW_EMAIL || '');
  const code = String(env.APP_REVIEW_CODE || '').trim();
  if (!email || !/^[0-9]{6}$/.test(code)) return null;
  return { email, code };
}

/** True when this email is the review account and the code is its code. */
export function reviewCodeMatches(email, code, env = process.env) {
  const account = reviewAccount(env);
  if (!account || normalizeEmail(email) !== account.email) return false;
  const given = Buffer.from(String(code || ''));
  const expected = Buffer.from(account.code);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action } = req.body || {};
  const email = normalizeEmail((req.body || {}).email);
  if (!isValidPromoEmail(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const sb = getSupabase();

  if (action === 'send') {
    const okEmail = await rateLimitKey('app-sign-in:' + email, 'track_link');
    const okIp = await rateLimitKey('app-sign-in-ip:' + ip, 'apply');
    if (!okEmail || !okIp) return res.status(429).json({ error: 'Too many codes requested. Wait a few minutes and try again.' });

    // The review account's code is fixed; nothing is emailed.
    if (reviewAccount()?.email === email) return res.status(200).json({ ok: true, expiresInMinutes: ASSEMBLECASH.CODE_TTL_MIN });

    let code;
    try {
      code = await generateAndStoreCode(sb, email, PURPOSE);
    } catch (error) {
      console.error('[customer-sign-in] code store failed:', error?.message || error);
      return res.status(503).json({ error: 'A code could not be sent right now. Try again in a minute.' });
    }
    const sent = await sendEmail({
      to: email,
      from: 'AssembleAtEase <booking@assembleatease.com>',
      subject: `Your AssembleAtEase code: ${code}`,
      replyTo: ownerEmail(),
      html: `<!DOCTYPE html><html><head><meta charset="utf-8"/></head>
<body style="margin:0;background:#f4f7f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#0d2430">
<div style="max-width:480px;margin:0 auto;padding:28px 18px">
  <div style="background:#fff;border:1px solid #e5edf0;border-radius:14px;padding:28px 26px;text-align:center">
    <p style="margin:0 0 6px;font-size:13px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#0099cc">Sign in to AssembleAtEase</p>
    <p style="margin:0 0 18px;font-size:15px;color:#5b6b73">Enter this code in the app:</p>
    <div style="font-size:34px;font-weight:800;letter-spacing:7px;color:#0d2430;background:#f6fafb;border:1px solid #e5edf0;border-radius:10px;padding:14px 0">${esc(code)}</div>
    <p style="margin:18px 0 0;font-size:13px;color:#73828a">The code expires in ${ASSEMBLECASH.CODE_TTL_MIN} minutes. If you did not ask for it, ignore this email.</p>
  </div>
  <p style="text-align:center;margin:14px 0 0;font-size:12px;color:#9aa7ad">AssembleAtEase &middot; (979) 232-5139</p>
</div></body></html>`,
      meta: { notificationType: 'customer_app_sign_in_code', recipientType: 'customer', disableDedupe: true },
    }).catch(error => ({ ok: false, error: error?.message || String(error) }));
    if (!sent?.ok) return res.status(503).json({ error: 'The code email could not be sent. Try again in a minute.' });
    return res.status(200).json({ ok: true, expiresInMinutes: ASSEMBLECASH.CODE_TTL_MIN });
  }

  if (action !== 'verify') return res.status(400).json({ error: 'action must be send or verify' });

  if (!(await rateLimit(ip, 'booking'))) return res.status(429).json({ error: 'Too many tries. Wait a minute and try again.' });
  const code = String((req.body || {}).code || '').trim();
  if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Enter the 6-digit code from your email.' });

  // The review account only ever accepts its own code.
  const isReview = reviewAccount()?.email === email;
  let verified = isReview && reviewCodeMatches(email, code);
  if (isReview && !verified) return res.status(400).json({ error: 'That code is not right or has expired. Send a new code.' });
  try {
    if (!verified) verified = await verifyCode(sb, email, code, PURPOSE);
  } catch (error) {
    console.error('[customer-sign-in] verify failed:', error?.message || error);
    return res.status(503).json({ error: 'Your code could not be checked right now. Try again in a minute.' });
  }
  if (!verified) return res.status(400).json({ error: 'That code is not right or has expired. Send a new code.' });

  const account = await customerAccount(sb, email);
  if (!account.ok) return res.status(account.status).json({ error: account.error });

  const session = await mintSession(email, account.otp);
  if (!session.ok) return res.status(503).json({ error: 'You could not be signed in right now. Try again in a minute.' });
  return res.status(200).json(session.body);
}

/**
 * The customer's account, created on first sign-in with the email confirmed,
 * plus a one-time token to open a session for it. Staff accounts are refused.
 */
export async function customerAccount(sb, email) {
  const { error: createError } = await sb.auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: { role: 'customer' },
  });
  if (createError && !/already|exists|registered/i.test(createError.message || '')) {
    console.error('[customer-sign-in] account create failed:', createError.message || createError);
    return { ok: false, status: 503, error: 'You could not be signed in right now. Try again in a minute.' };
  }

  const { data: link, error: linkError } = await sb.auth.admin.generateLink({ type: 'magiclink', email });
  const user = link?.user;
  const otp = link?.properties?.email_otp;
  if (linkError || !user?.id || !otp) {
    console.error('[customer-sign-in] session link failed:', linkError?.message || 'no token');
    return { ok: false, status: 503, error: 'You could not be signed in right now. Try again in a minute.' };
  }

  const metadataRole = String(user.user_metadata?.role || user.app_metadata?.role || '').toLowerCase();
  const { data: profile } = await sb.from('profiles').select('role').eq('id', user.id).maybeSingle();
  if (STAFF_ROLES.has(metadataRole) || STAFF_ROLES.has(String(profile?.role || '').toLowerCase())) {
    return { ok: false, status: 409, error: 'This email is set up for the Easer app. Sign in with the email you book with.' };
  }
  return { ok: true, user, otp };
}

/** Exchanges the one-time token for a session, in Supabase's own token shape. */
export async function mintSession(email, otp, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(`${process.env.SUPABASE_URL}/auth/v1/verify`, {
      method: 'POST',
      headers: { apikey: process.env.SUPABASE_SERVICE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'magiclink', email, token: otp }),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body?.access_token || !body?.refresh_token || !body?.user?.id) {
      console.error('[customer-sign-in] verify token failed:', response.status, body?.msg || body?.error_description || body?.error || '');
      return { ok: false };
    }
    return {
      ok: true,
      body: {
        access_token: body.access_token,
        refresh_token: body.refresh_token,
        expires_in: body.expires_in,
        user: { id: body.user.id, email: body.user.email },
      },
    };
  } catch (error) {
    console.error('[customer-sign-in] verify token error:', error?.message || error);
    return { ok: false };
  }
}
