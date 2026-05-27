import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';

function asSortedPairs(mapObj) {
  return Object.entries(mapObj).sort((a, b) => b[1] - a[1]);
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const daysParam = parseInt(req.query.days || '7', 10);
  const days = Number.isFinite(daysParam) ? Math.min(Math.max(daysParam, 1), 30) : 7;
  const since = new Date(Date.now() - days * 86400000).toISOString();

  const sb = getSupabase();
  const { data, error } = await sb
    .from('notification_log')
    .select('notification_type,status,recipient_type,subject,sent_at')
    .eq('channel', 'email')
    .gte('sent_at', since)
    .limit(10000);

  if (error) {
    console.error('email-usage-report query error:', error);
    return res.status(500).json({ error: 'Failed to load notification usage' });
  }

  const rows = data || [];
  const byType = {};
  const byStatus = {};
  const byRecipientType = {};
  const bySubject = {};

  for (const row of rows) {
    const type = row.notification_type || 'unknown';
    const status = row.status || 'unknown';
    const recipientType = row.recipient_type || 'unknown';
    const subject = row.subject || '(no subject)';

    byType[type] = (byType[type] || 0) + 1;
    byStatus[status] = (byStatus[status] || 0) + 1;
    byRecipientType[recipientType] = (byRecipientType[recipientType] || 0) + 1;
    bySubject[subject] = (bySubject[subject] || 0) + 1;
  }

  const sentCount = byStatus.sent || 0;
  const failedCount = byStatus.failed || 0;
  const suppressedCount = byStatus.suppressed || 0;
  const dailyAvg = Number((sentCount / days).toFixed(2));

  return res.status(200).json({
    windowDays: days,
    from: since,
    totals: {
      all: rows.length,
      sent: sentCount,
      failed: failedCount,
      suppressed: suppressedCount,
      estimatedSentPerDay: dailyAvg,
      estimatedSentPerMonth: Math.round(dailyAvg * 30),
    },
    byStatus: asSortedPairs(byStatus),
    byType: asSortedPairs(byType),
    byRecipientType: asSortedPairs(byRecipientType),
    topSubjects: asSortedPairs(bySubject).slice(0, 15),
  });
}
