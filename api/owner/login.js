import { checkOwnerPassword, setOwnerSessionCookie } from '../_email.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const password = String(req.body?.password || '').trim();
  const result = checkOwnerPassword(req, password);

  if (result.locked) {
    const retryAfterSeconds = Math.max(1, Math.ceil((result.retryAfterMs || 0) / 1000));
    res.setHeader('Retry-After', String(retryAfterSeconds));
    return res.status(429).json({
      error: 'Too many failed attempts. Please try again later.',
      retryAfterSeconds,
    });
  }

  if (!result.ok) {
    return res.status(401).json({ error: 'Invalid password' });
  }

  if (!setOwnerSessionCookie(req, res)) {
    return res.status(500).json({ error: 'Owner session could not be created' });
  }

  return res.status(200).json({ ok: true });
}
