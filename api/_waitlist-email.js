/**
 * _waitlist-email.js — the ONE waitlist welcome email.
 *
 * Someone who signs up and someone the owner adds get the SAME email: same
 * header, same status badge, same "what happens next", same footer. A person
 * cannot tell which door they came through, and neither should look like the
 * cheaper one.
 *
 * Exactly three sentences differ, and only because the signup wording would be
 * FALSE for someone who never filled in a form:
 *
 *   intro      "Thank you for your interest" assumes they came to us.
 *   step1      "We review your request" assumes a request was made.
 *   legalLine  "You received this because you signed up" is the claim that
 *              matters most — it is the line a recipient reads when they are
 *              trying to work out why a company is emailing them, and getting
 *              it wrong is both dishonest and the thing CAN-SPAM cares about.
 *
 * Everything else is shared, so the design cannot drift between the two.
 */

import { esc } from './_email.js';

const LOGO = 'https://www.assembleatease.com/images/logo.jpg';
const SITE = 'https://www.assembleatease.com';

export const WAITLIST_EMAIL_VARIANT = Object.freeze({
  SIGNUP: 'signup',
  OWNER_ADDED: 'owner_added',
  // Someone who submitted a full APPLICATION and was placed on the waitlist
  // rather than approved or rejected. They came to us, so nothing here may
  // reference a conversation — and it must not claim their area is closed,
  // which is a reason we may not have and would have to stand behind later.
  APPLIED: 'applied',
});

/**
 * Returns { subject, html } for the waitlist welcome email.
 * Unknown variants fall back to the owner-added wording, because that copy is
 * true either way — claiming someone signed up when they did not is the only
 * failure here that cannot be walked back.
 */
