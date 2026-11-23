import { esc } from '../_email.js';

// Why the owner declines a request, and the email each reason sends (owner,
// 2026-11-23: "when we decline a quote it doesnt give us a option to why and
// based on why it will give a different email response. like ... the quote with
// jeff. he said he found someone else." Every decline used to send "We're sorry.
// We can't take this one." to a customer who had told us they hired someone else).
// Cut from ten reasons to six the same day ("it dont look simple right").
//
// One list for the owner's Decline box (owner/index.html #decline-reason mirrors
// the keys and labels), the reason saved on the booking, and the email.
// scripts/test-owner-decline-reasons.mjs holds the two together.
//
// email: which customer email the reason sends; null sends nothing.
//   closed       the customer ended it: thanks, no apology, a way back.
//   price        the customer turned down the price: thanks, reply to re-price.
//   no_response  we never heard back: closed, reply to pick it back up.
//   unable       we cannot take it: one apology, thanks, Book again.
export const OWNER_DECLINE_REASONS = Object.freeze({
  hired_someone: Object.freeze({ label: 'Customer found someone else', email: 'closed' }),
  not_needed: Object.freeze({ label: 'Customer no longer needs it', email: 'closed' }),
  price: Object.freeze({ label: 'Price too high', email: 'price' }),
  no_response: Object.freeze({ label: "Customer didn't respond", email: 'no_response' }),
  cant_do: Object.freeze({ label: "We can't do this job", email: 'unable' }),
  duplicate: Object.freeze({ label: 'Duplicate or test', email: null }),
});

export function ownerDeclineReason(code) {
  return Object.prototype.hasOwnProperty.call(OWNER_DECLINE_REASONS, code) ? OWNER_DECLINE_REASONS[code] : null;
}

/** What the booking records: the reason, and the owner's note when there is one. */
export function declineReasonText(code, note) {
  const reason = ownerDeclineReason(code);
  if (!reason) return null;
  const cleanNote = String(note || '').trim();
  return cleanNote ? `${reason.label} — ${cleanNote}` : reason.label;
}

const SITE = 'https://www.assembleatease.com';
const P = 'margin:0 0 20px;font-size:15px;color:#52525b;line-height:1.7';
const P_SMALL = 'margin:0 0 20px;font-size:14px;color:#52525b;line-height:1.7';
const button = (href, label) => `<p style="margin:0 0 20px;text-align:center"><a href="${href}" style="display:inline-block;background:#00BFFF;color:#002b3a;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:700;font-size:14px">${label}</a></p>`;
const noteBox = (title, note) => `<table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-radius:6px;margin-bottom:20px"><tr><td style="padding:14px 18px">
           <p style="margin:0 0 4px;font-size:11px;font-weight:600;text-transform:uppercase;color:#71717a">${title}</p>
           <p style="margin:0;font-size:14px;color:#1a1a1a;line-height:1.6">${esc(note)}</p>
         </td></tr></table>`;

const CLOSED_BADGE = { status: 'CLOSED', statusColor: '#71717a', statusBg: '#f4f4f5' };
const UNABLE_BADGE = { status: 'UNABLE TO FULFIL', statusColor: '#71717a', statusBg: '#f4f4f5' };

/**
 * The customer email for a declined request, or null when the reason sends none.
 *   isQuote:  the request was a custom quote (wording only).
 *   hasCard:  the customer saved a card, so the email can say nothing was charged.
 * Returns { subject, headline, bodyHtml, status, statusColor, statusBg }.
 */
export function declineEmail({ code, note, firstName, service, ref, isQuote, hasCard }) {
  const reason = ownerDeclineReason(code);
  if (!reason || !reason.email) return null;
  const kind = isQuote ? 'quote request' : 'booking request';
  const name = esc(firstName || 'there');
  const what = `<strong>${esc(service || 'your project')}</strong>`;
  const cardNote = hasCard ? ' Nothing was charged to your card.' : '';
  const cleanNote = String(note || '').trim();
  const closedSubject = `Your ${kind} is closed — ${ref}`;
  const ourNote = cleanNote ? noteBox('A note from our team', cleanNote) : '';

  switch (reason.email) {
    case 'closed':
      return {
        ...CLOSED_BADGE,
        subject: closedSubject,
        headline: `Thanks for letting us know, ${name}.`,
        bodyHtml: `
        <p style="${P}">We've closed your ${kind} for ${what}.${cardNote}</p>
        ${ourNote}
        <p style="${P_SMALL}">When you have another project, we're here to help.</p>
        ${button(`${SITE}/book`, 'Book a service')}`,
      };
    case 'price':
      return {
        ...CLOSED_BADGE,
        subject: closedSubject,
        headline: `Thanks for letting us know, ${name}.`,
        bodyHtml: `
        <p style="${P}">We've closed your ${kind} for ${what}.${cardNote}</p>
        ${ourNote}
        <p style="${P_SMALL}">If the work changes, or you want a price for part of it, reply to this email and we'll send a new quote.</p>`,
      };
    case 'no_response':
      return {
        ...CLOSED_BADGE,
        subject: closedSubject,
        headline: `We've closed your ${kind}, ${name}.`,
        bodyHtml: `
        <p style="${P}">Your ${kind} for ${what} is closed.${cardNote}</p>
        ${ourNote}
        <p style="${P_SMALL}">If you still need help, reply to this email and we'll pick it back up.</p>`,
      };
    case 'unable':
    default:
      // Owner, 2026-10-23: one apology, then thanks (thanking outperforms a second
      // apology after a service failure), a way back to booking, and the first name.
      return {
        ...UNABLE_BADGE,
        subject: (isQuote ? 'Your Quote Request — ' : 'Your Booking Request — ') + ref,
        headline: `We're sorry, ${name}. We can't take this one.`,
        bodyHtml: `
        <p style="${P}">We are not able to take on your ${isQuote ? 'quote request' : 'request'} for ${what} at this time.${cardNote}</p>
        ${cleanNote ? noteBox('Reason', cleanNote) : ''}
        <p style="${P_SMALL}">We'd love to help you on another date or with a different service. Feel free to submit a new booking and we'll do our best to make it work.</p>
        ${button(`${SITE}/book`, 'Book again')}
        <p style="margin:0;font-size:14px;color:#52525b;line-height:1.7">Thank you for your understanding.</p>`,
      };
  }
}
