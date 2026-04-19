import { getSupabase } from '../_supabase.js';
import { sendEmail, ownerEmail } from '../_email.js';

const LOGO = 'https://www.assembleatease.com/images/logo.jpg';

/**
 * GET /api/cron/daily-summary
 * Runs daily at 8 AM CT. Sends Travis a summary of yesterday's activity.
 * Schedule: 0 13 * * *  (8 AM CT = 13:00 UTC)
 */
export default async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.authorization !== 'Bearer ' + cronSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const sb = getSupabase();

  // Yesterday's date range (UTC)
  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setUTCHours(0, 0, 0, 0);
  const yesterdayStart = new Date(todayStart);
  yesterdayStart.setUTCDate(yesterdayStart.getUTCDate() - 1);

  const yStart = yesterdayStart.toISOString();
  const yEnd = todayStart.toISOString();

  const yesterdayLabel = yesterdayStart.toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/Chicago',
  });

  try {
    // Parallel queries for yesterday's data
    const [
      { data: newBookings },
      { data: completedBookings },
      { data: cancelledBookings },
      { data: pendingAll },
      { data: newApps },
      { data: activeAssemblers },
    ] = await Promise.all([
      sb.from('bookings').select('id, ref, service, customer_name, payment_status, amount_charged')
        .gte('created_at', yStart).lt('created_at', yEnd),
      sb.from('bookings').select('id, ref, service, amount_charged, payment_status')
        .eq('status', 'completed').gte('completed_at', yStart).lt('completed_at', yEnd),
      sb.from('bookings').select('id, ref')
        .eq('status', 'cancelled').gte('cancelled_at', yStart).lt('cancelled_at', yEnd),
      sb.from('bookings').select('id').eq('status', 'pending'),
      sb.from('profiles').select('id, full_name, email')
        .eq('role', 'assembler').eq('application_status', 'applied')
        .gte('created_at', yStart).lt('created_at', yEnd),
      sb.from('profiles').select('id')
        .eq('role', 'assembler').in('tier', ['starter', 'verified', 'elite']),
    ]);

    // Revenue: sum captured amounts from yesterday's completed bookings
    const revenueYesterday = (completedBookings || []).reduce((sum, b) => {
      return b.payment_status === 'captured' ? sum + (b.amount_charged || 0) : sum;
    }, 0);

    const revDisplay = revenueYesterday > 0 ? `$${(revenueYesterday / 100).toFixed(2)}` : '$0.00';

    const html = buildDailySummaryEmail({
      date: yesterdayLabel,
      newBookings: newBookings || [],
      completedCount: (completedBookings || []).length,
      cancelledCount: (cancelledBookings || []).length,
      pendingCount: (pendingAll || []).length,
      newApps: newApps || [],
      activeAssemblerCount: (activeAssemblers || []).length,
      revenue: revDisplay,
    });

    await sendEmail({
      to: ownerEmail(),
      from: 'AssembleAtEase <booking@assembleatease.com>',
      subject: `Daily Summary — ${yesterdayLabel}`,
      html,
    });

    return res.status(200).json({ sent: true, date: yesterdayLabel });
  } catch (err) {
    console.error('Daily summary cron error:', err);
    return res.status(500).json({ error: 'Summary failed' });
  }
}

