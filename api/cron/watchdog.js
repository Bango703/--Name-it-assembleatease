import { getSupabase } from '../_supabase.js';
import { sendEmail, ownerEmail } from '../_email.js';

/**
 * GET /api/cron/watchdog
 * Runs every hour via Vercel cron.
 *
 * Checks that each critical cron has run within its expected window.
 * If any are overdue, emails the owner with the list and last known run time.
 *
 * staleMinutes = how long after the expected interval before alerting.
 * Uses 2.5× the schedule interval to allow for minor drift.
 */
const CRONS = [
  { name: 'expire-offers',   staleMinutes: 25,    label: 'Offer expiry (every 10 min)'    },
  { name: 'auto-dispatch',   staleMinutes: 70,    label: 'Auto dispatch (every 30 min)'   },
  { name: 'reminders',       staleMinutes: 90,    label: 'Appointment reminders (hourly)' },
  { name: 'stale-booking',   staleMinutes: 1560,  label: 'Stale booking cleanup (daily)'  },
  { name: 'tier-check',      staleMinutes: 1560,  label: 'Tier check + scoring (daily)'   },
  { name: 'reauth-payments', staleMinutes: 1560,  label: 'Payment re-auth (daily)'        },
];

export default async function handler(req, res) {
  const secret = req.headers['authorization']?.replace('Bearer ', '');
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const sb = getSupabase();
  const now = Date.now();
  const overdue = [];

  for (const cron of CRONS) {
    const { data: rows } = await sb
      .from('cron_log')
      .select('ran_at, status, error_text')
      .eq('cron_name', cron.name)
      .order('ran_at', { ascending: false })
      .limit(1);

    const last = rows?.[0];
    const lastRanMs = last ? new Date(last.ran_at).getTime() : 0;
    const minutesSince = (now - lastRanMs) / 60000;

    if (minutesSince > cron.staleMinutes) {
      overdue.push({
        name: cron.name,
        label: cron.label,
        lastRan: last ? last.ran_at : null,
        minutesSince: Math.round(minutesSince),
        lastStatus: last?.status || 'never run',
        lastError: last?.error_text || null,
      });
    }
  }

  if (!overdue.length) {
    return res.status(200).json({ ok: true, message: 'All crons healthy' });
  }

  // Build owner alert email
  const rows = overdue.map(c => {
    const lastRanStr = c.lastRan
      ? new Date(c.lastRan).toLocaleString('en-US', { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' })
      : 'Never';
    const errorNote = c.lastError ? ` — Last error: ${c.lastError}` : '';
    return `<tr>
      <td style="padding:8px 12px;border-bottom:1px solid #e4e4e7;font-size:13px;font-weight:600;color:#111">${c.label}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e4e4e7;font-size:13px;color:#ef4444">${c.minutesSince} min ago</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e4e4e7;font-size:12px;color:#6b7280">${lastRanStr}${errorNote}</td>
    </tr>`;
  }).join('');

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
  <div style="background:#fff;border-radius:8px;border:1px solid #e4e4e7;overflow:hidden">
    <div style="background:#dc2626;padding:1.25rem 1.5rem">
      <p style="margin:0;font-size:16px;font-weight:700;color:#fff">Cron Health Alert — ${overdue.length} job(s) overdue</p>
      <p style="margin:4px 0 0;font-size:12px;color:rgba(255,255,255,0.8)">${new Date().toLocaleString('en-US', { weekday:'long', month:'long', day:'numeric', hour:'numeric', minute:'2-digit' })}</p>
    </div>
    <div style="padding:1.5rem">
      <p style="margin:0 0 1rem;font-size:14px;color:#374151">The following scheduled jobs have not run within their expected window. This may mean dispatch offers are not expiring, bookings are not auto-dispatching, or other critical operations are stalled.</p>
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead>
          <tr style="background:#f9fafb">
            <th style="padding:8px 12px;text-align:left;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:#6b7280;border-bottom:2px solid #e4e4e7">Job</th>
            <th style="padding:8px 12px;text-align:left;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:#6b7280;border-bottom:2px solid #e4e4e7">Overdue By</th>
            <th style="padding:8px 12px;text-align:left;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:#6b7280;border-bottom:2px solid #e4e4e7">Last Run</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <p style="margin:1.25rem 0 0;font-size:13px;color:#6b7280">Check the Vercel dashboard for function logs and errors. If Vercel cron is healthy, check that <code>CRON_SECRET</code> is set correctly in your environment variables.</p>
    </div>
  </div>
</div>
</body></html>`;

  await sendEmail({
    to:      ownerEmail(),
    from:    'AssembleAtEase <booking@assembleatease.com>',
    subject: `Platform Alert — ${overdue.length} scheduled job(s) overdue`,
    html,
    meta:    { notificationType: 'cron_alert', recipientType: 'owner' },
  }).catch(e => console.error('Watchdog alert email error:', e));

  console.log(JSON.stringify({ audit: true, action: 'cron_watchdog', overdue: overdue.map(c => c.name), timestamp: new Date().toISOString() }));
  return res.status(200).json({ ok: false, overdue });
}
