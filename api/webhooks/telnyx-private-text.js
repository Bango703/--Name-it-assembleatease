import { getSupabase } from '../_supabase.js';
import { verifyVoiceSignature } from '../_voice-call-history.js';
import { normalizeUsPhone, formatUsPhone } from '../_phone.js';
import { sendSms } from '../_sms.js';
import { logActivity } from '../booking/_activity.js';
import { inspectRelayMessage } from '../booking/_relay-contact-guard.js';
import { privateTextConfig, openLinesForCaller, leadEaserId, STOP_WORDS, HELP_WORDS } from '../_private-line.js';

/**
 * POST /api/webhooks/telnyx-private-text — private job texts on the
 * AssembleAtEase toll-free line (api/_private-line.js privateTextConfig).
 *
 * A customer texts the line: her text goes to the lead Easer on her open job.
 * The lead Easer texts the line: it goes to the customer. Every relayed text is
 * labelled as coming through AssembleAtEase, passes the contact guard (no phone
 * numbers, emails or payment handles, either way), needs the recipient's text
 * consent, and lands on the booking timeline for the owner. STOP and HELP are
 * never relayed. Its own Telnyx messaging profile: the business number's
 * texts (api/webhooks/telnyx.js) are not handled here.
 */
export const config = { api: { bodyParser: false } };
const MAX_BYTES = 65536;

export default async function handler(req, res, deps = {}) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const publicKey = String(process.env.TELNYX_PUBLIC_KEY || '').trim();
  if (!publicKey) return res.status(503).json({ error: 'Private texts are not configured' });
  let raw;
  try {
    const chunks = [];
    let length = 0;
    for await (const chunk of req) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      length += bytes.length;
      if (length > MAX_BYTES) return res.status(413).json({ error: 'Payload too large' });
      chunks.push(bytes);
    }
    raw = Buffer.concat(chunks);
  } catch {
    return res.status(400).json({ error: 'Unable to read event' });
  }
  if (!(deps.verify || verifyVoiceSignature)(raw, req.headers || {}, publicKey, Date.now())) {
    return res.status(400).json({ error: 'Invalid webhook signature' });
  }
  let event;
  try { event = JSON.parse(raw.toString('utf8')); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }
  const result = await handlePrivateTextEvent(event, {
    cfg: deps.cfg || privateTextConfig(),
    sb: deps.sb || getSupabase(),
    now: deps.now || Date.now(),
    send: deps.send || ((message) => sendSms(message)),
    log: deps.log || logActivity,
  });
  return res.status(200).json({ ok: true, ...result });
}

