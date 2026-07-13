import { verifyOwner } from '../_email.js';

/**
 * Destructive Easer deletion is retired. Business, payout, tax, agreement, and
 * audit records must be retained. The owner dashboard uses the guarded account
 * archive action in /api/assembler/update instead.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });
  return res.status(410).json({
    error: 'Permanent Easer deletion is disabled. Use the account archive workflow.',
    code: 'EASER_DELETE_RETIRED',
  });
}
