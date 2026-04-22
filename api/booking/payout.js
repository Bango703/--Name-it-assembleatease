import { getSupabase } from '../_supabase.js';
import { verifyOwner, sendEmail, ownerEmail, esc } from '../_email.js';

const LOGO = 'https://www.assembleatease.com/images/logo.jpg';

/**
 * POST /api/booking/payout
 * Owner-only: record that an assembler was paid out for a completed job.
 * Body: { bookingId?, ref?, amount (cents), notes? }
 * Sends the assembler a payout confirmation email (#17).
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const { bookingId, ref, amount, notes } = req.body;
  if (!bookingId && !ref) return res.status(400).json({ error: 'bookingId or ref is required' });

  const sb = getSupabase();

  let query = sb.from('bookings').select('*, profiles!bookings_assembler_id_fkey(id, full_name, email)');
  if (bookingId) query = query.eq('id', bookingId);
  else query = query.eq('ref', ref);
  const { data: booking, error: fetchErr } = await query.single();

  if (fetchErr || !booking) return res.status(404).json({ error: 'Booking not found' });
  if (booking.status !== 'completed') {
    return res.status(400).json({ error: 'Only completed bookings can be paid out. Current status: ' + booking.status });
  }
  if (!booking.assembler_id) {
    return res.status(400).json({ error: 'No assembler assigned to this booking' });
  }

  // Auto-derive payout from assembler_due (recorded at job completion), or fall back to 80% of amount_charged
  const PLATFORM_FEE_PCT = Math.min(100, Math.max(0, parseInt(process.env.PLATFORM_FEE_PCT || '20')));
  const derivedDue = booking.assembler_due != null
    ? booking.assembler_due
    : Math.round((booking.amount_charged || 0) * (1 - PLATFORM_FEE_PCT / 100));

  const payoutCents = amount ? parseInt(amount) : derivedDue;
  if (!payoutCents || payoutCents <= 0) return res.status(400).json({ error: 'Cannot determine payout amount — no assembler_due recorded and no amount supplied' });

  const payoutDisplay = `$${(payoutCents / 100).toFixed(2)}`;
  const platformRevenue = (booking.amount_charged || 0) - payoutCents;

  // Record payout
  const { error: updateErr } = await sb.from('bookings').update({
    payout_amount: payoutCents,
    paid_out_at: new Date().toISOString(),
    payout_notes: notes?.trim() || null,
    payout_status: 'paid',
    platform_revenue: platformRevenue,
  }).eq('id', booking.id);

  if (updateErr) {
    console.error('Payout DB update error:', updateErr);
    return res.status(500).json({ error: 'Failed to record payout' });
  }

  // #17 — Send assembler payout notification email
  const assembler = booking.profiles;
  if (assembler?.email) {
    try {
      await sendEmail({
        to: assembler.email,
        from: 'AssembleAtEase <booking@assembleatease.com>',
        subject: `Payout Sent — ${booking.ref} — ${payoutDisplay}`,
        html: buildPayoutEmail({
          firstName: (assembler.full_name || 'there').split(' ')[0],
          ref: booking.ref,
          service: booking.service,
          date: booking.date,
          payoutDisplay,
          notes: notes?.trim() || null,
        }),
        replyTo: ownerEmail(),
      });
    } catch (e) {
      console.error('Payout email error:', e);
    }
  }

  return res.status(200).json({
    success: true,
    bookingRef: booking.ref,
    assemblerId: booking.assembler_id,
    payoutAmount: payoutCents,
    platformRevenue,
    amountCharged: booking.amount_charged || 0,
  });
}

function buildPayoutEmail({ firstName, ref, service, date, payoutDisplay, notes }) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1a1a1a">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px 8px 0 0;border-bottom:1px solid #e4e4e7"><tr><td style="padding:20px 24px;text-align:center">
    <img src="${LOGO}" alt="AssembleAtEase" width="44" height="44" style="border-radius:50%;display:inline-block"/>
    <p style="margin:8px 0 0;font-size:17px;font-weight:700;color:#1a1a1a">AssembleAtEase</p>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-left:1px solid #e4e4e7;border-right:1px solid #e4e4e7"><tr><td style="padding:32px 24px 24px">
    <p style="margin:0 0 8px;font-size:24px;font-weight:700;color:#1a1a1a">You've been paid, ${esc(firstName)}!</p>
    <p style="margin:0 0 20px;font-size:15px;color:#52525b;line-height:1.7">We've sent your payout for the following completed job. Thank you for your great work!</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;margin-bottom:20px"><tr><td style="padding:18px 20px">
      <p style="margin:0 0 4px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:#166534">Payout Amount</p>
      <p style="margin:0;font-size:26px;font-weight:700;color:#065f46">${esc(payoutDisplay)}</p>
    </td></tr></table>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-radius:6px;margin-bottom:20px"><tr><td style="padding:14px 18px;font-size:14px">
      <table width="100%">
        <tr><td style="padding:6px 0;color:#71717a;width:110px;border-bottom:1px solid #f0f0f0">Reference</td><td style="padding:6px 0;border-bottom:1px solid #f0f0f0;font-weight:600">${esc(ref)}</td></tr>
        <tr><td style="padding:6px 0;color:#71717a;border-bottom:1px solid #f0f0f0">Service</td><td style="padding:6px 0;border-bottom:1px solid #f0f0f0">${esc(service)}</td></tr>
        <tr><td style="padding:6px 0;color:#71717a">Date</td><td style="padding:6px 0">${esc(date || 'Completed')}</td></tr>
        ${notes ? `<tr><td style="padding:6px 0;color:#71717a;vertical-align:top">Notes</td><td style="padding:6px 0">${esc(notes)}</td></tr>` : ''}
      </table>
    </td></tr></table>
    <p style="margin:0;font-size:13px;color:#71717a;line-height:1.6">Questions about your payout? Contact <a href="mailto:service@assembleatease.com" style="color:#0097a7">service@assembleatease.com</a>.</p>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-top:none;border-radius:0 0 8px 8px"><tr><td style="padding:16px 24px;text-align:center;font-size:11px;color:#a1a1aa">
    AssembleAtEase &bull; Austin, TX &bull; <a href="mailto:service@assembleatease.com" style="color:#71717a">service@assembleatease.com</a>
  </td></tr></table>
</div></body></html>`;
}
