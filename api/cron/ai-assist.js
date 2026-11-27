import { getSupabase } from '../_supabase.js';
import { logCron } from './_cron-logger.js';
import { isMissingAiAssistTable, runAiAssist } from '../_ai-assist-runner.js';

/**
 * GET /api/cron/ai-assist
 * Every 5 minutes. Writes an AI suggestion for each booking message, text and
 * open case waiting for the owner, records what the owner did with earlier
 * suggestions, and sends routine customer replies only when
 * AI_AUTO_REPLY_ENABLED=true (api/_ai-assist-runner.js).
 */
export default async function handler(req, res) {
  const secret = req.headers['authorization']?.replace('Bearer ', '');
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const started = Date.now();
  try {
    const summary = await runAiAssist(getSupabase());
    await logCron('ai-assist', {
      status: summary.failed ? 'partial' : 'ok',
      // Every piece of work the run did, so a run that only reviewed cases is not logged as 0.
      records: summary.drafted + summary.autoSent + summary.reconciled + summary.casesReviewed + summary.casesClosed,
      errorText: summary.errors.length ? summary.errors.slice(0, 3).join(' | ') : null,
      duration: Date.now() - started,
    });
    return res.status(200).json(summary);
  } catch (error) {
    const missingTable = isMissingAiAssistTable(error);
    const message = missingTable ? 'Migration 135 (ai_assist_drafts) is not applied.' : (error?.message || String(error));
    await logCron('ai-assist', { status: 'error', error: message, duration: Date.now() - started });
    return res.status(missingTable ? 200 : 500).json({ error: message, setupNeeded: missingTable });
  }
}
