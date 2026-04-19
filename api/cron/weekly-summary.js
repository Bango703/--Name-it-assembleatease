import { getSupabase } from '../_supabase.js';
import { sendEmail, ownerEmail } from '../_email.js';

const LOGO = 'https://www.assembleatease.com/images/logo.jpg';

/**
 * GET /api/cron/weekly-summary
 * Runs every Monday at 9 AM CT. Sends Travis the previous week's revenue & activity summary.
 * Schedule: 0 14 * * 1  (9 AM CT = 14:00 UTC)
 */
export default async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.authorization !== 'Bearer ' + cronSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const sb = getSupabase();

  // Last week: Monday–Sunday
  const now = new Date();
  const dayOfWeek = now.getUTCDay(); // 0=Sun, 1=Mon
  const daysToLastMonday = dayOfWeek === 1 ? 7 : (dayOfWeek + 6) % 7;
  const lastMonday = new Date(now);
  lastMonday.setUTCDate(now.getUTCDate() - daysToLastMonday);
  lastMonday.setUTCHours(0, 0, 0, 0);
  const lastSunday = new Date(lastMonday);
  lastSunday.setUTCDate(lastMonday.getUTCDate() + 7);

  const wStart = lastMonday.toISOString();
  const wEnd = lastSunday.toISOString();

  const weekLabel = `${lastMonday.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Chicago' })} – ${new Date(lastSunday.getTime() - 1).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Chicago' })}`;

  try {
    const [
      { data: newBookings },
      { data: completedBookings },
      { data: cancelledBookings },
      { data: newApps },
      { data: approvedAssemblers },
      { data: allActive },
    ] = await Promise.all([
      sb.from('bookings').select('id, ref, service, customer_name, status')
        .gte('created_at', wStart).lt('created_at', wEnd),
      sb.from('bookings').select('id, ref, service, amount_charged, payment_status')
        .eq('status', 'completed').gte('completed_at', wStart).lt('completed_at', wEnd),
      sb.from('bookings').select('id')
        .eq('status', 'cancelled').gte('cancelled_at', wStart).lt('cancelled_at', wEnd),
      sb.from('profiles').select('id, full_name')
        .eq('role', 'assembler').eq('application_status', 'applied')
        .gte('created_at', wStart).lt('created_at', wEnd),
      sb.from('profiles').select('id')
        .eq('role', 'assembler').eq('application_status', 'approved')
        .gte('approved_at', wStart).lt('approved_at', wEnd),
      sb.from('profiles').select('id').eq('role', 'assembler').in('tier', ['starter', 'verified', 'elite']),
    ]);

    const revenue = (completedBookings || []).reduce((sum, b) => {
      return b.payment_status === 'captured' ? sum + (b.amount_charged || 0) : sum;
    }, 0);

    const avgJobValue = completedBookings?.length
      ? revenue / completedBookings.length
      : 0;

    const html = buildWeeklySummaryEmail({
      weekLabel,
      newBookingCount: (newBookings || []).length,
      completedCount: (completedBookings || []).length,
      cancelledCount: (cancelledBookings || []).length,
      revenue: revenue > 0 ? `$${(revenue / 100).toFixed(2)}` : '$0.00',
      avgJobValue: avgJobValue > 0 ? `$${(avgJobValue / 100).toFixed(2)}` : 'N/A',
      newAppCount: (newApps || []).length,
      newApprovedCount: (approvedAssemblers || []).length,
      activeAssemblerCount: (allActive || []).length,
      recentBookings: (newBookings || []).slice(0, 10),
    });

    await sendEmail({
      to: ownerEmail(),
      from: 'AssembleAtEase <booking@assembleatease.com>',
      subject: `Weekly Revenue Summary — ${weekLabel}`,
      html,
    });

    return res.status(200).json({ sent: true, week: weekLabel });
  } catch (err) {
    console.error('Weekly summary cron error:', err);
    return res.status(500).json({ error: 'Summary failed' });
  }
}