export function buildWaitlistEmail({ name, city, state, variant = WAITLIST_EMAIL_VARIANT.SIGNUP } = {}) {
  const sName = esc(String(name || '').trim().split(/\s+/)[0] || 'there');
  const sCity = esc(city || '');
  const sState = esc(state || '');
  const isSignup = variant === WAITLIST_EMAIL_VARIANT.SIGNUP;
  const isApplied = variant === WAITLIST_EMAIL_VARIANT.APPLIED;

  // "Houston, TX" when we know it, a neutral phrase when we do not — never a
  // stray comma where a place should be.
  const place = (sCity && sState) ? `<strong>${sCity}, ${sState}</strong>` : (sCity ? `<strong>${sCity}</strong>` : 'your area');

  const intro = isApplied
    ? `Thank you for applying to AssembleAtEase. We're building a trusted network of skilled professionals in ${place}, and your application is on our waitlist.`
    : isSignup
      ? `Thank you for your interest in joining AssembleAtEase. We're building a trusted network of skilled professionals in ${place}, and we're glad you want to be part of it.`
      : `Following our conversation, we've added you to the AssembleAtEase professional network waitlist for ${place}. There's nothing you need to do right now &mdash; we'll be in touch when applications open.`;

  const step1 = isApplied ? 'We review your application' : (isSignup ? 'We review your request' : 'We review your details');

  const legalLine = isApplied
    ? 'You received this email because you applied to join the AssembleAtEase professional network. If you would rather we removed your application, reply to this email.'
    : isSignup
      ? 'You received this email because you signed up for the AssembleAtEase assembler waitlist. If you did not make this request, please disregard this email.'
      : 'You received this email because we added you to the AssembleAtEase Easer waitlist after speaking with you. If this was not something you asked for, reply to this email and we will remove you straight away.';

  const subject = isApplied
    ? 'Your AssembleAtEase application is on our waitlist'
    : isSignup
      ? 'Your AssembleAtEase Easer waitlist request'
      : 'You are on the AssembleAtEase Easer waitlist';

  return { subject, html: `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1a1a1a">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
  <!-- Header -->
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px 8px 0 0;border-bottom:1px solid #e4e4e7"><tr><td style="padding:24px;text-align:center">
    <img src="${LOGO}" alt="AssembleAtEase" width="44" height="44" style="border-radius:50%;display:inline-block"/>
    <p style="margin:8px 0 0;font-size:17px;font-weight:700;color:#1a1a1a">AssembleAtEase</p>
  </td></tr></table>

  <!-- Body -->
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-left:1px solid #e4e4e7;border-right:1px solid #e4e4e7"><tr><td style="padding:32px 24px 24px">
    <p style="margin:0 0 6px;font-size:24px;font-weight:700;color:#1a1a1a">You're on the waitlist, ${sName}.</p>
    <p style="margin:0 0 24px;font-size:15px;color:#52525b;line-height:1.7">${intro}</p>

    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-radius:6px;margin-bottom:24px"><tr><td style="padding:18px 20px">
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr><td style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:#71717a;padding-bottom:6px">Your Status</td></tr>
        <tr><td><span style="display:inline-block;background:#dbeafe;color:#1e40af;font-size:11px;font-weight:700;padding:3px 10px;border-radius:99px">ON WAITLIST</span></td></tr>
      </table>
    </td></tr></table>

    <p style="margin:0 0 12px;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#71717a">What Happens Next</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px">
      <tr><td style="width:28px;vertical-align:top;padding:6px 0"><div style="width:22px;height:22px;background:#00BFFF;border-radius:50%;text-align:center;line-height:22px;font-size:11px;font-weight:700;color:#fff">1</div></td><td style="padding:6px 0 6px 10px;font-size:14px;color:#52525b;line-height:1.6"><strong style="color:#1a1a1a">${step1}</strong> — Our team evaluates new applications as spots become available.</td></tr>
      <tr><td style="vertical-align:top;padding:6px 0"><div style="width:22px;height:22px;background:#00BFFF;border-radius:50%;text-align:center;line-height:22px;font-size:11px;font-weight:700;color:#fff">2</div></td><td style="padding:6px 0 6px 10px;font-size:14px;color:#52525b;line-height:1.6"><strong style="color:#1a1a1a">We reach out</strong> — When a spot opens in your area, you'll be among the first contacted.</td></tr>
      <tr><td style="vertical-align:top;padding:6px 0"><div style="width:22px;height:22px;background:#00BFFF;border-radius:50%;text-align:center;line-height:22px;font-size:11px;font-weight:700;color:#fff">3</div></td><td style="padding:6px 0 6px 10px;font-size:14px;color:#52525b;line-height:1.6"><strong style="color:#1a1a1a">Start earning</strong> — Get matched with local customers and begin completing jobs.</td></tr>
    </table>

    <p style="margin:0 0 12px;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#71717a">Why Professionals Choose Us</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;margin-bottom:24px">
      <tr><td style="padding:8px 0;color:#52525b;line-height:1.5;border-bottom:1px solid #f0f0f0">Review job scope and estimated earnings before accepting.</td></tr>
      <tr><td style="padding:8px 0;color:#52525b;line-height:1.5;border-bottom:1px solid #f0f0f0">Receive offers only after application, verification, and owner approval.</td></tr>
      <tr><td style="padding:8px 0;color:#52525b;line-height:1.5;border-bottom:1px solid #f0f0f0">Customer booking and scheduling are managed through the platform.</td></tr>
      <tr><td style="padding:8px 0;color:#52525b;line-height:1.5">If invited, you will see all application requirements and any applicable fee before submitting.</td></tr>
    </table>

    <table width="100%" cellpadding="0" cellspacing="0"><tr><td style="text-align:center;padding:8px 0">
      <a href="${SITE}" style="display:inline-block;background:#00BFFF;color:#ffffff;padding:12px 32px;border-radius:6px;text-decoration:none;font-size:14px;font-weight:600">Visit AssembleAtEase</a>
    </td></tr></table>
  </td></tr></table>

  <!-- Footer -->
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-top:none;border-radius:0 0 8px 8px"><tr><td style="padding:20px 24px;text-align:center">
    <img src="${LOGO}" alt="AssembleAtEase" width="28" height="28" style="border-radius:50%;display:inline-block"/>
    <p style="margin:8px 0 4px;font-size:12px;font-weight:600;color:#71717a">AssembleAtEase</p>
    <p style="margin:0 0 8px;font-size:11px;color:#a1a1aa;line-height:1.5">Professional Assembly &amp; Handyman Services<br/>Market availability varies by service area.</p>
    <p style="margin:0;font-size:11px;color:#a1a1aa"><a href="${SITE}" style="color:#71717a;text-decoration:none">assembleatease.com</a> &bull; <a href="mailto:service@assembleatease.com" style="color:#71717a;text-decoration:none">service@assembleatease.com</a></p>
    <p style="margin:10px 0 0;font-size:10px;color:#d4d4d8">${legalLine}</p>
  </td></tr></table>
</div></body></html>` };
}
