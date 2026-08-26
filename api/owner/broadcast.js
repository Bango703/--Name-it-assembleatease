import { getSupabase } from '../_supabase.js';
import { verifyOwner, sendEmail, ownerEmail, esc } from '../_email.js';
import { normalizeEmail, unsubscribeUrl, broadcastFooter } from '../_broadcast.js';
import { governedSend, describeGovernedRun, remainingDailyBudget } from '../_send-governor.js';

// Give the send loop headroom (Pro plans honor this).
export const config = { maxDuration: 60 };

const LOGO = 'https://www.assembleatease.com/images/logo.jpg';
const AUDIENCES = new Set(['past_customers', 'marketing_optins']);
// Cap per send so the function stays well within its time budget. At launch
// scale the list is far smaller; larger lists need batched sending (future).
// Pacing, retry, and the platform-wide 24h ceiling live in _send-governor.js —
// this number only bounds how much work one HTTP request takes on.
const MAX_RECIPIENTS = 250;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function buildBroadcastHtml(bodyHtml, email) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1a1a1a">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;border:1px solid #e4e4e7"><tr><td style="padding:28px 24px">
    <div style="text-align:center;margin-bottom:20px">
      <img src="${LOGO}" alt="AssembleAtEase" width="44" height="44" style="border-radius:50%;display:inline-block"/>
      <p style="margin:8px 0 0;font-size:17px;font-weight:700;color:#1a1a1a">AssembleAtEase</p>
    </div>
    <div style="font-size:15px;color:#1a1a1a;line-height:1.7">${bodyHtml}</div>
    ${broadcastFooter(email)}
  </td></tr></table>
</div></body></html>`;
}

// Returns the shape the governor understands: `status` lets a 429 be retried
// instead of being recorded as a permanent failure and silently dropped.
async function sendOne(email, subject, bodyHtml) {
  try {
    const result = await sendEmail({
      to: email,
      from: 'AssembleAtEase <booking@assembleatease.com>',
      subject,
      html: buildBroadcastHtml(bodyHtml, email),
      replyTo: ownerEmail(),
      meta: {
        notificationType: 'broadcast',
        recipientType: 'customer',
        disableDedupe: true,
        listUnsubscribe: unsubscribeUrl(email),
      },
    });
    return {
      ok: !!(result?.ok && !result?.suppressed),
      status: result?.status || null,
      error: result?.error || null,
    };
  } catch (err) {
    console.error('broadcast send error for', email, err?.message || err);
    return { ok: false, error: err?.message || String(err) };
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const audience = String(req.body?.audience || '').trim();
  const subject = String(req.body?.subject || '').trim();
  const bodyHtml = String(req.body?.bodyHtml || '').trim();
  const testEmail = normalizeEmail(req.body?.testEmail || '');

  if (!subject) return res.status(400).json({ error: 'A subject is required.' });
  if (!bodyHtml) return res.status(400).json({ error: 'A message body is required.' });
  if (!testEmail && !AUDIENCES.has(audience)) {
    return res.status(400).json({ error: 'Choose a valid audience.' });
  }

  const sb = getSupabase();

  // ── Test send: one email to the owner's chosen address, nothing logged as a broadcast ──
  if (testEmail) {
    if (!EMAIL_RE.test(testEmail)) return res.status(400).json({ error: 'Enter a valid test email.' });
    const ok = await sendOne(testEmail, `[TEST] ${subject}`, bodyHtml);
    await sb.from('email_broadcasts').insert({
      audience: AUDIENCES.has(audience) ? audience : 'past_customers',
      subject, recipient_count: 1, sent_count: ok ? 1 : 0, failed_count: ok ? 0 : 1, is_test: true,
    }).then(() => {}, () => {});
    return res.status(ok ? 200 : 502).json({ ok, test: true, sentTo: testEmail });
  }

  // ── Resolve the audience ──
  let candidates = [];
  if (audience === 'past_customers') {
    const { data, error } = await sb.from('bookings')
      .select('customer_email')
      .not('customer_email', 'is', null);
    if (error) { console.error('broadcast audience query failed:', error.message); return res.status(503).json({ error: 'Could not load recipients.' }); }
    candidates = (data || []).map(r => r.customer_email);
  } else {
    const { data, error } = await sb.from('email_marketing_optins').select('email');
    if (error) { console.error('broadcast optin query failed:', error.message); return res.status(503).json({ error: 'Could not load recipients.' }); }
    candidates = (data || []).map(r => r.email);
  }

  // Normalize + dedupe + validate.
  const unique = [...new Set(candidates.map(normalizeEmail).filter(e => EMAIL_RE.test(e)))];

  // Filter out everyone who has unsubscribed.
  const { data: suppRows, error: suppErr } = await sb.from('email_suppressions').select('email');
  if (suppErr) { console.error('broadcast suppression query failed:', suppErr.message); return res.status(503).json({ error: 'Could not verify the opt-out list. No email was sent.' }); }
  const suppressed = new Set((suppRows || []).map(r => normalizeEmail(r.email)));
  const recipients = unique.filter(e => !suppressed.has(e));
  const suppressedCount = unique.length - recipients.length;

  // Pre-send count so the owner sees exactly how many people this will email
  // (and how many are opted out) before committing. Nothing is sent.
  if (req.body?.countOnly === true) {
    return res.status(200).json({ ok: true, countOnly: true, audience, recipientCount: recipients.length, suppressed: suppressedCount });
  }

  if (recipients.length === 0) {
    return res.status(200).json({ ok: true, recipientCount: 0, sent: 0, failed: 0, suppressed: suppressedCount, message: 'No eligible recipients (all opted out or none on this list).' });
  }
  if (recipients.length > MAX_RECIPIENTS) {
    return res.status(413).json({
      error: `This list has ${recipients.length} recipients. The current sender handles up to ${MAX_RECIPIENTS} per send — ask for batched sending before a list this large.`,
      code: 'RECIPIENT_LIMIT',
      recipientCount: recipients.length,
    });
  }

  // Refuse a list the day's remaining budget cannot cover, rather than sending
  // part of it and leaving the owner unsure who actually received the message.
  const budget = await remainingDailyBudget(sb);
  if (recipients.length > budget.remaining) {
    return res.status(429).json({
      error: `Sending ${recipients.length} emails would pass the platform 24-hour email ceiling. ${budget.used} of ${budget.ceiling} are already used, so ${budget.remaining} remain. Nothing was sent — wait for the window to clear or split this into smaller sends.`,
      code: 'DAILY_EMAIL_CEILING',
      recipientCount: recipients.length,
      ceiling: budget.ceiling,
      used: budget.used,
      remaining: budget.remaining,
    });
  }

  // ── Paced, capped, retried send ──
  const run = await governedSend(
    recipients,
    (email) => sendOne(email, subject, bodyHtml),
    { sb, maxPerRun: MAX_RECIPIENTS, label: `broadcast:${audience}` },
  );
  const sent = run.sent;
  const failed = run.failed;

  await sb.from('email_broadcasts').insert({
    audience, subject,
    recipient_count: recipients.length,
    sent_count: sent, failed_count: failed, suppressed_count: suppressedCount,
    is_test: false, created_by: 'owner',
  }).then(() => {}, () => {});

  return res.status(200).json({
    ok: true, audience,
    recipientCount: recipients.length,
    sent, failed, suppressed: suppressedCount,
    notSent: run.skipped,
    stoppedBy: run.stoppedBy,
    summary: describeGovernedRun(run),
  });
}
