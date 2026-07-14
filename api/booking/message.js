import { getSupabase } from '../_supabase.js';
import { verifyOwner, sendEmail, ownerEmail, esc } from '../_email.js';
import { sendPushToUser } from '../_push.js';
import { logActivity } from './_activity.js';
import {
  authenticateBearerUser,
  requireAssignedWorkEaser,
  respondWithEaserAccessError,
} from '../_easer-access.js';
import { customerOwnsBooking } from './_customer-booking-auth.js';

const SITE = 'https://www.assembleatease.com';

export default async function handler(req, res) {
  // GET — owner or the active, approved Easer assigned to the booking.
  if (req.method === 'GET') {
    const { bookingId, ref } = req.query || {};
    if (!bookingId && !ref) return res.status(400).json({ error: 'bookingId or ref query param required' });
    const sb = getSupabase();
    const ownerRequest = verifyOwner(req);
    let easerAccess = null;
    if (!ownerRequest) {
      easerAccess = await requireAssignedWorkEaser(req, { supabase: sb });
      if (!easerAccess.ok) return respondWithEaserAccessError(res, easerAccess);
    }

    let bq = sb.from('bookings').select('id, assembler_id');
    if (bookingId) bq = bq.eq('id', bookingId); else bq = bq.eq('ref', ref);
    const { data: bk, error: bkErr } = await bq.maybeSingle();
    if (bkErr) return res.status(500).json({ error: 'Failed to verify booking access' });
    if (!bk) return res.status(404).json({ error: 'Booking not found' });
    if (!ownerRequest && bk.assembler_id !== easerAccess.user.id) {
      return res.status(404).json({ error: 'Booking not found' });
    }
    let messagesQuery = sb
      .from('messages')
      .select('id, booking_id, sender, sender_user_id, recipient_type, recipient_user_id, body, created_at, read_at')
      .eq('booking_id', bk.id);
    if (!ownerRequest) {
      // Assignment alone is not message ownership: after reassignment, role-
      // only rows could disclose the prior Easer's thread. Legacy rows with no
      // user identity intentionally remain owner-only.
      messagesQuery = messagesQuery.or(
        `sender_user_id.eq.${easerAccess.user.id},recipient_user_id.eq.${easerAccess.user.id}`,
      );
    }
    const { data: msgs, error: msgsErr } = await messagesQuery
      .order('created_at', { ascending: true });
    if (msgsErr) return res.status(500).json({ error: 'Failed to fetch messages' });

    const readRecipient = ownerRequest ? 'owner' : 'assembler';
    const unreadIds = (msgs || [])
      .filter(message => message.recipient_type === readRecipient
        && (ownerRequest || message.recipient_user_id === easerAccess.user.id)
        && !message.read_at)
      .map(message => message.id);
    if (unreadIds.length) {
      let readQuery = sb
        .from('messages')
        .update({ read_at: new Date().toISOString() })
        .in('id', unreadIds)
        .eq('recipient_type', readRecipient);
      if (!ownerRequest) {
        readQuery = readQuery.eq('recipient_user_id', easerAccess.user.id);
      }
      const { error: readError } = await readQuery.is('read_at', null);
      if (readError) {
        console.error('Message read-state update error:', readError);
        return res.status(503).json({ error: 'Messages loaded, but read state could not be secured. Please retry.' });
      }
    }
    return res.status(200).json({ messages: msgs || [] });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { bookingId, ref, body: msgBody, sender, target } = req.body || {};
  if (!bookingId && !ref) return res.status(400).json({ error: 'bookingId or ref is required' });
  const messageText = typeof msgBody === 'string' ? msgBody.trim() : '';
  if (!messageText) return res.status(400).json({ error: 'Message body is required' });
  if (messageText.length > 2000) return res.status(400).json({ error: 'Message must be 2000 characters or fewer' });

  const sb = getSupabase();

  // Authenticate before looking up a caller-supplied booking identifier.
  let resolvedSender;
  let resolvedRecipient;
  let authenticatedUser = null;
  if (sender === 'owner') {
    if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });
    resolvedSender = 'owner';
    resolvedRecipient = target === 'assembler' ? 'assembler' : target === 'customer' ? 'customer' : null;
    if (!resolvedRecipient) {
      return res.status(400).json({ error: 'Owner messages require target customer or assembler' });
    }
  } else if (sender === 'assembler') {
    const easerAccess = await requireAssignedWorkEaser(req, { supabase: sb });
    if (!easerAccess.ok) return respondWithEaserAccessError(res, easerAccess);
    authenticatedUser = easerAccess.user;
    resolvedSender = 'assembler';
    resolvedRecipient = 'owner';
  } else {
    const authenticated = await authenticateBearerUser(req);
    if (!authenticated.ok) {
      return res.status(authenticated.status).json({ error: authenticated.error });
    }
    authenticatedUser = authenticated.user;
    resolvedSender = 'customer';
    resolvedRecipient = 'owner';
  }

  let query = sb.from('bookings').select('*');
  if (bookingId) query = query.eq('id', bookingId);
  else query = query.eq('ref', ref);
  const { data: booking, error: fetchErr } = await query.maybeSingle();
  if (fetchErr) return res.status(500).json({ error: 'Failed to verify booking access' });
  if (!booking) return res.status(404).json({ error: 'Booking not found' });

  if (resolvedSender === 'assembler'
      && (!booking.assembler_id || booking.assembler_id !== authenticatedUser.id)) {
    return res.status(404).json({ error: 'Booking not found' });
  }
  if (resolvedSender === 'customer') {
    if (!customerOwnsBooking(booking, authenticatedUser)) {
      return res.status(404).json({ error: 'Booking not found' });
    }
  }
  if (resolvedSender === 'owner' && target === 'assembler' && !booking.assembler_id) {
    return res.status(409).json({ error: 'No Easer is assigned to this booking' });
  }

  // Insert message
  const { data: message, error: insertErr } = await sb
    .from('messages')
    .insert({
      booking_id: booking.id,
      sender: resolvedSender,
      sender_user_id: authenticatedUser?.id || null,
      recipient_type: resolvedRecipient,
      recipient_user_id: resolvedSender === 'owner' && resolvedRecipient === 'assembler'
        ? booking.assembler_id
        : null,
      body: messageText,
    })
    .select()
    .single();

  if (insertErr) {
    console.error('Message insert error:', insertErr);
    return res.status(500).json({ error: 'Failed to save message' });
  }

  // Send notification email to the other party. Message persistence remains
  // authoritative even if this notification fails.
  let notificationResult = null;
  let notificationFailure = null;
  try {
    const LOGO = 'https://www.assembleatease.com/images/logo.jpg';
    const sBody = esc(messageText);

    if (resolvedSender === 'owner' && target === 'assembler') {
      // Notify assigned Easer
      const { data: { user: easerUser }, error: easerErr } = await sb.auth.admin.getUserById(booking.assembler_id);
      if (easerErr || !easerUser?.email) {
        throw new Error('Message was saved, but the assigned Easer email could not be resolved');
      }
      const easerHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1a1a1a">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px 8px 0 0;border-bottom:1px solid #e4e4e7"><tr><td style="padding:20px 24px;text-align:center">
    <img src="${LOGO}" alt="AssembleAtEase" width="44" height="44" style="border-radius:50%;display:inline-block"/>
    <p style="margin:8px 0 0;font-size:17px;font-weight:700;color:#1a1a1a">AssembleAtEase</p>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-left:1px solid #e4e4e7;border-right:1px solid #e4e4e7"><tr><td style="padding:28px 24px">
    <p style="margin:0 0 6px;font-size:20px;font-weight:700;color:#1a1a1a">Job update from dispatcher</p>
    <p style="margin:0 0 20px;font-size:13px;color:#71717a">Ref: ${esc(booking.ref)} &bull; ${esc(booking.service)}</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-radius:6px"><tr><td style="padding:16px 18px">
      <p style="margin:0;font-size:14px;color:#1a1a1a;line-height:1.7">${sBody}</p>
    </td></tr></table>
    <p style="margin:20px 0 0;font-size:13px;color:#52525b">Reply to this email if you have questions.</p>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-top:none;border-radius:0 0 8px 8px"><tr><td style="padding:16px 24px;text-align:center;font-size:11px;color:#a1a1aa">
    AssembleAtEase &bull; Austin, TX &bull; <a href="mailto:service@assembleatease.com" style="color:#71717a">service@assembleatease.com</a>
  </td></tr></table>
</div></body></html>`;
      notificationResult = await sendEmail({
        to: easerUser.email,
        from: 'AssembleAtEase <booking@assembleatease.com>',
        subject: 'Job update from dispatcher — ' + booking.ref,
        html: easerHtml,
        replyTo: ownerEmail(),
        meta: {
          bookingId: booking.id,
          notificationType: 'owner_message',
          recipientType: 'easer',
          recipientUserId: booking.assembler_id,
          disableDedupe: true,
        },
      });
      // Push the message straight to the Easer's device so it isn't silent —
      // same channel as job offers. Email alone is easy to miss on a job.
      sendPushToUser(booking.assembler_id, {
        title: 'New message from dispatch',
        body: messageText.slice(0, 140),
        url: SITE + '/assembler/my-assignments',
        jobId: booking.id,
      }, { bookingId: booking.id, notificationType: 'owner_message', recipientType: 'easer' }).catch(() => {});
    } else if (resolvedSender === 'owner') {
      // Notify customer
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1a1a1a">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px 8px 0 0;border-bottom:1px solid #e4e4e7"><tr><td style="padding:20px 24px;text-align:center">
    <img src="${LOGO}" alt="AssembleAtEase" width="44" height="44" style="border-radius:50%;display:inline-block"/>
    <p style="margin:8px 0 0;font-size:17px;font-weight:700;color:#1a1a1a">AssembleAtEase</p>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-left:1px solid #e4e4e7;border-right:1px solid #e4e4e7"><tr><td style="padding:28px 24px">
    <p style="margin:0 0 6px;font-size:20px;font-weight:700;color:#1a1a1a">New message about your booking</p>
    <p style="margin:0 0 20px;font-size:13px;color:#71717a">Ref: ${esc(booking.ref)}</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-radius:6px"><tr><td style="padding:16px 18px">
      <p style="margin:0;font-size:14px;color:#1a1a1a;line-height:1.7">${sBody}</p>
    </td></tr></table>
    <p style="margin:20px 0 0;font-size:13px;color:#52525b">Reply to this email to respond.</p>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-top:none;border-radius:0 0 8px 8px"><tr><td style="padding:16px 24px;text-align:center;font-size:11px;color:#a1a1aa">
    AssembleAtEase &bull; Austin, TX &bull; <a href="mailto:service@assembleatease.com" style="color:#71717a">service@assembleatease.com</a>
  </td></tr></table>
</div></body></html>`;
      notificationResult = await sendEmail({
        to: booking.customer_email,
        from: 'AssembleAtEase <booking@assembleatease.com>',
        subject: 'Message about booking ' + booking.ref,
        html,
        replyTo: ownerEmail(),
        meta: {
          bookingId: booking.id,
          notificationType: 'owner_message',
          recipientType: 'customer',
          disableDedupe: true,
        },
      });
    } else if (resolvedSender === 'assembler') {
      // Notify owner about assembler message
      notificationResult = await sendEmail({
        to: ownerEmail(),
        from: 'AssembleAtEase Bookings <booking@assembleatease.com>',
        subject: 'Easer Message — ' + booking.ref,
        html: `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1a1a1a">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;border:1px solid #e4e4e7"><tr><td style="padding:28px 24px">
    <p style="margin:0 0 4px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:#71717a">Booking ${esc(booking.ref)} &mdash; Easer Message</p>
    <p style="margin:0 0 16px;font-size:18px;font-weight:700;color:#1a1a1a">Message from your Easer</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-radius:6px;margin-bottom:16px"><tr><td style="padding:16px 18px">
      <p style="margin:0;font-size:14px;color:#1a1a1a;line-height:1.7">${sBody}</p>
    </td></tr></table>
    <p style="margin:0;font-size:13px;color:#71717a">Service: ${esc(booking.service)} &bull; Customer: ${esc(booking.customer_name)}</p>
  </td></tr></table>
</div></body></html>`,
        replyTo: ownerEmail(),
        meta: {
          bookingId: booking.id,
          notificationType: 'easer_message',
          recipientType: 'owner',
          disableDedupe: true,
        },
      });
    } else {
      // Customer message — notify owner
      notificationResult = await sendEmail({
        to: ownerEmail(),
        from: 'AssembleAtEase Bookings <booking@assembleatease.com>',
        subject: 'Customer Reply — ' + booking.ref + ' from ' + booking.customer_name,
        html: `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1a1a1a">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px 8px 0 0;border-bottom:3px solid #00BFFF"><tr><td style="padding:20px 24px">
    <table cellpadding="0" cellspacing="0"><tr>
      <td><img src="${LOGO}" alt="AssembleAtEase" width="36" height="36" style="border-radius:50%;display:block"/></td>
      <td style="padding-left:12px;font-size:16px;font-weight:700;color:#1a1a1a">AssembleAtEase</td>
    </tr></table>
  </td><td style="padding:20px 24px;text-align:right;font-size:12px;color:#71717a">Customer Message</td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-left:1px solid #e4e4e7;border-right:1px solid #e4e4e7"><tr><td style="padding:28px 24px">
    <p style="margin:0 0 4px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:#71717a">Booking ${esc(booking.ref)}</p>
    <p style="margin:0 0 20px;font-size:20px;font-weight:700;color:#1a1a1a">Reply from ${esc(booking.customer_name)}</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-radius:6px"><tr><td style="padding:16px 18px">
      <p style="margin:0;font-size:14px;color:#1a1a1a;line-height:1.7">${sBody}</p>
    </td></tr></table>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:6px"><tr><td style="padding:14px 18px">
      <p style="margin:0;font-size:13px;color:#1e40af">Contact <strong>${esc(booking.customer_name)}</strong> at <a href="mailto:${esc(booking.customer_email)}" style="color:#1e40af">${esc(booking.customer_email)}</a>.</p>
    </td></tr></table>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-top:none;border-radius:0 0 8px 8px"><tr><td style="padding:16px 24px;text-align:center;font-size:11px;color:#a1a1aa">AssembleAtEase &bull; Austin, TX</td></tr></table>
</div></body></html>`,
        replyTo: booking.customer_email,
        meta: {
          bookingId: booking.id,
          notificationType: 'customer_message',
          recipientType: 'owner',
          disableDedupe: true,
        },
      });
    }
    if (notificationResult?.ok !== true || notificationResult?.suppressed === true) {
      throw new Error(notificationResult?.error || notificationResult?.reason || 'Message notification was not delivered');
    }
  } catch (emailErr) {
    console.error('Message email error:', emailErr);
    notificationFailure = emailErr?.message || String(emailErr);
    await logActivity(sb, {
      bookingId: booking.id,
      eventType: 'message_notification_failed',
      actorType: 'system',
      actorName: 'notifications',
      description: `Message ${message.id} was saved, but its notification failed.`,
      metadata: {
        messageId: message.id,
        sender: resolvedSender,
        recipientType: resolvedRecipient,
        error: notificationFailure,
      },
    }).catch(activityError => {
      console.error('Message notification failure activity log error:', activityError?.message || activityError);
    });
  }

  return res.status(200).json({
    success: true,
    message: { id: message.id, sender: resolvedSender, recipientType: resolvedRecipient },
    notification: notificationFailure
      ? { delivered: false, warning: 'Message saved, but the notification was not delivered.' }
      : { delivered: true },
  });
}
