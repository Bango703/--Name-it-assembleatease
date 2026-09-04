// Sends FAITHFUL previews of key customer + Easer emails to a review inbox,
// rendered from the REAL builders the platform uses (so the buttons and copy
// match production exactly). Subjects are prefixed [PREVIEW].
//   node scripts/preview-emails-send.mjs [recipient@email]
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildStatusEmail, esc } from '../api/_email.js';
import { buildAssignmentEmail } from '../api/booking/assign.js';
import { buildPayoutEmail } from '../api/booking/payout.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TO = process.argv[2] || 'tg703664@gmail.com';
const FROM = 'AssembleAtEase <booking@assembleatease.com>';
const SITE = 'https://www.assembleatease.com';

const env = {};
for (const l of readFileSync(join(ROOT, '.env.local'), 'utf8').split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
}
const KEY = env.RESEND_API_KEY;
if (!KEY) throw new Error('RESEND_API_KEY not found in .env.local');

const ref = 'AAE-PREVIEW1';
const trackBtn = (r) => `<table width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0 0"><tr><td style="text-align:center"><a href="${SITE}/track?ref=${r}" style="display:inline-block;background:#00BFFF;color:#ffffff;font-size:14px;font-weight:600;padding:12px 32px;border-radius:6px;text-decoration:none">Track your booking</a></td></tr></table>`;
const reachUs = (name) => `<p style="margin:18px 0 0;font-size:14px;color:#52525b;line-height:1.7">Need to reach ${esc(name)}? Call or text us at <a href="tel:+19792325139" style="color:#00BFFF;text-decoration:none">(979) 232-5139</a> and we'll connect you.</p>`;

// review-request.js email, reproduced (the real "Leave Your Review" button).
const reviewEmail = `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px 8px 0 0;border-bottom:1px solid #e4e4e7"><tr><td style="padding:20px 24px;text-align:center"><img src="${SITE}/images/logo.jpg" width="44" height="44" style="border-radius:50%"/><p style="margin:8px 0 0;font-size:17px;font-weight:700">AssembleAtEase</p></td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fff;border-left:1px solid #e4e4e7;border-right:1px solid #e4e4e7"><tr><td style="padding:32px 24px 24px">
    <p style="margin:0 0 8px;font-size:24px;font-weight:700;color:#1a1a1a">How was your experience?</p>
    <p style="margin:0 0 8px;font-size:15px;color:#52525b;line-height:1.7">We hope you loved your <strong>King Bed Frame Assembly</strong> service!</p>
    <p style="margin:0 0 24px;font-size:15px;color:#52525b;line-height:1.7">Your booking is already filled in — just click below, pick your stars, and write a couple words. Takes less than a minute.</p>
    <table cellpadding="0" cellspacing="0" style="margin:0 auto 24px"><tr><td style="background:#00BFFF;border-radius:8px"><a href="${SITE}/review?ref=${ref}" style="display:inline-block;padding:16px 40px;color:#fff;font-size:16px;font-weight:700;text-decoration:none;border-radius:8px">Leave Your Review</a></td></tr></table>
    <p style="margin:0;font-size:13px;color:#71717a;line-height:1.6;text-align:center">Thank you for choosing AssembleAtEase — it means the world to a small local business.</p>
  </td></tr></table>
</div></body></html>`;

const emails = [
  { who: 'Easer', subject: `You've got a new job — King Bed Frame Assembly`,
    html: buildAssignmentEmail({ firstName: 'Travis', service: 'King Bed Frame Assembly', date: 'Sat, Jul 20', time: '10:00 AM',
      estimatedPayCents: 7113, acceptUrl: `${SITE}/assembler/my-assignments?accept=${ref}`, declineUrl: `${SITE}/assembler/my-assignments?decline=${ref}`, ref }) },
  { who: 'Easer', subject: `Your payment is on the way — $71.13 for King Bed Frame Assembly`,
    html: buildPayoutEmail({ firstName: 'Travis', ref, service: 'King Bed Frame Assembly', date: 'Jul 17', payoutDisplay: '$71.13', method: 'zelle', isCancellation: false }) },
  { who: 'Customer', subject: `Your Easer is confirmed — ${ref}`,
    html: buildStatusEmail({ customerName: 'Gupta', ref, status: 'Confirmed', statusColor: '#065f46', statusBg: '#d1fae5',
      headline: 'Your Easer is confirmed.', bodyHtml: `<p style="margin:0;font-size:15px;color:#52525b;line-height:1.7">Hi Gupta, good news — <strong>Travis</strong> will be handling your <strong>King Bed Frame Assembly</strong> on <strong>Sat, Jul 20</strong> at <strong>10:00 AM</strong>. We'll send another note when they're on the way.</p>${trackBtn(ref)}<p style="margin:18px 0 0;font-size:14px;color:#52525b;line-height:1.7">Questions before then? Call or text us at <a href="tel:+19792325139" style="color:#00BFFF;text-decoration:none">(979) 232-5139</a>.</p>` }) },
  { who: 'Customer', subject: `Your Easer is on the way — ${ref}`,
    html: buildStatusEmail({ customerName: 'Gupta', ref, status: 'On the way', statusColor: '#1d4ed8', statusBg: '#dbeafe',
      headline: 'Your Easer is on the way.', bodyHtml: `<p style="margin:0;font-size:15px;color:#52525b;line-height:1.7">Hi Gupta, Travis is heading to you now and should arrive around 10:00 AM.</p>${trackBtn(ref)}${reachUs('Travis')}` }) },
  { who: 'Customer', subject: `Your job is underway — ${ref}`,
    html: buildStatusEmail({ customerName: 'Gupta', ref, status: 'In progress', statusColor: '#059669', statusBg: '#d1fae5',
      headline: 'Your job is underway.', bodyHtml: `<p style="margin:0;font-size:15px;color:#52525b;line-height:1.7">Hi Gupta, great news — Travis has started working on your King Bed Frame Assembly. We'll let you know as soon as it's complete.</p>${trackBtn(ref)}` }) },
  { who: 'Customer', subject: `How was your experience? Leave a review`, html: reviewEmail },
];

async function send(e) {
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM, to: TO, subject: `[PREVIEW] ${e.subject}`, html: e.html, reply_to: 'service@assembleatease.com' }),
  });
  return { ok: resp.ok, status: resp.status, body: (await resp.text()).slice(0, 160) };
}

console.log(`Sending ${emails.length} FAITHFUL previews to ${TO} ...\n`);
let sent = 0;
for (const e of emails) {
  const r = await send(e);
  console.log(`  ${r.ok ? 'SENT' : 'FAIL(' + r.status + ')'}  [${e.who}]  ${e.subject}${r.ok ? '' : '  -> ' + r.body}`);
  if (r.ok) sent += 1;
  await new Promise(res => setTimeout(res, 700));
}
console.log(`\nDone: ${sent}/${emails.length} sent to ${TO}.`);
