import { getSupabase } from '../_supabase.js';

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
  try {
    const sb = getSupabase();
    await sb.from('cron_log').insert({
      cron_name:         cronName,
      status:            error ? 'error' : status,
      records_processed: records,
      error_text:        error || null,
      duration_ms:       duration || null,
    });

    // Prune rows older than 30 days (non-blocking, best-effort)
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    sb.from('cron_log').delete().eq('cron_name', cronName).lt('ran_at', cutoff)
      .then(() => {}).catch(() => {});
  } catch (_) { /* non-fatal */ }
}