function buildWeeklySummaryEmail({
  weekLabel, newBookingCount, completedCount, cancelledCount,
  revenue, avgJobValue, newAppCount, newApprovedCount,
  activeAssemblerCount, recentBookings,
}) {
  const bookingRows = recentBookings.length
    ? recentBookings.map(b => `
      <tr>
        <td style="padding:8px 10px;border-bottom:1px solid #f0f0f0;font-size:13px;font-weight:600">${b.ref}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #f0f0f0;font-size:13px">${b.service}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #f0f0f0;font-size:13px">${b.customer_name}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #f0f0f0;font-size:12px"><span style="display:inline-block;background:${b.status === 'completed' ? '#d1fae5' : b.status === 'cancelled' ? '#f4f4f5' : '#fef3c7'};color:${b.status === 'completed' ? '#065f46' : b.status === 'cancelled' ? '#71717a' : '#92400e'};padding:2px 8px;border-radius:99px;font-weight:600;text-transform:uppercase;font-size:10px">${b.status}</span></td>
      </tr>`).join('')
    : `<tr><td colspan="4" style="padding:12px 10px;font-size:13px;color:#71717a;text-align:center">No bookings this week</td></tr>`;

  return `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1a1a1a">
<div style="max-width:640px;margin:0 auto;padding:24px 16px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px 8px 0 0;border-bottom:3px solid #0097a7"><tr>
    <td style="padding:20px 24px"><table cellpadding="0" cellspacing="0"><tr>
      <td><img src="${LOGO}" alt="AssembleAtEase" width="36" height="36" style="border-radius:50%;display:block"/></td>
      <td style="padding-left:12px;font-size:16px;font-weight:700;color:#1a1a1a">AssembleAtEase</td>
    </tr></table></td>
    <td style="padding:20px 24px;text-align:right;font-size:12px;color:#71717a">Weekly Summary</td>
  </tr></table>

  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-left:1px solid #e4e4e7;border-right:1px solid #e4e4e7"><tr><td style="padding:28px 24px">
    <p style="margin:0 0 4px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:#71717a">Weekly Revenue Summary</p>
    <p style="margin:0 0 8px;font-size:22px;font-weight:700;color:#1a1a1a">${weekLabel}</p>
    <p style="margin:0 0 24px;font-size:14px;color:#52525b">Here's how last week went, Travis.</p>

    <!-- Revenue hero -->
    <table width="100%" cellpadding="0" cellspacing="0" style="background:linear-gradient(135deg,#0097a7,#00838f);border-radius:8px;margin-bottom:24px"><tr><td style="padding:24px;text-align:center">
      <p style="margin:0 0 4px;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:1px;color:rgba(255,255,255,0.8)">Total Revenue Captured</p>
      <p style="margin:0;font-size:40px;font-weight:700;color:#ffffff">${revenue}</p>
      <p style="margin:8px 0 0;font-size:12px;color:rgba(255,255,255,0.7)">Avg job value: ${avgJobValue}</p>
    </td></tr></table>

    <!-- KPIs -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px">
      <tr>
        <td style="width:33.3%;padding:0 6px 0 0">
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-radius:6px"><tr><td style="padding:14px 16px;text-align:center">
            <p style="margin:0 0 4px;font-size:11px;color:#71717a;font-weight:600;text-transform:uppercase;letter-spacing:0.5px">New Bookings</p>
            <p style="margin:0;font-size:24px;font-weight:700;color:#0097a7">${newBookingCount}</p>
          </td></tr></table>
        </td>
        <td style="width:33.3%;padding:0 6px">
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-radius:6px"><tr><td style="padding:14px 16px;text-align:center">
            <p style="margin:0 0 4px;font-size:11px;color:#71717a;font-weight:600;text-transform:uppercase;letter-spacing:0.5px">Completed</p>
            <p style="margin:0;font-size:24px;font-weight:700;color:#065f46">${completedCount}</p>
          </td></tr></table>
        </td>
        <td style="width:33.3%;padding:0 0 0 6px">
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-radius:6px"><tr><td style="padding:14px 16px;text-align:center">
            <p style="margin:0 0 4px;font-size:11px;color:#71717a;font-weight:600;text-transform:uppercase;letter-spacing:0.5px">Cancelled</p>
            <p style="margin:0;font-size:24px;font-weight:700;color:${cancelledCount > 0 ? '#dc2626' : '#1a1a1a'}">${cancelledCount}</p>
          </td></tr></table>
        </td>
      </tr>
    </table>

    <!-- Assembler stats -->
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-radius:6px;margin-bottom:24px"><tr><td style="padding:16px 18px">
      <p style="margin:0 0 10px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#71717a">Assembler Stats</p>
      <table width="100%" cellpadding="0" cellspacing="0" style="font-size:13px">
        <tr><td style="padding:4px 0;color:#71717a;width:60%">Active Assemblers</td><td style="padding:4px 0;font-weight:600">${activeAssemblerCount}</td></tr>
        <tr><td style="padding:4px 0;color:#71717a">New Applications</td><td style="padding:4px 0;font-weight:600${newAppCount > 0 ? ';color:#0097a7' : ''}">${newAppCount}</td></tr>
        <tr><td style="padding:4px 0;color:#71717a">Newly Approved</td><td style="padding:4px 0;font-weight:600${newApprovedCount > 0 ? ';color:#065f46' : ''}">${newApprovedCount}</td></tr>
      </table>
    </td></tr></table>

    <!-- Recent bookings -->
    <p style="margin:0 0 10px;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#71717a">Last Week's Bookings</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e4e4e7;border-radius:6px;overflow:hidden">
      <tr style="background:#fafafa">
        <th style="padding:8px 10px;font-size:11px;font-weight:600;text-align:left;color:#71717a;border-bottom:1px solid #e4e4e7">Ref</th>
        <th style="padding:8px 10px;font-size:11px;font-weight:600;text-align:left;color:#71717a;border-bottom:1px solid #e4e4e7">Service</th>
        <th style="padding:8px 10px;font-size:11px;font-weight:600;text-align:left;color:#71717a;border-bottom:1px solid #e4e4e7">Customer</th>
        <th style="padding:8px 10px;font-size:11px;font-weight:600;text-align:left;color:#71717a;border-bottom:1px solid #e4e4e7">Status</th>
      </tr>
      ${bookingRows}
    </table>

  </td></tr></table>

  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-top:none;border-radius:0 0 8px 8px"><tr><td style="padding:14px 24px;text-align:center;font-size:11px;color:#a1a1aa">
    AssembleAtEase &bull; Austin, TX &bull; Weekly automated summary
  </td></tr></table>
</div></body></html>`;
}
