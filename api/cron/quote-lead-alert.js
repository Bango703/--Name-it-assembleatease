import { getSupabase } from '../_supabase.js';
import { sendEmail, ownerEmail, esc } from '../_email.js';
import { logCron } from './_cron-logger.js';
import { recordOperationalEvents } from '../_observability.js';
import { QUOTE_LEAD_SOURCE } from '../booking/quote-lead.js';

/**
 * Daily: custom quotes that were started and never sent.
 *
 * Owner, 2026-10-21: 12 of 15 quote requests stopped at the last step and the
 * only trace was a Stripe customer. A started quote is now a lead
 * (api/booking/quote-lead.js); sending the quote marks it converted. What is
 * still "new" two hours later is someone who stopped, and the owner is told
 * once per lead, with how to reach them.
 */
export const ALERTED_EVENT = 'quote_lead_alerted';
const QUIET_HOURS = 2;

export function buildQuoteLeadEmail(leads) {
  const rows = leads.map((l) => `<tr>
    <td style="padding:8px 10px;border-bottom:1px solid #e4e4e7"><strong>${esc(l.customer_name || 'Name not given')}</strong><br>
      <a href="mailto:${esc(l.customer_email)}?subject=${encodeURIComponent('Your AssembleAtEase quote')}" style="color:#00BFFF;font-size:13px">${esc(l.customer_email)}</a>${l.customer_phone ? `<br><span style="font-size:13px">${esc(l.customer_phone)}</span>` : ''}</td>
    <td style="padding:8px 10px;border-bottom:1px solid #e4e4e7;font-size:13px">${esc(l.requested_service || 'Custom quote')}${l.details ? `<br><span style="color:#71717a">${esc(String(l.details).slice(0, 200))}</span>` : ''}</td>
    <td style="padding:8px 10px;border-bottom:1px solid #e4e4e7;font-size:13px">${esc([l.city, l.zip_code].filter(Boolean).join(' '))}</td>
  </tr>`).join('');
  return `<div style="font-family:sans-serif;max-width:680px;margin:0 auto;padding:2rem">
    <h2 style="margin:0 0 0.5rem">${leads.length} quote${leads.length === 1 ? '' : 's'} started and not sent</h2>
    <p style="color:#3f3f46;line-height:1.6">They filled in the quote form and stopped before sending it. Reply with a price or a question.</p>
    <table style="width:100%;border-collapse:collapse;margin:1rem 0;font-size:14px">
      <thead><tr style="text-align:left;color:#71717a;font-size:12px;text-transform:uppercase"><th style="padding:6px 10px">Customer</th><th style="padding:6px 10px">Wanted</th><th style="padding:6px 10px">Where</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p><a href="https://www.assembleatease.com/owner/" style="color:#00BFFF">Open Unbooked Requests in the dashboard</a></p>
  </div>`;
}

export function createQuoteLeadAlert({ getSb = getSupabase, send = (message) => sendEmail(message), log = logCron, record = recordOperationalEvents, now = () => Date.now() } = {}) {
  return async function handler(req, res) {
    const cronSecret = process.env.CRON_SECRET;
    if (!cronSecret || req.headers.authorization !== 'Bearer ' + cronSecret) return res.status(401).json({ error: 'Unauthorized' });
    const startedAt = now();
    try {
      const sb = getSb();
      const quietBefore = new Date(now() - QUIET_HOURS * 3600 * 1000).toISOString();
      const { data: leads, error } = await sb.from('market_requests')
        .select('id, customer_name, customer_email, customer_phone, requested_service, details, city, zip_code, created_at')
        .eq('source', QUOTE_LEAD_SOURCE).eq('status', 'new').lt('created_at', quietBefore)
        .order('created_at', { ascending: true }).limit(50);
      if (error) throw error;
      const ids = (leads || []).map((l) => String(l.id));
      let fresh = leads || [];
      if (ids.length) {
        const { data: told } = await sb.from('operational_events').select('reason_detail').eq('event_type', ALERTED_EVENT).in('reason_detail', ids);
        const toldIds = new Set((told || []).map((r) => r.reason_detail));
        fresh = fresh.filter((l) => !toldIds.has(String(l.id)));
      }
      if (fresh.length) {
        const result = await send({
          to: ownerEmail(),
          from: 'AssembleAtEase <booking@assembleatease.com>',
          subject: `${fresh.length} quote${fresh.length === 1 ? '' : 's'} started and not sent`,
          html: buildQuoteLeadEmail(fresh),
          meta: { notificationType: 'quote_lead_alert', recipientType: 'owner' },
        });
        // Recorded after the send, so a failed email is retried tomorrow.
        if (result?.ok !== false) {
          await record(sb, fresh.map((l) => ({
            event_type: ALERTED_EVENT,
            route: '/api/cron/quote-lead-alert',
            method: 'CRON',
            actor_role: 'cron',
            stage: 'alert',
            reason_code: 'quote_lead_not_sent',
            reason_detail: String(l.id),
            mutation_result: 'owner_alerted',
          })));
        }
      }
      await log('quote-lead-alert', { status: 'ok', records: fresh.length, duration: now() - startedAt });
      return res.status(200).json({ alerted: fresh.length });
    } catch (error) {
      await log('quote-lead-alert', { status: 'error', records: 0, error: error?.message || String(error), duration: now() - startedAt });
      return res.status(500).json({ error: 'Quote lead alert failed' });
    }
  };
}

export default createQuoteLeadAlert();
