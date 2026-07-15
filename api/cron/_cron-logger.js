import { getSupabase } from '../_supabase.js';
import { buildRequestId, getDeploymentMetadata, insertOperationalEventFailOpen } from '../_observability.js';

/**
 * Log a cron run to cron_log table.
 * Non-fatal — never throws.
 *
 * Usage:
 *   const t = Date.now();
 *   // ... do work ...
 *   await logCron('expire-offers', { status:'ok', records:5, duration: Date.now()-t });
 *   await logCron('expire-offers', { status:'error', error: err.message });
 */
export async function logCron(cronName, { status = 'ok', records = 0, error = null, duration = null } = {}) {
  const finalStatus = error ? 'error' : status;
  try {
    const sb = getSupabase();
    await sb.from('cron_log').insert({
      cron_name:         cronName,
      status:            finalStatus,
      records_processed: records,
      error_text:        error || null,
      duration_ms:       duration || null,
    });

    // Prune rows older than 30 days (non-blocking, best-effort)
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    sb.from('cron_log').delete().eq('cron_name', cronName).lt('ran_at', cutoff)
      .then(() => {}).catch(() => {});
  } catch (insertError) {
    // Keep cron execution non-fatal, but preserve an audit trail when cron_log writes fail.
    try {
      const sb = getSupabase();
      await insertOperationalEventFailOpen(sb, {
        request_id: buildRequestId({}),
        event_type: 'cron_log_write_failed',
        route: `/api/cron/${String(cronName || '').trim()}`,
        method: 'CRON',
        actor_role: 'cron',
        stage: 'log-write',
        status_code: 0,
        reason_code: 'db_write_failed',
        reason_detail: `cron_log insert failed: ${insertError?.message || String(insertError)}`,
        mutation_result: 'fallback_logged',
        payload: {
          cron_name: cronName,
          status: finalStatus,
          records_processed: Number(records) || 0,
          duration_ms: duration || null,
          error_text: error || null,
        },
        ...getDeploymentMetadata(),
      });
    } catch (_) {
      // Last-resort visibility in platform logs if both DB paths fail.
      console.error('[cron-log] failed to write cron_log and fallback event', {
        cronName,
        status: finalStatus,
        records,
        insertError: insertError?.message || String(insertError),
      });
    }
  }
}
