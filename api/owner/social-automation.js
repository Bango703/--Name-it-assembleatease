import { verifyOwner } from '../_email.js';
import { getSocialAutomationSnapshot, getSocialAutomationStatus } from '../_social-publisher.js';
import { runSocialQueueTopUp } from '../_social-automation.js';

export default async function handler(req, res) {
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  if (req.method === 'GET') {
    try {
      const snapshot = await getSocialAutomationSnapshot();
      return res.status(200).json({ success: true, snapshot });
    } catch (error) {
      const snapshot = {
        ...getSocialAutomationStatus(),
        fetchedAt: new Date().toISOString(),
        error: error?.message || String(error),
        enabled: false,
      };
      return res.status(200).json({ success: true, snapshot, warning: 'Social automation snapshot loaded with a fallback because Buffer could not be reached.' });
    }
  }

  if (req.method === 'POST') {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const result = await runSocialQueueTopUp({
        dryRun: body.dryRun === true,
        channels: body.channels,
      });
      return res.status(200).json(result);
    } catch (error) {
      return res.status(500).json({ error: 'Failed to run social automation', detail: error?.message || String(error) });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
