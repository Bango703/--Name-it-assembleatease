import { getSupabase } from './_supabase.js';
import { normalizeUsPhone } from './_phone.js';

/**
 * THE SMS sender. Every text the platform sends goes through here.
 *
 * Mirrors api/_email.js deliberately: one module owns the send, one place writes
 * to notification_log, and a failure is reported rather than thrown — a text that
 * does not go out must never strand a booking, an assignment, or a dispatch.
 *
 * REFUSES TO SEND WITHOUT RECORDED CONSENT.
 * TCPA requires prior express consent for an automated text. A phone number on
 * file is NOT consent to text it — someone gave that number so a pro could call
 * about a job. Consent is a recorded timestamp (migration 076) or there is no
 * send. This is the one rule in this file that has legal consequences, so it is
 * checked server-side on every send and cannot be bypassed by a caller.
 *
 * Opt-out beats everything. Telnyx blocks a STOP number at the carrier, but the
 * platform must not keep queueing messages into a void and reporting them as
 * sent.
 */

const TELNYX_API = 'https://api.telnyx.com/v2/messages';

export function isSmsEnabled() {
  return Boolean(
    (process.env.TELNYX_API_KEY || '').trim()
    && (process.env.TELNYX_FROM_NUMBER || '').trim(),
  );
}

/**
 * May we text this person right now? Returns a reason when not, so the owner is
 * shown WHY a text did not go rather than silence.
 */
export function smsEligibility(subject = {}) {
  const phone = normalizeUsPhone(subject.phone);
  if (!phone) return { ok: false, reason: 'no_valid_phone' };
  if (subject.sms_opted_out_at) return { ok: false, reason: 'opted_out' };
  if (!subject.sms_consent_at) return { ok: false, reason: 'no_consent_recorded' };
  return { ok: true, phone };
}

/**
 * Send one transactional SMS.
 *
 * @param {object}  opts
 * @param {object}  opts.recipient        Row carrying phone + consent columns.
 * @param {string}  opts.body             Message text. Keep it under 160 chars.
 * @param {object}  opts.meta             { bookingId, notificationType, recipientType, recipientUserId }
 * @returns {Promise<{ok:boolean, skipped?:string, providerId?:string, error?:string}>}
 *          Never throws. The caller decides what a failure means.
 */
export async function sendSms({ recipient, body, meta = {} }) {
  const sb = getSupabase();

  if (!isSmsEnabled()) {
    return { ok: false, skipped: 'sms_not_configured' };
  }

  const eligible = smsEligibility(recipient);
  if (!eligible.ok) {
    // Logged, not silent: "we did not text them, and here is why" is
    // operational truth the owner needs (Article 16).
    await logSms(sb, {
      meta,
      to: recipient?.phone || null,
      body,
      status: 'suppressed',
      errorText: eligible.reason,
      providerId: null,
    });
    return { ok: false, skipped: eligible.reason };
  }

  const text = String(body || '').trim();
  if (!text) return { ok: false, skipped: 'empty_body' };

  // Every message carries the opt-out instruction. Carriers expect it and it is
  // the difference between a compliant programme and a complaint.
  const withOptOut = text.length > 130 ? text : `${text} Reply STOP to opt out.`;

  let providerId = null;
  let status = 'provider_accepted';
  let errorText = null;

  try {
    const payload = {
      from: (process.env.TELNYX_FROM_NUMBER || '').trim(),
      to: eligible.phone,
      text: withOptOut,
    };
    const profileId = (process.env.TELNYX_MESSAGING_PROFILE_ID || '').trim();
    if (profileId) payload.messaging_profile_id = profileId;

    const resp = await fetch(TELNYX_API, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${(process.env.TELNYX_API_KEY || '').trim()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const raw = await resp.text();
    let parsed = null;
    try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }

    if (!resp.ok) {
      status = 'failed';
      errorText = (parsed?.errors || [])
        .map(e => e?.detail || e?.title)
        .filter(Boolean)
        .join('; ') || `HTTP ${resp.status}`;
    } else {
      providerId = parsed?.data?.id || null;
    }
  } catch (err) {
    status = 'failed';
    errorText = err?.message || String(err);
  }

  await logSms(sb, { meta, to: eligible.phone, body: withOptOut, status, errorText, providerId });

  if (status === 'failed') {
    console.error('[sms] send failed:', meta.notificationType, errorText);
    return { ok: false, error: errorText };
  }
  return { ok: true, providerId };
}

/**
 * Record the attempt. 'provider_accepted' means Telnyx took it, NOT that it
 * arrived — the webhook upgrades it to delivered/failed later, exactly as email
 * does. Logging never throws: a logging fault must not fail a send.
 */
async function logSms(sb, { meta, to, body, status, errorText, providerId }) {
  try {
    await sb.from('notification_log').insert({
      channel: 'sms',
      booking_id: meta.bookingId || null,
      notification_type: meta.notificationType || 'sms',
      recipient_type: meta.recipientType || null,
      recipient_user_id: meta.recipientUserId || null,
      recipient_email: to,           // the address column, holding a phone for SMS
      subject: String(body || '').slice(0, 160),
      status,
      provider_id: providerId,
      error_text: errorText,
    });
  } catch (err) {
    console.error('[sms] notification_log write failed:', err?.message || err);
  }
}

/** Record consent at the moment it is given. */
export async function recordSmsConsent(sb, { table, id, source }) {
  if (!table || !id) return { ok: false };
  try {
    const { error } = await sb.from(table).update({
      sms_consent_at: new Date().toISOString(),
      sms_consent_source: String(source || 'unspecified').slice(0, 80),
      // Fresh consent lifts a prior opt-out; that is what opting back in means.
      sms_opted_out_at: null,
    }).eq('id', id);
    if (error) throw error;
    return { ok: true };
  } catch (err) {
    console.error('[sms] consent write failed:', err?.message || err);
    return { ok: false, error: err?.message || String(err) };
  }
}
