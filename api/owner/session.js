import { clearOwnerSessionCookie, verifyOwner } from '../_email.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  if (!verifyOwner(req)) {
    clearOwnerSessionCookie(req, res);
    return res.status(401).json({ error: 'Unauthorized' });
  }

  return res.status(200).json({ ok: true });
}
