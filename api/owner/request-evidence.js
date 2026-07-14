import { getSupabase } from '../_supabase.js';
import { verifyOwner, sendEmail, ownerEmail, esc } from '../_email.js';
import { logActivity } from '../booking/_activity.js';
import { sendPushToUser } from '../_push.js';

const LOGO = 'https://www.assembleatease.com/images/logo.jpg';

/**
 * POST /api/owner/request-evidence
 * Owner-only: request that the assigned Easer uploads completion evidence.
 * Sets evidence_requested_at on the booking; payout.js blocks payout until
 * at least one evidence row exists for this booking.
 * Body: { bookingId }
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const bookingId = String(req.body?.bookingId || '').trim();
  if (!bookingId) return res.status(400).json({ error: 'bookingId required' });

  const sb = getSupabase();
  const { data: requestedRows, error: requestError } = await sb.rpc('request_booking_evidence_hold', {
    p_booking_id: bookingId,
  });
  if (requestError) {
    console.error('request-evidence reservation error:', requestError);
    const status = requestError.code === 'P0002'
      ? 404
      : (['23505', '23514', '55P03', '22000'].includes(requestError.code) ? 409 : 503);
    return res.status(status).json({
      error: status === 503
        ? 'Evidence request safety checks could not be verified. No payout hold was changed.'
        : requestError.message,
      code: status === 503 ? 'EVIDENCE_REQUEST_RESERVATION_FAILED' : 'EVIDENCE_REQUEST_CONFLICT',
    });
  }
  const requested = Array.isArray(requestedRows) ? requestedRows[0] : requestedRows;
  if (!requested) {
    return res.status(503).json({
      error: 'Evidence request safety checks returned no booking. No notification was sent.',
      code: 'EVIDENCE_REQUEST_RESERVATION_FAILED',
    });
  }
  const booking = {
    id: requested.booking_id,
    ref: requested.booking_ref,
    status: requested.booking_status,
    assembler_id: requested.assembler_id,
    assembler_name: requested.assembler_name,
    service: requested.service,
    date: requested.booking_date,
    evidence_requested_at: requested.evidence_requested_at,
  };

  // Load Easer profile for email + push
  const { data: profile } = await sb
    .from('profiles')
    .select('email, full_name')
    .eq('id', booking.assembler_id)
    .maybeSingle();

  const firstName = (profile?.full_name || 'there').split(' ')[0];

  if (profile?.email) {
    try {
      await sendEmail({
        to: profile.email,
        from: 'AssembleAtEase <booking@assembleatease.com>',
        subject: `Action Required: Upload Evidence for Job ${booking.ref}`,
        html: buildEvidenceRequestEmail({ firstName, ref: booking.ref, service: booking.service, date: booking.date }),
        replyTo: ownerEmail(),
      });
    } catch (e) {
      console.error('request-evidence email error:', e);
    }
  }

  try {
    await sendPushToUser(
      booking.assembler_id,
      {
        title: 'Evidence Upload Required',
        body: `Please upload photos for your completed job (${booking.ref}). Your payout is on hold until received.`,
        url: '/assembler/my-assignments.html',
      },
      { bookingId: booking.id, notificationType: 'evidence_request', recipientType: 'easer' }
    );
  } catch (e) {
    console.error('request-evidence push error:', e);
  }

  await logActivity(sb, {
    bookingId: booking.id,
    eventType: 'evidence_requested',
    actorType: 'owner',
    actorName: 'Owner',
    description: `Evidence upload requested from ${booking.assembler_name || 'Easer'} — payout held pending upload`,
    metadata: { assemblerName: booking.assembler_name, ref: booking.ref },
  });

  return res.status(200).json({
    success: true,
    ref: booking.ref,
    evidenceRequestedAt: booking.evidence_requested_at,
  });
}

function buildEvidenceRequestEmail({ firstName, ref, service, date }) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1a1a1a">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px 8px 0 0;border-bottom:1px solid #e4e4e7"><tr><td style="padding:20px 24px;text-align:center">
    <img src="${LOGO}" alt="AssembleAtEase" width="44" height="44" style="border-radius:50%;display:inline-block"/>
    <p style="margin:8px 0 0;font-size:17px;font-weight:700;color:#1a1a1a">AssembleAtEase</p>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-left:1px solid #e4e4e7;border-right:1px solid #e4e4e7"><tr><td style="padding:32px 24px 24px">
    <p style="margin:0 0 8px;font-size:24px;font-weight:700;color:#1a1a1a">Action Required, ${esc(firstName)}</p>
    <p style="margin:0 0 20px;font-size:15px;color:#52525b;line-height:1.7">We need you to upload completion photos for a recently finished job. Your payout will remain on hold until we receive this evidence.</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fffbeb;border:1px solid #fde68a;border-radius:6px;margin-bottom:20px"><tr><td style="padding:14px 18px;font-size:14px">
      <table width="100%">
        <tr><td style="padding:6px 0;color:#71717a;width:110px;border-bottom:1px solid #fef3c7">Reference</td><td style="padding:6px 0;border-bottom:1px solid #fef3c7;font-weight:600">${esc(ref)}</td></tr>
        <tr><td style="padding:6px 0;color:#71717a;border-bottom:1px solid #fef3c7">Service</td><td style="padding:6px 0;border-bottom:1px solid #fef3c7">${esc(service || '—')}</td></tr>
        <tr><td style="padding:6px 0;color:#71717a">Date</td><td style="padding:6px 0">${esc(date || 'Completed')}</td></tr>
      </table>
    </td></tr></table>
    <p style="margin:0 0 16px;font-size:14px;color:#52525b;line-height:1.6">Please open your Easer dashboard, find this job under <strong>Completed</strong>, and upload at least one photo showing the finished work.</p>
    <table width="100%" cellpadding="0" cellspacing="0"><tr><td style="text-align:center;padding:4px 0 20px">
      <a href="https://www.assembleatease.com/assembler/my-assignments.html" style="display:inline-block;background:#059669;color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:15px;font-weight:600">Open My Assignments</a>
    </td></tr></table>
    <p style="margin:0;font-size:13px;color:#71717a;line-height:1.6">Questions? Contact <a href="mailto:service@assembleatease.com" style="color:#00BFFF">service@assembleatease.com</a>.</p>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-top:none;border-radius:0 0 8px 8px"><tr><td style="padding:16px 24px;text-align:center;font-size:11px;color:#a1a1aa">
    AssembleAtEase &bull; Austin, TX &bull; <a href="mailto:service@assembleatease.com" style="color:#71717a">service@assembleatease.com</a>
  </td></tr></table>
</div></body></html>`;
}
