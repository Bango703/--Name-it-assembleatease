import { normalizeUsPhone } from './_phone.js';

const CONVERSATION_STATUSES = new Set(['open', 'archived']);
const MESSAGE_DIRECTIONS = new Set(['inbound', 'outbound']);
const MESSAGE_SENDERS = new Set(['customer', 'easer', 'owner', 'system']);
const MESSAGE_STATUSES = new Set(['received', 'queued', 'provider_accepted', 'sent', 'delivered', 'delivery_delayed', 'failed', 'suppressed']);

function clean(value, maxLength) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, maxLength) || null;
}

function timestamp(value) {
  const date = new Date(value || Date.now());
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

async function latestLinkedBooking(sb, phone) {
  const variants = [phone, phone.replace(/^\+1/, ''), phone.replace(/^\+/, '')].filter(Boolean);
  const { data, error } = await sb.from('bookings')
    .select('id, ref, customer_name, customer_email, customer_phone, sms_consent_at, sms_opted_out_at')
    .in('customer_phone', variants)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function linkedEaser(sb, phone) {
  const variants = [phone, phone.replace(/^\+1/, ''), phone.replace(/^\+/, '')].filter(Boolean);
  const { data, error } = await sb.from('profiles')
    .select('id, full_name, email, phone, role, status, sms_consent_at, sms_opted_out_at')
    .eq('role', 'assembler')
    .in('phone', variants)
    // profiles has created_at, not updated_at — ordering by a missing column
    // threw 'column profiles.updated_at does not exist' and killed every inbound text.
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

export async function findSmsContact(sb, phone) {
  const booking = await latestLinkedBooking(sb, phone);
  const easer = await linkedEaser(sb, phone);
  if (booking) return { booking, easer, recipient: { phone, sms_consent_at: booking.sms_consent_at, sms_opted_out_at: booking.sms_opted_out_at } };
  if (easer) return { booking: null, easer, recipient: { phone, sms_consent_at: easer.sms_consent_at, sms_opted_out_at: easer.sms_opted_out_at } };
  return { booking: null, easer: null, recipient: { phone, sms_consent_at: null, sms_opted_out_at: null } };
}

async function openConversation(sb, input) {
  const phone = normalizeUsPhone(input.phone);
  if (!phone) throw new Error('A valid phone number is required for an SMS conversation');
  const booking = input.booking || null;
  const easer = input.easer || null;
  const occurredAt = timestamp(input.occurredAt);
  const preview = clean(input.body, 500) || '(No text)';

  const { data: existing, error: findError } = await sb.from('sms_conversations')
    .select('id, status, unread_count')
    .eq('phone', phone)
    .maybeSingle();
  if (findError) throw findError;

  if (!existing) {
    const { data, error } = await sb.from('sms_conversations')
      .insert({
        phone,
        customer_name: clean(booking?.customer_name, 120),
        customer_email: clean(booking?.customer_email, 254),
        booking_id: booking?.id || null,
        easer_id: easer?.id || null,
        status: 'open',
        last_message_at: occurredAt,
        last_message_preview: preview,
        unread_count: input.direction === 'inbound' ? 1 : 0,
      })
      .select('id, status, unread_count')
      .single();
    if (error && error.code !== '23505') throw error;
    if (data?.id) return { id: data.id, status: data.status, unreadCount: data.unread_count };
  }

  const unreadCount = Number(existing.unread_count || 0) + (input.direction === 'inbound' ? 1 : 0);
  const { data, error } = await sb.from('sms_conversations')
    .update({
      customer_name: clean(booking?.customer_name, 120),
      customer_email: clean(booking?.customer_email, 254),
      booking_id: booking?.id || null,
      easer_id: easer?.id || null,
      status: existing.status === 'archived' ? 'open' : existing.status,
      last_message_at: occurredAt,
      last_message_preview: preview,
      unread_count: unreadCount,
      updated_at: occurredAt,
    })
    .eq('id', existing.id)
    .select('id, status, unread_count')
    .single();
  if (error) throw error;
  return { id: data.id, status: data.status, unreadCount: data.unread_count };
}

export async function recordSmsConversationMessage(sb, input = {}) {
  const direction = String(input.direction || '').toLowerCase();
  const sender = String(input.sender || '').toLowerCase();
  const status = String(input.status || '').toLowerCase();
  if (!MESSAGE_DIRECTIONS.has(direction)) throw new Error('Invalid SMS message direction');
  if (!MESSAGE_SENDERS.has(sender)) throw new Error('Invalid SMS message sender');
  if (!MESSAGE_STATUSES.has(status)) throw new Error('Invalid SMS message status');
  const body = String(input.body || '').trim();
  if (!body) throw new Error('SMS message body is required');
  if (body.length > 2000) throw new Error('SMS message body is too long');
  const phone = normalizeUsPhone(input.phone);
  if (!phone) throw new Error('A valid phone number is required');

  const booking = input.booking === undefined ? await latestLinkedBooking(sb, phone) : input.booking;
  const easer = input.easer === undefined ? await linkedEaser(sb, phone) : input.easer;
  const conversation = await openConversation(sb, {
    phone, booking, easer, body, direction, occurredAt: input.occurredAt,
  });

  if (input.providerId) {
    const { data: duplicate, error: duplicateError } = await sb.from('sms_messages')
      .select('id, conversation_id')
      .eq('provider_id', input.providerId)
      .maybeSingle();
    if (duplicateError) throw duplicateError;
    if (duplicate?.id) return { messageId: duplicate.id, conversationId: duplicate.conversation_id, duplicate: true };
  }

  const { data, error } = await sb.from('sms_messages')
    .insert({
      conversation_id: conversation.id,
      booking_id: booking?.id || null,
      direction,
      sender,
      phone,
      body: body.slice(0, 2000),
      provider_id: input.providerId || null,
      notification_id: input.notificationId || null,
      status,
      error_text: clean(input.errorText, 500),
      read_at: direction === 'inbound' ? null : timestamp(input.occurredAt),
      occurred_at: timestamp(input.occurredAt),
    })
    .select('id, conversation_id')
    .single();
  if (error) {
    if (error.code === '23505' && input.providerId) {
      const { data: duplicate } = await sb.from('sms_messages')
        .select('id, conversation_id')
        .eq('provider_id', input.providerId)
        .maybeSingle();
      if (duplicate?.id) return { messageId: duplicate.id, conversationId: duplicate.conversation_id, duplicate: true };
    }
    throw error;
  }
  return { messageId: data.id, conversationId: data.conversation_id, duplicate: false };
}

export async function markSmsConversationRead(sb, conversationId, at = new Date().toISOString()) {
  const stamp = timestamp(at);
  const { error: messagesError } = await sb.from('sms_messages')
    .update({ read_at: stamp })
    .eq('conversation_id', conversationId)
    .eq('direction', 'inbound')
    .is('read_at', null);
  if (messagesError) throw messagesError;
  const { data, error } = await sb.from('sms_conversations')
    .update({ unread_count: 0, updated_at: stamp })
    .eq('id', conversationId)
    .select('id')
    .single();
  if (error) throw error;
  return data;
}

export function normalizeSmsConversationStatus(value) {
  const status = String(value || '').trim().toLowerCase();
  return CONVERSATION_STATUSES.has(status) ? status : null;
}
