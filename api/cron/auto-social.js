import { logCron } from './_cron-logger.js';
import { runSocialQueueTopUp } from '../_social-automation.js';

export function summarizeSocialErrors(result) {
  const messages = (result?.posts || [])
    .filter(post => post?.status === 'error')
    .map(post => post.error || post.reason)
    .filter(Boolean);
  const uniqueMessages = [...new Set(messages)];
  if (uniqueMessages.length) return uniqueMessages.slice(0, 3).join('; ');
  const errorCount = Number(result?.summary?.errors) || 0;
  return errorCount ? `${errorCount} social post${errorCount === 1 ? '' : 's'} failed without a provider error message.` : null;
}

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
    const errorText = status === 'partial' ? summarizeSocialErrors(result) : null;
    await logCron('auto-social', {
      status,
      records: result.summary.queued || 0,
      errorText,
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
