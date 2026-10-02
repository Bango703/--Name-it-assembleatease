/**
 * Text the owner when someone is waiting on them.
 *
 * Owner, 2026-10-01: "I DONT GET SMS MESSAGES?" Customer and Easer messages
 * written to the owner arrived by email only; texts went to Easers and
 * customers, never the owner. This sends the owner a short text for a message
 * that needs them (the same rule as the Messages inbox, api/_owner-inbox.js),
 * to OWNER_PERSONAL_PHONE, the owner's own number already used for owner calls.
 *
 * A burst is one doorbell: at most one text per booking per 30 minutes, except
 * urgent Easer reports, which always go. The message itself is not in the text;
 * it is in the dashboard and the email.
 */
import { sendSms as defaultSendSms } from './_sms.js';
import { normalizeUsPhone } from './_phone.js';

export const OWNER_MESSAGE_TEXT_TYPE = 'owner_message_text';
const THROTTLE_MS = 30 * 60 * 1000;

export function ownerTextBody({ fromParty, ref, urgent = false }) {
  const who = fromParty === 'assembler' ? 'Your Easer' : 'A customer';
  return `AssembleAtEase: ${urgent ? 'URGENT - ' : ''}${who} messaged you about ${ref}. Reply in Messages at assembleatease.com/owner`;
}

export async function textOwnerAboutMessage({ sb, booking, fromParty, urgent = false }, {
  env = process.env, sendSms = defaultSendSms, now = Date.now,
} = {}) {
  const phone = normalizeUsPhone(env.OWNER_PERSONAL_PHONE);
  if (!phone) return { ok: false, skipped: 'owner_phone_not_set' };
  if (!urgent) {
    const since = new Date(now() - THROTTLE_MS).toISOString();
    const { data: recent, error } = await sb.from('notification_log')
      .select('id')
      .eq('channel', 'sms')
      .eq('booking_id', booking.id)
      .eq('notification_type', OWNER_MESSAGE_TEXT_TYPE)
      .gte('created_at', since)
      .limit(1);
    // A failed lookup sends anyway: a duplicate text beats a missed customer.
    if (!error && recent?.length) return { ok: false, skipped: 'recently_texted' };
  }
  return sendSms({
    // The owner's own number, set by the owner for owner alerts, is the consent.
    recipient: { phone, sms_consent_at: 'owner_configured' },
    body: ownerTextBody({ fromParty, ref: booking.ref, urgent }),
    meta: { bookingId: booking.id, notificationType: OWNER_MESSAGE_TEXT_TYPE, recipientType: 'owner' },
  }).catch(error => ({ ok: false, error: error?.message || String(error) }));
}