/** The event logic with every outside call injected (scripts/test-private-calling.mjs). */
export async function handlePrivateTextEvent(event, ctx) {
  const { cfg } = ctx;
  if (String(event?.data?.event_type || '') !== 'message.received') return { ignored: 'not_inbound' };
  const payload = event?.data?.payload || {};
  const to = normalizeUsPhone(payload.to?.[0]?.phone_number || payload.to);
  const from = normalizeUsPhone(payload.from?.phone_number || payload.from);
  if (!cfg.number || to !== cfg.number) return { ignored: 'not_the_private_text_line' };
  if (!from) return { ignored: 'no_sender' };
  const text = String(payload.text || '').trim();
  const word = text.toLowerCase().replace(/[^a-z]/g, '');

  // Carrier keywords are answered or honoured, never relayed.
  if (STOP_WORDS.includes(word)) return { action: 'opt_out_noted' };
  const reply = (body, meta = {}) => ctx.send({
    recipient: { phone: from, sms_consent_at: 'reply', sms_opted_out_at: null },
    body, from: cfg.number, messagingProfileId: cfg.profileId,
    meta: { notificationType: 'private_text_reply', recipientType: 'unknown', ...meta },
  });
  const business = formatUsPhone(cfg.businessNumber) || 'AssembleAtEase';
  if (HELP_WORDS.includes(word)) {
    await reply(`AssembleAtEase job texts. For help call or text ${business}.`);
    return { action: 'help_sent' };
  }
  if (!cfg.enabled) {
    await reply(`This AssembleAtEase number is not taking texts yet. Call or text ${business}.`);
    return { action: 'not_enabled' };
  }

  let lines = await openLinesForCaller(ctx.sb, from, ctx.now);
  if (!lines.length) {
    await reply(`This number is for active AssembleAtEase jobs. For anything else, call or text ${business}.`);
    return { action: 'no_open_job' };
  }
  let message = text;
  if (lines.length > 1) {
    const pick = text.match(/^\s*([1-5])[\s.:)-]+([\s\S]+)$/);
    const chosen = pick ? lines[Number(pick[1]) - 1] : null;
    if (!chosen) {
      const options = lines.slice(0, 5).map((l, i) => `${i + 1} for ${l.booking.date}${l.booking.time ? ' ' + String(l.booking.time).split(/[-–—]/)[0].trim() : ''}`).join(', ');
      await reply(`You have ${lines.length} active jobs. Start your text with ${options}.`);
      return { action: 'asked_which_job' };
    }
    lines = [chosen];
    message = pick[2].trim();
  }
  const line = lines[0];
  if (!message) return { ignored: 'empty' };

  const inspection = inspectRelayMessage(message);
  if (!inspection.ok) {
    await reply('Phone numbers, emails and payment details cannot be sent through AssembleAtEase job texts. Your message was not sent.');
    await ctx.log(ctx.sb, {
      bookingId: line.booking.id, eventType: 'private_text_blocked', actorType: line.callerType, actorName: line.callerType,
      description: `A job text from the ${line.callerType} was not sent: it contained ${inspection.label}.`,
      metadata: { code: inspection.code, text: message.slice(0, 300) },
    }).catch(() => {});
    return { action: 'blocked', code: inspection.code };
  }

  // Who receives it, with their own text consent.
  let recipient;
  let label;
  if (line.callerType === 'customer') {
    const easerId = await leadEaserId(ctx.sb, line.booking);
    const { data: easer } = await ctx.sb.from('profiles').select('id, phone, full_name, sms_consent_at, sms_opted_out_at').eq('id', easerId).maybeSingle();
    recipient = easer ? { id: easer.id, phone: easer.phone, sms_consent_at: easer.sms_consent_at, sms_opted_out_at: easer.sms_opted_out_at } : null;
    const customerFirst = String(line.booking.customer_name || 'your customer').split(/\s+/)[0];
    label = `AssembleAtEase job ${line.booking.ref}, ${customerFirst}: `;
  } else {
    recipient = { phone: line.booking.customer_phone, sms_consent_at: line.booking.sms_consent_at, sms_opted_out_at: line.booking.sms_opted_out_at };
    const proFirst = String(line.booking.assembler_name || 'your pro').split(/\s+/)[0];
    label = `AssembleAtEase, ${proFirst} (your pro): `;
  }
  const sent = recipient ? await ctx.send({
    recipient, body: label + message, from: cfg.number, messagingProfileId: cfg.profileId,
    meta: { bookingId: line.booking.id, notificationType: 'private_text_relay', recipientType: line.callerType === 'customer' ? 'easer' : 'customer' },
  }) : { ok: false, skipped: 'no_recipient' };
  await ctx.log(ctx.sb, {
    bookingId: line.booking.id, eventType: sent?.ok ? 'private_text_relayed' : 'private_text_not_delivered', actorType: line.callerType, actorName: line.callerType,
    description: sent?.ok
      ? `Job text relayed (${line.callerType === 'customer' ? 'customer to Easer' : 'Easer to customer'}).`
      : `Job text not delivered: ${sent?.skipped || sent?.error || 'unknown'}.`,
    metadata: { text: message.slice(0, 300), outcome: sent?.ok ? 'sent' : (sent?.skipped || sent?.error || null) },
  }).catch(() => {});
  if (!sent?.ok) {
    await reply('Your message could not be delivered by text. Use the message box on your job instead.');
    return { action: 'not_delivered', reason: sent?.skipped || sent?.error || null };
  }
  return { action: 'relayed', bookingRef: line.booking.ref, direction: line.callerType };
}
