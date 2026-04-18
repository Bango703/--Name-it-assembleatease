import { getSupabase } from '../_supabase.js';
import { verifyOwner, sendEmail, buildStatusEmail, ownerEmail, esc } from '../_email.js';
import { updateDealStage } from '../_hubspot.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const { bookingId, ref } = req.body;
  if (!bookingId && !ref) return res.status(400).json({ error: 'bookingId or ref is required' });

  const sb = getSupabase();

  let query = sb.from('bookings').select('*');
  if (bookingId) query = query.eq('id', bookingId);
  else query = query.eq('ref', ref);
  const { data: booking, error: fetchErr } = await query.single();

  if (fetchErr || !booking) return res.status(404).json({ error: 'Booking not found' });
  if (booking.status !== 'confirmed') {
    return res.status(400).json({ error: 'Only confirmed bookings can be completed. Current status: ' + booking.status });
  }

  const { error: updateErr } = await sb
    .from('bookings')
    .update({ status: 'completed', completed_at: new Date().toISOString() })
    .eq('id', booking.id);

  if (updateErr) {
    console.error('Complete update error:', updateErr);
    return res.status(500).json({ error: 'Failed to update booking' });
  }

  // Send completion email with review link
  try {
    const reviewUrl = process.env.GOOGLE_REVIEW_URL || 'https://www.assembleatease.com';
    const html = buildStatusEmail({
      customerName: booking.customer_name,
      ref: booking.ref,
      status: 'COMPLETED',
      statusColor: '#065f46',
      statusBg: '#d1fae5',
      headline: `Job complete! Thank you, ${esc(booking.customer_name)}.`,
      bodyHtml: `
        <p style="margin:0 0 20px;font-size:15px;color:#52525b;line-height:1.7">Your <strong>${esc(booking.service)}</strong> service has been completed. We hope you're happy with the work!</p>
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:6px;margin-bottom:20px"><tr><td style="padding:18px 20px;text-align:center">
          <p style="margin:0 0 8px;font-size:15px;font-weight:700;color:#1e40af">Enjoyed the service?</p>
          <p style="margin:0 0 16px;font-size:13px;color:#1e40af;line-height:1.6">A quick review helps other Austin homeowners find reliable help.</p>
          <a href="${esc(reviewUrl)}" style="display:inline-block;background:#0097a7;color:#ffffff;padding:12px 32px;border-radius:6px;text-decoration:none;font-size:14px;font-weight:600">Leave a Review &#9733;</a>
        </td></tr></table>
        <p style="margin:0;font-size:14px;color:#52525b;line-height:1.7">Need anything else? We'd love to help again anytime.</p>`,
    });

    await sendEmail({
      to: booking.customer_email,
      from: 'AssembleAtEase <booking@assembleatease.com>',
      subject: 'Job Complete — How did we do? ' + booking.ref,
      html,
      replyTo: ownerEmail(),
    });
  } catch (emailErr) {
    console.error('Complete email error:', emailErr);
  }

  // Non-blocking HubSpot stage update
  if (booking.hubspot_deal_id) {
    updateDealStage(booking.hubspot_deal_id, 'closedwon').catch(e => console.error('HubSpot complete stage error:', e));
  }

  return res.status(200).json({ success: true, booking: { id: booking.id, ref: booking.ref, status: 'completed' } });
}
