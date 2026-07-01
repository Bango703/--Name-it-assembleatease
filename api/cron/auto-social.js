import { logCron } from './_cron-logger.js';
import { runSocialQueueTopUp } from '../_social-automation.js';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const startedAt = Date.now();
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.authorization !== 'Bearer ' + cronSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (String(process.env.SOCIAL_AUTO_PUBLISH || '').toLowerCase() !== 'true') {
    await logCron('auto-social', { status: 'ok', records: 0, duration: Date.now() - startedAt });
    return res.status(200).json({
      success: true,
      disabled: true,
      reason: 'SOCIAL_AUTO_PUBLISH is not enabled.',
    });
  }

  try {
    const result = await runSocialQueueTopUp({ dryRun: false });
    const status = result.summary.errors ? 'partial' : 'ok';
    await logCron('auto-social', {
      status,
      records: result.summary.queued || 0,
      duration: Date.now() - startedAt,
    });
    return res.status(200).json(result);
  } catch (error) {
    await logCron('auto-social', {
      status: 'error',
      records: 0,
      error: error?.message || String(error),
      duration: Date.now() - startedAt,
    });
    return res.status(500).json({ error: 'Auto-social run failed', detail: error?.message || String(error) });
  }
}