function buildDailySummaryEmail({ date, newBookings, completedCount, cancelledCount, pendingCount, newApps, activeAssemblerCount, revenue }) {
  const bookingRows = newBookings.length
    ? newBookings.map(b => `
      <tr>
        <td style="padding:8px 10px;border-bottom:1px solid #f0f0f0;font-size:13px;font-weight:600">${b.ref}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #f0f0f0;font-size:13px">${b.service}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #f0f0f0;font-size:13px">${b.customer_name}</td>
      </tr>`).join('')
    : `<tr><td colspan="3" style="padding:12px 10px;font-size:13px;color:#71717a;text-align:center">No new bookings yesterday</td></tr>`;

  const appRows = newApps.length
    ? newApps.map(a => `<li style="padding:3px 0;font-size:13px">${a.full_name} — ${a.email}</li>`).join('')
    : '';

  return `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1a1a1a">
<div style="max-width:640px;margin:0 auto;padding:24px 16px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px 8px 0 0;border-bottom:3px solid #0097a7"><tr>
    <td style="padding:20px 24px"><table cellpadding="0" cellspacing="0"><tr>
      <td><img src="${LOGO}" alt="AssembleAtEase" width="36" height="36" style="border-radius:50%;display:block"/></td>
      <td style="padding-left:12px;font-size:16px;font-weight:700;color:#1a1a1a">AssembleAtEase</td>
    </tr></table></td>
    <td style="padding:20px 24px;text-align:right;font-size:12px;color:#71717a">Daily Summary</td>
  </tr></table>

  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-left:1px solid #e4e4e7;border-right:1px solid #e4e4e7"><tr><td style="padding:28px 24px">
    <p style="margin:0 0 4px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:#71717a">Daily Briefing</p>
    <p style="margin:0 0 24px;font-size:22px;font-weight:700;color:#1a1a1a">${date}</p>

    <!-- KPIs -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px">
      <tr>
        <td style="width:25%;padding:0 6px 0 0">
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-radius:6px"><tr><td style="padding:14px 16px;text-align:center">
            <p style="margin:0 0 4px;font-size:11px;color:#71717a;font-weight:600;text-transform:uppercase;letter-spacing:0.5px">New Bookings</p>
            <p style="margin:0;font-size:24px;font-weight:700;color:#0097a7">${newBookings.length}</p>
          </td></tr></table>
        </td>
        <td style="width:25%;padding:0 6px">
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-radius:6px"><tr><td style="padding:14px 16px;text-align:center">
            <p style="margin:0 0 4px;font-size:11px;color:#71717a;font-weight:600;text-transform:uppercase;letter-spacing:0.5px">Completed</p>
            <p style="margin:0;font-size:24px;font-weight:700;color:#065f46">${completedCount}</p>
          </td></tr></table>
        </td>
        <td style="width:25%;padding:0 6px">
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-radius:6px"><tr><td style="padding:14px 16px;text-align:center">
            <p style="margin:0 0 4px;font-size:11px;color:#71717a;font-weight:600;text-transform:uppercase;letter-spacing:0.5px">Revenue</p>
            <p style="margin:0;font-size:24px;font-weight:700;color:#065f46">${revenue}</p>
          </td></tr></table>
        </td>
        <td style="width:25%;padding:0 0 0 6px">
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-radius:6px"><tr><td style="padding:14px 16px;text-align:center">
            <p style="margin:0 0 4px;font-size:11px;color:#71717a;font-weight:600;text-transform:uppercase;letter-spacing:0.5px">Cancelled</p>
            <p style="margin:0;font-size:24px;font-weight:700;color:${cancelledCount > 0 ? '#dc2626' : '#1a1a1a'}">${cancelledCount}</p>
          </td></tr></table>
        </td>
      </tr>
    </table>

    <!-- Status row -->
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-radius:6px;margin-bottom:24px"><tr><td style="padding:14px 18px">
      <table width="100%" cellpadding="0" cellspacing="0" style="font-size:13px">
        <tr>
          <td style="padding:4px 0;color:#71717a;width:50%">Pending Bookings (total)</td>
          <td style="padding:4px 0;font-weight:600">${pendingCount} ${pendingCount > 5 ? '<span style="color:#dc2626">⚠ Action needed</span>' : ''}</td>
        </tr>
        <tr>
          <td style="padding:4px 0;color:#71717a">Active Assemblers</td>
          <td style="padding:4px 0;font-weight:600">${activeAssemblerCount}</td>
        </tr>
        ${newApps.length > 0 ? `<tr><td style="padding:4px 0;color:#71717a">New Applications</td><td style="padding:4px 0;font-weight:600;color:#0097a7">${newApps.length} new</td></tr>` : ''}
      </table>
    </td></tr></table>

    <!-- New bookings table -->
    <p style="margin:0 0 10px;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#71717a">Yesterday's New Bookings</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e4e4e7;border-radius:6px;overflow:hidden;margin-bottom:24px">
      <tr style="background:#fafafa">
        <th style="padding:8px 10px;font-size:11px;font-weight:600;text-align:left;color:#71717a;border-bottom:1px solid #e4e4e7">Ref</th>
        <th style="padding:8px 10px;font-size:11px;font-weight:600;text-align:left;color:#71717a;border-bottom:1px solid #e4e4e7">Service</th>
        <th style="padding:8px 10px;font-size:11px;font-weight:600;text-align:left;color:#71717a;border-bottom:1px solid #e4e4e7">Customer</th>
      </tr>
      ${bookingRows}
    </table>

    ${newApps.length > 0 ? `
    <!-- New assembler applications -->
    <p style="margin:0 0 10px;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#71717a">New Assembler Applications</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:6px;margin-bottom:24px"><tr><td style="padding:14px 18px">
      <ul style="margin:0;padding-left:16px">${appRows}</ul>
    </td></tr></table>` : ''}

  </td></tr></table>

  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-top:none;border-radius:0 0 8px 8px"><tr><td style="padding:14px 24px;text-align:center;font-size:11px;color:#a1a1aa">
    AssembleAtEase &bull; Austin, TX &bull; Daily automated summary
  </td></tr></table>
</div></body></html>`;
}
