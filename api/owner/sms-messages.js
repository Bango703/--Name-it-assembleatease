import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';
import { rateLimit } from '../_ratelimit.js';
import { normalizeUsPhone } from '../_phone.js';
import { sendSms } from '../_sms.js';
import {
  findSmsContact,
  markSmsConversationRead,
  normalizeSmsConversationStatus,
  recordSmsConversationMessage,
} from '../_sms-conversations.js';

function clean(value, maxLength) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, maxLength) || null;
}

async function getConversation(res, conversationId) {
  const sb = getSupabase();
  const { data: conversation, error: conversationError } = await sb.from('sms_conversations')
    .select('id, phone, customer_name, customer_email, booking_id, easer_id, status, unread_count, last_message_at, bookings(id, ref, service, status)')
    .eq('id', conversationId)
    .maybeSingle();
  if (conversationError) {
    console.error('Owner SMS conversation lookup error:', conversationError);
    return res.status(503).json({ error: 'SMS conversation could not be verified. The migration may not be applied yet.' });
  }
  if (!conversation) return res.status(404).json({ error: 'SMS conversation not found' });
  if (conversation.easer_id) {
    const { data: profile } = await sb.from('profiles').select('id, full_name, email').eq('id', conversation.easer_id).maybeSingle();
    conversation.profiles = profile || null;
  }

  const { data: messages, error: messagesError } = await sb.from('sms_messages')
    .select('id, conversation_id, booking_id, direction, sender, phone, body, provider_id, notification_id, status, error_text, read_at, occurred_at, created_at')
    .eq('conversation_id', conversationId)
    .order('occurred_at', { ascending: true });
  if (messagesError) {
    console.error('Owner SMS message load error:', messagesError);
    return res.status(503).json({ error: 'SMS messages could not be loaded. The migration may not be applied yet.' });
  }

  try {
    await markSmsConversationRead(sb, conversationId);
  } catch (readError) {
    console.error('Owner SMS read-state update failed:', readError);
    return res.status(503).json({
      error: 'Messages loaded, but the unread state could not be updated. Refresh and try again.',
      messages: messages || [],
      conversation,
    });
  }

  const contact = await findSmsContact(sb, conversation.phone);
  return res.status(200).json({
    conversation,
    messages: messages || [],
    replyEligibility: {
      consentRecorded: Boolean(contact.recipient.sms_consent_at),
      optedOut: Boolean(contact.recipient.sms_opted_out_at),
      customerBookingId: contact.booking?.id || null,
      easerId: contact.easer?.id || null,
    },
  });
}

async function replyToConversation(req, res, conversationId) {
  const body = clean(req.body?.body, 2000);
  if (!body) return res.status(400).json({ error: 'Reply text is required' });
  const sb = getSupabase();

  const { data: conversation, error: conversationError } = await sb.from('sms_conversations')
    .select('id, phone, status, booking_id, easer_id')
    .eq('id', conversationId)
    .maybeSingle();
  if (conversationError) {
    console.error('Owner SMS reply lookup error:', conversationError);
    return res.status(503).json({ error: 'SMS conversation could not be verified. The migration may not be applied yet.' });
  }
  if (!conversation) return res.status(404).json({ error: 'SMS conversation not found' });
  if (normalizeSmsConversationStatus(conversation.status) !== 'open') {
    return res.status(409).json({ error: 'This conversation is archived.' });
  }

  const phone = normalizeUsPhone(conversation.phone);
  if (!phone) return res.status(409).json({ error: 'This conversation does not have a valid phone number.' });
  const contact = await findSmsContact(sb, phone);
  const result = await sendSms({
    recipient: contact.recipient,
    body,
    meta: {
      bookingId: conversation.booking_id || contact.booking?.id || null,
      notificationType: 'owner_sms_reply',
      recipientType: contact.easer ? 'easer' : 'customer',
      recipientUserId: contact.easer?.id || null,
    },
  });

  const { data: notification, error: notificationError } = await sb.from('notification_log')
    .select('id, provider_id, status')
    .eq('channel', 'sms')
    .eq('notification_type', 'owner_sms_reply')
    .eq('recipient_email', phone)
    .order('sent_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (notificationError) console.error('Owner SMS reply notification lookup error:', notificationError);

  if (!result.ok) {
    const { data: blockedMessage, error: blockedError } = await sb.from('sms_messages')
      .insert({
        conversation_id: conversation.id,
        booking_id: conversation.booking_id || contact.booking?.id || null,
        direction: 'outbound',
        sender: 'owner',
        phone,
        body,
        notification_id: notification?.id || null,
        status: 'suppressed',
        error_text: result.skipped || result.error || 'sms_blocked',
        read_at: new Date().toISOString(),
        occurred_at: new Date().toISOString(),
      })
      .select('id')
      .single();
    if (blockedError) console.error('Owner SMS blocked reply save error:', blockedError);
    return res.status(409).json({
      error: 'The reply was not sent because this phone number does not currently have text-message consent.',
      code: 'SMS_REPLY_BLOCKED',
      reason: result.skipped || result.error || null,
      messageId: blockedMessage?.id || null,
    });
  }

  await recordSmsConversationMessage(sb, {
    phone,
    booking: contact.booking,
    easer: contact.easer,
    direction: 'outbound',
    sender: 'owner',
    body,
    status: notification?.status || 'provider_accepted',
    providerId: notification?.provider_id || result.providerId || null,
    notificationId: notification?.id || null,
    occurredAt: new Date().toISOString(),
  });

  return res.status(200).json({ sent: true, providerId: notification?.provider_id || result.providerId || null });
}

export default async function handler(req, res) {
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });
  const ip = String(req.headers?.['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  if (!(await rateLimit(ip, 'default'))) return res.status(429).json({ error: 'Too many requests. Please wait a moment.' });

  const conversationId = String(req.query?.conversationId || req.body?.conversationId || '').trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(conversationId)) {
    return res.status(400).json({ error: 'A valid conversation ID is required' });
  }

  if (req.method === 'GET') return getConversation(res, conversationId);
  if (req.method === 'POST') return replyToConversation(req, res, conversationId);
  return res.status(405).json({ error: 'Method not allowed' });
}
