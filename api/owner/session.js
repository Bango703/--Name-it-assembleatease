import { createOwnerSessionToken, verifyOwnerPassword } from '../_email.js';
import { hasDurableRateLimit, rateLimitKey } from '../_ratelimit.js';

function requestIp(req) {
  return String(req.headers?.['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown')
    .split(',')[0]
    .trim();
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (process.env.VERCEL_ENV === 'production' && !hasDurableRateLimit()) {
    return res.status(503).json({ error: 'Owner login is unavailable until the security rate limiter is configured.' });
  }

  const ip = requestIp(req);
  if (!(await rateLimitKey(`owner-login:${ip}`, 'owner_auth'))) {
    return res.status(429).json({ error: 'Too many sign-in attempts. Try again later.' });
  }

  if (!verifyOwnerPassword(req, req.body?.password)) {
    return res.status(401).json({ error: 'Invalid owner credentials.' });
  }

  const session = createOwnerSessionToken();
  if (!session) {
    return res.status(503).json({ error: 'Owner sessions are not configured.' });
  }

  return res.status(200).json({ ok: true, ...session });
}
